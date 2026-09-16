/**
 * Migration day: move every account's workspace onto a tournament.
 *
 *   node tools/migrate-tournaments.mjs            # say what it would do
 *   node tools/migrate-tournaments.mjs --apply    # do it
 *
 * Before: `.state/users/<userId>/` held one account's graphics, and that
 * account's session key was what an OBS browser source carried.
 * After:  `.state/tournaments/<tournamentId>/` holds a tournament's graphics,
 * the tournament has its own keys, and people are members of it.
 *
 * ## This is the one script in the repo with no partial undo
 *
 * The project's usual migration trick does not apply and it is worth saying why
 * rather than leaving somebody to wonder. buses.js needed no runner at all: the
 * NEW file took a new name, so the absence of that file was the signal, and the
 * old binary could still boot the tree. A rename cannot do that - after this
 * runs, the previous build looks in `.state/users/` and finds nothing.
 *
 * So the properties below are not politeness, they are the whole safety story:
 *
 *   IDEMPOTENT      a tournament records the account it was migrated from, so a
 *                   second run finds it standing and skips rather than making a
 *                   duplicate workspace nobody is watching.
 *   RESUMABLE       each account is moved and recorded before the next is
 *                   started, so an interrupted run leaves a tree that is part
 *                   migrated and says so - and running again finishes the job.
 *   MARKER LAST     `.state/schema-version` is written only once every account
 *                   is done. Its absence on a tree that has tournaments in it
 *                   is what "interrupted" looks like, and nothing else would
 *                   say so: no code anywhere scans `.state/users/`, so a
 *                   half-finished move otherwise presents as a blank scoreboard
 *                   and an empty team library with no error and no log line.
 *   REFUSES A MESS  a tree it does not recognise is left alone rather than
 *                   guessed at.
 *
 * ## The key sheet is the deliverable
 *
 * Every session key in the building stops working the moment this runs - that
 * was a deliberate choice, taken over grandfathering, because a migration day
 * you are having anyway is the cheapest place to also re-key. What makes it
 * survivable is the sheet this prints: old key, new key, which tournament. That
 * is what somebody carries round the venue re-pasting OBS sources, Shots Fired
 * webhooks and VHUD's GET JSON box. Print it, keep it, and do this on a day with
 * no matches on it.
 */

import { mkdir, readFile, rename, writeFile, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

/** Bumped when the on-disk layout changes again. Written as the last act. */
const SCHEMA_VERSION = 2;

const STATE_DIR = process.env.STATE_DIR ?? '.state';
const APPLY = process.argv.includes('--apply');

const exists = async (target) => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
};

/**
 * Move a workspace.
 *
 * `rename` rather than a copy-then-delete, deliberately. On one filesystem it is
 * atomic: the directory is at the old path or the new one and never half at
 * both, which is exactly the property a resumable migration needs. A copy would
 * leave two workspaces diverging if it died in the middle, and nothing
 * downstream could tell which one was real.
 */
async function moveWorkspace(from, to) {
  await mkdir(path.dirname(to), { recursive: true });
  await rename(from, to);
}

/**
 * @param {object} options
 * @param {string} [options.stateDir]
 * @param {boolean} [options.apply]
 * @param {(line: string) => void} [options.log]
 * @param {(done: number) => void} [options.afterEach] called once per migrated
 *   account. A seam for the suite, which throws from it to simulate a crash
 *   mid-run - the one case that cannot be reached any other way and the one the
 *   marker-written-last rule exists for. Without it nothing asserts the ORDER of
 *   the writes, and reversing them passes every other assertion in the file
 *   while making an interrupted tree permanently unresumable.
 */
export async function migrate({ stateDir = STATE_DIR, apply = false, log = console.log, afterEach = null } = {}) {
  const usersFile = path.join(stateDir, 'users.json');
  const tournamentsFile = path.join(stateDir, 'tournaments.json');
  const markerFile = path.join(stateDir, 'schema-version');
  const usersDir = path.join(stateDir, 'users');
  const tournamentsDir = path.join(stateDir, 'tournaments');

  if (!(await exists(usersFile))) {
    log(`No ${usersFile} - nothing to migrate. This looks like a fresh install.`);
    return { migrated: [], skipped: [], already: true };
  }

  const marker = await readJson(markerFile, null);
  if (marker?.version >= SCHEMA_VERSION) {
    log(`Already at schema ${marker.version}. Nothing to do.`);
    return { migrated: [], skipped: [], already: true };
  }

  const users = await readJson(usersFile, null);
  if (!Array.isArray(users)) {
    throw new Error(`${usersFile} is not an array of accounts. Refusing to guess at this tree.`);
  }

  const tournaments = (await readJson(tournamentsFile, [])) ?? [];
  if (!Array.isArray(tournaments)) {
    throw new Error(`${tournamentsFile} exists and is not an array. Refusing to overwrite it.`);
  }

  /*
   * Which accounts already have a tournament standing for them.
   *
   * This is what makes a second run a no-op and an interrupted run resumable,
   * and it is why `migratedFrom` is a stored field rather than something
   * inferred. Inferring it - "a tournament whose only member is this user" -
   * would also match a tournament somebody made by hand this morning, and
   * skipping THAT would silently strand a real workspace.
   */
  const done = new Map(tournaments.filter((t) => t?.migratedFrom).map((t) => [t.migratedFrom, t]));

  const migrated = [];
  const skipped = [];

  for (const user of users) {
    const userId = String(user?.id ?? '');
    if (!userId) continue;

    if (done.has(userId)) {
      skipped.push({ username: user.username, reason: 'already migrated', tournament: done.get(userId) });
      continue;
    }

    const from = path.join(usersDir, userId);
    const hasWorkspace = await exists(from);

    /*
     * A tournament for every account, whether or not a directory exists.
     *
     * An account that never opened a dashboard has no directory - its stores
     * were all defaults and nothing was ever written. It still had a production
     * before this ran, so it still has one after; the alternative is somebody
     * signing in on Monday to be told they are on no tournament, which reads as
     * data loss and is not.
     */
    const tournament = {
      id: randomUUID(),
      name: user.username ? `${user.username}'s production` : 'Untitled tournament',
      startsAt: '',
      endsAt: '',
      logo: '',
      members: { [userId]: 'owner' },
      createdAt: Number.isFinite(user.createdAt) ? user.createdAt : Date.now(),
      createdBy: userId,
      archivedAt: 0,
      sessionKey: randomUUID(),
      // Blank, like the account key it replaces: minted when somebody asks.
      // Carrying the old one across would hand every tournament a live remote
      // control that nobody set up.
      controlKey: '',
      migratedFrom: userId,
    };

    const to = path.join(tournamentsDir, tournament.id);

    log(
      `${apply ? 'moving ' : 'would move '}${user.username}` +
        `${hasWorkspace ? '' : ' (no workspace on disk - defaults only)'}` +
        `\n    ${path.join('users', userId)} -> ${path.join('tournaments', tournament.id)}`,
    );

    if (apply) {
      if (hasWorkspace) await moveWorkspace(from, to);
      else await mkdir(to, { recursive: true });

      /*
       * Recorded immediately, one account at a time, rather than all at the end.
       *
       * If this dies between two accounts, what is on disk and what tournaments.json
       * says agree - so the next run picks up exactly where it stopped. Batching
       * the writes would make a crash lose the record of moves that had already
       * happened, and those workspaces would then be invisible to everything.
       */
      tournaments.push(tournament);
      await writeFile(tournamentsFile, JSON.stringify(tournaments, null, 2), 'utf8');
    }

    if (apply) afterEach?.(migrated.length + 1);

    migrated.push({
      username: user.username,
      userId,
      tournamentId: tournament.id,
      name: tournament.name,
      oldKey: String(user.sessionKey ?? ''),
      newKey: tournament.sessionKey,
      hadWorkspace: hasWorkspace,
      hadControlKey: Boolean(user.controlKey),
    });
  }

  if (apply) {
    // LAST. Its absence on a tree that already has tournaments in it is the only
    // thing that says "this run did not finish".
    await writeFile(
      markerFile,
      JSON.stringify({ version: SCHEMA_VERSION, migratedAt: Date.now(), accounts: migrated.length }, null, 2),
      'utf8',
    );
  }

  return { migrated, skipped, already: false };
}

// --------------------------------------------------------------- the sheet ---

const line = (n = 74) => '-'.repeat(n);

function printSheet(migrated) {
  if (!migrated.length) return;

  console.log(`\n${line()}`);
  console.log('  KEY SHEET - every OBS source, webhook and VHUD box needs re-pasting');
  console.log(line());

  for (const entry of migrated) {
    console.log(`\n  ${entry.name}`);
    console.log(`    was   ${entry.username}'s account`);
    console.log(`    OLD   ${entry.oldKey || '(none)'}   <- stops working now`);
    console.log(`    NEW   ${entry.newKey}`);
    if (entry.hadControlKey) {
      console.log(`    NOTE  they had a Companion control key. It is NOT carried across -`);
      console.log(`          mint a new one for this tournament from the Account tab.`);
    }
  }

  console.log(`\n${line()}`);
  console.log('  Paste the NEW key into: OBS browser sources, the three webhook URLs,');
  console.log("  and VHUD's GET JSON box. The old keys resolve to nothing.");
  console.log(`${line()}\n`);
}

/*
 * Run only when invoked directly, so the suite can import migrate() instead.
 *
 * Compared as resolved URLs. This was `endsWith('migrate-tournaments.mjs')`,
 * which is true of the SUITE as well - they share a basename - so importing the
 * runner ran its command line against whatever `.state` the tests happened to
 * be beside. It was a dry run and wrote nothing, and that is luck rather than
 * design: `--apply` in argv would have migrated a real tree from inside a test.
 *
 * `file://${process.argv[1]}` on its own is not enough either. On Windows argv[1]
 * is `D:\...\migrate-tournaments.mjs`, and import.meta.url is
 * `file:///D:/.../migrate-tournaments.mjs` - three slashes and forward ones - so
 * the two never match and the script would never run at all.
 */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const result = await migrate({ apply: APPLY });

    if (result.already) {
      // Nothing to say beyond what migrate() already said.
    } else if (!APPLY) {
      console.log(`\n${result.migrated.length} account(s) would be migrated, ${result.skipped.length} skipped.`);
      console.log('Nothing has been written. Re-run with --apply to do it.');
      /*
       * Deliberately NO key sheet on a dry run.
       *
       * The keys above were generated for this preview and are not the ones
       * --apply will mint. Printing them would put a page of plausible,
       * authoritative-looking, WRONG keys in front of somebody who is about to
       * walk round a venue pasting them into OBS - and they would find out at
       * ten minutes to air. The sheet exists once, on the run that means it.
       */
      console.log('The key sheet prints on --apply, not here: these keys are not the ones you would get.\n');
    } else {
      console.log(`\nMigrated ${result.migrated.length} account(s), skipped ${result.skipped.length}.`);
      printSheet(result.migrated);
    }
  } catch (error) {
    console.error(`\nMigration refused: ${error.message}\n`);
    process.exit(1);
  }
}
