/**
 * The map veto: the model, the routes, and the three links.
 *
 * The links are why this suite is worth its length. They are the SIXTH secret
 * in this program and the only one handed to somebody outside the organisation
 * running the show - a visiting team's captain, on a phone, with no account -
 * so the questions that matter are not "does a ban land" but "what else does
 * that link reach" and "what does a wrong one tell you".
 *
 * Verified by deliberate breaks; each one is named in the commit.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { addMember, makeAccount, openAsAdmin, signIn } from './harness.mjs';

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8180;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-veto-'));

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

const POOL = ['Ascent', 'Bind', 'Haven', 'Lotus', 'Split', 'Sunset', 'Abyss'];

try {
  const { cookie, key, tournamentId } = await openAsAdmin(BASE, 'boss', 'a-long-enough-password', 'Veto Cup');
  const H = { 'Content-Type': 'application/json', Cookie: cookie };
  const at = (route) => `${BASE}${route}?session=${tournamentId}`;

  const get = async (route, headers = { Cookie: cookie }) => {
    const response = await fetch(at(route), { headers });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const post = async (route, body, headers = H) => {
    const response = await fetch(at(route), { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  // ------------------------------------------------------------ the pool ---
  let r = await post('/api/veto', { action: 'pool.save', pool: POOL });
  eq('1 the pool saves', r.status, 200);
  eq('2 ...and reads back whole', (r.body?.veto?.pool ?? []).join(','), POOL.join(','));

  r = await post('/api/veto', { action: 'pool.save', pool: [...POOL, 'Ascent', ''] });
  eq('3 duplicates and blanks are dropped', (r.body?.veto?.pool ?? []).length, 7);

  // ---------------------------------------------------------- a standalone ---
  r = await post('/api/veto', {
    action: 'create',
    veto: { name: 'CRU vs JAIL', format: 'bo3', a: { name: 'Crusaders', shortName: 'CRU' }, b: { name: 'Jail Time', shortName: 'JAIL' } },
  });
  eq('4 a standalone veto is created', r.status, 200);
  const veto = r.body.veto.vetoes[0];
  ok('5 ...with the template sequence', veto.steps.map((s) => s.kind).join(' ') === 'ban ban pick pick ban ban decider', veto.steps.map((s) => s.kind).join(' '));
  ok('6 ...taking a copy of the pool', veto.pool.length === 7);
  ok('7 ...and a copy of both teams, never an id reference', veto.a.name === 'Crusaders' && veto.b.shortName === 'JAIL');

  // ------------------------------------------------------------ the links ---
  r = await get('/api/veto');
  const tokens = r.body?.tokens?.[veto.id];
  ok('8 an editor is given three links', Boolean(tokens?.a && tokens?.b && tokens?.referee));
  ok('9 ...which are all different', new Set([tokens.a, tokens.b, tokens.referee]).size === 3);
  ok('10 ...and long enough not to guess', tokens.a.length >= 40, String(tokens.a.length));
  ok(
    '11 the document itself carries no token',
    !JSON.stringify(r.body.veto).includes(tokens.a),
    'A TOKEN IS IN THE DOCUMENT',
  );

  /*
   * A VIEWER sees the board and gets no links. Every other read on this server
   * is the same for everybody who may see the tournament, because what they
   * carry is information; this one carries credentials that run a veto.
   */
  await makeAccount(BASE, cookie, 'watcher', 'a-long-enough-password');
  const roster = await (await fetch(`${BASE}/api/account/me`, { headers: { Cookie: cookie } })).json();
  const watcherId = roster.grantable?.find((entry) => entry.username === 'watcher')?.id;
  await addMember(BASE, cookie, tournamentId, watcherId, 'viewer');
  const { cookie: watcherCookie } = await signIn(BASE, 'watcher', 'a-long-enough-password');

  r = await get('/api/veto', { Cookie: watcherCookie });
  eq('12 a viewer may read the vetoes', r.status, 200);
  ok('13 ...and is given no links at all', r.body?.tokens === null, JSON.stringify(r.body?.tokens));

  // --------------------------------------------------------- the key gate ---
  /*
   * NOT in KEYED_ROUTES, either verb - and adding the path turns these red,
   * which is what makes them an assertion about that list rather than about a
   * check inside the route. A session key is typed into OBS configuration and
   * read out over screen shares; it must not hand out a credential that files
   * bans for a real match.
   */
  r = await get('/api/veto', {});
  const keyed = await fetch(`${BASE}/api/veto?key=${encodeURIComponent(key)}`);
  eq('14 a session key cannot read a veto', keyed.status, 403);
  const keyedWrite = await fetch(`${BASE}/api/veto?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'rotate', id: veto.id }),
  });
  ok('15 ...nor rotate its links', keyedWrite.status === 403, String(keyedWrite.status));

  // ------------------------------------------------------ the public route ---
  const pub = (token, suffix = '') =>
    `${BASE}/api/veto/public?session=${encodeURIComponent(tournamentId)}&k=${encodeURIComponent(token)}${suffix}`;
  const readAs = async (token) => {
    const response = await fetch(pub(token));
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const answerAs = async (token, body) => {
    const response = await fetch(pub(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  r = await readAs(tokens.a);
  eq('16 a captain link opens with no account', r.status, 200);
  eq('17 ...and knows which seat it is', r.body?.veto?.you, 'a');
  ok('18 ...and says it is their turn', r.body?.veto?.turn === 'a' && r.body?.veto?.yours === true);
  ok(
    '19 a captain is told NOTHING about the tokens',
    !JSON.stringify(r.body).includes(tokens.a) && !JSON.stringify(r.body).includes(tokens.referee),
    'A TOKEN REACHED A CAPTAIN',
  );

  /*
   * A wrong token and a wrong tournament answer IDENTICALLY, so this cannot be
   * used to find out which tournaments exist on this server - the same rule the
   * `!ctx.bundle` refusal follows, reached again by a route that has no ctx.
   */
  const badToken = await fetch(pub('not-a-real-token'));
  const badTournament = await fetch(
    `${BASE}/api/veto/public?session=00000000-0000-4000-8000-000000000000&k=${encodeURIComponent(tokens.a)}`,
  );
  eq('20 a wrong token is 404', badToken.status, 404);
  eq('21 a wrong tournament is 404 too', badTournament.status, 404);
  eq(
    '22 ...byte for byte the same answer',
    JSON.stringify(await badToken.json().catch(() => null)),
    JSON.stringify(await badTournament.json().catch(() => null)),
  );

  // ------------------------------------------------------------- the turns ---
  r = await answerAs(tokens.b, { action: 'answer', map: 'Split' });
  eq('23 a captain cannot ban on the other team\'s turn', r.status, 409);

  r = await answerAs(tokens.a, { action: 'answer', map: 'Split' });
  eq('24 the team whose turn it is can', r.status, 200);
  eq('25 ...and the turn passes', r.body?.veto?.turn, 'b');

  r = await answerAs(tokens.b, { action: 'answer', map: 'Split' });
  eq('26 the same map cannot go twice', r.status, 409);

  r = await answerAs(tokens.a, { action: 'answer', map: 'Sunset' });
  eq('27 nor can a team take two turns in a row', r.status, 409);

  await answerAs(tokens.b, { action: 'answer', map: 'Sunset' });
  r = await answerAs(tokens.a, { action: 'answer', map: 'Haven' });
  eq('28 a pick lands', r.status, 200);
  /*
   * The side goes to the OTHER team by default, which is the ordinary rulebook.
   * It is a separate decision from the pick and is asked of a different team, so
   * it cannot ride along with it.
   */
  eq('29 ...and the side is the other team\'s to choose', r.body?.veto?.steps?.[2]?.sideBy, 'b');
  r = await answerAs(tokens.a, { action: 'side', at: 2, side: 'attack' });
  eq('30 the picking team cannot choose the side', r.status, 409);
  r = await answerAs(tokens.b, { action: 'side', at: 2, side: 'attack' });
  eq('31 the other team can', r.status, 200);
  eq('32 ...and it lands on that map', r.body?.veto?.steps?.[2]?.side, 'attack');

  await answerAs(tokens.b, { action: 'answer', map: 'Ascent' });
  await answerAs(tokens.a, { action: 'answer', map: 'Bind' });
  await answerAs(tokens.b, { action: 'answer', map: 'Lotus' });

  /*
   * The MESSAGE, not just the status, and the first version of this assertion
   * is why. It checked only for a 409 and was VACUOUS: delete the decider guard
   * and the turn check refuses anyway, because turnOf() calls the decider
   * nobody's turn - so it passed against code with the guard removed. Found by
   * breaking it on purpose, which is the only way anyone ever finds one.
   */
  r = await answerAs(tokens.a, { action: 'answer' });
  eq('33 a captain cannot file the decider', r.status, 409);
  ok(
    '33b ...and is told it is the referee who confirms it',
    /referee/i.test(r.body?.error?.message ?? ''),
    r.body?.error?.message,
  );
  r = await answerAs(tokens.referee, { action: 'answer' });
  eq('34 the referee can', r.status, 200);
  eq('35 ...and it is whatever survived', r.body?.veto?.steps?.[6]?.map, 'Abyss');
  eq('36 the veto is complete', r.body?.complete, true);

  r = await answerAs(tokens.referee, { action: 'answer' });
  eq('37 a finished veto takes no more answers', r.status, 409);

  // ------------------------------------------------------------- rotation ---
  const before = tokens.a;
  r = await post('/api/veto', { action: 'rotate', id: veto.id, role: 'a' });
  eq('38 a link can be rotated', r.status, 200);
  ok('39 ...and it changes', r.body?.tokens?.a !== before);
  const stale = await fetch(pub(before));
  eq('40 the old link stops working', stale.status, 404);
  const other = await fetch(pub(tokens.referee));
  eq('41 ...and only that one - the referee is untouched', other.status, 200);

  // ------------------------------------------------- from a fixture, filed ---
  await post('/api/schedule', { action: 'stage.save', stage: { name: 'Playoffs', kind: 'bracket', bestOf: 3 } });
  const sched = await post('/api/schedule', {
    action: 'fixture.save',
    fixture: { stageId: 'playoffs', bestOf: 3, left: { name: 'Crusaders', shortName: 'CRU' }, right: { name: 'Jail Time', shortName: 'JAIL' } },
  });
  const fixtureId = sched.body?.schedule?.fixtures?.[0]?.id;
  ok('42 a fixture exists to attach to', Boolean(fixtureId));

  r = await post('/api/veto', { action: 'create', fixtureId });
  const linked = r.body.veto.vetoes.find((entry) => entry.fixtureId === fixtureId);
  ok('43 a veto can be made from a fixture', Boolean(linked));
  ok('44 ...bringing both teams across', linked.a.name === 'Crusaders' && linked.b.name === 'Jail Time');
  eq('45 ...and the series length', linked.format, 'bo3');

  const linkedTokens = (await get('/api/veto')).body.tokens[linked.id];
  const walk = ['Split', 'Sunset', 'Haven', 'Ascent', 'Bind', 'Lotus'];
  for (let i = 0; i < walk.length; i += 1) {
    await answerAs(i % 2 === 0 ? linkedTokens.a : linkedTokens.b, { action: 'answer', map: walk[i] });
  }
  await answerAs(linkedTokens.referee, { action: 'answer' });

  /*
   * THE WRITE-BACK, and the reason it is an operator press: the schedule is the
   * competition record and every desk of the tournament shares it, while a veto
   * can be driven by somebody holding a link who has no account here at all. A
   * token must not be able to write the draw.
   */
  const beforeFile = await get('/api/schedule');
  eq('46 filing does not happen by itself', beforeFile.body?.schedule?.fixtures?.[0]?.maps?.[0]?.name ?? '', '');

  r = await post('/api/veto', { action: 'file', id: linked.id, at: 0 });
  eq('47 an operator can file one map', r.status, 200);
  eq('48 ...and only that one', r.body?.schedule?.fixtures?.[0]?.maps?.[0]?.name, 'Haven');
  ok('49 ...leaving the rest alone', !(r.body?.schedule?.fixtures?.[0]?.maps?.[1]?.name));

  r = await post('/api/veto', { action: 'file', id: linked.id });
  const rows = r.body?.schedule?.fixtures?.[0]?.maps ?? [];
  eq('50 ...or all of them at once', rows.map((row) => row.name).join(','), 'Haven,Ascent,Abyss');

  /*
   * The NAME only. A veto knows which map is played, not what the score was -
   * and overwriting a score Report already filed would throw away the one thing
   * a veto cannot know.
   */
  await post('/api/schedule', {
    action: 'fixture.save',
    fixture: { ...sched.body.schedule.fixtures[0], id: fixtureId, maps: [{ name: 'Haven', left: 13, right: 7 }] },
  });
  r = await post('/api/veto', { action: 'file', id: linked.id, at: 0 });
  const kept = r.body?.schedule?.fixtures?.[0]?.maps?.[0];
  ok('51 filing a map keeps a score already on it', kept?.left === 13 && kept?.right === 7, JSON.stringify(kept));

  // ------------------------------------------------------------- the reset ---
  r = await post('/api/veto', { action: 'reset', id: linked.id });
  const cleared = r.body.veto.vetoes.find((entry) => entry.id === linked.id);
  ok('52 a reset empties every step', cleared.steps.every((step) => !step.map));
  const stillOpen = await fetch(pub(linkedTokens.a));
  eq('53 ...and does NOT break the links the captains already have', stillOpen.status, 200);

  // --------------------------------------------------------- the board ---
  /*
   * The GRAPHIC, as opposed to the veto: a snapshot, and a set of reveal flags.
   *
   * The shape goes up whole and the maps arrive one at a time, so what is
   * asserted here is that the two are independent - every row exists from the
   * moment the board is loaded, and `revealed` is what decides whether an
   * audience can read it.
   */
  {
    const board = (extra = '') => `${BASE}/api/veto-board?session=${tournamentId}${extra}`;
    const boardGet = async (extra = '') => (await (await fetch(board(extra), { headers: { Cookie: cookie } })).json());
    const boardPost = async (body, extra = '') => {
      const response = await fetch(board(extra), { method: 'POST', headers: H, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json().catch(() => null) };
    };

    let b = await boardPost({ action: 'load', id: veto.id }, '&bus=preview');
    eq('57 a finished veto loads onto the board', b.status, 200);
    eq('58 ...carrying every step', b.body.state.rows.length, 7);
    ok('59 ...and revealing none of them', b.body.state.revealed.every((flag) => flag === false), JSON.stringify(b.body.state.revealed));

    /*
     * The MAP is in the state even while it is hidden - the page is what does
     * not paint it. Worth stating out loud: anyone holding the session key can
     * read an unrevealed map. That is the production, not the audience, and the
     * suspense this feature creates is for the audience.
     */
    ok('60 an unrevealed step still carries its map in the state', Boolean(b.body.state.rows[0].map), JSON.stringify(b.body.state.rows[0]));

    b = await boardPost({ action: 'reveal', at: 2, on: true }, '&bus=preview');
    eq('61 one step can be revealed', b.body.state.revealed.map((f) => (f ? '1' : '0')).join(''), '0010000');

    /*
     * OUT OF ORDER, which is the whole reason it is a set rather than a count.
     * A veto read out over comms arrives in whatever order people speak.
     */
    b = await boardPost({ action: 'reveal', at: 6, on: true }, '&bus=preview');
    eq('62 ...and another, out of order', b.body.state.revealed.map((f) => (f ? '1' : '0')).join(''), '0010001');

    b = await boardPost({ action: 'reveal', at: 2, on: false }, '&bus=preview');
    eq('63 ...and taken back one at a time', b.body.state.revealed.map((f) => (f ? '1' : '0')).join(''), '0000001');

    b = await boardPost({ action: 'reveal', all: true }, '&bus=preview');
    ok('64 all at once', b.body.state.revealed.every(Boolean));
    b = await boardPost({ action: 'reveal', all: false }, '&bus=preview');
    ok('65 ...and none at once', b.body.state.revealed.every((flag) => !flag));

    b = await boardPost({ action: 'reveal', at: 99, on: true }, '&bus=preview');
    eq('66 a step that does not exist is refused', b.status, 400);
    b = await boardPost({ action: 'reveal', at: 'three', on: true }, '&bus=preview');
    eq('67 ...and so is one that is not a number', b.status, 400);

    /*
     * A reload with MORE steps must not leave the new ones inheriting a flag.
     * The array is sized from the rows every time it is sanitised, so this is
     * the property that makes reloading a longer board safe.
     */
    await boardPost({ action: 'reveal', all: true }, '&bus=preview');
    const bo5 = await post('/api/veto', {
      action: 'create',
      veto: { name: 'Bo5', format: 'bo5', a: { name: 'A' }, b: { name: 'B' } },
    });
    const longer = bo5.body.veto.vetoes.find((entry) => entry.format === 'bo5');
    b = await boardPost({ action: 'load', id: longer.id }, '&bus=preview');
    eq('68 a reloaded board sizes its flags to the new rows', b.body.state.revealed.length, b.body.state.rows.length);
    ok('69 ...and reveals none of them', b.body.state.revealed.every((flag) => !flag), JSON.stringify(b.body.state.revealed));

    /*
     * AND THE OTHER HALF, which is the one the fix introduced.
     *
     * Reloading the SAME veto is the ordinary "they have banned another one,
     * catch up" press, and it must KEEP what has been revealed - wiping it
     * would make the operator walk the board out again from the start, live.
     * Only a different veto starts hidden.
     */
    await boardPost({ action: 'reveal', at: 0, on: true }, '&bus=preview');
    await boardPost({ action: 'reveal', at: 1, on: true }, '&bus=preview');
    b = await boardPost({ action: 'load', id: longer.id }, '&bus=preview');
    eq(
      '70 reloading the SAME veto keeps what is revealed',
      b.body.state.revealed.map((f) => (f ? '1' : '0')).join('').slice(0, 2),
      '11',
    );

    const keyed = await fetch(`${BASE}/api/veto-board?key=${encodeURIComponent(key)}`);
    eq('71 a key may read the board, so OBS works', keyed.status, 200);
  }

  // ---------------------------------------------------------------- the log ---
  ok('54 a captain\'s ban is logged', /veto/.test(log) && /ban/.test(log), 'no audit line for a veto answer');
  ok('55 no token reached the log', !log.includes(tokens.referee) && !log.includes(linkedTokens.a), 'TOKEN LEAKED');
  ok('56 ...not even in a URL', !/[?&]k=[A-Za-z0-9_-]{20}/.test(log), 'TOKEN LEAKED IN A URL');
} catch (error) {
  fail += 1;
  console.log('THREW', error.stack);
  console.log(log.slice(-1800));
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
