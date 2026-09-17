/**
 * The productions migration runner, against fixture trees in temp directories
 * and never a real `.state`.
 *
 * No server and no port. The case that matters is a crash mid-run: `migrate()`
 * takes an `afterEach` seam so this suite can kill it between tournaments, and
 * assertion 18 goes red if the schema marker is written before the moves rather
 * than after - a reorder that passes every other assertion in the file while
 * making an interrupted tree claim to be finished.
 *
 * ONE assertion, not four. Measured by making the change and counting, because
 * the last runner's suite carried a header claiming four and it was worth
 * knowing which sentence was true. One is enough here and it is the right one;
 * a count nobody has checked is worse than no count.
 *
 *   node tools/tests/migrate-productions.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..', '..');
const { migrate } = await import(pathToFileURL(path.join(PROJECT, 'tools', 'migrate-productions.mjs')).href);
const { makeTournamentStore } = await import(pathToFileURL(path.join(PROJECT, 'tournaments.js')).href);

let passed = 0;
const failures = [];
const ok = (name, condition, detail) => {
  if (condition) passed += 1;
  else failures.push(`${name}${detail === undefined ? '' : ` - got ${JSON.stringify(detail)}`}`);
};
const eq = (name, actual, expected) => ok(name, actual === expected, actual);

const quiet = () => {};
const roots = [];

/** A tree in the shape this runner expects to find: flat, pre-productions. */
function legacyTree(tournaments) {
  const root = mkdtempSync(path.join(tmpdir(), 'rl-mig-prod-'));
  roots.push(root);
  mkdirSync(path.join(root, 'tournaments'), { recursive: true });
  const index = [];
  for (const entry of tournaments) {
    const dir = path.join(root, 'tournaments', entry.id);
    mkdirSync(dir, { recursive: true });
    for (const [file, body] of Object.entries(entry.files ?? {})) {
      writeFileSync(path.join(dir, file), JSON.stringify(body), 'utf8');
    }
    index.push({
      id: entry.id,
      name: entry.name ?? 'Cup',
      members: { u1: 'owner' },
      sessionKey: entry.sessionKey ?? `key-${entry.id}`,
      controlKey: entry.controlKey ?? '',
      createdAt: 1,
      ...(entry.productions ? { productions: entry.productions } : {}),
    });
  }
  writeFileSync(path.join(root, 'tournaments.json'), JSON.stringify(index), 'utf8');
  return root;
}

const deskDir = (root, tid, pid = tid) => path.join(root, 'tournaments', tid, 'productions', pid);
const at = (...parts) => existsSync(path.join(...parts));

// ------------------------------------------------------------ a dry run ---

{
  const root = legacyTree([{ id: 't1', files: { 'graphic.json': { a: 1 }, 'teams.json': [{ id: 'sen' }] } }]);
  const before = readdirSync(path.join(root, 'tournaments', 't1')).sort().join(',');
  await migrate({ stateDir: root, apply: false, say: quiet });
  eq('1 a dry run moves nothing', readdirSync(path.join(root, 'tournaments', 't1')).sort().join(','), before);
  ok('2 ...and writes no marker', !at(root, 'schema-version'));
}

// --------------------------------------------------- what moves and what does not ---

{
  const root = legacyTree([
    {
      id: 't1',
      files: {
        'graphic.json': { a: 1 },
        'graphic.preview.json': { a: 2 },
        'winner.json': { w: 1 },
        'select.json': { s: 1 },
        'global.json': { g: 1 },
        'teams.json': [{ id: 'sen' }],
        'aliases.json': { players: [] },
        'schedule.json': { version: 1, stages: [], fixtures: [] },
        'presets.json': [],
      },
    },
  ]);
  await migrate({ stateDir: root, apply: true, say: quiet });

  const desk = deskDir(root, 't1');
  for (const file of ['graphic.json', 'graphic.preview.json', 'winner.json', 'select.json', 'global.json']) {
    ok(`3.${file} moved to the desk`, at(desk, file));
    ok(`3.${file} is gone from the tournament`, !at(root, 'tournaments', 't1', file));
  }

  /*
   * The half that matters more. Moving a shared file down is the failure that
   * reads as data loss: the second court opens with an empty team library and
   * nothing says why.
   */
  for (const file of ['teams.json', 'aliases.json', 'schedule.json', 'presets.json']) {
    ok(`4.${file} stayed on the tournament`, at(root, 'tournaments', 't1', file));
    ok(`4.${file} did NOT go to the desk`, !at(desk, file));
  }

  eq('5 the content survived the move', readFileSync(path.join(desk, 'winner.json'), 'utf8'), '{"w":1}');
  eq('6 the marker is written', readFileSync(path.join(root, 'schema-version'), 'utf8'), '3');
}

// ------------------------------------------------ the desk id is deterministic ---

{
  const root = legacyTree([{ id: 't1', files: { 'winner.json': { w: 1 } } }]);
  await migrate({ stateDir: root, apply: true, say: quiet });
  ok('7 the desk directory is named for the tournament', at(deskDir(root, 't1', 't1'), 'winner.json'));

  /*
   * And it agrees with what the STORE mints, which is the whole point.
   *
   * A random id here would be minted afresh on every load until something wrote
   * the record, so the runner would move a tournament's graphics into a
   * directory the next boot no longer looks in - a blank scoreboard with no
   * error and no log line.
   */
  const store = makeTournamentStore(path.join(root, 'tournaments.json'));
  await store.load();
  const record = store.byId('t1');
  eq('8 the store mints the same id the runner used', record.productions[0].id, 't1');
  eq('9 ...called Main', record.productions[0].name, 'Main');
  eq('10 ...carrying the tournament key that OBS already has', record.productions[0].sessionKey, 'key-t1');
}

// ---------------------------------------------------------------- idempotent ---

{
  const root = legacyTree([{ id: 't1', files: { 'winner.json': { w: 1 } } }]);
  const first = await migrate({ stateDir: root, apply: true, say: quiet });
  const second = await migrate({ stateDir: root, apply: true, say: quiet });
  eq('11 the first run moves the file', first.moved, 1);
  eq('12 a second run moves nothing', second.moved, 0);
  eq('13 ...and the file is still there exactly once', readFileSync(path.join(deskDir(root, 't1'), 'winner.json'), 'utf8'), '{"w":1}');
}

// ------------------------------------------------------ a crash mid-run ---

{
  const root = legacyTree([
    { id: 't1', files: { 'winner.json': { w: 1 } } },
    { id: 't2', files: { 'winner.json': { w: 2 } } },
    { id: 't3', files: { 'winner.json': { w: 3 } } },
  ]);

  const boom = new Error('killed between tournaments');
  let done = 0;
  await migrate({
    stateDir: root,
    apply: true,
    say: quiet,
    afterEach: async () => {
      done += 1;
      if (done === 2) throw boom;
    },
  }).catch((error) => {
    ok('14 the run stopped where it was killed', error === boom);
  });

  ok('15 the tournaments before the crash are migrated', at(deskDir(root, 't1'), 'winner.json'));
  ok('16 ...and so is the one it was on', at(deskDir(root, 't2'), 'winner.json'));
  ok('17 the one after it is untouched', at(root, 'tournaments', 't3', 'winner.json'));

  /*
   * THE ONE THAT MATTERS. The marker is the only thing that says a tree is
   * finished, so an interrupted run must not have written it - otherwise a tree
   * with a third of its graphics in the wrong place claims to be migrated, and
   * the symptom is a blank scoreboard rather than an error, because a store
   * whose file is absent loads its defaults and says nothing.
   */
  ok('18 an interrupted run wrote NO marker', !at(root, 'schema-version'));

  const finished = await migrate({ stateDir: root, apply: true, say: quiet });
  eq('19 running again finishes the job', finished.moved, 1);
  ok('20 ...moving only what was left', at(deskDir(root, 't3'), 'winner.json'));
  ok('21 ...and only then writing the marker', at(root, 'schema-version'));
}

// ------------------------------------------------------------ refuses a mess ---

{
  const root = mkdtempSync(path.join(tmpdir(), 'rl-mig-prod-'));
  roots.push(root);
  const result = await migrate({ stateDir: root, apply: true, say: quiet });
  eq('22 a tree with no tournaments.json is left alone', result.moved, 0);
  ok('23 ...and gets no marker', !at(root, 'schema-version'));

  const junk = mkdtempSync(path.join(tmpdir(), 'rl-mig-prod-'));
  roots.push(junk);
  writeFileSync(path.join(junk, 'tournaments.json'), '{"not":"a list"}', 'utf8');
  const refused = await migrate({ stateDir: junk, apply: true, say: quiet });
  ok('24 a tournaments.json that is not a list is refused', refused.refused === true);
  ok('25 ...and gets no marker', !at(junk, 'schema-version'));
}

// --------------------------------------- a tree already carrying productions ---

{
  const root = legacyTree([
    {
      id: 't1',
      files: { 'winner.json': { w: 1 } },
      productions: [
        { id: 'desk-a', name: 'Main', sessionKey: 'key-a', controlKey: '', createdAt: 1 },
        { id: 'desk-b', name: 'Court 2', sessionKey: 'key-b', controlKey: '', createdAt: 2 },
      ],
    },
  ]);
  await migrate({ stateDir: root, apply: true, say: quiet });
  ok('26 the graphics go to the FIRST desk', at(deskDir(root, 't1', 'desk-a'), 'winner.json'));
  ok('27 ...and not to the second', !at(deskDir(root, 't1', 'desk-b'), 'winner.json'));
}

// ---------------------------------------- a tournament with nothing on air yet ---

{
  const root = legacyTree([{ id: 't1', files: { 'teams.json': [] } }]);
  const result = await migrate({ stateDir: root, apply: true, say: quiet });
  eq('28 a tournament with no graphics moves nothing', result.moved, 0);
  ok('29 ...and keeps its team library', at(root, 'tournaments', 't1', 'teams.json'));
  ok('30 ...and the run still completes', at(root, 'schema-version'));
}

for (const root of roots) rmSync(root, { recursive: true, force: true });

console.log(`\nmigrate-productions: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
