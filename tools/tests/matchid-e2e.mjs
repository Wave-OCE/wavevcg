/**
 * The match-id webhook, end to end against a real server.
 *
 * What matters: the key opens it and nothing else does, the id reaches the
 * right session's stream and only that one, and a lookup by id alone is no
 * longer refused for want of a Riot ID.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

// The checkout this suite lives in, resolved from the suite's own location so
// that moving the tree does not break it.
const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8151;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-mid-'));

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass += 1;
  else {
    fail += 1;
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
    LOG_LEVEL: 'info',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (c) => (log += c));
server.stderr.on('data', (c) => (log += c));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ID = '0e2a1c5f-7b3d-4a91-8c2e-5f6a7b8c9d0e';
const ID2 = 'aabbccdd-1122-3344-5566-778899aabbcc';

/** Collect named SSE events for a while, then give them back. */
async function collect(url, eventName, ms, after = async () => {}, headers = {}) {
  const controller = new AbortController();
  const seen = [];
  const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/event-stream', ...headers } });
  if (!response.ok) throw new Error(`stream ${url} answered ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const name = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (name === eventName && data) seen.push(JSON.parse(data));
        }
      }
    } catch {
      /* aborted */
    }
  })();

  await wait(250); // let the replay frame land
  await after();
  await wait(ms);
  controller.abort();
  await pump.catch(() => {});
  return seen;
}

try {
  for (let i = 0; i < 80; i += 1) {
    try {
      await fetch(`${BASE}/api/auth/state`);
      break;
    } catch {
      await wait(250);
    }
  }

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'a-long-enough-password' }),
  });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((l) => l.split(';')[0]).join('; ');
  const me = (await login.json()).user;
  const key = me.sessionKey;

  const hook = (body, headers = {}, k = key) =>
    fetch(`${BASE}/api/match-id?key=${encodeURIComponent(k)}`, { method: 'POST', headers, body });

  // ------------------------------------------------------------ the gate ---
  const noKey = await fetch(`${BASE}/api/match-id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ matchId: ID }),
  });
  ok('no key is refused', noKey.status === 401, String(noKey.status));
  const noKeyBody = await noKey.json();
  ok('and says to add a key, not to sign in', /key=/.test(noKeyBody.error?.message ?? ''), noKeyBody.error?.message);

  const badKey = await hook(ID, { 'Content-Type': 'text/plain' }, 'not-a-real-key');
  ok('a key that names nobody is refused', badKey.status === 401 || badKey.status === 404, String(badKey.status));

  // The key must not have grown reach. /api/teams is not a keyed route.
  const overreach = await fetch(`${BASE}/api/teams?key=${encodeURIComponent(key)}`);
  ok('the key still opens nothing else', overreach.status === 403, String(overreach.status));

  // ---------------------------------------------------------- body shapes ---
  const bare = await hook(ID, { 'Content-Type': 'text/plain' });
  ok('a bare string with text/plain is accepted', bare.status === 200, String(bare.status));
  const bareBody = await bare.json();
  ok('and echoes the id', bareBody.matchId === ID, JSON.stringify(bareBody));
  ok('and reports it as fresh', bareBody.fresh === true, JSON.stringify(bareBody));

  const again = await hook(ID, { 'Content-Type': 'text/plain' });
  ok('re-posting the same id is not fresh', (await again.json()).fresh === false);

  const noType = await hook(ID2, {});
  ok('no content-type at all is accepted on the key path', noType.status === 200, String(noType.status));

  const asJson = await hook(JSON.stringify({ matchId: ID }), { 'Content-Type': 'application/json' });
  ok('{matchId} is accepted', asJson.status === 200 && (await asJson.json()).matchId === ID);

  const nested = await hook(JSON.stringify({ events: [{ data: JSON.stringify({ matchId: ID2 }) }] }), {
    'Content-Type': 'application/json',
  });
  ok('a nested json-string envelope is accepted', nested.status === 200 && (await nested.json()).matchId === ID2);

  const junk = await hook('not an id at all', { 'Content-Type': 'text/plain' });
  ok('junk is refused with 400', junk.status === 400, String(junk.status));
  const junkBody = await junk.json();
  ok('and the 400 carries a hint', Boolean(junkBody.error?.hint), JSON.stringify(junkBody.error));

  const traversal = await hook('../../../etc/passwd', { 'Content-Type': 'text/plain' });
  ok('a path is refused', traversal.status === 400, String(traversal.status));

  const empty = await hook('', { 'Content-Type': 'text/plain' });
  ok('an empty body is refused', empty.status === 400, String(empty.status));

  // ------------------------------------------------------------- the SSE ---
  // Replay: a dashboard opening now must find the last id already waiting.
  const replay = await collect(`${BASE}/api/events`, 'matchFeed', 400, async () => {}, { Cookie: cookie });
  ok('the stream replays the held id', replay[0]?.state?.matchId === ID2, JSON.stringify(replay[0]?.state));

  // Live: an id posted while connected arrives.
  const live = await collect(
    `${BASE}/api/events`,
    'matchFeed',
    700,
    async () => {
      await hook(ID, { 'Content-Type': 'text/plain' });
    },
    { Cookie: cookie },
  );
  ok('a live post reaches the stream', live.some((f) => f.state?.matchId === ID), JSON.stringify(live.map((f) => f.state?.matchId)));
  ok('the replay frame came first', live[0]?.state?.matchId === ID2, JSON.stringify(live[0]?.state));

  // -------------------------------------------------- session isolation ---
  await fetch(`${BASE}/api/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ action: 'create', username: 'second', password: 'another-long-password', role: 'user' }),
  });
  const login2 = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'second', password: 'another-long-password' }),
  });
  const second = (await login2.json()).user;

  if (!second?.sessionKey) {
    ok('a second account was made', false, JSON.stringify(second));
  } else {
    ok('a second account was made', true);
    const other = await collect(`${BASE}/api/events?key=${encodeURIComponent(second.sessionKey)}`, 'matchFeed', 600, async () => {
      await hook('11112222-3333-4444-5555-666677778888', { 'Content-Type': 'text/plain' }, key);
    });
    const leaked = other.some((f) => f.state?.matchId);
    ok("THE OTHER SESSION'S FEED STAYS EMPTY", !leaked, JSON.stringify(other.map((f) => f.state)));
  }

  // ------------------------------------------- match lookup with no handle ---
  // Tracker is off in this server, so the refusal must be about tracker being
  // off - NOT about a missing Riot ID, which is the guard that was relaxed.
  const byId = await fetch(`${BASE}/api/match?provider=tracker&matchId=${ID}`, { headers: { Cookie: cookie } });
  const byIdBody = await byId.json();
  ok(
    'a handle-less tracker lookup is not refused for want of a Riot ID',
    !/riot id/i.test(byIdBody.error?.message ?? ''),
    JSON.stringify(byIdBody.error),
  );

  // The list route still demands one - it has nowhere else to look.
  const listNoHandle = await fetch(`${BASE}/api/matches?provider=tracker`, { headers: { Cookie: cookie } });
  const listBody = await listNoHandle.json();
  ok('the match LIST is still refused without a Riot ID', listNoHandle.status >= 400, JSON.stringify(listBody.error));

  // ------------------------------------------------------------ the log ---
  ok('the id is in the log', log.includes(ID), 'not logged');
  ok('no session key reached the log', !log.includes(key), 'KEY LEAKED TO LOG');
  ok('no password reached the log', !log.includes('a-long-enough-password'), 'PASSWORD LEAKED');
} catch (error) {
  fail += 1;
  console.log('THREW', error.stack);
  console.log(log.slice(-1500));
} finally {
  server.kill('SIGKILL');
  await wait(400);
  try {
    rmSync(STATE, { recursive: true, force: true });
  } catch {
    /* windows */
  }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
