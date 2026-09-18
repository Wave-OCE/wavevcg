/**
 * The two team splashes: the lineup and the head-to-head.
 *
 * Both hold a COPY of a team rather than a reference, and most of what is worth
 * asserting follows from that: a Load takes a snapshot, editing the library
 * afterwards does not reach a graphic that is already on air, and the operator's
 * own settings survive a Load that only means "now show the other team".
 *
 * Verified by deliberate breaks; each is named in the commit.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openAsAdmin } from './harness.mjs';

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8181;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-teamg-'));

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}`);

const server = spawn(process.execPath, ['server.js'], {
  cwd: PROJECT,
  env: {
    ...process.env,
    PORT: String(PORT),
    STATE_DIR: STATE,
    ADMIN_USERNAME: 'boss',
    ADMIN_PASSWORD: 'a-long-enough-password',
    TRACKER_ENABLED: 'false',
    HENRIK_API_KEY: '',
    RIOT_ACCOUNT_KEY: '',
    RIOT_API_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (c) => (log += c));
server.stderr.on('data', (c) => (log += c));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 80; i += 1) {
  try {
    await fetch(`${BASE}/api/auth/state`);
    break;
  } catch {
    await wait(250);
  }
}

try {
  const { cookie, key, tournamentId } = await openAsAdmin(BASE, 'boss', 'a-long-enough-password', 'Team Graphics Cup');
  const H = { 'Content-Type': 'application/json', Cookie: cookie };
  const at = (route, extra = '') => `${BASE}${route}?session=${tournamentId}${extra}`;

  const get = async (route, extra = '') => (await (await fetch(at(route, extra), { headers: { Cookie: cookie } })).json());
  const post = async (route, body, extra = '') => {
    const response = await fetch(at(route, extra), { method: 'POST', headers: H, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const PHOTO = '/media/portrait.png';

  const cru = (
    await post('/api/teams', {
      action: 'save',
      team: {
        name: 'Crusaders',
        shortName: 'CRU',
        colour: '#22aa55',
        logo: '/media/cru.png',
        banner: '/media/cru-banner.png',
        playerPhoto: '/media/cru-default.png',
        players: [
          { displayName: 'Blessed', riotId: 'Blessed#0001', photo: PHOTO },
          { displayName: 'Neon', riotId: 'Neon#EU' },
          { displayName: 'Tayo', riotId: 'Tayo#OCE', photo: PHOTO },
          { displayName: '2door', riotId: '2door#AU', photo: PHOTO },
          { displayName: 'Wisp', riotId: 'Wisp#NZ', photo: PHOTO },
          { displayName: 'Sub', riotId: 'Sub#AU', photo: PHOTO },
        ],
      },
    })
  ).body.saved;

  const jail = (
    await post('/api/teams', { action: 'save', team: { name: 'Jail Time', shortName: 'JAIL', logo: '/media/jail.png' } })
  ).body.saved;

  // ------------------------------------------------------------- the fields ---
  eq('1 a team carries a backdrop', cru.banner, '/media/cru-banner.png');
  eq('2 ...and a default player photo', cru.playerPhoto, '/media/cru-default.png');
  eq('3 a player carries a photo', cru.players[0].photo, PHOTO);

  /*
   * An image field is VALIDATED, not merely trimmed, and a player's photo goes
   * through the same rule as a team's logo. They used to differ - the team's was
   * checked and the player's was any string at all - which is two fields holding
   * the same kind of value cleaned by different rules, one of which was
   * "anything".
   */
  const junk = (
    await post('/api/teams', {
      action: 'save',
      team: { id: cru.id, name: 'Crusaders', players: [{ displayName: 'X', riotId: 'X#1', photo: 'javascript:alert(1)' }] },
    })
  ).body.saved;
  eq('4 a photo that is not a URL is refused', junk.players[0].photo, '');

  // Put the roster back.
  await post('/api/teams', {
    action: 'save',
    team: {
      id: cru.id,
      name: 'Crusaders',
      shortName: 'CRU',
      colour: '#22aa55',
      logo: '/media/cru.png',
      banner: '/media/cru-banner.png',
      playerPhoto: '/media/cru-default.png',
      players: [
        { displayName: 'Blessed', riotId: 'Blessed#0001', photo: PHOTO },
        { displayName: 'Neon', riotId: 'Neon#EU' },
        { displayName: 'Tayo', riotId: 'Tayo#OCE', photo: PHOTO },
        { displayName: '2door', riotId: '2door#AU', photo: PHOTO },
        { displayName: 'Wisp', riotId: 'Wisp#NZ', photo: PHOTO },
        { displayName: 'Sub', riotId: 'Sub#AU', photo: PHOTO },
      ],
    },
  });

  // ------------------------------------------------------------- the lineup ---
  let r = await post('/api/lineup', { action: 'load', id: cru.id }, '&bus=preview');
  eq('5 a lineup loads a team', r.status, 200);
  eq('6 ...carrying the org', r.body.state.teamName, 'Crusaders');
  eq('7 ...and its default photo, for anybody without one', r.body.state.defaultPhoto, '/media/cru-default.png');
  /*
   * FIVE, from a squad of six. Trimmed at the point of COPY rather than at
   * paint time: which five appear is a decision the operator makes by ordering
   * the roster, not one the page makes silently while it draws.
   */
  eq('8 ...trimmed to five', r.body.state.players.length, 5);
  eq('9 ...in roster order', r.body.state.players.map((p) => p.name).join(','), 'Blessed,Neon,Tayo,2door,Wisp');

  /*
   * The operator's own settings survive a Load. The format, the heading and the
   * event logo are set once before a show; a Load means "now show the other
   * team" and must not undo them.
   */
  const styled = await post(
    '/api/lineup',
    { state: { ...r.body.state, format: 'names', heading: 'Starting lineup', eventLogo: '/media/event.png' } },
    '&bus=preview',
  );
  eq('10 the format is settable', styled.body.state.format, 'names');
  r = await post('/api/lineup', { action: 'load', id: jail.id }, '&bus=preview');
  eq('11 a second Load swaps the team', r.body.state.teamName, 'Jail Time');
  eq('12 ...and keeps the format', r.body.state.format, 'names');
  eq('13 ...and the heading', r.body.state.heading, 'Starting lineup');
  eq('14 ...and the event logo', r.body.state.eventLogo, '/media/event.png');

  /*
   * A COPY, not a view. Editing the library afterwards must not reach a graphic
   * that may be on air - the rule every other graphic here follows.
   */
  await post('/api/teams', { action: 'save', team: { id: jail.id, name: 'Renamed Mid Show', shortName: 'RMS' } });
  r = await get('/api/lineup', '&bus=preview');
  eq('15 renaming the team does NOT change the loaded graphic', r.state.teamName, 'Jail Time');

  r = await post('/api/lineup', { action: 'load', id: 'nope' }, '&bus=preview');
  eq('16 loading a team that is gone is refused', r.status, 404);

  // -------------------------------------------------------- the head to head ---
  r = await post('/api/headtohead', { action: 'side', side: 'left', id: cru.id }, '&bus=preview');
  eq('17 a side takes a team', r.body.state.left.teamName, 'Crusaders');
  eq('18 ...with its backdrop', r.body.state.left.banner, '/media/cru-banner.png');
  r = await post('/api/headtohead', { action: 'side', side: 'right', id: jail.id }, '&bus=preview');
  eq('19 the other side is independent', r.body.state.right.teamName, 'Renamed Mid Show');
  eq('20 ...and the first is untouched', r.body.state.left.teamName, 'Crusaders');

  await post('/api/schedule', { action: 'stage.save', stage: { name: 'Playoffs', kind: 'bracket', bestOf: 3 } });
  const sched = await post('/api/schedule', {
    action: 'fixture.save',
    fixture: { stageId: 'playoffs', bestOf: 3, left: { name: 'Alpha', shortName: 'ALP' }, right: { name: 'Beta', shortName: 'BET' } },
  });
  const fixtureId = sched.body.schedule.fixtures[0].id;

  r = await post('/api/headtohead', { action: 'fixture', id: fixtureId }, '&bus=preview');
  eq('21 a fixture fills both halves', `${r.body.state.left.teamName} v ${r.body.state.right.teamName}`, 'Alpha v Beta');

  // --------------------------------------------------------------- the buses ---
  /*
   * Writes stage, like every other graphic - `busFor` sends an unqualified write
   * to preview, and air must not move until somebody takes it.
   */
  const air = await get('/api/headtohead');
  ok('22 air is untouched by all of that', !air.state.left.teamName, air.state.left.teamName);

  r = await post('/api/take', { graphic: 'headToHead' });
  eq('23 it can be taken', r.status, 200);
  const taken = await get('/api/headtohead');
  eq('24 ...and then air has it', taken.state.left.teamName, 'Alpha');

  /*
   * The CUE. A take that only moved the TEAM must not replay the entrance - an
   * operator swapping a tricode is correcting a mistake, not presenting a new
   * graphic. Only visibility is in `transport`.
   */
  const before = (await get('/api/headtohead')).state.anim.cue;
  await post('/api/headtohead', { action: 'side', side: 'left', id: cru.id }, '&bus=preview');
  await post('/api/take', { graphic: 'headToHead' });
  eq('25 a take that only changed the team does not bump the cue', (await get('/api/headtohead')).state.anim.cue, before);

  const showing = await get('/api/headtohead', '&bus=preview');
  await post('/api/headtohead', { state: { ...showing.state, anim: { ...showing.state.anim, visible: true } } }, '&bus=preview');
  await post('/api/take', { graphic: 'headToHead' });
  ok('26 ...but showing it does', (await get('/api/headtohead')).state.anim.cue !== before, 'cue did not move');

  // ------------------------------------------------------------ the key gate ---
  /*
   * READ-ONLY for a session key, like the other output pages: an OBS browser
   * source carries a key and no cookie. A key must not be able to WRITE one.
   */
  const keyRead = await fetch(`${BASE}/api/lineup?key=${encodeURIComponent(key)}`);
  eq('27 a key may read a lineup, so OBS works', keyRead.status, 200);
  const keyWrite = await fetch(`${BASE}/api/lineup?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'load', id: cru.id }),
  });
  eq('28 ...and may not write one', keyWrite.status, 403);
  const h2hRead = await fetch(`${BASE}/api/headtohead?key=${encodeURIComponent(key)}`);
  eq('29 the same for the head to head', h2hRead.status, 200);

  ok('30 a load is logged', /lineup loaded/.test(log), 'no audit line for a lineup load');
  ok('31 no session key reached the log', !log.includes(key), 'KEY LEAKED');
} catch (error) {
  fail += 1;
  console.log('THREW', error.stack);
  console.log(log.slice(-1500));
} finally {
  server.kill('SIGTERM');
  await wait(600);
  server.kill('SIGKILL');
  try {
    rmSync(STATE, { recursive: true, force: true });
  } catch {
    /* windows */
  }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
