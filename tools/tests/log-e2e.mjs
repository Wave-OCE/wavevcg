/**
 * Logging: the levels, the admin routes, and - the one that matters - that no
 * secret reaches a buffer the admin panel renders in a browser.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

import { makeTournament } from './harness.mjs';

// The checkout this suite lives in, resolved from the suite's own location so
// that moving the tree does not break it.
const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8126;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-log-'));

const PASSWORD = 'a-long-enough-password';

let passed = 0;
let failed = 0;
const ok = (name, condition, detail = '') => {
  if (condition) passed += 1;
  else {
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
    ADMIN_PASSWORD: PASSWORD,
    TRACKER_ENABLED: 'false',
    LOG_LEVEL: 'debug',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (c) => (log += c));
server.stderr.on('data', (c) => (log += c));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// `cookie()` reads the jar out, because the shared setup helpers in
// harness.mjs take a cookie string rather than an agent.
function agent() {
  let cookie = '';
  const call = async (route, options = {}) => {
    const response = await fetch(`${BASE}${route}`, {
      ...options,
      redirect: 'manual',
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
    return { status: response.status, json, text, cookie };
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
  for (let i = 0; i < 60; i += 1) {
    try {
      await fetch(`${BASE}/api/auth/state`);
      break;
    } catch {
      await wait(250);
    }
  }

  const boss = agent();
  const anon = agent();

  // Something to log: a refusal, a sign-in, a keyed read, a write, a webhook.
  await boss('/api/auth/login', json({ username: 'boss', password: 'nope' }));
  await boss('/api/auth/login', json({ username: 'boss', password: PASSWORD }));

  /*
   * The key to hunt for in the buffer belongs to a TOURNAMENT now.
   *
   * It is taken off the session list rather than off the user, because that is
   * the route the dashboard actually reads it from and it is the value that
   * ends up in an OBS URL - which is the whole reason redaction exists. The
   * leftover `user.sessionKey` field would have been the wrong string to look
   * for: it opens nothing, so finding it in a log would prove nothing either.
   */
  const made = await makeTournament(BASE, boss.cookie(), 'Logging');
  let r = await boss('/api/account/me');
  const key = r.json?.sessions?.find((s) => s.id === made.id)?.sessionKey;
  ok('got a session key to look for', typeof key === 'string' && key.length > 8, JSON.stringify(r.json?.sessions));
  ok('and it is the tournament key OBS is given', key === made.key);

  await anon(`/api/graphic?key=${key}`);
  await boss('/api/graphic?bus=program', json({ state: { anim: { visible: true, cue: 3 } } }));
  await anon(`/api/roster?key=${key}`, json({ eventIndex: 0, name: 'TenZ #SEN', character: 'Jett' }));
  for (let i = 0; i < 5; i += 1) await anon('/api/health');

  // -------------------------------------------------------------- access ---
  r = await anon('/api/admin/logs');
  ok('a stranger cannot read the log', r.status === 401, `got ${r.status}`);

  r = await boss('/api/admin/users', json({ action: 'create', username: 'operator', password: 'another-long-password' }));
  const op = agent();
  await op('/api/auth/login', json({ username: 'operator', password: 'another-long-password' }));
  r = await op('/api/admin/logs');
  ok('a non-admin cannot read the log', r.status === 403, `got ${r.status}`);
  r = await op('/api/admin/logs', json({ level: 'error' }));
  ok('a non-admin cannot change the level', r.status === 403, `got ${r.status}`);

  // -------------------------------------------------------------- shape ---
  r = await boss('/api/admin/logs?limit=500');
  ok('the log reads', r.status === 200, JSON.stringify(r.json?.error));
  ok('it reports the level', r.json?.level === 'debug', r.json?.level);
  ok('and the levels available', Array.isArray(r.json?.levels) && r.json.levels.length === 4);
  ok('and a cursor', Number.isFinite(r.json?.cursor) && r.json.cursor > 0);
  ok('there are entries', (r.json?.entries?.length ?? 0) > 5, String(r.json?.entries?.length));
  ok('newest first', r.json.entries[0].seq > r.json.entries[1].seq);

  const all = r.json.entries;
  const text = JSON.stringify(all);

  // ------------------------------------------------------- the secrets ---
  //
  // The whole reason redaction happens on the way in: this buffer is rendered
  // in a browser, so anything in it has already left the server.
  ok('the session key is nowhere in the log', !text.includes(key), 'the key leaked into the buffer');
  ok('no password is in the log', !text.includes(PASSWORD) && !text.includes('another-long-password'));
  ok('no password hash or salt is in the log', !/"(hash|salt)":"[0-9a-f]{8}/.test(text));
  ok('no cookie is in the log', !/rl_session=[0-9a-f]{16}/.test(text));

  const keyed = all.filter((entry) => entry.message.includes('key='));
  ok('keyed requests were logged', keyed.length >= 2, String(keyed.length));
  ok('and every one is redacted', keyed.every((entry) => entry.message.includes('key=<hidden>')), JSON.stringify(keyed[0]));

  const refusal = all.find((entry) => entry.tag === 'auth' && entry.message === 'sign-in refused');
  ok('a failed sign-in is logged', Boolean(refusal), JSON.stringify(all.filter((e) => e.tag === 'auth')));
  ok('at warn', refusal?.level === 'warn', refusal?.level);
  ok('with the username attempted', refusal?.meta?.username === 'boss', JSON.stringify(refusal?.meta));
  ok('and never the password tried', !JSON.stringify(refusal).includes('nope'));

  // ------------------------------------------------------------ content ---
  ok('a sign-in is logged', all.some((e) => e.tag === 'auth' && e.message.includes('boss signed in')));
  ok('a session opening is logged', all.some((e) => e.tag === 'session' && e.message.includes('opened')));
  ok('an admin action is logged', all.some((e) => e.tag === 'admin' && e.message.includes('created the account')));
  ok('what went on air is logged', all.some((e) => e.tag === 'air' && e.message === 'scoreboard on'));
  ok('the feed is logged', all.some((e) => e.tag === 'feed' && e.message.includes('roster')));

  const requests = all.filter((entry) => entry.tag === 'request');
  ok('requests are logged with a status', requests.every((entry) => Number.isFinite(entry.meta?.status)));
  ok('and a duration', requests.every((entry) => Number.isFinite(entry.meta?.ms)));
  ok('and who made them', requests.every((entry) => typeof entry.meta?.who === 'string'));
  ok('a keyed request is marked as such', requests.some((entry) => entry.meta.who.includes('(key)')));

  // Five health checks were sent. None of them belong in a log.
  ok('the health check is never logged', !all.some((entry) => entry.message.includes('/api/health')));

  // ------------------------------------------------------------- levels ---
  r = await boss(`/api/admin/logs?level=warn&limit=500`);
  ok('filtering by level works', r.json.entries.every((entry) => entry.level === 'warn' || entry.level === 'error'));
  ok('and returns fewer than everything', r.json.entries.length < all.length);

  r = await boss('/api/admin/logs?tag=air&limit=500');
  ok('filtering by tag works', r.json.entries.length > 0 && r.json.entries.every((entry) => entry.tag === 'air'));

  const cursor = (await boss('/api/admin/logs?limit=1')).json.cursor;
  await boss('/api/graphic?bus=program', json({ state: { anim: { visible: false, cue: 4 } } }));
  r = await boss(`/api/admin/logs?since=${cursor}&limit=500`);
  ok('since returns only what is new', r.json.entries.every((entry) => entry.seq > cursor));
  ok('and does return the new lines', r.json.entries.length > 0, String(r.json.entries.length));

  // ------------------------------------------------------ level, at runtime ---
  r = await boss('/api/admin/logs', json({ level: 'nonsense' }));
  ok('a bad level is refused', r.status === 400, `got ${r.status}`);

  r = await boss('/api/admin/logs', json({ level: 'warn' }));
  ok('the level can be lowered', r.json?.level === 'warn', JSON.stringify(r.json));

  const beforeQuiet = (await boss('/api/admin/logs?limit=1')).json.cursor;
  await boss('/api/graphic');
  await boss('/api/graphic');
  r = await boss(`/api/admin/logs?since=${beforeQuiet}&limit=500`);
  ok('debug lines stop being recorded', !r.json.entries.some((entry) => entry.level === 'debug'), JSON.stringify(r.json.entries));

  // The audit trail has to survive being turned down - it is the one line that
  // explains why the log went quiet.
  r = await boss('/api/admin/logs?level=warn&limit=500');
  ok('who lowered it is still recorded', r.json.entries.some((e) => e.tag === 'admin' && e.message.includes('set the log level to warn')), 'the audit line was lost');

  r = await boss('/api/admin/logs', json({ level: 'debug' }));
  ok('and raised again', r.json?.level === 'debug');

  // ------------------------------------------------------------ console ---
  ok('the console carries the same lines', log.includes('boss signed in'), log.slice(-400));
  ok('and the console never shows the key', !log.includes(key), 'the key reached stdout');
  ok('and never a password', !log.includes(PASSWORD));
} catch (error) {
  failed += 1;
  console.log(`  THREW ${error.stack}`);
} finally {
  server.kill('SIGTERM');
  await wait(700);
  server.kill('SIGKILL');
  try {
    rmSync(STATE, { recursive: true, force: true });
  } catch {
    /* windows */
  }
}

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\n--- server log ---\n' + log.slice(-4000));
  process.exitCode = 1;
}
