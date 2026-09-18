/**
 * The bracket graphic.
 *
 * What is worth asserting here is almost entirely about the SNAPSHOT: this
 * graphic holds a drawing rather than a competition, so the questions are
 * whether the drawing matches what the Schedule page would draw, whether a
 * schedule edit can move what is on air (it must not), and whether the reveal
 * counts rounds rather than matches.
 *
 * Verified by deliberate breaks; each is named in the commit.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openAsAdmin } from './harness.mjs';
import { bracketLayout } from '../../public/schedule-schema.js';
import { bracketChampion } from '../../public/bracket-graphic-schema.js';

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8182;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-brkg-'));

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
  const { cookie, key, tournamentId } = await openAsAdmin(BASE, 'boss', 'a-long-enough-password', 'Bracket Cup');
  const H = { 'Content-Type': 'application/json', Cookie: cookie };
  const at = (route, extra = '') => `${BASE}${route}?session=${tournamentId}${extra}`;
  const get = async (route, extra = '') => (await (await fetch(at(route, extra), { headers: { Cookie: cookie } })).json());
  const post = async (route, body, extra = '') => {
    const response = await fetch(at(route, extra), { method: 'POST', headers: H, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const T = (name, short) => ({ name, shortName: short });
  /*
   * Written out rather than generated. A Bo3 needs two map WINS and a map
   * cannot be 13-13 - a generated fixture produced exactly that and the
   * quarter-final came out undecided, which is the sort of thing that makes a
   * suite assert against a state nobody meant to build.
   */
  const bo3 = (leftWins) =>
    leftWins === 2
      ? [{ name: 'Ascent', left: 13, right: 7 }, { name: 'Bind', left: 13, right: 9 }]
      : [{ name: 'Ascent', left: 7, right: 13 }, { name: 'Bind', left: 9, right: 13 }];

  const save = (fixture) => post('/api/schedule', { action: 'fixture.save', fixture });

  await post('/api/schedule', { action: 'stage.save', stage: { name: 'Playoffs', kind: 'bracket', bestOf: 3 } });

  const quarters = [
    ['qf1', T('Sentinels', 'SI'), T('Crusaders', 'CRU'), 0],
    ['qf2', T('Arcane', 'ARC'), T('Zero GC', 'ZOGC'), 2],
    ['qf3', T('Aim Labs', 'AIM'), T('Wooden Box', 'WB'), 0],
    ['qf4', T('Zenith', 'ZO'), T('Jail Time', 'JAIL'), 0],
  ];
  for (let i = 0; i < quarters.length; i += 1) {
    const [id, left, right, wins] = quarters[i];
    await save({ id, stageId: 'playoffs', round: 1, slot: i, bracket: 'upper', bestOf: 3, left, right, maps: bo3(wins) });
  }

  /*
   * The later rounds get their EDGES first and their results second, which is
   * the operator's real order and the only one the schedule allows:
   * propagation refuses to rewrite a fixture that has already been played, so
   * one save carrying both an edge and a 2-0 is correctly refused.
   */
  const semis = [
    ['sf1', 'qf1', 'qf2', 2],
    ['sf2', 'qf3', 'qf4', 0],
  ];
  for (let i = 0; i < semis.length; i += 1) {
    const [id, a, b] = semis[i];
    await save({
      id,
      stageId: 'playoffs',
      round: 2,
      slot: i,
      bracket: 'upper',
      bestOf: 3,
      left: { source: { fixtureId: a, take: 'winner' } },
      right: { source: { fixtureId: b, take: 'winner' } },
    });
  }
  await save({
    id: 'gf',
    stageId: 'playoffs',
    round: 3,
    slot: 0,
    bracket: 'upper',
    bestOf: 3,
    left: { source: { fixtureId: 'sf1', take: 'winner' } },
    right: { source: { fixtureId: 'sf2', take: 'winner' } },
  });

  let sched = await get('/api/schedule');
  const byId = Object.fromEntries(sched.schedule.fixtures.map((f) => [f.id, f]));
  eq('1 the draw propagated into the semi-finals', byId.sf1.left.name, 'Crusaders');
  for (const [id, , , wins] of semis) await save({ ...byId[id], maps: bo3(wins) });
  sched = await get('/api/schedule');
  await save({ ...sched.schedule.fixtures.find((f) => f.id === 'gf'), maps: bo3(2) });

  // ------------------------------------------------------------- the load ---
  let r = await post('/api/bracket', { action: 'load', id: 'playoffs' }, '&bus=preview');
  eq('2 a stage loads', r.status, 200);
  const drawn = r.body.state;
  eq('3 ...as three rounds', drawn.columns, 3);
  eq('4 ...and seven matches', drawn.nodes.length, 7);
  eq('5 ...with six edges', drawn.links.length, 6);

  /*
   * THE ONE THAT JUSTIFIES THE WHOLE DESIGN: the graphic's drawing is the same
   * one the Schedule page computes, because both come from bracketLayout. A
   * second implementation of the geometry is one refactor away from a board on
   * the desk that does not match the board on air, with nothing failing.
   */
  const fresh = await get('/api/schedule');
  const layout = bracketLayout(fresh.schedule, 'playoffs');
  eq(
    '6 the graphic draws exactly what the Schedule page would',
    JSON.stringify(drawn.nodes.map((n) => [n.id, n.column, n.row])),
    JSON.stringify(layout.nodes.map((n) => [n.id, n.column, n.row])),
  );

  /*
   * Teams are RESOLVED into the snapshot - the output page never dereferences
   * anything while it paints.
   */
  const qf1 = drawn.nodes.find((n) => n.id === 'qf1');
  eq('7 a node carries its teams by name', `${qf1.left.shortName}/${qf1.right.shortName}`, 'SI/CRU');
  eq('8 ...and their map score', `${qf1.left.score}-${qf1.right.score}`, '0-2');
  eq('9 ...and who won', qf1.winner, 'right');

  /*
   * An edge is LIVE only where somebody actually progressed. A line pulsing
   * toward an empty slot tells an audience about a result that does not exist.
   */
  eq('10 every edge of a finished bracket is live', drawn.links.filter((l) => l.live).length, 6);
  eq('11 the champion falls out of the drawing', bracketChampion(drawn)?.shortName, 'CRU');

  /*
   * AND THE OTHER DIRECTION, which is the half that makes assertion 10 mean
   * anything.
   *
   * Its first version only counted live edges on a FINISHED bracket, where all
   * six are - so hard-coding `live: true` passed it. Found by breaking it on
   * purpose. An unplayed round is the case the flow exists to exclude: a line
   * pulsing toward an empty slot tells an audience about a result that does not
   * exist.
   */
  {
    await post('/api/schedule', { action: 'stage.save', stage: { name: 'Undecided', kind: 'bracket', bestOf: 3 } });
    await save({ id: 'uq1', stageId: 'undecided', round: 1, slot: 0, bracket: 'upper', bestOf: 3, left: T('Alpha', 'ALP'), right: T('Beta', 'BET') });
    await save({ id: 'uq2', stageId: 'undecided', round: 1, slot: 1, bracket: 'upper', bestOf: 3, left: T('Gamma', 'GAM'), right: T('Delta', 'DEL') });
    await save({
      id: 'usf',
      stageId: 'undecided',
      round: 2,
      slot: 0,
      bracket: 'upper',
      bestOf: 3,
      left: { source: { fixtureId: 'uq1', take: 'winner' } },
      right: { source: { fixtureId: 'uq2', take: 'winner' } },
    });

    const half = await post('/api/bracket', { action: 'load', id: 'undecided' }, '&bus=preview');
    eq('11b an unplayed bracket still draws its edges', half.body.state.links.length, 2);
    eq('11c ...and NONE of them is live', half.body.state.links.filter((l) => l.live).length, 0);
    eq('11d ...and it has no champion', bracketChampion(half.body.state), null);

    // One result, and exactly one edge comes alive.
    const now = await get('/api/schedule');
    await save({ ...now.schedule.fixtures.find((f) => f.id === 'uq1'), maps: bo3(2) });
    const oneDone = await post('/api/bracket', { action: 'load', id: 'undecided' }, '&bus=preview');
    eq('11e filing one result lights exactly one edge', oneDone.body.state.links.filter((l) => l.live).length, 1);

    // Back to the finished bracket for everything below.
    await post('/api/bracket', { action: 'load', id: 'playoffs' }, '&bus=preview');
  }

  // ------------------------------------------------------------ the reveal ---
  eq('12 a fresh load reveals nothing', drawn.reveal, 0);
  r = await post('/api/bracket', { action: 'reveal' }, '&bus=preview');
  eq('13 reveal counts ROUNDS, not matches', r.body.state.reveal, 1);
  r = await post('/api/bracket', { action: 'reveal', to: 99 }, '&bus=preview');
  eq('14 ...and is clamped to the rounds that exist', r.body.state.reveal, 3);
  r = await post('/api/bracket', { action: 'reveal', to: -5 }, '&bus=preview');
  eq('15 ...and never below nothing', r.body.state.reveal, 0);

  // ---------------------------------------------------- the operator's work ---
  const styled = await post(
    '/api/bracket',
    {
      state: {
        ...r.body.state,
        heading: 'Playoffs',
        flow: false,
        eventLogo: '/media/event.png',
        winner: { show: true, heading: 'CHAMPIONS', label: '', image: '', footer: 'WINNER' },
      },
    },
    '&bus=preview',
  );
  eq('16 the winner panel is settable', styled.body.state.winner.heading, 'CHAMPIONS');
  eq('17 the flow can be switched off', styled.body.state.flow, false);

  r = await post('/api/bracket', { action: 'load', id: 'playoffs' }, '&bus=preview');
  eq('18 a second Load keeps the winner panel wording', r.body.state.winner.heading, 'CHAMPIONS');
  eq('19 ...and the flow switch', r.body.state.flow, false);
  eq('20 ...and the event logo', r.body.state.eventLogo, '/media/event.png');

  /*
   * A COPY, not a view. This is the graphic most likely to be up while somebody
   * is filing results behind it, so a schedule edit reaching air would be the
   * worst version of the failure copy-not-link exists to prevent.
   */
  await post('/api/take', { graphic: 'bracket' });
  const onAir = await get('/api/bracket');
  eq('21 it can be taken', onAir.state.nodes.length, 7);

  await save({ ...(await get('/api/schedule')).schedule.fixtures.find((f) => f.id === 'qf1'), left: T('RENAMED', 'REN') });
  const after = await get('/api/bracket');
  const stillSI = after.state.nodes.find((n) => n.id === 'qf1');
  eq('22 renaming a team does NOT change what is on air', stillSI.left.shortName, 'SI');

  r = await post('/api/bracket', { action: 'load', id: 'nope' }, '&bus=preview');
  eq('23 loading a stage that is gone is refused', r.status, 404);

  await post('/api/schedule', { action: 'stage.save', stage: { name: 'Empty', kind: 'bracket', bestOf: 3 } });
  r = await post('/api/bracket', { action: 'load', id: 'empty' }, '&bus=preview');
  eq('24 a stage with no matches is refused rather than drawn blank', r.status, 400);

  // ------------------------------------------------------------ the cue ---
  /*
   * Revealing a round must NOT replay the entrance - only visibility is in
   * `transport`, so a take that moved the reveal leaves the cue alone.
   */
  const cueBefore = (await get('/api/bracket')).state.anim.cue;
  await post('/api/bracket', { action: 'reveal', to: 2 }, '&bus=preview');
  await post('/api/take', { graphic: 'bracket' });
  eq('25 a take that only revealed a round does not bump the cue', (await get('/api/bracket')).state.anim.cue, cueBefore);

  const shown = await get('/api/bracket', '&bus=preview');
  await post('/api/bracket', { state: { ...shown.state, anim: { ...shown.state.anim, visible: true } } }, '&bus=preview');
  await post('/api/take', { graphic: 'bracket' });
  ok('26 ...but showing it does', (await get('/api/bracket')).state.anim.cue !== cueBefore, 'cue did not move');

  // ------------------------------------------------------------ the gate ---
  const keyRead = await fetch(`${BASE}/api/bracket?key=${encodeURIComponent(key)}`);
  eq('27 a key may read it, so OBS works', keyRead.status, 200);
  const keyWrite = await fetch(`${BASE}/api/bracket?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'load', id: 'playoffs' }),
  });
  eq('28 ...and may not write it', keyWrite.status, 403);

  ok('29 a load is logged', /bracket loaded/.test(log), 'no audit line');
  ok('30 no session key reached the log', !log.includes(key), 'KEY LEAKED');
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
