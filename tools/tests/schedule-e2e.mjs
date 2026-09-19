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


  // ======================================================== the templates =====
  /*
   * The SHAPE is `buildTemplate`, a pure function asserted in schedule-model
   * with no server at all. What is here is the half that needs a store: minting
   * an id per match and swapping every `ref` for one, so that what reaches disk
   * is a document whose edges name real fixtures.
   *
   * That swap is the part that can silently half-work. A ref resolved to
   * nothing leaves a dangling edge, `apply` refuses the WHOLE write, and the
   * message an operator gets is about an edge rather than about the template
   * they just pressed.
   */
  await boss(here('/api/schedule'), json({ action: 'stage.save', stage: { name: 'Main event', kind: 'bracket', bestOf: 3 } }));
  const eight = Array.from({ length: 8 }, (_, i) => ({ name: `Seed ${i + 1}` }));

  r = await boss(here('/api/schedule'), json({ action: 'template.apply', stageId: 'main-event', template: 'double', teams: eight }));
  ok('t1. a template lays a stage out', r.status === 200, r.text.slice(0, 200));

  let main = (await boss(here('/api/schedule'))).json.schedule.fixtures.filter((f) => f.stageId === 'main-event');
  ok('t2. ...as the whole draw, not one round', main.length === 14, String(main.length));
  ok('t3. ...across both halves and a grand final', new Set(main.map((f) => f.bracket)).size === 3, JSON.stringify([...new Set(main.map((f) => f.bracket))]));

  /*
   * EVERY EDGE NAMES A REAL FIXTURE. This is the assertion the ref-to-id swap
   * exists for, and it is asked of the whole document rather than spot-checked
   * - one dangling edge is one match that never fills in, and it would be found
   * in the semi-final.
   */
  const ids = new Set(main.map((f) => f.id));
  const edges = main.flatMap((f) => [f.left?.source?.fixtureId, f.right?.source?.fixtureId].filter(Boolean));
  ok('t4. every edge names a match that exists', edges.length > 0 && edges.every((id) => ids.has(id)), JSON.stringify(edges.filter((id) => !ids.has(id))));
  ok('t5. ...and there are as many as the shape needs', edges.length === (14 - 4) * 2, String(edges.length));
  ok('t6. ...with losers wired as well as winners', main.some((f) => f.left?.source?.take === 'loser' || f.right?.source?.take === 'loser'), 'no loser edges');

  /*
   * A WINNER CARRIES ITSELF FORWARD. The whole reason to wire a bracket rather
   * than type it: a result filed in round one fills in round two with nobody
   * touching it. `propagate` does the work; this is the assertion that the
   * template gave it something to work with.
   */
  const r1 = main.filter((f) => f.round === 1 && f.bracket === 'upper').sort((a, b) => a.slot - b.slot);
  await boss(here('/api/schedule'), json({
    action: 'result',
    id: r1[0].id,
    maps: [{ name: 'Ascent', left: 13, right: 8 }, { name: 'Bind', left: 13, right: 4 }],
  }));
  main = (await boss(here('/api/schedule'))).json.schedule.fixtures.filter((f) => f.stageId === 'main-event');
  const semi = main.find((f) => f.bracket === 'upper' && f.round === 2 && f.left?.source?.fixtureId === r1[0].id);
  ok('t7. a result carries the winner into the next round', semi?.left?.name === r1[0].left.name, JSON.stringify({ want: r1[0].left.name, got: semi?.left?.name }));
  const drop = main.find((f) => f.bracket === 'lower' && (f.left?.source?.fixtureId === r1[0].id || f.right?.source?.fixtureId === r1[0].id));
  const dropped = drop?.left?.source?.fixtureId === r1[0].id ? drop?.left : drop?.right;
  ok('t8. ...and the loser into the lower bracket', dropped?.name === r1[0].right.name, JSON.stringify({ want: r1[0].right.name, got: dropped?.name }));

  /*
   * IT REPLACES, behind the same bar as deleting the stage. "Lay this out as a
   * double elimination" is a statement about the whole stage, and a template
   * folded into existing matches produces a shape that is neither.
   */
  r = await boss(here('/api/schedule'), json({ action: 'template.apply', stageId: 'main-event', template: 'single', teams: eight }));
  ok('t9. laying out over existing matches is not done on the bare ask', r.status === 400, r.text.slice(0, 200));
  ok('t10. ...and says nothing has changed', /nothing has been changed/i.test(r.json?.error?.hint ?? ''), JSON.stringify(r.json?.error));
  ok('t11. ...leaving the draw alone', (await boss(here('/api/schedule'))).json.schedule.fixtures.filter((f) => f.stageId === 'main-event').length === 14);

  r = await boss(here('/api/schedule'), json({ action: 'template.apply', stageId: 'main-event', template: 'single', teams: eight, confirm: 'Main event' }));
  ok('t12. the exact name lays it out again', r.status === 200, r.text.slice(0, 200));
  /*
   * LOGGED, like removing a stage, and for the identical reason: both destroy
   * results somebody filed, and the schedule is shared by every desk of the
   * tournament, so that line is the only answer to "who wiped the group stage".
   * The first version of this action had no log call at all.
   */
  ok('t12a. ...and says so in the log', /laid out as single, replacing 14 match/.test(log), 'no audit line for a re-layout');
  ok('t12b. ...naming who did it', /boss/.test(log.split('laid out as single')[1]?.slice(0, 200) ?? ''), 'the audit line does not say who');
  main = (await boss(here('/api/schedule'))).json.schedule.fixtures.filter((f) => f.stageId === 'main-event');
  ok('t13. ...as the new shape', main.length === 7, String(main.length));
  ok('t14. ...with nothing of the old one left', main.every((f) => f.bracket === 'upper'), JSON.stringify([...new Set(main.map((f) => f.bracket))]));

  /*
   * A ROUND ROBIN TEMPLATE CHANGES WHAT THE STAGE IS. A pool of matches on a
   * stage still marked "bracket" would draw a bracket of them.
   */
  r = await boss(here('/api/schedule'), json({
    action: 'template.apply',
    stageId: 'main-event',
    template: 'roundrobin',
    teams: eight,
    groups: 2,
    confirm: 'Main event',
  }));
  ok('t15. a round robin template applies', r.status === 200, r.text.slice(0, 200));
  const templated = (await boss(here('/api/schedule'))).json.schedule;
  const mainStage = templated.stages.find((e) => e.id === 'main-event');
  ok('t16. ...and the stage becomes a round robin', mainStage.kind === 'roundrobin', mainStage.kind);
  ok('t17. ...carrying the groups it made', mainStage.groups.map((g) => g.name).join(',') === 'Group A,Group B', JSON.stringify(mainStage.groups));
  const pooled = templated.fixtures.filter((f) => f.stageId === 'main-event');
  ok('t18. ...eight teams in two pools is twelve matches', pooled.length === 12, String(pooled.length));
  ok('t19. ...every one of them in a group', pooled.every((f) => f.group), JSON.stringify(pooled.map((f) => f.group)));

  r = await boss(here('/api/schedule'), json({ action: 'template.apply', stageId: 'main-event', template: 'nonsense', teams: eight, confirm: 'Main event' }));
  ok('t20. an unknown template is refused', r.status === 400, r.text.slice(0, 120));
  ok('t21. ...and says which there are', /single/.test(r.json?.error?.hint ?? ''), JSON.stringify(r.json?.error));
  r = await boss(here('/api/schedule'), json({ action: 'template.apply', stageId: 'main-event', template: 'single', teams: [{ name: 'Alone' }], confirm: 'Main event' }));
  ok('t22. one team is not a draw', r.status === 400, r.text.slice(0, 120));

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
  /*
   * ------------------------ A STAGE AGAIN, WITH NONE OF ITS RESULTS ---
   *
   * A season is the same shape repeated, and building the second one meant
   * laying it out from a template again and re-typing the groups, or clicking
   * through thirty matches. The SHAPE copies - format, groups, every match's
   * place in the draw, and the edges between them.
   *
   * What must NOT copy is the teams and the results, and that is the assertion
   * worth its length: standings are derived from what has been played, so a
   * copied 13-7 counts in a live table with nothing on screen saying it was
   * never played.
   */
  await boss(here('/api/schedule'), json({
    action: 'stage.save',
    stage: { id: 'season-one', name: 'Season one', kind: 'bracket', bestOf: 3 },
  }));
  await boss(here('/api/schedule'), json({
    action: 'template.apply',
    stageId: 'season-one',
    template: 'single',
    teams: [{ name: 'Alpha', teamId: 'a' }, { name: 'Bravo', teamId: 'b' }, { name: 'Charlie', teamId: 'c' }, { name: 'Delta', teamId: 'd' }],
  }));
  const seasonOne = (await boss(here('/api/schedule'))).json.schedule.fixtures.filter((f) => f.stageId === 'season-one');
  ok('25d1. the stage to copy has a wired draw', seasonOne.length === 3 && seasonOne.some((f) => f.left?.source || f.right?.source), String(seasonOne.length));

  // File a result, so the copy has something it could wrongly bring across.
  await boss(here('/api/schedule'), json({
    action: 'fixture.save',
    fixture: { ...seasonOne.find((f) => f.round === 1), maps: [{ map: 'Ascent', left: 13, right: 4 }, { map: 'Bind', left: 13, right: 8 }] },
  }));

  r = await boss(here('/api/schedule'), json({ action: 'stage.duplicate', id: 'season-one', name: 'Season two' }));
  const copy = r.json.schedule.stages.find((entry) => entry.name === 'Season two');
  const copied = r.json.schedule.fixtures.filter((f) => f.stageId === copy?.id);
  ok('25d2. duplicating makes a new stage', Boolean(copy) && copy.id !== 'season-one', JSON.stringify(copy));
  ok('25d3. ...with the same format and series', copy.kind === 'bracket' && copy.bestOf === 3, JSON.stringify(copy));
  ok('25d4. ...and the same number of matches', copied.length === seasonOne.length, `${copied.length} vs ${seasonOne.length}`);
  ok(
    '25d5. ...in the same places in the draw',
    JSON.stringify(copied.map((f) => [f.bracket, f.round, f.slot]).sort()) ===
      JSON.stringify(seasonOne.map((f) => [f.bracket, f.round, f.slot]).sort()),
    JSON.stringify(copied.map((f) => [f.bracket, f.round, f.slot])),
  );

  ok(
    '25d6. NO TEAMS come across',
    copied.every((f) => !f.left?.name && !f.right?.name && !f.left?.teamId && !f.right?.teamId),
    JSON.stringify(copied.map((f) => [f.left?.name, f.right?.name])),
  );
  /*
   * `winner: 'auto'` is the ABSENCE of an override, not a result - it is what
   * `emptyFixture` starts at and means "work it out from the maps". Asserting
   * `!f.winner` here was wrong about the model rather than about the code, and
   * it took the failure detail naming the value to see it.
   */
  ok(
    '25d7. AND NO RESULTS, because a copied score counts in a live table',
    copied.every((f) => (f.maps ?? []).length === 0 && (f.winner ?? 'auto') === 'auto'),
    JSON.stringify(copied.map((f) => ({ maps: f.maps, winner: f.winner }))),
  );

  /*
   * The edges ARE the shape - a bracket without them is thirty unconnected
   * matches, which is the hand-wiring this exists to avoid. They must point
   * INSIDE the copy: an edge left pointing at the original would fill the new
   * season's first round from last season's results.
   */
  const copyIds = new Set(copied.map((f) => f.id));
  const copiedEdges = copied.flatMap((f) => [f.left?.source, f.right?.source].filter(Boolean));
  ok('25d8. the edges come across', copiedEdges.length > 0, String(copiedEdges.length));
  ok(
    '25d9. ...pointing inside the copy, never back at the original',
    copiedEdges.every((e) => copyIds.has(e.fixtureId)),
    JSON.stringify(copiedEdges),
  );

  const stillThere = r.json.schedule.fixtures.filter((f) => f.stageId === 'season-one');
  ok('25d10. the stage copied FROM is untouched', stillThere.length === seasonOne.length && stillThere.some((f) => (f.maps ?? []).length === 2), String(stillThere.length));

  // A name that slugs onto an existing id must not REPLACE it - the same rule
  // stage.save applies, and here getting it wrong would delete the original.
  r = await boss(here('/api/schedule'), json({ action: 'stage.duplicate', id: 'season-one', name: 'Season two' }));
  const twos = r.json.schedule.stages.filter((entry) => entry.name === 'Season two');
  ok('25d11. a colliding name makes a second stage rather than replacing', twos.length === 2, JSON.stringify(twos.map((e) => e.id)));

  r = await boss(here('/api/schedule'), json({ action: 'stage.duplicate', id: 'nope', name: 'x' }));
  ok('25d12. copying a stage that does not exist is refused', r.status === 400, String(r.status));

  for (const gone of ['season-one', ...twos.map((e) => e.id)]) {
    await boss(here('/api/schedule'), json({ action: 'stage.remove', id: gone, confirm: gone === 'season-one' ? 'Season one' : 'Season two' }));
  }

  /*
   * ------------------------------------- THE MATCHES IN NO GROUP, swept up ---
   *
   * Removing a group leaves its matches behind on purpose - the reference is
   * cleared and they land in a visible "Not in a group" bucket, because a match
   * belonging to no table an operator can see reads as matches having vanished
   * from the draw. That is right, and it left the bucket a dead end: nothing
   * could empty it but deleting the matches one at a time.
   *
   * Two answers, because there are two honest ones, and both run here on a
   * stage of their own so nothing above moves.
   */
  await boss(here('/api/schedule'), json({
    action: 'stage.save',
    stage: { id: 'loose-pool', name: 'Loose pool', kind: 'roundrobin', bestOf: 3, groups: [{ id: 'pool-a', name: 'Pool A' }] },
  }));
  await boss(here('/api/schedule'), json({
    action: 'generate',
    stageId: 'loose-pool',
    group: 'pool-a',
    teams: [{ name: 'Echo', teamId: 'e' }, { name: 'Foxtrot', teamId: 'f' }, { name: 'Golf', teamId: 'g' }],
  }));
  const looseIn = (doc) => doc.schedule.fixtures.filter((f) => f.stageId === 'loose-pool');

  r = await boss(here('/api/schedule'), json({ action: 'group.sweep', stageId: 'loose-pool', group: '' }));
  ok('25s1. a stage whose matches are all in a group has nothing to sweep', r.status === 400, r.text.slice(0, 140));

  // Drop the group. Its matches stay, which is the behaviour this whole block
  // exists because of.
  r = await boss(here('/api/schedule'), json({
    action: 'stage.save',
    stage: { id: 'loose-pool', name: 'Loose pool', kind: 'roundrobin', bestOf: 3, groups: [] },
  }));
  ok('25s2. removing a group leaves its matches behind', looseIn(r.json).length === 3, String(looseIn(r.json).length));

  r = await boss(here('/api/schedule'), json({ action: 'group.sweep', stageId: 'loose-pool', group: 'not-a-group' }));
  ok('25s3. moving them into a group that does not exist is refused', r.status === 400, r.text.slice(0, 140));

  // MOVE. A pool renamed into existence after the matches were made wants them
  // carried across, not deleted - so the destructive answer is not the only one.
  await boss(here('/api/schedule'), json({
    action: 'stage.save',
    stage: { id: 'loose-pool', name: 'Loose pool', kind: 'roundrobin', bestOf: 3, groups: [{ id: 'pool-b', name: 'Pool B' }] },
  }));
  r = await boss(here('/api/schedule'), json({ action: 'group.sweep', stageId: 'loose-pool', group: 'pool-b' }));
  ok(
    '25s4. they can be moved into a group instead of deleted',
    looseIn(r.json).length === 3 && looseIn(r.json).every((f) => f.group === 'pool-b'),
    JSON.stringify(looseIn(r.json).map((f) => f.group)),
  );

  /*
   * DELETE, and the bar rising with what it would take. An unplayed match is
   * nothing filed, so nothing is asked; a filed result wants the stage name
   * typed back, which is the rule `stage.remove` already follows by asking
   * nothing at all of an empty stage.
   */
  await boss(here('/api/schedule'), json({
    action: 'stage.save',
    stage: { id: 'loose-pool', name: 'Loose pool', kind: 'roundrobin', bestOf: 3, groups: [] },
  }));
  r = await boss(here('/api/schedule'), json({ action: 'group.sweep', stageId: 'loose-pool', group: '' }));
  ok('25s5. unplayed ones are deleted with no name typed', looseIn(r.json).length === 0, String(looseIn(r.json).length));

  // Again, with a result filed on one of them.
  await boss(here('/api/schedule'), json({
    action: 'stage.save',
    stage: { id: 'loose-pool', name: 'Loose pool', kind: 'roundrobin', bestOf: 3, groups: [{ id: 'pool-c', name: 'Pool C' }] },
  }));
  await boss(here('/api/schedule'), json({
    action: 'generate',
    stageId: 'loose-pool',
    group: 'pool-c',
    teams: [{ name: 'Echo', teamId: 'e' }, { name: 'Foxtrot', teamId: 'f' }],
  }));
  const played = looseIn((await boss(here('/api/schedule'))).json)[0];
  await boss(here('/api/schedule'), json({
    action: 'fixture.save',
    fixture: { ...played, maps: [{ map: 'Ascent', left: 13, right: 7 }, { map: 'Bind', left: 13, right: 9 }] },
  }));
  await boss(here('/api/schedule'), json({
    action: 'stage.save',
    stage: { id: 'loose-pool', name: 'Loose pool', kind: 'roundrobin', bestOf: 3, groups: [] },
  }));

  r = await boss(here('/api/schedule'), json({ action: 'group.sweep', stageId: 'loose-pool', group: '' }));
  ok('25s6. a filed result is not deleted on the bare ask', r.status === 400, r.text.slice(0, 160));
  ok('25s7. ...and it says how many have one', /1 of those/.test(r.json?.error?.message ?? ''), r.json?.error?.message);
  ok('25s8. ...and that nothing has happened yet', /nothing has been deleted/i.test(r.json?.error?.hint ?? ''), JSON.stringify(r.json?.error));

  r = await boss(here('/api/schedule'), json({ action: 'group.sweep', stageId: 'loose-pool', group: '', confirm: 'Loose poo' }));
  ok('25s9. a name that is nearly right is still refused', r.status === 400, r.text.slice(0, 120));

  r = await boss(here('/api/schedule'), json({ action: 'group.sweep', stageId: 'loose-pool', group: '', confirm: 'Loose pool' }));
  ok('25s10. ...and the exact name deletes them', looseIn(r.json).length === 0, String(looseIn(r.json).length));
  ok('25s11. destroying a filed result is logged at warn', /ungrouped match/.test(log) && /WARN/.test(log), 'no warn line');

  await boss(here('/api/schedule'), json({ action: 'stage.remove', id: 'loose-pool', confirm: 'Loose pool' }));

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
