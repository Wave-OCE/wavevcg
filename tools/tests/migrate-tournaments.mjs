/**
 * The migration runner, against fixture trees in temp directories.
 *
 * Never against a real `.state` - every tree here is built by hand and thrown
 * away. That is the point: this is the one script in the repo with no partial
 * undo, so the interesting cases are the ones you cannot rehearse on live data.
 *
 * The case that matters most is the interrupted run. Nothing in this server ever
 * scans `.state/users/`, so a half-finished move presents as a blank scoreboard
 * and an empty team library with no error and no log line anywhere - which is
 * why the schema marker is written last and why several assertions here are
 * about its absence rather than its contents.
 *
 * Verified by breaking the runner: see the note against each group.
 *
 *   node tools/tests/migrate-tournaments.mjs
 */
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { migrate } from '../migrate-tournaments.mjs';

let passed = 0;
let failed = 0;
const ok = (name, condition, detail = '') => {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
};

const quiet = () => {};
const dirs = [];

const exists = async (target) => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

/**
 * A `.state` tree as it looked before tournaments existed.
 *
 * `accounts` is [username, { hasWorkspace, controlKey }]. A user with no
 * workspace directory is a real case: an account that never opened a dashboard
 * has no directory, because every store was still on its defaults.
 */
async function fixture(accounts, extra = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rl-migrate-'));
  dirs.push(dir);

  const users = accounts.map(([username, options = {}], i) => ({
    id: `user-${i}-${username}`,
    username,
    role: i === 0 ? 'admin' : 'user',
    sessionKey: `old-key-${username}`,
    controlKey: options.controlKey ? `old-control-${username}` : '',
    createdAt: 1700000000000 + i,
    grants: {},
  }));

  await writeFile(path.join(dir, 'users.json'), JSON.stringify(users, null, 2), 'utf8');

  for (const [i, [, options = {}]] of accounts.entries()) {
    if (options.hasWorkspace === false) continue;
    const workspace = path.join(dir, 'users', users[i].id);
    await mkdir(workspace, { recursive: true });
    // One real store, so a move can be checked by its contents rather than by
    // the directory merely existing.
    await writeFile(
      path.join(workspace, 'graphic.json'),
      JSON.stringify({ marker: users[i].username }),
      'utf8',
    );
  }

  if (extra.tournaments) {
    await writeFile(path.join(dir, 'tournaments.json'), JSON.stringify(extra.tournaments, null, 2), 'utf8');
  }
  if (extra.marker) {
    await writeFile(path.join(dir, 'schema-version'), JSON.stringify(extra.marker), 'utf8');
  }

  return { dir, users };
}

try {
  // ------------------------------------------------------------ a dry run ---
  {
    const { dir } = await fixture([['alex'], ['sam']]);
    const result = await migrate({ stateDir: dir, apply: false, log: quiet });

    ok('1. a dry run reports both accounts', result.migrated.length === 2);
    ok('2. ...and writes no tournaments file', !(await exists(path.join(dir, 'tournaments.json'))));
    ok('3. ...and no marker', !(await exists(path.join(dir, 'schema-version'))));
    ok('4. ...and leaves the workspaces where they were', await exists(path.join(dir, 'users', 'user-0-alex')));
  }

  // -------------------------------------------------------- the clean run ---
  //
  // Break `moveWorkspace` to a no-op and 7 goes red; drop `migratedFrom` from
  // the record and 9 goes red.
  {
    const { dir, users } = await fixture([['alex'], ['sam', { controlKey: true }]]);
    const result = await migrate({ stateDir: dir, apply: true, log: quiet });

    ok('5. both accounts migrated', result.migrated.length === 2);

    const tournaments = await readJson(path.join(dir, 'tournaments.json'));
    ok('6. a tournament per account', tournaments.length === 2);

    const alex = tournaments.find((t) => t.migratedFrom === users[0].id);
    ok('7. the workspace moved, contents and all', await exists(path.join(dir, 'tournaments', alex.id, 'graphic.json')));
    const moved = await readJson(path.join(dir, 'tournaments', alex.id, 'graphic.json'));
    ok('8. ...and it is the right one', moved.marker === 'alex');
    ok('9. the tournament records where it came from', alex.migratedFrom === users[0].id);
    ok('10. the old workspace is gone', !(await exists(path.join(dir, 'users', users[0].id))));

    ok('11. the account is its sole owner', alex.members[users[0].id] === 'owner');
    ok('12. ...and nobody else is on it', Object.keys(alex.members).length === 1);
    ok('13. it is named after the account', alex.name.includes('alex'));

    ok('14. a new session key was minted', /^[0-9a-f-]{36}$/.test(alex.sessionKey));
    ok('15. ...and it is NOT the old one', alex.sessionKey !== 'old-key-alex');

    const sam = tournaments.find((t) => t.migratedFrom === users[1].id);
    ok('16. a control key is NOT carried across', sam.controlKey === '');
    ok('17. ...and the sheet says so', result.migrated.find((m) => m.username === 'sam').hadControlKey === true);

    const marker = await readJson(path.join(dir, 'schema-version'));
    ok('18. the marker was written', marker.version === 2);
    ok('19. ...and counts what it did', marker.accounts === 2);

    ok('20. the sheet carries the old key', result.migrated[0].oldKey === 'old-key-alex');
    ok('21. ...and the new one', result.migrated[0].newKey === alex.sessionKey);
  }

  // ------------------------------------------------------------- a re-run ---
  //
  // Remove the `done` check and 23 goes red with four tournaments.
  {
    const { dir } = await fixture([['alex'], ['sam']]);
    await migrate({ stateDir: dir, apply: true, log: quiet });
    const first = await readJson(path.join(dir, 'tournaments.json'));

    const again = await migrate({ stateDir: dir, apply: true, log: quiet });
    ok('22. a second run says it is already done', again.already === true);

    const second = await readJson(path.join(dir, 'tournaments.json'));
    ok('23. ...and makes no duplicates', second.length === 2, `${second.length} tournaments`);
    ok('24. ...and does not re-key anything', second[0].sessionKey === first[0].sessionKey);
  }

  // ------------------------------------------------- an interrupted run ---
  //
  // The case nothing else in this system can detect. Simulated by a tree that
  // has one tournament recorded and no marker - exactly what a crash between
  // two accounts leaves behind.
  {
    const { dir, users } = await fixture([['alex'], ['sam']]);

    // Migrate alex by hand, the way a half-run would have.
    const partial = [
      {
        id: 'already-here',
        name: "alex's production",
        members: { [users[0].id]: 'owner' },
        sessionKey: 'kept-key',
        controlKey: '',
        migratedFrom: users[0].id,
        createdAt: 1,
        createdBy: users[0].id,
        archivedAt: 0,
      },
    ];
    await writeFile(path.join(dir, 'tournaments.json'), JSON.stringify(partial, null, 2), 'utf8');
    await mkdir(path.join(dir, 'tournaments', 'already-here'), { recursive: true });
    await rm(path.join(dir, 'users', users[0].id), { recursive: true, force: true });

    ok('25. the half-migrated tree has no marker', !(await exists(path.join(dir, 'schema-version'))));

    const result = await migrate({ stateDir: dir, apply: true, log: quiet });
    ok('26. a resumed run is not refused as already done', result.already === false);
    ok('27. ...it skips the one already moved', result.skipped.length === 1);
    ok('28. ...and moves only the one left', result.migrated.length === 1 && result.migrated[0].username === 'sam');

    const tournaments = await readJson(path.join(dir, 'tournaments.json'));
    ok('29. still one tournament per account', tournaments.length === 2);
    ok('30. the already-migrated one was not re-keyed', tournaments.find((t) => t.id === 'already-here').sessionKey === 'kept-key');
    ok('31. the marker is written once it finishes', (await readJson(path.join(dir, 'schema-version'))).version === 2);
  }

  // ------------------------------- a crash mid-run, and the marker's order ---
  //
  // The property everything else rests on, and the only group that catches the
  // writes being reordered. Move the marker write ABOVE the account loop and
  // every other assertion in this file still passes - while a crashed run
  // becomes permanently unresumable, because the next one sees version >= 2 and
  // refuses. 45 and 46 are the ones that go red.
  {
    const { dir } = await fixture([['alex'], ['sam'], ['kim']]);

    let threw = null;
    try {
      await migrate({
        stateDir: dir,
        apply: true,
        log: quiet,
        afterEach: (done) => {
          if (done === 2) throw new Error('simulated crash');
        },
      });
    } catch (error) {
      threw = error.message;
    }
    ok('43. the run died partway', threw === 'simulated crash');

    const partway = await readJson(path.join(dir, 'tournaments.json'));
    ok('44. the accounts it got through are recorded', partway.length === 2, `${partway.length}`);
    ok('45. NO marker was written', !(await exists(path.join(dir, 'schema-version'))));

    // Which is the whole point: the tree can be finished rather than being
    // stuck, and the two already moved are not moved again.
    const resumed = await migrate({ stateDir: dir, apply: true, log: quiet });
    ok('46. a resumed run finishes the job', resumed.already === false && resumed.migrated.length === 1);
    ok('47. ...skipping the two already done', resumed.skipped.length === 2);

    const finished = await readJson(path.join(dir, 'tournaments.json'));
    ok('48. one tournament per account, no duplicates', finished.length === 3);
    ok('49. ...and the marker lands once it really is done', (await readJson(path.join(dir, 'schema-version'))).version === 2);
  }

  // ---------------------------------------------------- an empty install ---
  {
    const dir = await mkdtemp(path.join(tmpdir(), 'rl-migrate-empty-'));
    dirs.push(dir);
    const result = await migrate({ stateDir: dir, apply: true, log: quiet });
    ok('32. a tree with no users.json is left alone', result.already === true);
    ok('33. ...and no marker is invented for it', !(await exists(path.join(dir, 'schema-version'))));
  }

  // An install with accounts but nobody who ever opened a dashboard.
  {
    const { dir } = await fixture([['alex', { hasWorkspace: false }]]);
    const result = await migrate({ stateDir: dir, apply: true, log: quiet });
    ok('34. an account with no workspace still gets a tournament', result.migrated.length === 1);
    const tournaments = await readJson(path.join(dir, 'tournaments.json'));
    ok('35. ...with a directory ready for it', await exists(path.join(dir, 'tournaments', tournaments[0].id)));
    ok('36. ...and the run says the workspace was absent', result.migrated[0].hadWorkspace === false);
  }

  // --------------------------------------------------------- refusals ---
  //
  // A tree it does not recognise is left alone rather than guessed at.
  {
    const { dir } = await fixture([['alex']]);
    await writeFile(path.join(dir, 'users.json'), JSON.stringify({ not: 'an array' }), 'utf8');
    let threw = null;
    try {
      await migrate({ stateDir: dir, apply: true, log: quiet });
    } catch (error) {
      threw = error.message;
    }
    ok('37. a users.json that is not an array is refused', Boolean(threw), 'it proceeded');
    ok('38. ...without writing a marker', !(await exists(path.join(dir, 'schema-version'))));
  }

  {
    const { dir } = await fixture([['alex']]);
    await writeFile(path.join(dir, 'tournaments.json'), JSON.stringify({ not: 'an array' }), 'utf8');
    let threw = null;
    try {
      await migrate({ stateDir: dir, apply: true, log: quiet });
    } catch (error) {
      threw = error.message;
    }
    ok('39. a tournaments.json that is not an array is refused', Boolean(threw));
    ok('40. ...rather than overwritten', (await readJson(path.join(dir, 'tournaments.json'))).not === 'an array');
  }

  // An already-migrated tree, marker and all.
  {
    const { dir } = await fixture([['alex']], { marker: { version: 2, migratedAt: 1, accounts: 1 } });
    const result = await migrate({ stateDir: dir, apply: true, log: quiet });
    ok('41. a tree at the current schema is left alone', result.already === true);
    ok('42. ...and its workspaces are not moved', await exists(path.join(dir, 'users', 'user-0-alex')));
  }
} catch (error) {
  failed += 1;
  console.log(`  FAIL  threw - ${error.stack}`);
} finally {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
