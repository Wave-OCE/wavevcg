/**
 * The legacy read, and the rules that make a permission different from a switch.
 *
 * A unit test with no server and no port: it writes a users.json by hand in the
 * shape a previous version wrote, loads it through the real store, and asserts
 * on what comes back.
 *
 * This covers the one irreversible thing in the capability change. cleanUser is
 * an allowlist - anything it does not name is dropped on load and erased on the
 * next write - so a record written before `capabilities` existed carries
 * `trackerLogin` at the top level and nothing else, and the FIRST login after
 * deploy rewrites it. Get the fallback wrong and every account's tracker
 * permission is cleared with no error, nothing in the log, and no way afterwards
 * to tell which accounts had held it.
 *
 * Verified by deleting the `trackerLogin` fallback in cleanUser: 1 and 2 go red.
 *
 *   node tools/tests/capability-migration.mjs
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { makeUserStore, publicUser, canOpenTrackerLogin } from '../../auth.js';
import { can, sanitiseCapabilities } from '../../public/capability-schema.js';

const dir = await mkdtemp(path.join(tmpdir(), 'rl-caps-'));
const file = path.join(dir, 'users.json');

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? '  ok  ' : 'FAIL  '}${label}` +
      (ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`),
  );
};

/*
 * Exactly what a users.json looked like before capabilities existed: the
 * permission is a top-level boolean and there is no `capabilities` key at all.
 */
await writeFile(
  file,
  JSON.stringify([
    { id: 'u-old-on', username: 'holder', role: 'user', trackerLogin: true },
    { id: 'u-old-off', username: 'plain', role: 'user', trackerLogin: false },
    { id: 'u-old-admin', username: 'boss', role: 'admin' },
    // A record written AFTER the change, where somebody explicitly turned the
    // permission off. The stale mirror beside it must not resurrect it.
    {
      id: 'u-new-off',
      username: 'revoked',
      role: 'user',
      trackerLogin: true,
      capabilities: { trackerLogin: false },
    },
  ]),
  'utf8',
);

const users = makeUserStore(file);
check('the store loaded', await users.load(), true);

const holder = users.byId('u-old-on');
const plain = users.byId('u-old-off');
const boss = users.byId('u-old-admin');
const revoked = users.byId('u-new-off');

// --- the legacy read -------------------------------------------------------

check('1. an old record keeps its permission', holder.capabilities.trackerLogin, true);
check('2. ...and canOpenTrackerLogin still answers yes', canOpenTrackerLogin(holder), true);
check('3. an old record without it stays without it', plain.capabilities.trackerLogin, false);
check('4. the old top-level field is mirrored, not dropped', holder.trackerLogin, true);
check('5. an explicit false beats a stale top-level true', revoked.capabilities.trackerLogin, false);
check('6. ...and the mirror is rewritten to match', revoked.trackerLogin, false);

// --- permissions default closed -------------------------------------------

check('7. a capability nobody has heard of is off', holder.capabilities.manageTournaments, false);
check('8. ...on an administrator too', boss.capabilities.manageTournaments, false);

// --- adminImplied is per capability ---------------------------------------

check('9. admin implies trackerLogin without the flag', can(boss, 'trackerLogin'), true);
check('10. admin does NOT imply manageTournaments', can(boss, 'manageTournaments'), false);
check('11. a non-admin holder still gets their own', can(holder, 'trackerLogin'), true);

// --- fail closed -----------------------------------------------------------

check('12. an unknown capability is refused', can(boss, 'notAThing'), false);
check('13. ...and a misspelling is not a back door', can(holder, 'trackerlogin'), false);
check('14. no user at all is refused', can(null, 'trackerLogin'), false);

// A string "true" from a form, a 1, a truthy object: none of these are `true`.
check(
  '15. only an exact true grants',
  sanitiseCapabilities({ trackerLogin: 'true', manageTournaments: 1 }),
  { trackerLogin: false, manageTournaments: false },
);

// --- a patch preserves, and cannot grant by omission ------------------------

const patched = sanitiseCapabilities(
  { manageTournaments: true },
  { trackerLogin: true, manageTournaments: false },
);
check('16. a patch keeps what it did not mention', patched.trackerLogin, true);
check('17. ...and applies what it did', patched.manageTournaments, true);
check(
  '18. an empty patch grants nothing and loses nothing',
  sanitiseCapabilities({}, { trackerLogin: true, manageTournaments: false }),
  { trackerLogin: true, manageTournaments: false },
);

// --- the projection --------------------------------------------------------

const shown = publicUser(boss);
check('19. publicUser sends the stored flags', shown.capabilities.trackerLogin, false);
check('20. ...and the resolved answer beside them', shown.may.trackerLogin, true);
check('21. ...which differ exactly where adminImplied applies', shown.may.manageTournaments, false);
check('22. the old projection still answers', shown.mayOpenTrackerLogin, true);

// --- writing through the store ---------------------------------------------

await users.update('u-old-off', { capabilities: { manageTournaments: true } });
const promoted = users.byId('u-old-off');
check('23. a capability can be granted', promoted.capabilities.manageTournaments, true);
check('24. ...without disturbing another', promoted.capabilities.trackerLogin, false);

await users.update('u-old-on', { trackerLogin: false });
const demoted = users.byId('u-old-on');
check('25. the old single-permission spelling still writes', demoted.capabilities.trackerLogin, false);
check('26. ...and keeps the mirror in step', demoted.trackerLogin, false);

await users.flush?.();
await rm(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
