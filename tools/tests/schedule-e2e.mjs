/**
 * The schedule over the real server: who may read one, who may change one, and
 * that a key reaches neither.
 *
 * Port 8178. 8177 is player-verify.
 *
 *   node tools/tests/schedule-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8178;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-sched-e2e-'));

let passed = 0;
let failed = 0;
const ok = (name, condition, detail = '') => {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const env = {
  ...process.env,
  PORT: String(PORT),
  STATE_DIR: STATE,
  ADMIN_USERNAME: 'boss',
  ADMIN_PASSWORD: 'a-long-enough-password',
  TRACKER_ENABLED: 'false',
  HENRIK_API_KEY: '',
  RIOT_API_KEY: '',
  RIOT_ACCOUNT_KEY: '',
};

let server = spawn(process.execPath, ['server.js'], { cwd: PROJECT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
const watch = (child) => {
  child.stdout.on('data', (c) => (log += c));
  child.stderr.on('data', (c) => (log += c));
};
watch(server);

const ready = async () => {
  for (let i = 0; i < 80; i += 1) {
    try {
      await fetch(`${BASE}/api/auth/state`);
      return true;
    } catch {
      await wait(250);
    }
  }
  return false;
};

function agent() {
  let cookie = '';
  return async (p, options = {}) => {
    const response = await fetch(`${BASE}${p}`, {
      ...options,
      headers: { ...(options.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) },
    });
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const pair = line.split(';')[0];
      if (pair.startsWith('rl_session=')) cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: response.status, text, json };
  };
}

const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

try {
  if (!(await ready())) throw new Error(`server never came up:\n${log}`);

  const boss = agent();
  const view = agent();
  await boss('/api/auth/login', json({ username: 'boss', password: 'a-long-enough-password' }));
  await boss('/api/admin/users', json({ action: 'create', username: 'watcher', password: 'another-long-password' }));
  const watcherId = (await boss('/api/admin/users')).json.users.find((u) => u.username === 'watcher').id;
  await view('/api/auth/login', json({ username: 'watcher', password: 'another-long-password' }));

  const cup = (await boss('/api/tournaments', json({ action: 'create', name: 'Summer Cup' }))).json.tournament;
  const other = (await boss('/api/tournaments', json({ action: 'create', name: 'Winter Cup' }))).json.tournament;
  await boss('/api/tournaments', json({ action: 'member', id: cup.id, userId: watcherId, level: 'viewer' }));

  const at = (id) => (p) => `${p}${p.includes('?') ? '&' : '?'}session=${id}`;
  // The key is a production's. Read once, so a negative assertion below cannot
  // quietly search for the string "undefined".
  const cupKey = cup.productions[0].sessionKey;
  ok('0. the tournament minted a real key', /^[0-9a-f-]{36}$/.test(cupKey ?? ''), cupKey);
  const here = at(cup.id);
  const there = at(other.id);

  // ------------------------------------------------------------ the shape ---

  let r = await boss(here('/api/schedule'));
  ok('1. a schedule is there from the start', r.status === 200, r.text.slice(0, 120));
  ok('2. ...and it is empty', r.json.schedule.stages.length === 0 && r.json.schedule.fixtures.length === 0);
  ok('3. ...and carries its version', r.json.schedule.version === 1);

  r = await boss(here('/api/schedule'), json({ action: 'stage.save', stage: { name: 'Group A', kind: 'roundrobin', bestOf: 3 } }));
  ok('4. an editor can add a stage', r.status === 200, r.text.slice(0, 160));
  ok('5. ...and its id is a slug', r.json.schedule.stages[0]?.id === 'group-a', JSON.stringify(r.json.schedule.stages));

  r = await boss(
    here('/api/schedule'),
    json({
      action: 'generate',
      stageId: 'group-a',
      teams: [{ name: 'Alpha', teamId: 'a' }, { name: 'Bravo', teamId: 'b' }, { name: 'Charlie', teamId: 'c' }, { name: 'Delta', teamId: 'd' }],
    }),
  );
  ok('6. a round robin generates every pairing', r.json.schedule?.fixtures?.length === 6, r.text.slice(0, 200));

  // Generation ADDS. A button that silently discarded a half-recorded group
  // would be the worst kind of convenience.
  r = await boss(here('/api/schedule'), json({ action: 'generate', stageId: 'group-a', teams: [{ name: 'Alpha', teamId: 'a' }, { name: 'Bravo', teamId: 'b' }] }));
  ok('7. generating again adds rather than replacing', r.json.schedule.fixtures.length === 7, String(r.json.schedule?.fixtures?.length));

  r = await boss(here('/api/schedule'), json({ action: 'generate', stageId: 'nope', teams: [{ name: 'a' }, { name: 'b' }] }));
  ok('8. generating into a stage that does not exist is refused', r.status === 400, String(r.status));

  r = await boss(here('/api/schedule'), json({ action: 'stage.remove', id: 'group-a' }));
  ok('9. a stage holding fixtures cannot be removed', r.status === 400, r.text.slice(0, 160));
  ok('10. ...and it says how many', /7 fixtures/.test(r.json?.error?.message ?? ''), r.json?.error?.message);

  // ---------------------------------------------------------- the results ---

  const first = (await boss(here('/api/schedule'))).json.schedule.fixtures[0];
  r = await boss(here('/api/schedule'), json({ action: 'result', id: first.id, maps: [{ name: 'Ascent', left: 13, right: 8 }, { name: 'Bind', left: 13, right: 4 }] }));
  ok('11. a result is recorded', r.status === 200, r.text.slice(0, 160));

  r = await boss(here('/api/schedule'), json({ action: 'result', id: first.id, maps: Array.from({ length: 4 }, () => ({ name: 'x', left: 13, right: 0 })) }));
  ok('12. more maps than the series holds is refused', r.status === 400, String(r.status));
  ok('13. ...and says what the series length is', /best of 3/i.test(r.json?.error?.message ?? ''), r.json?.error?.message);

  r = await boss(here('/api/schedule'), json({ action: 'fixture.remove', id: 'nothing' }));
  ok('14. removing a fixture that is not there is a no-op, not a crash', r.status === 200, r.text.slice(0, 120));

  r = await boss(here('/api/schedule'), json({ action: 'wat' }));
  ok('15. an unknown action is a 400', r.status === 400, String(r.status));
  ok('16. ...and lists the real ones', /stage\.save/.test(r.json?.error?.hint ?? ''), r.json?.error?.hint);

  // --------------------------------------------------------- the team gate ---

  await boss(here('/api/teams'), json({ action: 'save', team: { name: 'Alpha', shortName: 'ALP' } }));
  const alpha = (await boss(here('/api/teams'))).json.teams.find((t) => t.name === 'Alpha');
  await boss(here('/api/schedule'), json({ action: 'fixture.save', fixture: { id: 'booked', stageId: 'group-a', left: { name: 'Alpha', teamId: alpha.id } } }));

  r = await boss(here('/api/teams'), json({ action: 'delete', id: alpha.id }));
  ok('17. a team in a fixture cannot be deleted', r.status === 409, `${r.status} ${r.text.slice(0, 120)}`);
  ok('18. ...and the fixture is named, not just counted', /Alpha/.test(r.json?.error?.hint ?? ''), r.json?.error?.hint);

  await boss(here('/api/schedule'), json({ action: 'fixture.remove', id: 'booked' }));
  r = await boss(here('/api/teams'), json({ action: 'delete', id: alpha.id }));
  ok('19. ...and it can once nothing books it', r.status === 200, r.text.slice(0, 120));

  // ------------------------------------------------------------- the gate ---

  r = await view(here('/api/schedule'));
  ok('20. a viewer can read the schedule', r.status === 200, String(r.status));

  r = await view(here('/api/schedule'), json({ action: 'stage.save', stage: { name: 'Mine' } }));
  ok('21. a viewer cannot change it', r.status === 403, String(r.status));

  r = await view(there('/api/schedule'));
  ok('22. a non-member cannot read another tournament\'s schedule', r.status === 403, String(r.status));

  /*
   * The KEYED_ROUTES question, answered in assertions rather than in a comment,
   * and asked of BOTH verbs.
   *
   * Write is obvious. Read is the one worth pinning: the session key is typed
   * into OBS configuration and read out over screen shares, and a draw that has
   * not been announced must not leak out of a URL sitting in somebody's stream
   * settings.
   *
   * This asserts the LIST, not a check in the handler - there is deliberately
   * none. Adding '/api/schedule' to KEYED_ROUTES turns 23 and 24 red.
   */
  const keyed = await fetch(`${BASE}/api/schedule?key=${encodeURIComponent(cupKey)}`);
  ok('23. a session key cannot READ a schedule', keyed.status === 403, String(keyed.status));
  const keyedWrite = await fetch(`${BASE}/api/schedule?key=${encodeURIComponent(cupKey)}`, json({ action: 'stage.save', stage: { name: 'x' } }));
  ok('24. ...nor write one', keyedWrite.status === 403, String(keyedWrite.status));

  // ------------------------------------------------- isolation and restart ---

  r = await boss(there('/api/schedule'));
  ok('25. the other tournament has its own, empty schedule', r.json.schedule.fixtures.length === 0, String(r.json.schedule?.fixtures?.length));

  r = await boss('/api/tournaments', json({ action: 'export', id: cup.id }));
  ok('26. the export carries the schedule', r.json.export?.schedule?.fixtures?.length === 7, String(r.json.export?.schedule?.fixtures?.length));

  const before = (await boss(here('/api/schedule'))).json.schedule;

  server.kill();
  await wait(700);
  server = spawn(process.execPath, ['server.js'], { cwd: PROJECT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  watch(server);
  if (!(await ready())) throw new Error('server did not come back up');

  const back = agent();
  await back('/api/auth/login', json({ username: 'boss', password: 'a-long-enough-password' }));
  const after = (await back(here('/api/schedule'))).json.schedule;
  ok('27. the schedule survives a restart', after.fixtures.length === before.fixtures.length, `${before.fixtures.length} -> ${after.fixtures?.length}`);
  ok('28. ...with its results intact', after.fixtures.find((f) => f.id === before.fixtures[0].id)?.maps.length === 2);
  ok('29. nothing was logged as unsaved', !log.includes('schedule not saved'));
} catch (error) {
  failed += 1;
  console.log(`  FAIL  threw - ${error.message}`);
} finally {
  server.kill();
  await wait(300);
  rmSync(STATE, { recursive: true, force: true });
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
