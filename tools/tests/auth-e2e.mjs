/**
 * End-to-end over the real server: accounts, the gate, per-production
 * isolation, session keys, and the crash the survey found.
 *
 * Runs against a throwaway STATE_DIR so the operator's live config is not
 * touched. Nothing here is mocked - it spawns node server.js and talks HTTP.
 *
 * What the cutover changed here, because this is the suite it changed most:
 * a workspace used to BE an account, so "my session" and "me" were the same
 * thing and every account arrived holding a key to its own production. A
 * workspace now belongs to a TOURNAMENT and people are members of one, so
 * every assertion below that used to say "the other account's graphics" now
 * says "the other tournament's", and the grant assertions are membership.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

import { addMember, grantCapability, makeTournament } from './harness.mjs';

// The checkout this suite lives in, resolved from the suite's own location so
// that moving the tree does not break it.
const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-auth-'));

let passed = 0;
let failed = 0;
const ok = (name, condition, detail = '') => {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
};

const server = spawn(process.execPath, ['server.js'], {
  cwd: PROJECT,
  env: {
    ...process.env,
    PORT: String(PORT),
    STATE_DIR: STATE,
    ADMIN_USERNAME: 'boss',
    ADMIN_PASSWORD: 'a-long-enough-password',
    TRACKER_ENABLED: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (c) => (log += c));
server.stderr.on('data', (c) => (log += c));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function ready() {
  for (let i = 0; i < 60; i += 1) {
    try {
      await fetch(`${BASE}/api/auth/state`);
      return true;
    } catch {
      await wait(250);
    }
  }
  return false;
}

/**
 * fetch that keeps a cookie jar per caller.
 *
 * `cookie()` reads that jar out, because the shared helpers in harness.mjs take
 * a cookie string: setup goes through them so there is one description of how a
 * tournament is made, while everything this suite is actually asserting - the
 * status code a route answers with - still goes through the jar directly.
 */
function agent() {
  let cookie = '';
  const call = async (path, options = {}) => {
    const response = await fetch(`${BASE}${path}`, {
      ...options,
      redirect: 'manual',
      headers: { ...(options.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) },
    });
    const set = response.headers.getSetCookie?.() ?? [];
    for (const line of set) {
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
    return { status: response.status, headers: response.headers, text, json };
  };
  call.cookie = () => cookie;
  return call;
}

const json = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

try {
  if (!(await ready())) throw new Error(`server never came up:\n${log}`);

  const anon = agent();
  const boss = agent();

  // ---------------------------------------------------------------- open ---
  let r = await anon('/api/auth/state');
  ok('auth/state is open', r.status === 200);
  ok('auth/state says accounts exist', r.json?.empty === false, JSON.stringify(r.json));

  r = await anon('/api/config');
  ok('config is open', r.status === 200);

  r = await anon('/login.html');
  ok('login page is served', r.status === 200 && r.text.includes('login-form'));

  r = await anon('/post-match.html');
  ok('post-match page is served without a login', r.status === 200);

  // The old address, still answering for OBS sources saved before the rename.
  r = await anon('/output.html');
  ok('the old /output.html redirects rather than 404ing', r.status === 302, String(r.status));
  ok('and points at the new name', r.headers.get('location') === '/post-match.html', r.headers.get('location'));

  // The whole point of that URL is the key on the end of it, so the redirect
  // has to carry the query string or every OBS source lands on a blank page.
  r = await anon('/output.html?key=abc123&x=1');
  ok('THE REDIRECT KEEPS THE QUERY STRING', r.headers.get('location') === '/post-match.html?key=abc123&x=1', r.headers.get('location'));

  // ---------------------------------------------------------------- gate ---
  for (const route of ['/api/graphic', '/api/winner', '/api/select', '/api/global', '/api/teams', '/api/aliases', '/api/presets', '/api/media']) {
    r = await anon(route);
    ok(`anonymous GET ${route} is refused`, r.status === 401, `got ${r.status}`);
  }

  r = await anon('/api/graphic', json({ visible: true }));
  ok('anonymous POST /api/graphic is refused', r.status === 401, `got ${r.status}`);

  r = await anon('/api/admin/users');
  ok('anonymous admin is refused', r.status === 401, `got ${r.status}`);

  r = await anon('/api/tournaments');
  ok('anonymous tournaments is refused', r.status === 401, `got ${r.status}`);

  r = await anon('/');
  ok('dashboard redirects to the login', r.status === 302 && r.headers.get('location')?.startsWith('/login.html'));

  r = await anon('/api/roster', json({ eventIndex: 0, name: 'X' }));
  ok('webhook without a key is refused', r.status === 401, `got ${r.status}`);
  ok('webhook refusal explains the key', /key=/.test(r.json?.error?.message ?? ''), r.json?.error?.message);

  // --------------------------------------------------------------- login ---
  r = await boss('/api/auth/login', json({ username: 'boss', password: 'wrong' }));
  ok('wrong password is refused', r.status === 401);
  ok('refusal does not name the reason', r.json?.error?.message === 'Wrong username or password.', r.json?.error?.message);

  r = await boss('/api/auth/login', json({ username: 'nobody', password: 'wrong' }));
  ok('unknown user gets the same answer', r.json?.error?.message === 'Wrong username or password.');

  r = await boss('/api/auth/login', json({ username: 'boss', password: 'a-long-enough-password' }));
  ok('login works', r.status === 200, JSON.stringify(r.json));
  ok('login never returns the hash', !('hash' in (r.json?.user ?? {})) && !('salt' in (r.json?.user ?? {})));
  /*
   * A person has no production any more, so a login cannot hand one over.
   *
   * The user record still carries a vestigial `sessionKey` field, and this is
   * the assertion that it is vestigial: whatever a login response says, it must
   * not open a graphic. If it ever resolves again, every account is silently a
   * production of its own and the whole cutover has come apart. Checked further
   * down, once there is a real tournament key for it to be distinguished from.
   */
  const staleAccountKey = r.json?.user?.sessionKey ?? 'no-key-on-a-login-response';
  const bossId = r.json.user.id;

  /*
   * The modern first run: an administrator with no tournament has nowhere to
   * look. Not an error state - it is what everybody sees on the day they are
   * given a login, which is exactly why it has to answer cleanly rather than
   * throw.
   */
  r = await boss('/api/graphic');
  ok('an account on no tournament has no session', r.status === 403, `got ${r.status}`);
  ok('and is told so plainly', r.json?.error?.message === 'No such session.', r.json?.error?.message);

  // Creating one needs the capability. The ADMIN_USERNAME bootstrap admin has
  // it; the second account below deliberately does not.
  const bossTournament = await makeTournament(BASE, boss.cookie(), 'Main stage');
  const bossKey = bossTournament.key;
  ok('a tournament carries its own session key', typeof bossKey === 'string' && bossKey.length > 8, String(bossKey));
  ok('and it is not the leftover account field', bossKey !== staleAccountKey);

  r = await boss('/api/graphic');
  ok('signed in and on a tournament, graphic reads', r.status === 200 && Boolean(r.json?.state), `got ${r.status}`);

  r = await boss('/');
  ok('signed in, dashboard serves', r.status === 200 && r.text.includes('<title>'));

  // The topbar selector reads this, and the one rename that could not be
  // avoided is here: a production is named, not usernamed.
  r = await boss('/api/account/me');
  const mine = r.json?.sessions ?? [];
  ok('account/me lists the tournament', mine.length === 1 && mine[0]?.id === bossTournament.id, JSON.stringify(mine));
  ok('and names it rather than usernaming it', mine[0]?.name === 'Main stage' && !('username' in (mine[0] ?? {})), JSON.stringify(mine[0]));
  ok('an owner is given the key for OBS', mine[0]?.sessionKey === bossKey);

  // ----------------------------------------------------------- csrf shape ---
  r = await boss('/api/graphic', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  ok('form-shaped POST is refused', r.status === 415, `got ${r.status}`);

  r = await boss('/api/graphic', { method: 'POST', body: '{}' });
  ok('POST with no content-type is refused', r.status === 415, `got ${r.status}`);

  // ------------------------------------------------------------ own state ---
  r = await boss('/api/graphic?bus=program', json({ state: { left: { teamName: 'ALPHA' } } }));
  ok('boss can write', r.status === 200, JSON.stringify(r.json?.error));
  ok('boss write took', r.json?.state?.left?.teamName === 'ALPHA', r.json?.state?.left?.teamName);

  // ---------------------------------------------------- second account ---
  r = await boss('/api/admin/users', json({ action: 'create', username: 'operator', password: 'another-long-password' }));
  ok('admin can create a user', r.status === 200, JSON.stringify(r.json?.error));
  const operatorId = r.json?.created?.id;
  ok('created user has an id', Boolean(operatorId));

  const op = agent();
  r = await op('/api/auth/login', json({ username: 'operator', password: 'another-long-password' }));
  ok('second account logs in', r.status === 200);

  /*
   * A new account is on NO tournament and cannot make one.
   *
   * This replaces "second account has its own key", which was true when an
   * account WAS a production and is the exact thing the cutover set out to
   * stop: somebody handed a login should not silently come with a broadcast
   * workspace and a webhook URL nobody meant to give them.
   */
  r = await op('/api/graphic');
  ok(
    'a brand-new account is on no tournament',
    r.status === 403 && r.json?.error?.message === 'No such session.',
    `${r.status} ${r.json?.error?.message}`,
  );

  r = await op('/api/tournaments', json({ action: 'create', name: 'Not allowed' }));
  ok('and cannot create one without the capability', r.status === 403, `got ${r.status}`);
  ok('the refusal points at an administrator', /administrator/i.test(r.json?.error?.hint ?? ''), JSON.stringify(r.json?.error));

  await grantCapability(BASE, boss.cookie(), operatorId, 'manageTournaments');
  const opTournament = await makeTournament(BASE, op.cookie(), 'Second stage');
  const opKey = opTournament.key;
  ok('once granted, the second account can open its own production', Boolean(opKey) && opKey !== bossKey);

  r = await op('/api/graphic');
  ok('second account reads its own graphic', r.status === 200);
  ok('second account is NOT looking at the first', r.json?.state?.left?.teamName !== 'ALPHA', r.json?.state?.left?.teamName);

  r = await op('/api/graphic?bus=program', json({ state: { left: { teamName: 'BRAVO' } } }));
  ok('second account writes its own', r.json?.state?.left?.teamName === 'BRAVO');

  r = await boss('/api/graphic');
  ok('the first production is unchanged by the second', r.json?.state?.left?.teamName === 'ALPHA', r.json?.state?.left?.teamName);

  // ------------------------------------------------- cross-session access ---
  /*
   * `?session=` is a tournament id now rather than a user id, and everything
   * below it is membership rather than `user.grants`. The levels are the same
   * three and mean the same three things, which is why these assertions did not
   * change shape - only what makes two productions, and who says who may reach
   * one.
   */
  r = await op(`/api/graphic?session=${bossTournament.id}`);
  ok('not being a member means no access', r.status === 403, `got ${r.status}`);

  r = await op('/api/admin/users');
  ok('non-admin cannot administer', r.status === 403, `got ${r.status}`);

  // A tournament nobody has heard of and one you are simply not on answer the
  // same way, so the route cannot be used to discover which competitions exist.
  r = await op('/api/tournaments', json({ action: 'update', id: bossTournament.id, fields: { name: 'Mine now' } }));
  ok('a non-member cannot even see the tournament record', r.status === 404, `got ${r.status}`);

  // Asserted on the record that comes back rather than on the call not
  // throwing: "it returned 200" is the vacuous half of this, and the half that
  // matters is that the operator is on the tournament at the level asked for.
  let roster = await addMember(BASE, boss.cookie(), bossTournament.id, operatorId, 'viewer');
  ok(
    'owner can add a viewer',
    roster?.members?.find((m) => m.id === operatorId)?.level === 'viewer',
    JSON.stringify(roster?.members),
  );

  r = await op(`/api/graphic?session=${bossTournament.id}`);
  ok(
    'viewer can read the shared production',
    r.status === 200 && r.json?.state?.left?.teamName === 'ALPHA',
    `${r.status} ${r.json?.state?.left?.teamName}`,
  );

  r = await op(`/api/graphic?session=${bossTournament.id}&bus=program`, json({ state: { left: { teamName: 'HACKED' } } }));
  ok('viewer cannot write', r.status === 403, `got ${r.status}`);

  r = await boss('/api/graphic');
  ok('viewer write really did nothing', r.json?.state?.left?.teamName === 'ALPHA');

  roster = await addMember(BASE, boss.cookie(), bossTournament.id, operatorId, 'editor');
  ok(
    'owner can promote to editor',
    roster?.members?.find((m) => m.id === operatorId)?.level === 'editor',
    JSON.stringify(roster?.members),
  );

  r = await op(`/api/graphic?session=${bossTournament.id}&bus=program`, json({ state: { left: { teamName: 'SHARED' } } }));
  ok('editor can write the shared production', r.status === 200 && r.json?.state?.left?.teamName === 'SHARED');

  // An editor runs the show; only an owner changes what the show IS. Re-keying
  // takes every browser source off air, and changing the roster is the same
  // shape of power, so both are owner-only.
  r = await op('/api/tournaments', json({ action: 'rotate-key', id: bossTournament.id }));
  ok('an editor cannot re-key the production', r.status === 403, `got ${r.status}`);
  r = await op('/api/tournaments', json({ action: 'member', id: bossTournament.id, userId: bossId, level: 'viewer' }));
  ok('an editor cannot change who is on it', r.status === 403, `got ${r.status}`);

  // A falsy level removes, which is the revoke.
  r = await boss('/api/tournaments', json({ action: 'member', id: bossTournament.id, userId: operatorId, level: '' }));
  ok(
    'owner can revoke',
    r.status === 200 && !r.json?.tournament?.members?.some((m) => m.id === operatorId),
    JSON.stringify(r.json?.tournament?.members ?? r.json?.error),
  );
  r = await op(`/api/graphic?session=${bossTournament.id}`);
  ok('revoked access is gone', r.status === 403, `got ${r.status}`);

  /*
   * The three routes the cutover moved off /api/account.
   *
   * Asserted gone rather than merely unused: a key names a tournament and
   * access to one is membership of it, so all three had to land where they can
   * be owner-only. Leaving a working account-level twin behind would have been
   * a second way to share a production that no tournament knows about.
   */
  for (const gone of ['/api/account/key', '/api/account/control-key', '/api/account/grant']) {
    r = await boss(gone, json({ userId: operatorId, level: 'viewer' }));
    ok(`${gone} is gone`, r.status === 404, `got ${r.status}`);
  }

  // ------------------------------------------------------- session keys ---
  r = await anon(`/api/graphic?key=${bossKey}`);
  ok(
    'a key reads the output state',
    r.status === 200 && r.json?.state?.left?.teamName === 'SHARED',
    `${r.status} ${r.json?.state?.left?.teamName}`,
  );

  r = await anon(`/api/graphic?key=${staleAccountKey}`);
  ok('AN ACCOUNT-LEVEL KEY OPENS NOTHING', r.status === 404, `got ${r.status}`);

  r = await anon(`/api/teams?key=${bossKey}`);
  ok('a key cannot reach the libraries', r.status === 403, `got ${r.status}`);

  r = await anon(`/api/admin/users?key=${bossKey}`);
  ok('a key cannot administer', r.status === 403, `got ${r.status}`);

  r = await anon(`/api/account/me?key=${bossKey}`);
  ok('a key cannot reach the account', r.status === 403, `got ${r.status}`);

  // The question KEYED_ROUTES exists to force, answered for the new route:
  // administering a competition is further from a graphic than operating the
  // desk is, and the desk is already out of bounds.
  r = await anon(`/api/tournaments?key=${bossKey}`);
  ok('a key cannot administer a tournament', r.status === 403, `got ${r.status}`);

  r = await anon(`/api/roster?key=${bossKey}`, json({ eventIndex: 0, name: 'TenZ #SEN', character: 'Jett' }));
  ok('a key drives the roster webhook', r.status === 200, JSON.stringify(r.json?.error));

  r = await boss('/api/select');
  ok('the webhook wrote the right production', r.json?.state?.slots?.[0]?.name === 'TenZ', r.json?.state?.slots?.[0]?.name);

  r = await op('/api/select');
  ok('the webhook did not touch the other production', r.json?.state?.slots?.[0]?.name !== 'TenZ');

  r = await anon(`/api/graphic?key=${bossKey}-nope`);
  ok('a wrong key is refused', r.status === 404, `got ${r.status}`);

  // -------------------------------------------------------- key rotation ---
  r = await boss('/api/tournaments', json({ action: 'rotate-key', id: bossTournament.id }));
  const rotated = r.json?.tournament?.sessionKey;
  ok('key rotates', r.status === 200 && Boolean(rotated) && rotated !== bossKey, JSON.stringify(r.json?.error));
  r = await anon(`/api/graphic?key=${bossKey}`);
  ok('the old key stops working', r.status === 404, `got ${r.status}`);
  r = await anon(`/api/graphic?key=${rotated}`);
  ok('the new key works', r.status === 200);

  // ------------------------------------------------------------- crash ---
  r = await anon('/%ZZ');
  ok('a malformed escape is answered, not fatal', r.status === 400 || r.status === 404, `got ${r.status}`);
  r = await anon('/media/%E0%A4%A');
  ok('a malformed media escape is answered', r.status === 400 || r.status === 404, `got ${r.status}`);
  r = await anon('/api/auth/state');
  ok('the server is still alive after both', r.status === 200);

  // ---------------------------------------------------------- traversal ---
  r = await anon('/../server.js');
  ok('traversal is blocked', r.status === 403 || r.status === 404, `got ${r.status}`);
  r = await anon('/%2e%2e%2fserver.js');
  ok('encoded traversal is blocked', r.status === 403 || r.status === 404, `got ${r.status}`);

  // ------------------------------------------------------------- logout ---
  r = await boss('/api/auth/logout', json({}));
  ok('logout answers', r.status === 200);
  r = await boss('/api/graphic');
  ok('logout really ends the session', r.status === 401, `got ${r.status}`);

  // ------------------------------------------------------ disable a user ---
  const boss2 = agent();
  await boss2('/api/auth/login', json({ username: 'boss', password: 'a-long-enough-password' }));
  r = await boss2('/api/admin/users', json({ action: 'update', id: operatorId, disabled: true }));
  ok('admin can disable', r.status === 200, JSON.stringify(r.json?.error));
  r = await op('/api/graphic');
  ok('a disabled account is signed out at once', r.status === 401, `got ${r.status}`);

  /*
   * This one CHANGED MEANING, and deliberately so.
   *
   * It used to read "a disabled account's key stops working", which was right
   * when the key was the account's. A key names a tournament now, and a
   * tournament is several people's shared workspace - so disabling one member
   * must not take a live production off air. Disabling is "they lose access";
   * everything they had access to keeps running, which is the same rule that
   * stops a deleted account deleting a competition with it.
   *
   * Kept as an assertion rather than dropped, because the failure it now guards
   * against is the louder one: a guest is disabled mid-show and every browser
   * source on the tournament goes black.
   */
  r = await anon(`/api/graphic?key=${opKey}`);
  ok("disabling a member does NOT take their tournament's browser sources down", r.status === 200, `got ${r.status}`);

  // ------------------------------------------------------- last admin ---
  r = await boss2('/api/admin/users', json({ action: 'update', id: bossId, role: 'user' }));
  ok('the last admin cannot demote themselves', r.status === 400, `got ${r.status}`);
  r = await boss2('/api/admin/users', json({ action: 'delete', id: bossId }));
  ok('the last admin cannot be deleted', r.status === 400, `got ${r.status}`);

  // ---------------------------------------------------------- health ---
  r = await boss2('/api/admin/health');
  ok('health reports', r.status === 200 && r.json?.accounts === 2, JSON.stringify(r.json));
  ok('health counts open sessions', r.json?.openSessions >= 1, String(r.json?.openSessions));

  // ------------------------------------------------------ password change ---
  r = await boss2('/api/account/password', json({ current: 'wrong', password: 'yet-another-long-one' }));
  ok('a password change needs the current one', r.status === 403, `got ${r.status}`);
  r = await boss2('/api/account/password', json({ current: 'a-long-enough-password', password: 'short' }));
  ok('a short password is refused', r.status === 400, `got ${r.status}`);
  r = await boss2('/api/account/password', json({ current: 'a-long-enough-password', password: 'yet-another-long-one' }));
  ok('a password change works', r.status === 200, JSON.stringify(r.json?.error));
  r = await boss2('/api/graphic');
  ok('the changing session survives its own change', r.status === 200, `got ${r.status}`);

  const boss3 = agent();
  r = await boss3('/api/auth/login', json({ username: 'boss', password: 'a-long-enough-password' }));
  ok('the old password no longer works', r.status === 401);
  r = await boss3('/api/auth/login', json({ username: 'boss', password: 'yet-another-long-one' }));
  ok('the new password works', r.status === 200);
} catch (error) {
  failed += 1;
  console.log(`  THREW ${error.stack}`);
} finally {
  server.kill('SIGTERM');
  await wait(600);
  server.kill('SIGKILL');
  try {
    rmSync(STATE, { recursive: true, force: true });
  } catch {
    /* windows sometimes still holds it */
  }
}

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\n--- server log ---\n' + log.slice(-4000));
  process.exitCode = 1;
}
