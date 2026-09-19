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
  /*
   * REMOVING A STAGE THAT HOLDS MATCHES.
   *
   * It used to be refused outright - "move or remove them first" - which is
   * right about the danger and wrong about the remedy: a group stage laid out
   * by mistake was sixteen deletions before the stage itself would go, and an
   * operator doing that at speed is likelier to delete the wrong thing than one
   * confirmation ever was.
   *
   * So it is possible now, behind the bar this codebase already sets for
   * anything irreversible: the exact name typed back. A confirm dialog is
   * answered "yes" by reflex and a name is not.
   */
  ok('9. a stage holding matches is not removed on the bare ask', r.status === 400, r.text.slice(0, 160));
  ok('10. ...and it says how many would go', /7 match/.test(r.json?.error?.message ?? ''), r.json?.error?.message);
  ok('10a. ...and says nothing has happened yet', /nothing has been removed/i.test(r.json?.error?.hint ?? ''), JSON.stringify(r.json?.error));

  r = await boss(here('/api/schedule'), json({ action: 'stage.remove', id: 'group-a', confirm: 'group a' }));
  ok('10b. a name that is nearly right is still refused', r.status === 400, r.text.slice(0, 120));

  /*
   * The destructive half runs on a stage of its OWN, built here and thrown
   * away, so the assertions below still have Group A's seven matches to work
   * on. A suite that deletes the fixture everything after it reads is a suite
   * that reports the wrong failure.
   */
  await boss(here('/api/schedule'), json({ action: 'stage.save', stage: { name: 'Doomed', kind: 'bracket', bestOf: 3 } }));
  await boss(here('/api/schedule'), json({ action: 'fixture.save', fixture: { stageId: 'doomed', round: 1, slot: 0, bestOf: 3 } }));
  const doomedBefore = (await boss(here('/api/schedule'))).json.schedule.fixtures.filter((f) => f.stageId === 'doomed');
  ok('10c. the throwaway stage has a match in it', doomedBefore.length === 1, String(doomedBefore.length));

  r = await boss(here('/api/schedule'), json({ action: 'stage.remove', id: 'doomed', confirm: 'Doomed' }));
  ok('10d. the exact name removes it', r.status === 200, r.text.slice(0, 160));
  const afterDoom = (await boss(here('/api/schedule'))).json.schedule;
  ok('10e. ...and the stage is gone', !afterDoom.stages.some((entry) => entry.id === 'doomed'), JSON.stringify(afterDoom.stages.map((x) => x.id)));
  ok('10f. ...and its matches went with it', !afterDoom.fixtures.some((f) => f.stageId === 'doomed'), JSON.stringify(afterDoom.fixtures.map((f) => f.stageId)));
  ok('10g. ...and every other stage is untouched', afterDoom.fixtures.filter((f) => f.stageId === 'group-a').length === 7, String(afterDoom.fixtures.filter((f) => f.stageId === 'group-a').length));

  /*
   * An EMPTY stage needs no name typed at all. There is nothing to lose, and
   * asking anyway would train the answer out of people for the case that
   * matters - which is the one directly above.
   */
  await boss(here('/api/schedule'), json({ action: 'stage.save', stage: { name: 'Empty', kind: 'bracket', bestOf: 3 } }));
  r = await boss(here('/api/schedule'), json({ action: 'stage.remove', id: 'empty' }));
  ok('10h. an empty stage goes with no confirmation', r.status === 200, r.text.slice(0, 160));
  ok('10i. ...and is really gone', !(await boss(here('/api/schedule'))).json.schedule.stages.some((e) => e.id === 'empty'));


  // =============================================== groups inside a stage =====
  /*
   * A group is a DIVISION INSIDE ONE STAGE. The model half - what a group is,
   * and one table per group - is in schedule-model, with no server and no port.
   * What is here is the half only the route can answer: that generation can be
   * pointed at ONE group, which is the entire reason groups are worth having,
   * and that removing one does not lose the matches that were in it.
   */
  await boss(here('/api/schedule'), json({
    action: 'stage.save',
    stage: { name: 'Pools', kind: 'roundrobin', bestOf: 3, groups: [{ name: 'Group A' }, { name: 'Group B' }] },
  }));
  const pools = (await boss(here('/api/schedule'))).json.schedule.stages.find((e) => e.id === 'pools');
  ok('g1. a stage saves with its groups', pools?.groups?.length === 2, JSON.stringify(pools?.groups));
  ok('g2. ...ids slugged from the names', pools.groups.map((g) => g.id).join(',') === 'group-a,group-b', JSON.stringify(pools.groups));

  /*
   * SIXTEEN TEAMS IN FOUR POOLS IS FOUR ROUND ROBINS OF SIX rather than one of
   * a hundred and twenty. Generating into a group is what makes that true, so
   * it is the assertion the whole feature rests on.
   */
  const four = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((name) => ({ name }));
  r = await boss(here('/api/schedule'), json({ action: 'generate', stageId: 'pools', group: 'group-a', teams: four }));
  ok('g3. a group can be laid out on its own', r.status === 200, r.text.slice(0, 160));

  let inPools = (await boss(here('/api/schedule'))).json.schedule.fixtures.filter((f) => f.stageId === 'pools');
  ok('g4. ...producing a round robin of four', inPools.length === 6, String(inPools.length));
  ok('g5. ...every match stamped with the group', inPools.every((f) => f.group === 'group-a'), JSON.stringify(inPools.map((f) => f.group)));

  r = await boss(here('/api/schedule'), json({ action: 'generate', stageId: 'pools', group: 'group-b', teams: [{ name: 'Echo' }, { name: 'Foxtrot' }] }));
  ok('g6. a second group lays out beside the first', r.status === 200, r.text.slice(0, 160));
  inPools = (await boss(here('/api/schedule'))).json.schedule.fixtures.filter((f) => f.stageId === 'pools');
  ok('g7. ...adding to the stage', inPools.length === 7, String(inPools.length));
  ok('g8. ...without touching the other group', inPools.filter((f) => f.group === 'group-a').length === 6, String(inPools.filter((f) => f.group === 'group-a').length));

  /*
   * A group id nobody has is REFUSED rather than written. A typo would produce
   * a pool of matches in a table no operator can see, which is the exact
   * failure the sweep below exists to prevent from the other direction.
   */
  r = await boss(here('/api/schedule'), json({ action: 'generate', stageId: 'pools', group: 'group-z', teams: four }));
  ok('g9. generating into a group that does not exist is refused', r.status === 400, r.text.slice(0, 160));
  ok('g10. ...and says which groups there are', /Group A/.test(r.json?.error?.hint ?? ''), JSON.stringify(r.json?.error));

  /*
   * REMOVING A GROUP DOES NOT REMOVE ITS MATCHES. Nothing breaks if the
   * reference is left dangling - an unknown group reads as ungrouped - but the
   * match then belongs to no table an operator can see and no group they can
   * pick, which reads as matches having vanished from the draw. Clearing it in
   * the same write puts them in the visible leftover bucket.
   */
  await boss(here('/api/schedule'), json({
    action: 'stage.save',
    stage: { id: 'pools', name: 'Pools', kind: 'roundrobin', bestOf: 3, groups: [{ id: 'group-a', name: 'Group A' }] },
  }));
  const afterDrop = (await boss(here('/api/schedule'))).json.schedule.fixtures.filter((f) => f.stageId === 'pools');
  ok('g11. removing a group keeps its matches', afterDrop.length === 7, String(afterDrop.length));
  ok('g12. ...and un-groups them rather than leaving a dead pointer', afterDrop.filter((f) => f.group === 'group-b').length === 0, JSON.stringify(afterDrop.map((f) => f.group)));
  ok('g13. ...while the group that stayed is untouched', afterDrop.filter((f) => f.group === 'group-a').length === 6, String(afterDrop.filter((f) => f.group === 'group-a').length));

  // Renaming a group keeps its id, so its matches stay in it. That is the whole
  // reason a group is `{ id, name }` rather than a bare name.
  await boss(here('/api/schedule'), json({
    action: 'stage.save',
    stage: { id: 'pools', name: 'Pools', kind: 'roundrobin', bestOf: 3, groups: [{ id: 'group-a', name: 'Alpha Pool' }] },
  }));
  const renamed = (await boss(here('/api/schedule'))).json.schedule;
  ok('g14. renaming a group keeps its matches in it', renamed.fixtures.filter((f) => f.group === 'group-a').length === 6, 'matches were orphaned by a rename');
  ok('g15. ...under the new name', renamed.stages.find((e) => e.id === 'pools').groups[0].name === 'Alpha Pool');


  // ==================================================== a round at a time =====
  /*
   * You could not make one. "Add fixture" adds a single match at the LAST round
   * number that already exists, so a bracket could never grow past round one
   * from the dashboard: the only way to a semi-final was to generate the whole
   * stage from the team library and accept the draw, or hand-edit
   * schedule.json.
   */
  await boss(here('/api/schedule'), json({ action: 'stage.save', stage: { name: 'Knockout', kind: 'bracket', bestOf: 3 } }));

  r = await boss(here('/api/schedule'), json({ action: 'round.add', stageId: 'knockout', count: 4 }));
  ok('r1. a round can be added', r.status === 200, r.text.slice(0, 160));
  let ko = (await boss(here('/api/schedule'))).json.schedule.fixtures.filter((f) => f.stageId === 'knockout');
  ok('r2. ...with the matches asked for', ko.length === 4, String(ko.length));
  ok('r3. ...all in round one, because there was nothing before it', ko.every((f) => f.round === 1), JSON.stringify(ko.map((f) => f.round)));
  ok('r4. ...in slots 0 upwards, which is what the bracket draws from', ko.map((f) => f.slot).sort().join(',') === '0,1,2,3', JSON.stringify(ko.map((f) => f.slot)));
  ok('r5. ...and EMPTY, because who plays in it is decided by the round before', ko.every((f) => !f.left.name && !f.right.name), JSON.stringify(ko.map((f) => [f.left.name, f.right.name])));
  ok('r6. ...taking the stage default series', ko.every((f) => f.bestOf === 3), JSON.stringify(ko.map((f) => f.bestOf)));

  /*
   * THE NUMBER IS DERIVED, not asked for. An operator adding a round means "the
   * one after this", and a number they have to work out is a number they can
   * get wrong - a match at round 7 of a 3-round bracket draws a column of empty
   * space and reads as a bug in the layout.
   */
  await boss(here('/api/schedule'), json({ action: 'round.add', stageId: 'knockout', count: 2 }));
  await boss(here('/api/schedule'), json({ action: 'round.add', stageId: 'knockout', count: 1 }));
  ko = (await boss(here('/api/schedule'))).json.schedule.fixtures.filter((f) => f.stageId === 'knockout');
  ok('r7. the next round follows the last one', ko.filter((f) => f.round === 2).length === 2, JSON.stringify(ko.map((f) => f.round)));
  ok('r8. ...and the one after that', ko.filter((f) => f.round === 3).length === 1, JSON.stringify(ko.map((f) => f.round)));
  ok('r9. ...building a 4-2-1 bracket from nothing', ko.length === 7, String(ko.length));

  /*
   * PER GROUP, because a round belongs to a pool. Counting the stage as a whole
   * would put Group B's first round at round two just because Group A already
   * had one, and the two pools would never line up again.
   */
  await boss(here('/api/schedule'), json({
    action: 'stage.save',
    stage: { name: 'Twin pools', kind: 'roundrobin', bestOf: 3, groups: [{ name: 'Left pool' }, { name: 'Right pool' }] },
  }));
  await boss(here('/api/schedule'), json({ action: 'round.add', stageId: 'twin-pools', group: 'left-pool', count: 2 }));
  await boss(here('/api/schedule'), json({ action: 'round.add', stageId: 'twin-pools', group: 'left-pool', count: 2 }));
  await boss(here('/api/schedule'), json({ action: 'round.add', stageId: 'twin-pools', group: 'right-pool', count: 2 }));
  const twin = (await boss(here('/api/schedule'))).json.schedule.fixtures.filter((f) => f.stageId === 'twin-pools');
  ok('r10. a round counts within its own group', twin.filter((f) => f.group === 'left-pool' && f.round === 2).length === 2, JSON.stringify(twin.map((f) => [f.group, f.round])));
  ok(
    "r11. ...so the other pool's first round is still round one",
    twin.filter((f) => f.group === 'right-pool').every((f) => f.round === 1),
    JSON.stringify(twin.filter((f) => f.group === 'right-pool').map((f) => f.round)),
  );

  r = await boss(here('/api/schedule'), json({ action: 'round.add', stageId: 'knockout', count: 0 }));
  ok('r12. a round of nothing is refused', r.status === 400, r.text.slice(0, 120));
  r = await boss(here('/api/schedule'), json({ action: 'round.add', stageId: 'knockout', count: 999 }));
  ok('r13. ...and so is an absurd one', r.status === 400, r.text.slice(0, 120));
  r = await boss(here('/api/schedule'), json({ action: 'round.add', stageId: 'nope', count: 2 }));
  ok('r14. a stage that does not exist is refused', r.status === 400, r.text.slice(0, 120));
  r = await boss(here('/api/schedule'), json({ action: 'round.add', stageId: 'twin-pools', group: 'nope', count: 2 }));
  ok('r15. ...and so is a group that does not', r.status === 400, r.text.slice(0, 120));

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

  /*
   * Compared against what is LIVE rather than against a literal.
   *
   * It used to assert 7, which is a count that moves every time an assertion
   * above it adds a fixture - and when it did, the failure said "the export
   * carries the schedule" about an export that was carrying the schedule
   * perfectly well. The `> 0` is the half that stops it passing vacuously when
   * both sides are empty.
   */
  const liveCount = (await boss(here('/api/schedule'))).json.schedule.fixtures.length;
  r = await boss('/api/tournaments', json({ action: 'export', id: cup.id }));
  ok('26. the export carries the schedule', liveCount > 0 && r.json.export?.schedule?.fixtures?.length === liveCount, `${r.json.export?.schedule?.fixtures?.length} exported vs ${liveCount} live`);

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
