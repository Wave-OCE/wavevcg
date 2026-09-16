/**
 * Does a rejected alias import leave the library alone?
 *
 * A unit test with no server and no port, like buses-test - it asserts on what
 * actually reaches disk, which is the whole point here.
 *
 * The bug this covers: import() merged into `players` in place and only THEN
 * tested the cap. It does not persist on the throw path, but seen() does, and
 * a roster webhook calls seen() every lobby. So a rejected import showed the
 * operator a 400 that read like their own mistake and wrote the over-cap
 * library to disk a minute later, with nothing connecting the two.
 *
 * Worse, and what assertion 6 is really for: the live array stayed over the cap
 * afterwards, so EVERY later import was refused as well. The library never
 * recovered without a hand edit.
 *
 * Verified by reverting the fix: 2, 3, 4 and 5 go red and 6 throws.
 *
 *   node tools/tests/alias-import-atomic.mjs
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { makeAliasStore } from '../../graphics.js';

/** Must match ALIAS_LIMIT in graphics.js. */
const ALIAS_LIMIT = 500;

const dir = await mkdtemp(path.join(tmpdir(), 'alias-import-'));
const file = path.join(dir, 'aliases.json');

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? '  ok  ' : 'FAIL  '}${label}` +
      (ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`),
  );
};

const store = makeAliasStore(file);
await store.load();

// Seed to exactly the cap, every one of them named - because the cap counts
// named players, not rows.
store.import(
  Array.from({ length: ALIAS_LIMIT }, (_, i) => ({
    id: `seed-${i}`,
    riotId: `Seed${i}#EU1`,
    alias: `Seed ${i}`,
  })),
);
await store.flush();

const before = store.list().length;
check('seeded to the cap', before, ALIAS_LIMIT);

// One more named player takes it over. This must be refused, and refused
// without taking the library with it.
let threw = null;
try {
  store.import([{ id: 'over-1', riotId: 'Straw#EU1', alias: 'Straw' }]);
} catch (error) {
  threw = error.message;
}

check('1. the over-cap import threw', typeof threw === 'string' && threw.includes('limit'), true);
check('2. the in-memory library is unchanged', store.list().length, before);
check('3. the refused entry is not in the library', store.list().some((p) => p.alias === 'Straw'), false);

// The real-world trigger. A roster event lands next and persists whatever is in
// memory, so this is the assertion that decides whether the bug reaches disk.
store.seen([{ id: 'seed-0', riotId: 'Seed0#EU1' }]);
await store.flush();

const onDisk = JSON.parse(await readFile(file, 'utf8'));
check('4. a later persist did not write the over-cap list', onDisk.length, before);
check('5. the refused entry never reached disk', onDisk.some((p) => p.alias === 'Straw'), false);

// And the library still takes a legal import afterwards - the half of this that
// a naive "check the cap first" fix would also pass, and that reverting the
// real fix makes throw.
const result = store.import([{ id: 'seed-0', riotId: 'Seed0#EU1', alias: 'Renamed' }]);
check('6. a legal update still applies after a refusal', store.list().find((p) => p.id === 'seed-0')?.alias, 'Renamed');
check('7. ...and counts as an update, not an add', [result.added, result.updated], [0, 1]);

// An import that stays under the cap by only updating must still be allowed,
// which is the reason the cap is tested after the merge rather than before.
const updateOnly = store.import([{ id: 'seed-1', riotId: 'Seed1#EU1', alias: 'Also renamed' }]);
check('8. an update-only import at the cap is allowed', [updateOnly.added, updateOnly.updated], [0, 1]);

// Flushed before the directory goes, or the last persist races the cleanup and
// warns about a file it cannot write - which reads like a failure and is not.
await store.flush();
await rm(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : `\nall passed`);
process.exit(failures ? 1 : 0);
