/**
 * The schedule model, as a unit test: no server, no port, no browser.
 *
 * The `buses-test.mjs` / `alias-import-atomic.mjs` shape, and for their reason -
 * it lets the assertions be about what actually reaches disk, which is the
 * whole question for a store whose defining property is that a refused write
 * leaves no trace.
 *
 *   node tools/tests/schedule-model.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..', '..');

const schema = await import(pathToFileURL(path.join(PROJECT, 'public', 'schedule-schema.js')).href);
const { makeScheduleStore } = await import(pathToFileURL(path.join(PROJECT, 'schedule.js')).href);

const {
  fixtureDecided,
  fixtureStatus,
  fixtureWinner,
  mapsNeeded,
  bracketLayout,
  roundRobinPairs,
  sanitiseFixture,
  sanitiseSchedule,
  sanitiseStage,
  sanitiseGroups,
  stageTables,
  standings,
} = schema;

/** A finished match in a group, for the group tables at the end of this file. */
const played = (id, group, left, right, leftMaps, rightMaps) =>
  sanitiseFixture({
    id,
    stageId: 'group-stage',
    group,
    bestOf: 3,
    left: { name: left },
    right: { name: right },
    maps: [
      ...Array.from({ length: leftMaps }, () => ({ name: 'Ascent', left: 13, right: 5 })),
      ...Array.from({ length: rightMaps }, () => ({ name: 'Bind', left: 5, right: 13 })),
    ],
  });

let passed = 0;
const failures = [];
const ok = (name, condition, detail) => {
  if (condition) passed += 1;
  else failures.push(`${name}${detail === undefined ? '' : ` - got ${JSON.stringify(detail)}`}`);
};
const eq = (name, actual, expected) => ok(name, actual === expected, actual);

const DIR = mkdtempSync(path.join(tmpdir(), 'rl-sched-'));

/*
 * A distinct file per block, rather than one reused.
 *
 * `persist()` is async and nothing here awaits it, which is correct for the
 * store - it serialises its OWN writes through one chain - but it means an
 * earlier block's write can land after a later block's writeFileSync and
 * silently clobber the fixture it was about to load. That cost twenty minutes
 * once; a counter costs nothing.
 */
let fileCount = 0;
let FILE = path.join(DIR, 'schedule-0.json');
const onDisk = () => {
  try {
    return readFileSync(FILE, 'utf8');
  } catch {
    return '';
  }
};

const nextFile = () => {
  fileCount += 1;
  FILE = path.join(DIR, `schedule-${fileCount}.json`);
  return FILE;
};

const fresh = async () => {
  const store = makeScheduleStore(nextFile());
  await store.load();
  return store;
};

const stage = (over = {}) => sanitiseStage({ name: 'Playoffs', kind: 'bracket', bestOf: 3, ...over });
const team = (name) => ({ name, shortName: name.slice(0, 3).toUpperCase(), teamId: name.toLowerCase() });
const maps = (...rows) => rows.map(([left, right]) => ({ name: 'Ascent', left, right }));

// ------------------------------------------------- a refused write is no write ---

{
  const store = await fresh();
  store.apply((draft) => {
    draft.stages.push(stage());
    draft.fixtures.push(sanitiseFixture({ id: 'qf1', stageId: 'playoffs', round: 1, left: team('Sentinels'), right: team('Loud') }));
  });
  await store.flush();
  const before = onDisk();

  let threw = null;
  try {
    store.apply((draft) => {
      draft.fixtures.push(
        sanitiseFixture({ id: 'sf1', stageId: 'playoffs', round: 2, left: { source: { fixtureId: 'nope', take: 'winner' } } }),
      );
    });
  } catch (error) {
    threw = error;
  }
  ok('1 an edge naming a fixture that does not exist is refused', threw !== null);
  ok('1b ...and the message names the fixture', /does not exist/i.test(threw?.message ?? ''), threw?.message);
  await store.flush();
  eq('2 the live document is byte-identical afterwards', onDisk(), before);
  eq('2b ...and in memory too', store.document().fixtures.length, 1);

  /*
   * THE ASSERTION THAT JUSTIFIES `apply`.
   *
   * This is the alias-import bite reproduced against a new store. That import
   * mutated the live library in place and checked its cap afterwards, so a
   * refused import left the over-cap list in memory where the NEXT unrelated
   * save wrote it to disk - and because the library was then over the cap,
   * every later import was refused for ever, with nothing logged.
   */
  let later = null;
  try {
    store.apply((draft) => {
      draft.fixtures[0].note = 'an unrelated later write';
    });
  } catch (error) {
    later = error;
  }
  /*
   * Inside a try, because the interesting failure THROWS. With `apply` mutating
   * the live document instead of a clone, the refused fixture stays in it and
   * every later write re-validates the poisoned document and is refused too -
   * for ever, exactly as the alias library stayed over its cap. Left uncaught
   * that reports as a stack trace on line 115 rather than as the assertion that
   * describes it, which is how a real fault ends up looking like somebody
   * else's bug.
   */
  ok('3 an unrelated later write is not refused by the poisoned draft', later === null, later?.message);
  await store.flush();
  const after = JSON.parse(onDisk());
  eq('3b ...and it did not commit the refused fixture', after.fixtures.length, 1);
  eq('3c ...and it did commit its own change', after.fixtures[0].note, 'an unrelated later write');
}

// -------------------------------------------------------------------- cycles ---

{
  const store = await fresh();
  let threw = null;
  try {
    store.apply((draft) => {
      draft.stages.push(stage());
      draft.fixtures.push(
        sanitiseFixture({ id: 'a', stageId: 'playoffs', round: 1, left: { source: { fixtureId: 'b', take: 'winner' } } }),
        sanitiseFixture({ id: 'b', stageId: 'playoffs', round: 2, left: { source: { fixtureId: 'a', take: 'winner' } } }),
      );
    });
  } catch (error) {
    threw = error;
  }
  ok('4 a cycle is refused', threw !== null);
  ok('4b ...and says they feed each other in a loop', /loop/i.test(threw?.message ?? ''), threw?.message);

  /*
   * And the legal case that a cheaper rule would have refused. A forward-edge
   * rule ("an edge may only point at a lower round") was considered and
   * rejected: it refuses an operator laying a lower bracket out in the order
   * they actually build one. A DFS costs one pass and allows this.
   */
  const fine = await fresh();
  let ok2 = true;
  try {
    fine.apply((draft) => {
      draft.stages.push(stage());
      draft.fixtures.push(
        sanitiseFixture({ id: 'lb2', stageId: 'playoffs', round: 5, left: { source: { fixtureId: 'lb1', take: 'winner' } } }),
        sanitiseFixture({ id: 'lb1', stageId: 'playoffs', round: 1, left: team('Sentinels'), right: team('Loud') }),
      );
    });
  } catch {
    ok2 = false;
  }
  ok('5 an edge from a high round to a low one is legal', ok2);
}

// ------------------------------------------- a damaged file LOADS, degraded ---

{
  const broken = {
    version: 1,
    stages: [stage()],
    fixtures: [
      sanitiseFixture({ id: 'keep', stageId: 'playoffs', round: 1, left: team('Sentinels') }),
      sanitiseFixture({ id: 'bad', stageId: 'playoffs', round: 2, left: { source: { fixtureId: 'ghost', take: 'winner' } } }),
    ],
  };
  writeFileSync(nextFile(), JSON.stringify(broken), 'utf8');
  const store = makeScheduleStore(FILE);
  const loaded = await store.load();
  ok('6 a hand-edited file with a dangling edge still loads', loaded);
  const doc = store.document();
  eq('6b ...keeping the fixture', doc.fixtures.length, 2);
  eq('6c ...and dropping only the edge', doc.fixtures.find((f) => f.id === 'bad').left.source, null);
}

// ------------------------------------------------------- delete refusals ---

{
  const store = await fresh();
  store.apply((draft) => {
    draft.stages.push(stage());
    draft.fixtures.push(
      sanitiseFixture({ id: 'qf1', stageId: 'playoffs', round: 1, left: team('Sentinels'), right: team('Loud') }),
      sanitiseFixture({ id: 'sf1', stageId: 'playoffs', round: 2, left: { source: { fixtureId: 'qf1', take: 'winner' } } }),
    );
  });

  eq('7 a fixture that feeds another is findable', store.fedBy('qf1').length, 1);
  eq('7b ...and one that feeds nothing is not', store.fedBy('sf1').length, 0);
  eq('8 a team in a fixture is findable', store.usesTeam('sentinels').length, 1);
  eq('8b ...and one nobody booked is not', store.usesTeam('nrg').length, 0);

  /*
   * The copy-not-link rule, asserted in the direction that proves it. Deleting
   * is refused by the route; RENAMING the library entry must leave every
   * fixture exactly as it was, because a fixture records who played and
   * rewriting it later would be the schedule editing history.
   */
  const before = JSON.stringify(store.document().fixtures[0]);
  // Renaming a team touches only teams.json. Nothing in this store can see it,
  // which is the property - so a write here that does not mention the team must
  // leave the fixture's copied fields untouched.
  store.apply((draft) => {
    draft.fixtures[0].note = 'unrelated';
  });
  const after = store.document().fixtures.find((f) => f.id === 'qf1');
  eq('9 a rename in the library cannot reach a played fixture', after.left.name, 'Sentinels');
  ok('9b ...and nothing else moved either', JSON.stringify({ ...after, note: '' }) === JSON.stringify({ ...JSON.parse(before), note: '' }));
}

// ----------------------------------------------------------- propagation ---

{
  const store = await fresh();
  store.apply((draft) => {
    draft.stages.push(stage());
    draft.fixtures.push(
      sanitiseFixture({ id: 'qf1', stageId: 'playoffs', round: 1, bestOf: 3, left: team('Sentinels'), right: team('Loud') }),
      sanitiseFixture({ id: 'sf1', stageId: 'playoffs', round: 2, bestOf: 3, left: { source: { fixtureId: 'qf1', take: 'winner' } } }),
    );
  });
  eq('10 an undecided source leaves the slot empty', store.document().fixtures.find((f) => f.id === 'sf1').left.name, '');

  store.apply((draft) => {
    draft.fixtures.find((f) => f.id === 'qf1').maps = maps([13, 8], [13, 10]).map((r) => ({ ...r, award: '' }));
  });
  eq('11 recording a result carries the winner forward', store.document().fixtures.find((f) => f.id === 'sf1').left.name, 'Sentinels');
  eq('11b ...with the team id, so nothing has to resolve it later', store.document().fixtures.find((f) => f.id === 'sf1').left.teamId, 'sentinels');

  // Correcting the result re-propagates, because SF1 has not been played.
  store.apply((draft) => {
    draft.fixtures.find((f) => f.id === 'qf1').maps = maps([8, 13], [10, 13]).map((r) => ({ ...r, award: '' }));
  });
  eq('12 correcting the result re-propagates', store.document().fixtures.find((f) => f.id === 'sf1').left.name, 'Loud');

  /*
   * And the refusal that matters. Once SF1 has been played, correcting QF1
   * must NOT silently replace one of the teams in a match that actually
   * happened - the schedule inventing a fixture nobody played.
   */
  store.apply((draft) => {
    draft.fixtures.find((f) => f.id === 'sf1').maps = maps([13, 4]).map((r) => ({ ...r, award: '' }));
  });
  let threw = null;
  try {
    store.apply((draft) => {
      draft.fixtures.find((f) => f.id === 'qf1').maps = maps([13, 8], [13, 10]).map((r) => ({ ...r, award: '' }));
    });
  } catch (error) {
    threw = error;
  }
  ok('13 correcting a source after the next match was played is refused', threw !== null);
  ok('13b ...and says which fixture was left alone', /already been played/i.test(threw?.message ?? ''), threw?.message);
  eq('13c ...and the played fixture keeps its team', store.document().fixtures.find((f) => f.id === 'sf1').left.name, 'Loud');
  eq('13d ...and the correction was NOT applied either', store.document().fixtures.find((f) => f.id === 'qf1').maps[0].left, 8);

  // A loser edge drops the other side.
  const lower = await fresh();
  lower.apply((draft) => {
    draft.stages.push(stage());
    draft.fixtures.push(
      sanitiseFixture({ id: 'u1', stageId: 'playoffs', round: 1, bestOf: 1, left: team('Sentinels'), right: team('Loud'), maps: [{ name: 'Bind', left: 13, right: 5 }] }),
      sanitiseFixture({ id: 'l1', stageId: 'playoffs', bracket: 'lower', round: 1, left: { source: { fixtureId: 'u1', take: 'loser' } } }),
    );
  });
  eq('14 a loser edge drops the beaten team into the lower bracket', lower.document().fixtures.find((f) => f.id === 'l1').left.name, 'Loud');
}

// ------------------------------------------- bestOf is why the field exists ---

{
  const bo3 = sanitiseFixture({ id: 'a', bestOf: 3, maps: maps([13, 0], [0, 13], [13, 0]) });
  const bo5 = sanitiseFixture({ id: 'b', bestOf: 5, maps: maps([13, 0], [0, 13], [13, 0]) });
  eq('15 a Bo3 at 2-1 is decided', fixtureDecided(bo3), true);
  eq('16 ...and a Bo5 at 2-1 is not', fixtureDecided(bo5), false);
  eq('16b the two documents differ only in bestOf', bo3.maps.length, bo5.maps.length);
  eq('17 mapsNeeded is right for every length', [1, 3, 5, 7, 9].map(mapsNeeded).join(','), '1,2,3,4,5');

  const empty = sanitiseFixture({ id: 'c', bestOf: 3 });
  eq('18 a fixture with no maps is not decided', fixtureDecided(empty), false);
  eq('18b ...and reads as scheduled', fixtureStatus(empty), 'scheduled');
  eq('19 a half-played fixture reads as live', fixtureStatus(sanitiseFixture({ id: 'd', bestOf: 3, maps: maps([13, 8]) })), 'live');
  eq('20 a void fixture is settled with no winner', fixtureWinner(sanitiseFixture({ id: 'e', winner: 'void' })), 'void');
  eq('20b ...and reads as void', fixtureStatus(sanitiseFixture({ id: 'e', winner: 'void' })), 'void');

  // A forfeit: a result with no map behind it.
  eq('21 an explicit winner beats the maps', fixtureWinner(sanitiseFixture({ id: 'f', bestOf: 3, winner: 'right', maps: maps([13, 0], [13, 0]) })), 'right');
  // An awarded map: 0-0 is the normal state of an unplayed row, so a forfeit on
  // one map cannot be expressed as a score at all.
  const awarded = sanitiseFixture({ id: 'g', bestOf: 3, maps: [{ name: 'Split', left: 0, right: 0, award: 'left' }, { name: 'Bind', left: 13, right: 2 }] });
  eq('22 an awarded map counts without a score', fixtureDecided(awarded), true);
}

// --------------------------------------------------------- the maps cap ---

{
  const store = await fresh();
  let threw = null;
  try {
    store.apply((draft) => {
      draft.stages.push(stage());
      draft.fixtures.push(sanitiseFixture({ id: 'a', stageId: 'playoffs', bestOf: 3, maps: maps([13, 0], [13, 0], [13, 0], [13, 0]) }));
    });
  } catch (error) {
    threw = error;
  }
  // sanitiseFixture slices on the way in, so the strict validator never sees an
  // over-length list from this path - which is the honest outcome to assert.
  eq('23 a Bo3 cannot hold four maps', store.document().fixtures[0]?.maps.length ?? 0, 3);
  ok('23b ...and it was not refused outright, it was sliced', threw === null);
  eq('24 nine is the ceiling, not five', schema.MAX_MAPS, 9);
}

// ------------------------------------------------------------- standings ---

{
  const doc = sanitiseSchedule({
    stages: [stage({ name: 'Group A', kind: 'roundrobin' })],
    fixtures: [
      sanitiseFixture({ id: '1', stageId: 'group-a', bestOf: 3, left: team('Alpha'), right: team('Bravo'), maps: maps([13, 5], [13, 7]) }),
      sanitiseFixture({ id: '2', stageId: 'group-a', bestOf: 3, left: team('Charlie'), right: team('Delta'), maps: maps([13, 5], [5, 13], [13, 7]) }),
      sanitiseFixture({ id: '3', stageId: 'group-a', bestOf: 3, left: team('Alpha'), right: team('Charlie'), maps: maps([13, 5]) }),
      sanitiseFixture({ id: '4', stageId: 'group-a', bestOf: 3, left: team('Bravo'), right: team('Delta'), winner: 'void' }),
    ],
  }, { strict: false }).schedule;

  const table = standings(doc, 'group-a');
  /*
   * Everybody in the stage has a row from the start. A table that grew a row
   * each time somebody finished a match would leave an operator checking the
   * draw unable to tell a missing team from one that had not played yet.
   */
  eq('24a every team in the stage has a row', table.length, 4);
  eq('24b ...including one whose only fixture was void', table.find((r) => r.name === 'Bravo')?.played, 1);
  eq('25 a half-played fixture contributes nothing', table.find((r) => r.name === 'Alpha').played, 1);
  eq('25b a void fixture contributes nothing either', table.find((r) => r.name === 'Delta').played, 1);
  eq('26 wins are counted', table.find((r) => r.name === 'Alpha').won, 1);
  eq('26b and losses', table.find((r) => r.name === 'Bravo').lost, 1);
  eq('27 map wins are counted', table.find((r) => r.name === 'Alpha').mapsWon, 2);
  eq('27b and rounds, for a rulebook to read', table.find((r) => r.name === 'Alpha').roundsWon, 26);

  /*
   * TIES ARE NOT BROKEN, and that is the decision.
   *
   * Real VALORANT group rulebooks tiebreak head-to-head first, so ranking by
   * map differential would be authoritative-looking and wrong in exactly the
   * situation that makes somebody open the table. Alpha and Charlie both have
   * one win here and Alpha has the better map difference - and they must still
   * share a rank.
   */
  const alpha = table.find((r) => r.name === 'Alpha');
  const charlie = table.find((r) => r.name === 'Charlie');
  eq('28 two teams on equal wins share a rank', alpha.rank, charlie.rank);
  ok('28b ...even though one has the better map difference', alpha.mapsWon - alpha.mapsLost !== charlie.mapsWon - charlie.mapsLost);
  ok('28c ...and both are marked tied', alpha.tied && charlie.tied);
  // Standard competition ranking: 1, 2, 2, 4 - not 1, 2, 2, 3.
  const ranks = table.map((r) => r.rank);
  eq('29 the rank after a tie skips', JSON.stringify(ranks), JSON.stringify([1, 1, 3, 3]));
}

// -------------------------------------------------- round robin generation ---

{
  const four = roundRobinPairs(4);
  eq('30 four teams play three rounds', four.length, 3);
  eq('30b ...of two matches each', four.every((round) => round.length === 2), true);
  const seen = new Set(four.flat().map(([a, b]) => [a, b].sort().join('-')));
  eq('30c ...and every pairing happens exactly once', seen.size, 6);

  const five = roundRobinPairs(5);
  eq('31 five teams play five rounds', five.length, 5);
  eq('31b ...with one sitting out each time', five.every((round) => round.length === 2), true);
  const seen5 = new Set(five.flat().map(([a, b]) => [a, b].sort().join('-')));
  eq('31c ...and still every pairing exactly once', seen5.size, 10);
}

// ------------------------------------------------------------- stages ---

{
  eq('32 a stage id is a slug of its name', stage({ name: 'Group A' }).id, 'group-a');
  eq('33 an unknown kind falls back rather than being kept', sanitiseStage({ name: 'x', kind: 'nonsense' }).kind, 'bracket');
  eq('34 a Bo4 is not a thing', sanitiseFixture({ id: 'a', bestOf: 4 }).bestOf, 3);
  eq('35 an impossible date is dropped', sanitiseFixture({ id: 'a', startsAt: '2026-02-31' }).startsAt, '');
  eq('35b a real one is kept', sanitiseFixture({ id: 'a', startsAt: '2026-07-04' }).startsAt, '2026-07-04');
  eq('36 externalId exists from the first commit', 'externalId' in sanitiseFixture({ id: 'a' }), true);

  /*
   * A slot may carry BOTH a team and an edge, and the sanitiser arbitrates
   * neither. It used to: it cleared the edge as soon as a teamId appeared, and
   * since propagation writes exactly such a teamId, every edge fired once and
   * then died - a quarter-final corrected afterwards left the semi-final
   * showing the team already carried across, with nothing to say the link was
   * gone. Pinning a slot means clearing `source` explicitly.
   */
  const both = sanitiseFixture({ id: 'a', left: { ...team('Sentinels'), source: { fixtureId: 'qf1', take: 'winner' } } });
  ok('37 a slot keeps both a team and its edge', both.left.source !== null && both.left.name === 'Sentinels');
  const pinned = sanitiseFixture({ id: 'a', left: { ...team('Sentinels'), source: null } });
  eq('37b clearing the source is what pins it', pinned.left.source, null);
}


// ------------------------------------------------------------ the bracket ---

/*
 * The drawing, as arithmetic.
 *
 * Here rather than in a browser suite because that is what it IS - a pure
 * function from a document to coordinates, with no DOM in it. The Schedule
 * sub-page lives behind a sub-tab and a hidden element measures zero, so a
 * layout that asked the DOM anything would stack the whole bracket on one spot
 * on the first paint and nowhere else; keeping the maths measurable without a
 * browser is the point, not a convenience.
 */
{
  const stage = { id: 's', name: 'Playoffs', kind: 'bracket', order: 0, bestOf: 3 };
  const fx = (id, round, slot, bracket = 'upper', extra = {}) => ({
    id,
    stageId: 's',
    round,
    slot,
    bracket,
    bestOf: 3,
    ...extra,
  });
  const from = (fixtureId, take = 'winner') => ({ source: { fixtureId, take } });
  const build = (fixtures) => sanitiseSchedule({ version: 1, stages: [stage], fixtures }).schedule;
  const rowOf = (layout, id) => layout.nodes.find((node) => node.id === id)?.row;
  const colOf = (layout, id) => layout.nodes.find((node) => node.id === id)?.column;
  // The property that matters on every shape: nothing is drawn on top of
  // anything else. Two fixtures may share a row OR a column, never both.
  const noOverlap = (layout) => {
    const cells = layout.nodes.map((node) => `${node.column}:${node.row}`);
    return new Set(cells).size === cells.length;
  };

  const single = build([
    fx('qf1', 1, 0),
    fx('qf2', 1, 1),
    fx('qf3', 1, 2),
    fx('qf4', 1, 3),
    fx('sf1', 2, 0, 'upper', { left: from('qf1'), right: from('qf2') }),
    fx('sf2', 2, 1, 'upper', { left: from('qf3'), right: from('qf4') }),
    fx('gf', 3, 0, 'upper', { left: from('sf1'), right: from('sf2') }),
  ]);
  let layout = bracketLayout(single, 's');

  eq('38 a round is a column', layout.columns, 3);
  eq('38b ...and the first round fills the rows', layout.rows, 4);
  eq('39 the first round lays out one per row', `${rowOf(layout, 'qf1')},${rowOf(layout, 'qf4')}`, '0,3');

  /*
   * THE ONE THE WHOLE FUNCTION IS FOR. A match sits centred between the two
   * that feed it - which is what makes a bracket read as a bracket rather than
   * as three lists side by side.
   */
  eq('40 a match centres between its feeders', rowOf(layout, 'sf1'), 0.5);
  eq('40b ...on both sides of the draw', rowOf(layout, 'sf2'), 2.5);
  eq('40c ...and the final centres on those', rowOf(layout, 'gf'), 1.5);
  eq('41 every edge is drawn', layout.links.length, 6);

  /*
   * Not `2 ** (round - 1) * (slot + 0.5)`, which is the formula a bracket
   * drawing usually starts with. It is right only for a full power-of-two
   * single elimination, and this model deliberately allows byes, sparse slots
   * and a lower bracket built in whatever order somebody builds one - so the
   * EDGES decide, and an unfed match takes the next free row in its column.
   */
  const bye = build([fx('a', 1, 0), fx('b', 1, 1), fx('x', 2, 0, 'upper', { left: from('a') }), fx('y', 2, 1, 'upper', { left: from('b') })]);
  layout = bracketLayout(bye, 's');
  eq('42 a match with ONE feeder sits level with it', rowOf(layout, 'x'), 0);
  eq('42b ...and the next one with its own', rowOf(layout, 'y'), 1);
  ok('42c nothing overlaps', noOverlap(layout));

  /*
   * A bracket nobody has wired yet - the state between pressing Generate and
   * drawing the edges. Free rows are counted per COLUMN, so this is two tidy
   * columns rather than a staircase running off the bottom.
   */
  const loose = build([fx('a', 1, 0), fx('b', 1, 1), fx('c', 1, 2), fx('d', 1, 3), fx('e', 2, 0), fx('f', 2, 1)]);
  layout = bracketLayout(loose, 's');
  eq('43 an unwired bracket starts each column at the top', `${rowOf(layout, 'e')},${rowOf(layout, 'f')}`, '0,1');
  eq('43b ...so it is as tall as its longest column', layout.rows, 4);
  eq('43c ...and draws no links', layout.links.length, 0);

  /*
   * Averaging can want two fixtures on one row - three matches feeding two, or
   * a half-wired bracket. They are pushed apart rather than drawn on top of
   * each other, and the order the operator laid out is preserved.
   */
  /*
   * The sources here are chosen to COLLIDE, and that is the whole point.
   *
   * The first version of this block used a/b and b/c, which average to 0.5 and
   * 1.5 - already a row apart, so the push-apart never fired and the assertions
   * passed against code with it deleted. Caught by breaking it on purpose, which
   * is the only reason anyone ever finds a vacuous assertion.
   *
   *   x and y take the SAME two feeders, so both want row 0.5 exactly.
   *   z takes a and c, wanting 1.0 - half a row from where y has to end up.
   */
  const crowded = build([
    fx('a', 1, 0),
    fx('b', 1, 1),
    fx('c', 1, 2),
    fx('x', 2, 0, 'upper', { left: from('a'), right: from('b') }),
    fx('y', 2, 1, 'upper', { left: from('a'), right: from('b') }),
    fx('z', 2, 2, 'upper', { left: from('a'), right: from('c') }),
  ]);
  layout = bracketLayout(crowded, 's');
  eq('44 two matches wanting one row are pushed apart', rowOf(layout, 'x'), 0.5);
  eq('44b ...the second to the next row down', rowOf(layout, 'y'), 1.5);
  eq('44c ...and a third that lands between them follows', rowOf(layout, 'z'), 2.5);
  ok('44d nothing shares a cell', noOverlap(layout));
  ok('44e ...and the order laid out is preserved', rowOf(layout, 'x') < rowOf(layout, 'y') && rowOf(layout, 'y') < rowOf(layout, 'z'));

  /*
   * Double elimination, and the bug this caught when it was written: a lower
   * bracket match is fed by the LOSERS of the upper bracket, so averaging
   * against every source dragged the whole lower band up into the upper one and
   * put the two finals on the same cell. Only same-half sources place a
   * fixture; a cross-band edge is still drawn.
   */
  const double = build([
    fx('u1', 1, 0),
    fx('u2', 1, 1),
    fx('uf', 2, 0, 'upper', { left: from('u1'), right: from('u2') }),
    fx('l1', 1, 0, 'lower', { left: from('u1', 'loser'), right: from('u2', 'loser') }),
    fx('lf', 2, 0, 'lower', { left: from('l1') }),
    fx('gf', 1, 0, 'final', { left: from('uf'), right: from('lf') }),
  ]);
  layout = bracketLayout(double, 's');
  ok('45 the lower bracket does not land on the upper', noOverlap(layout));
  ok('45b ...it sits BELOW it', rowOf(layout, 'l1') > rowOf(layout, 'uf'));
  ok('45c ...and a loser edge is still drawn', layout.links.some((link) => link.take === 'loser'));
  eq('45d the grand final is to the right of everything', colOf(layout, 'gf'), 2);
  ok(
    '45e ...and centred between the two bands',
    rowOf(layout, 'gf') > rowOf(layout, 'uf') && rowOf(layout, 'gf') < rowOf(layout, 'l1'),
    rowOf(layout, 'gf'),
  );

  // An edge pointing at a fixture that is gone is dropped rather than drawn to
  // nowhere - the same rule sanitiseSchedule applies to the record itself.
  const dangling = build([fx('a', 1, 0), fx('b', 2, 0, 'upper', { left: from('a'), right: from('ghost') })]);
  layout = bracketLayout(dangling, 's');
  eq('46 an edge to a fixture that is gone is not drawn', layout.links.length, 1);

  const empty = bracketLayout(build([]), 's');
  eq('47 an empty stage draws nothing', empty.nodes.length, 0);
  eq('47b ...and has no size', `${empty.columns}x${empty.rows}`, '0x0');
  eq('48 a stage id nobody has draws nothing either', bracketLayout(single, 'nope').nodes.length, 0);
}


// ================================================= groups inside a stage =====
/*
 * A group is a DIVISION INSIDE ONE STAGE, not a stage of its own.
 *
 * "Group stage" is one phase of a competition and reads as one thing on a
 * strip; four separate stages called Group A to Group D is four entries before
 * the playoffs appear, and an eight-group event is unusable. One table per
 * group, shown together.
 *
 * Here rather than in a browser suite for the reason the bracket layout is: it
 * is a pure function from a document to tables, with no DOM in it.
 */
{
  const stage = sanitiseStage({ name: 'Group stage', kind: 'roundrobin', groups: ['Group A', 'Group B'] });
  eq('g1 a stage can carry groups', stage.groups.length, 2);
  eq('g2 ...with ids slugged from their names', stage.groups.map((g) => g.id).join(','), 'group-a,group-b');
  ok('g3 ...and a stage with none is the ordinary case', sanitiseStage({ name: 'Playoffs' }).groups.length === 0);

  /*
   * A group with no name is not a group - it cannot be picked out of a list or
   * labelled on a table, the same rule a nameless team and a nameless stage get.
   * And two groups resolving to ONE id would put both their matches in one
   * table and lose half the draw with nothing failing.
   */
  const messy = sanitiseGroups(['Group A', { name: '' }, 'Group A', { name: 'Group B' }]);
  eq('g4 a nameless group is dropped', messy.length, 2);
  eq('g5 ...and a duplicate id with it', messy.map((g) => g.id).join(','), 'group-a,group-b');

  const renamed = sanitiseGroups([{ id: 'group-a', name: 'Alpha Pool' }]);
  eq('g6 renaming a group keeps its id, so its matches are not orphaned', renamed[0].id, 'group-a');

  // ---------------------------------------------------------- the tables ---

  const doc = {
    version: 1,
    stages: [stage],
    fixtures: [
      played('a1', 'group-a', 'Alpha', 'Bravo', 2, 0),
      played('a2', 'group-a', 'Alpha', 'Charlie', 2, 1),
      played('b1', 'group-b', 'Delta', 'Echo', 2, 0),
    ],
  };

  const tables = stageTables(doc, stage);
  eq('g7 one table per group', tables.length, 2);
  eq('g8 ...named', tables.map((t) => t.name).join(','), 'Group A,Group B');
  eq('g9 ...holding only their own teams', tables[0].table.map((r) => r.name).sort().join(','), 'Alpha,Bravo,Charlie');
  eq('g10 ...and not each other\'s', tables[1].table.map((r) => r.name).sort().join(','), 'Delta,Echo');
  eq('g11 a group is ranked on its own', tables[0].table[0].name, 'Alpha');
  eq('g12 ...and so is the other one', tables[1].table[0].name, 'Delta');

  /*
   * A STAGE WITH NO GROUPS STILL ANSWERS WITH A LIST - of one.
   *
   * That is the whole reason this function exists rather than the page
   * branching on whether there are groups: two rendering paths for one table is
   * how the grouped one ends up missing whatever the ungrouped one gains next.
   */
  const flat = sanitiseStage({ name: 'Playoffs', kind: 'roundrobin' });
  const one = stageTables({ ...doc, stages: [flat], fixtures: doc.fixtures.map((f) => ({ ...f, stageId: flat.id })) }, flat);
  eq('g13 a stage with no groups answers with one table', one.length, 1);
  eq('g14 ...unnamed, because there is nothing to tell apart', one[0].name, '');
  eq('g15 ...holding everybody', one[0].table.length, 5);

  /*
   * AN UNGROUPED MATCH IS VISIBLE. Splitting an existing pool leaves every
   * match ungrouped until somebody assigns them, and a table that silently
   * omitted them would read as teams having been dropped from the draw.
   */
  const partly = {
    ...doc,
    fixtures: [...doc.fixtures, played('loose', '', 'Foxtrot', 'Golf', 2, 0)],
  };
  const withLeftovers = stageTables(partly, stage);
  eq('g16 matches in no group get a bucket of their own', withLeftovers.length, 3);
  eq('g17 ...named so it is obvious what it is', withLeftovers[2].name, 'Not in a group');
  eq('g18 ...holding them', withLeftovers[2].table.map((r) => r.name).sort().join(','), 'Foxtrot,Golf');
  ok('g19 ...and it is absent when nothing is in it', stageTables(doc, stage).length === 2);

  /*
   * Asking for the stage as a WHOLE still counts every group together, which is
   * what a grouped stage's overall standings are - and is what `standings` with
   * no group argument has always meant.
   */
  eq('g20 the stage as a whole still counts everybody', standings(doc, stage.id).length, 5);
}

rmSync(DIR, { recursive: true, force: true });

console.log(`\nschedule-model: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
