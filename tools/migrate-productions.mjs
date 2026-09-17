/**
 * Migration day, again: give every tournament's desk a directory of its own.
 *
 *   node tools/migrate-productions.mjs            # say what it would do
 *   node tools/migrate-productions.mjs --apply    # do it
 *
 * Before: `.state/tournaments/<id>/` held the competition AND the graphics.
 * After:  the competition stays where it is - teams, aliases, schedule,
 *         presets - and the graphics move down into
 *         `.state/tournaments/<id>/productions/<productionId>/`.
 *
 * Because a tournament runs more than one match at a time, and two concurrent
 * matches are two streams: the graphic STATE is a store, so one set of files
 * cannot serve both.
 *
 * ## This one is much gentler than the last, and it is worth saying why
 *
 * `migrate-tournaments.mjs` is the script with no partial undo, and it earned
 * that: it renamed the directory a running build looks in, and it re-keyed
 * every OBS source in the building. Neither is true here.
 *
 *   THE KEYS DO NOT MOVE. `cleanProductions` in tournaments.js reads a record
 *   written before productions existed as one production called "Main" holding
 *   the tournament's existing session and control keys. So every OBS URL, every
 *   webhook and every stream deck keeps working, untouched. There is no key
 *   sheet to carry round a venue this time - that is the deliberate difference
 *   from last time, and it is available precisely because nothing is being
 *   renamed or merged, only nested.
 *
 *   THE RECORDS NEED NO MIGRATING. The legacy read above does that on load, in
 *   memory, and the next ordinary write persists it. This script moves FILES
 *   and nothing else.
 *
 * What is still true, and still the whole safety story:
 *
 *   IDEMPOTENT      a tournament whose `productions/` directory already holds
 *                   the graphics is skipped, not moved again.
 *   RESUMABLE       each tournament is finished before the next is started, so
 *                   an interrupted run leaves a tree that is part migrated and
 *                   running it again finishes the job.
 *   MARKER LAST     `.state/schema-version` is written only once every
 *                   tournament is done. Writing it earlier would make a crashed
 *                   run look finished - and the symptom of a half-moved tree is
 *                   not an error, it is a scoreboard that opens blank, because
 *                   a store whose file is absent loads its defaults and says
 *                   nothing.
 *   REFUSES A MESS  a tree it does not recognise is left alone rather than
 *                   guessed at.
 *
 * ## The files that move, and the ones that must not
 *
 * Moving too much is the failure mode here. `teams.json`, `aliases.json`,
 * `schedule.json` and `presets.json` belong to the COMPETITION and are shared
 * by every desk - move them down and the second court gets an empty team
 * library, which reads as data loss.
 */

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

/** Bumped when the on-disk layout changes again. Written as the last act. */
const SCHEMA_VERSION = 3;

/**
 * What belongs to a DESK. Everything else in a tournament directory stays.
 *
 * Listed explicitly rather than matched by a pattern, and the difference
 * matters: a rule like "everything except the four shared files" would sweep a
 * file added next year into a desk directory without anybody deciding that it
 * should go there. A list makes every new file force the question, the same way
 * KEYED_ROUTES does for routes.
 */
const DESK_FILES = [
  'graphic.json',
  'graphic.preview.json',
  'winner.json',
  'winner.preview.json',
  'select.json',
  'select.preview.json',
  'global.json',
];

/** What stays on the tournament. Here so the reader can see both halves at once. */
const SHARED_FILES = ['teams.json', 'aliases.json', 'schedule.json', 'presets.json'];

const exists = async (target) => {
  try {
    await readdir(path.dirname(target));
    await readFile(target);
    return true;
  } catch (error) {
    if (error.code === 'EISDIR') return true;
    return false;
  }
};

const isDir = async (target) => {
  try {
    await readdir(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * Move every tournament's graphics into a desk directory.
 *
 * `afterEach` is a test seam and nothing else uses it. It lets the suite kill a
 * run between tournaments and then assert that the tree is resumable - which is
 * the case that cannot be provoked any other way, and the case that a reordered
 * marker write silently breaks.
 */
export async function migrate({ stateDir = '.state', apply = false, say = console.log, afterEach = null } = {}) {
  const root = path.resolve(stateDir);
  const indexPath = path.join(root, 'tournaments.json');
  const tournamentsDir = path.join(root, 'tournaments');

  let index;
  try {
    index = JSON.parse(await readFile(indexPath, 'utf8'));
  } catch {
    say(`No tournaments.json under ${root}. Nothing to migrate - this tree has never run a tournament.`);
    return { moved: 0, skipped: 0, tournaments: 0 };
  }
  if (!Array.isArray(index)) {
    say('tournaments.json is not a list. Refusing to guess at it.');
    return { moved: 0, skipped: 0, tournaments: 0, refused: true };
  }

  let moved = 0;
  let skipped = 0;

  for (const record of index) {
    const id = String(record?.id ?? '');
    if (!id) continue;

    const dir = path.join(tournamentsDir, id);
    if (!(await isDir(dir))) {
      say(`  ${id}  no workspace directory - nothing to move`);
      skipped += 1;
      continue;
    }

    /*
     * Which desk the files belong to.
     *
     * The record's FIRST production, which the legacy read created from the
     * tournament's own keys - so the desk that inherits the graphics is the
     * same desk that inherits the OBS key that has been pointing at them. If a
     * record has already been written since productions shipped it will have a
     * real list, and the first entry is still "Main".
     *
     * A record with no productions at all is the ordinary pre-migration shape,
     * and it is handled rather than refused - see the note on deskId below.
     */
    const desk = Array.isArray(record.productions) ? record.productions[0] : null;
    /*
     * The first desk's id is the tournament's own - see cleanProductions.
     *
     * Which is what lets this script run on a tree nothing has written since
     * productions shipped: it does not need the record to have been migrated
     * first, and it cannot disagree with the id the server will mint, because
     * neither of them is choosing one. It also makes the whole run idempotent
     * and crash-safe in the only order that matters - files first, record never
     * - since a re-run targets the same directory.
     */
    const deskId = desk?.id ?? id;

    const deskDir = path.join(dir, 'productions', String(deskId));
    const present = [];
    for (const file of DESK_FILES) {
      if (await exists(path.join(dir, file))) present.push(file);
    }

    if (!present.length) {
      const already = (await isDir(deskDir)) ? ' (already moved)' : ' (nothing on air yet)';
      say(`  ${id}  nothing to move${already}`);
      skipped += 1;
      continue;
    }

    say(`  ${id}  ${present.length} file${present.length === 1 ? '' : 's'} -> productions/${deskId}/`);
    for (const file of present) say(`      ${file}`);

    if (apply) {
      await mkdir(deskDir, { recursive: true });
      for (const file of present) {
        await rename(path.join(dir, file), path.join(deskDir, file));
      }
      moved += present.length;
    }

    // Recorded before the next tournament is started, which is what makes an
    // interrupted run resumable rather than ambiguous.
    await afterEach?.(id);
  }

  if (apply) {
    /*
     * LAST, and the suite has four assertions that go red if this moves.
     *
     * The marker is the only thing that says a tree is finished. Written before
     * the loop, a run that crashed halfway would leave a tree that claims to be
     * migrated while half its tournaments still have their graphics in the
     * wrong place - and the symptom is a blank scoreboard, not an error,
     * because an absent file is a store loading its defaults.
     */
    await writeFile(path.join(root, 'schema-version'), String(SCHEMA_VERSION), 'utf8');
  }

  say('');
  say(
    apply
      ? `Moved ${moved} file${moved === 1 ? '' : 's'} across ${index.length - skipped} tournament${index.length - skipped === 1 ? '' : 's'}.`
      : `Would move ${moved || '(counted on --apply)'} - run again with --apply.`,
  );
  say('');
  say('The keys did NOT change. Every OBS URL, webhook and stream deck keeps working.');
  say(`Left alone on each tournament: ${SHARED_FILES.join(', ')}`);

  return { moved, skipped, tournaments: index.length };
}

/*
 * Compared as a URL rather than by basename.
 *
 * `endsWith('migrate-productions.mjs')` would also match the SUITE, which
 * shares the name - so importing this module from the test ran its CLI against
 * whatever `.state` the developer had. That happened with the last runner. It
 * was a dry run, so nothing was written, which is luck rather than design.
 */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const apply = process.argv.includes('--apply');
  await migrate({ stateDir: process.env.STATE_DIR ?? '.state', apply });
}
