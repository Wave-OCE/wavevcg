/**
 * End-to-end over the real server: accounts, the gate, per-session isolation,
 * session keys, and the crash the survey found.
 *
 * Runs against a throwaway STATE_DIR so the operator's live config is not
 * touched. Nothing here is mocked - it spawns node server.js and talks HTTP.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

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

/** fetch that keeps a cookie jar per caller. */
function agent() {
  let cookie = '';
  return async (path, options = {}) => {
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
  ok('login returns the session key', typeof r.json?.user?.sessionKey === 'string' && r.json.user.sessionKey.length > 8);
  ok('login never returns the hash', !('hash' in (r.json?.user ?? {})) && !('salt' in (r.json?.user ?? {})));
  const bossKey = r.json.user.sessionKey;
  const bossId = r.json.user.id;

  r = await boss('/api/graphic');
  ok('signed in, graphic reads', r.status === 200 && r.json?.state);

  r = await boss('/');
  ok('signed in, dashboard serves', r.status === 200 && r.text.includes('<title>'));

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
  const opKey = r.json?.user?.sessionKey;
  ok('second account has its own key', opKey && opKey !== bossKey);

  r = await op('/api/graphic');
  ok('second account reads its own graphic', r.status === 200);
  ok('second account is NOT looking at the first', r.json?.state?.left?.teamName !== 'ALPHA', r.json?.state?.left?.teamName);

  r = await op('/api/graphic?bus=program', json({ state: { left: { teamName: 'BRAVO' } } }));
  ok('second account writes its own', r.json?.state?.left?.teamName === 'BRAVO');

  r = await boss('/api/graphic');
  ok('first account is unchanged by the second', r.json?.state?.left?.teamName === 'ALPHA', r.json?.state?.left?.teamName);

  // ------------------------------------------------- cross-session access ---
  r = await op(`/api/graphic?session=${bossId}`);
  ok('no grant means no access', r.status === 403, `got ${r.status}`);

  r = await op('/api/admin/users');
  ok('non-admin cannot administer', r.status === 403, `got ${r.status}`);

  r = await boss('/api/account/grant', json({ userId: operatorId, level: 'viewer' }));
  ok('owner can grant viewer', r.status === 200, JSON.stringify(r.json?.error));

  r = await op(`/api/graphic?session=${bossId}`);
  ok('viewer can read the shared session', r.status === 200 && r.json?.state?.left?.teamName === 'ALPHA');

  r = await op(`/api/graphic?session=${bossId}&bus=program`, json({ state: { left: { teamName: 'HACKED' } } }));
  ok('viewer cannot write', r.status === 403, `got ${r.status}`);

  r = await boss('/api/graphic');
  ok('viewer write really did nothing', r.json?.state?.left?.teamName === 'ALPHA');

  r = await boss('/api/account/grant', json({ userId: operatorId, level: 'editor' }));
  ok('owner can promote to editor', r.status === 200);

  r = await op(`/api/graphic?session=${bossId}&bus=program`, json({ state: { left: { teamName: 'SHARED' } } }));
  ok('editor can write the shared session', r.status === 200 && r.json?.state?.left?.teamName === 'SHARED');

  r = await boss('/api/account/grant', json({ userId: operatorId, level: '' }));
  ok('owner can revoke', r.status === 200);
  r = await op(`/api/graphic?session=${bossId}`);
  ok('revoked access is gone', r.status === 403, `got ${r.status}`);

  // ------------------------------------------------------- session keys ---
  r = await anon(`/api/graphic?key=${bossKey}`);
  ok('a key reads the output state', r.status === 200 && r.json?.state?.left?.teamName === 'SHARED');

  r = await anon(`/api/teams?key=${bossKey}`);
  ok('a key cannot reach the libraries', r.status === 403, `got ${r.status}`);

  r = await anon(`/api/admin/users?key=${bossKey}`);
  ok('a key cannot administer', r.status === 403, `got ${r.status}`);

  r = await anon(`/api/account/me?key=${bossKey}`);
  ok('a key cannot reach the account', r.status === 403, `got ${r.status}`);

  r = await anon(`/api/roster?key=${bossKey}`, json({ eventIndex: 0, name: 'TenZ #SEN', character: 'Jett' }));
  ok('a key drives the roster webhook', r.status === 200, JSON.stringify(r.json?.error));

  r = await boss('/api/select');
  ok('the webhook wrote the right session', r.json?.state?.slots?.[0]?.name === 'TenZ', r.json?.state?.slots?.[0]?.name);

  r = await op('/api/select');
  ok('the webhook did not touch the other session', r.json?.state?.slots?.[0]?.name !== 'TenZ');

  r = await anon(`/api/graphic?key=${bossKey}-nope`);
  ok('a wrong key is refused', r.status === 404, `got ${r.status}`);

  // -------------------------------------------------------- key rotation ---
  r = await boss('/api/account/key', json({}));
  const rotated = r.json?.user?.sessionKey;
  ok('key rotates', r.status === 200 && rotated && rotated !== bossKey);
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
  r = await anon(`/api/graphic?key=${opKey}`);
  ok("a disabled account's key stops working", r.status === 404, `got ${r.status}`);

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
