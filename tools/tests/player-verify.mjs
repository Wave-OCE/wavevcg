/**
 * PUUID verification.
 *
 * Mostly a UNIT test - no server, no port, no network - because the cases worth
 * covering here are the awkward ones: a 404 that is an answer rather than an
 * outage, a rate limit mid-batch, and a stored id the configured key can no
 * longer decrypt. Provoking those against the live APIs would need a key, a
 * network and somebody else's quota, which is a suite nobody runs; both sides
 * are injected (`henrik`, `accountGet`) precisely so they can be faked here.
 *
 * The last block does start a server, on 8177, with NO keys at all. That part
 * makes no outbound call by design - it is the route gate, and a keyless server
 * refuses before it would ever reach the network.
 *
 *   node tools/tests/player-verify.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..', '..');
const PORT = 8177;
const BASE = `http://127.0.0.1:${PORT}`;

const { ProviderError } = await import(pathToFileURL(path.join(PROJECT, 'providers.js')).href);
const { checkPuuid, resolveRiotId, splitRiotId, henrikLookups } = await import(
  pathToFileURL(path.join(PROJECT, 'riot-account.js')).href
);

let passed = 0;
const failures = [];
const ok = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${label}${detail === undefined ? '' : ` - got ${JSON.stringify(detail)}`}`);
};
const eq = (label, actual, expected) => ok(label, actual === expected, actual);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The two real values, captured from a live run so the fakes are shaped like
// the thing they stand in for rather than like what would be convenient.
const CANONICAL = '01d1e35f-7e01-50f7-be31-2b1e53d708a9';
const ENCRYPTED = 'Q3-G8S7FR8Pzxsq38H85i5XRZH9X7DsWPQIucyT-jvIkD8KOviY9bOf9kcweqFR8RtxjWvxtJyGXoQ';

const henrikOk = {
  account: async ({ gameName, tagLine }) => ({ gameName, tagLine, puuid: CANONICAL, region: 'ap' }),
  accountByPuuid: async () => ({ gameName: 'RTLine', tagLine: 'GLHF', puuid: CANONICAL, region: 'ap' }),
};
const riotOk = async (_routing, endpoint) =>
  endpoint.includes('by-puuid')
    ? { puuid: ENCRYPTED, gameName: 'RTLine', tagLine: 'GLHF' }
    : { puuid: ENCRYPTED, gameName: 'RTLine', tagLine: 'GLHF' };
const throws = (error) => async () => {
  throw error;
};

// ------------------------------------------------------- the Riot ID shape ---

ok('1 a Riot ID splits', splitRiotId('TenZ#SEN')?.gameName === 'TenZ' && splitRiotId('TenZ#SEN')?.tagLine === 'SEN');
eq('2 no hash is not one', splitRiotId('TenZ'), null);
eq('3 a trailing hash is not one', splitRiotId('TenZ#'), null);
eq('4 a leading hash is not one', splitRiotId('#SEN'), null);
eq('5 two hashes are not one', splitRiotId('a#b#c'), null);
ok('6 spaces in the game name are fine', splitRiotId('Big Name#EU')?.gameName === 'Big Name');
ok('7 surrounding whitespace is trimmed', splitRiotId('  TenZ#SEN  ')?.tagLine === 'SEN');

// --------------------------------------------------------------- resolving ---

{
  /*
   * RIOT FIRST, and the one place in this program where HenrikDev is not the
   * primary source. Verification asks Riot's own account service whether an
   * account exists and what it is called, so asking the authority is the right
   * shape - and it spends no HenrikDev budget on a roster of thirty players an
   * hour before a show.
   *
   * Note that BOTH sources are handed in here and Henrik is still not touched:
   * the assertion is about order, not about availability.
   */
  let henrikAsked = false;
  const watched = {
    account: async (parts) => {
      henrikAsked = true;
      return henrikOk.account(parts);
    },
    accountByPuuid: henrikOk.accountByPuuid,
  };
  const identity = await resolveRiotId({ riotId: 'RTLine#GLHF', henrik: watched, accountGet: riotOk, routing: 'europe' });
  eq('8 riot is preferred over henrik', identity.source, 'riot');
  eq('9 and it is riot\'s encrypted id that is stored', identity.puuid, ENCRYPTED);
  eq('9b henrik is not asked at all when riot answers', henrikAsked, false);
  eq('10 the handle comes back assembled', identity.riotId, 'RTLine#GLHF');
}

{
  // The fallback is a real one: Riot down, Henrik on, an operator still gets a
  // verified player - and it is marked henrik so the re-check knows who to ask.
  const identity = await resolveRiotId({
    riotId: 'RTLine#GLHF',
    henrik: henrikOk,
    henrikNote: 'unused - a source was handed in',
    accountGet: throws(new ProviderError(503, 'No Riot account key configured.')),
    routing: 'europe',
  });
  eq('11 henrik answers when riot cannot', identity.source, 'henrik');
  eq('12 and its id is the canonical uuid', identity.puuid, CANONICAL);
}

{
  /*
   * NULL IS THE REFUSAL. The switch lives in server.js; this file never sees a
   * setting, it sees a source or it does not. So the composite failure has to
   * carry the note the caller supplied, or an operator with a Henrik key and a
   * switch turned off is sent to look for a key they already have.
   */
  const err = await resolveRiotId({
    riotId: 'RTLine#GLHF',
    henrik: null,
    henrikNote: 'The HenrikDev fallback for verification is switched off.',
    accountGet: throws(new ProviderError(503, 'No Riot account key configured.')),
    routing: 'europe',
  }).catch((e) => e);
  ok('12b a gated-off fallback says so rather than blaming a missing key', /switched off/.test(err.hint), err.hint);
}

{
  /*
   * A 404 from the account service is an ANSWER, and the short-circuit moved
   * with the order rather than being dropped. Riot is the authority on whether
   * a Riot account exists, so there is nothing a second source could add -
   * falling through would spend somebody else's rate limit to learn what we
   * already knew and turn "no such player" into a vaguer two-source failure.
   */
  let reached = false;
  const err = await resolveRiotId({
    riotId: 'Nobody#XXXX',
    henrik: {
      account: async () => {
        reached = true;
        return { puuid: CANONICAL, gameName: 'Nobody', tagLine: 'XXXX' };
      },
      accountByPuuid: throws(new Error('x')),
    },
    accountGet: throws(new ProviderError(404, 'Account not found')),
    routing: 'europe',
  }).catch((e) => e);
  eq('13 a riot 404 is passed straight through', err.status, 404);
  eq('14 and henrik is never asked', reached, false);
}

{
  // An OUTAGE is not an answer, so the other source is tried.
  const identity = await resolveRiotId({
    riotId: 'RTLine#GLHF',
    henrik: henrikOk,
    accountGet: throws(new ProviderError(429, 'Rate limited')),
    routing: 'europe',
  });
  eq('15 a riot rate limit falls back to henrik', identity.source, 'henrik');
}

{
  const err = await resolveRiotId({
    riotId: 'RTLine#GLHF',
    henrik: { account: throws(new ProviderError(429, 'Rate limited')), accountByPuuid: throws(new Error('x')) },
    accountGet: throws(new ProviderError(503, 'No Riot account key configured.')),
    routing: 'europe',
  }).catch((e) => e);
  eq('16 both sources down is a 502', err.status, 502);
  ok('17 and the hint names both failures', err.hint.includes('HenrikDev') && err.hint.includes('Riot'), err.hint);
}

{
  const err = await resolveRiotId({ riotId: 'nothash', henrik: henrikOk, accountGet: riotOk }).catch((e) => e);
  eq('18 junk is refused before any lookup', err.status, 400);
}

// ---------------------------------------------------------------- checking ---

{
  const out = await checkPuuid({
    puuid: CANONICAL,
    puuidSource: 'henrik',
    riotId: 'RTLine#GLHF',
    henrik: henrikOk,
    accountGet: riotOk,
  });
  eq('19 an unchanged name reads ok', out.verdict, 'ok');
}

{
  const out = await checkPuuid({
    puuid: CANONICAL,
    puuidSource: 'henrik',
    riotId: 'OldName#OLD',
    henrik: henrikOk,
    accountGet: riotOk,
  });
  eq('20 a changed name reads renamed', out.verdict, 'renamed');
  eq('21 and the new handle comes with it', out.current.riotId, 'RTLine#GLHF');
}

{
  // Riot IDs are matched case-insensitively, so a difference in case is not a
  // rename. Reporting one would put an amber button on every roster whose
  // operator typed lowercase.
  const out = await checkPuuid({
    puuid: CANONICAL,
    puuidSource: 'henrik',
    riotId: 'rtline#glhf',
    henrik: henrikOk,
    accountGet: riotOk,
  });
  eq('22 case alone is not a rename', out.verdict, 'ok');
}

{
  /*
   * THE ONE THAT MATTERS. A riot-sourced id that the current key cannot decrypt
   * must read unknown, never renamed: the identity is intact and it is this
   * server that cannot read it. Collapsing the two would report every
   * riot-sourced player on every roster as renamed the morning after a key
   * rotation - a loud, plausible, entirely false alarm whose only offered
   * remedy is accepting rewrites that change nothing.
   */
  const out = await checkPuuid({
    puuid: ENCRYPTED,
    puuidSource: 'riot',
    riotId: 'RTLine#GLHF',
    henrik: henrikOk,
    accountGet: throws(new ProviderError(400, 'Bad Request - Exception decrypting 01d1e35f-...')),
  });
  eq('23 a key that cannot decrypt reads unknown, not renamed', out.verdict, 'unknown');
  ok('24 and the reason says why, and what to do', /different Riot key/i.test(out.reason) && /Re-verify/i.test(out.reason), out.reason);
  eq('25 no current identity is invented', out.current, undefined);
}

{
  // Routing by source is the whole reason the field exists. A henrik-sourced id
  // must not be sent to Riot, which would answer 400 and read as "no such
  // player" - so assert that the wrong client is never called.
  let riotCalled = false;
  await checkPuuid({
    puuid: CANONICAL,
    puuidSource: 'henrik',
    riotId: 'RTLine#GLHF',
    henrik: henrikOk,
    accountGet: async () => {
      riotCalled = true;
      return {};
    },
  });
  eq('26 a henrik id is never sent to riot', riotCalled, false);
}

{
  let henrikCalled = false;
  await checkPuuid({
    puuid: ENCRYPTED,
    puuidSource: 'riot',
    riotId: 'RTLine#GLHF',
    henrik: {
      account: async () => {
        henrikCalled = true;
        return {};
      },
      accountByPuuid: async () => {
        henrikCalled = true;
        return {};
      },
    },
    accountGet: riotOk,
  });
  eq('27 a riot id is never sent to henrik', henrikCalled, false);
}

{
  /*
   * A 200 with a thin body must not read as a rename. Both sources can answer
   * without a name - Henrik's shape is not guaranteed field by field - and the
   * unguarded comparison fell to the else, painting an amber button reading
   * "-> " whose only action was to blank the player's real Riot ID.
   */
  const out = await checkPuuid({
    puuid: CANONICAL,
    puuidSource: 'henrik',
    riotId: 'RTLine#GLHF',
    henrik: { account: throws(new Error('x')), accountByPuuid: async () => ({ gameName: '', tagLine: '', puuid: CANONICAL }) },
    accountGet: riotOk,
  });
  eq('28a a nameless answer reads unknown, not renamed', out.verdict, 'unknown');
  eq('28b and offers nothing to apply', out.current, undefined);
}

{
  const out = await checkPuuid({ puuid: CANONICAL, puuidSource: '', riotId: 'RTLine#GLHF', henrik: henrikOk, accountGet: riotOk });
  eq('28 an id with no recorded source reads unknown', out.verdict, 'unknown');
  ok('29 and says there is no way to know which API can read it', /which API/i.test(out.reason), out.reason);
}

{
  const out = await checkPuuid({ puuid: '', puuidSource: 'henrik', riotId: 'RTLine#GLHF', henrik: henrikOk, accountGet: riotOk });
  eq('30 no stored puuid reads unknown rather than throwing', out.verdict, 'unknown');
}

{
  const out = await checkPuuid({ puuid: CANONICAL, puuidSource: 'henrik', riotId: 'RTLine#GLHF', henrik: null, accountGet: riotOk });
  eq('31 a henrik id with no henrik source reads unknown', out.verdict, 'unknown');
  ok('32 and says which source it cannot reach', /HenrikDev/i.test(out.reason), out.reason);
}

{
  const out = await checkPuuid({
    puuid: CANONICAL,
    puuidSource: 'henrik',
    riotId: 'RTLine#GLHF',
    henrik: { account: throws(new Error('boom')), accountByPuuid: throws(new ProviderError(429, 'Rate limited')) },
    accountGet: riotOk,
  });
  eq('33 an outage reads unknown, not renamed', out.verdict, 'unknown');
}

// ------------------------------------------------------------- the gate ---
//
// A server with NO keys, so nothing here reaches the network.

const STATE = mkdtempSync(path.join(tmpdir(), 'rl-verify-suite-'));
const server = spawn(process.execPath, ['server.js'], {
  cwd: PROJECT,
  env: {
    ...process.env,
    PORT: String(PORT),
    STATE_DIR: STATE,
    ADMIN_USERNAME: 'boss',
    ADMIN_PASSWORD: 'a-long-enough-password',
    TRACKER_ENABLED: 'false',
    HENRIK_API_KEY: '',
    RIOT_API_KEY: '',
    RIOT_ACCOUNT_KEY: '',
    DISCORD_ENABLED: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (chunk) => (serverLog += chunk));
server.stderr.on('data', (chunk) => (serverLog += chunk));

try {
  for (let i = 0; i < 80; i += 1) {
    try {
      await fetch(`${BASE}/api/auth/state`);
      break;
    } catch {
      await wait(250);
    }
  }

  const jar = [];
  const call = async (method, p, body, cookies = jar) => {
    const response = await fetch(BASE + p, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookies.length ? { Cookie: cookies.join('; ') } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const line of response.headers.getSetCookie?.() ?? []) cookies.push(line.split(';')[0]);
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  await call('POST', '/api/auth/login', { username: 'boss', password: 'a-long-enough-password' });
  await call('POST', '/api/tournaments', { action: 'create', name: 'Gate' });

  const config = await call('GET', '/api/config');
  eq('34 a keyless server says it cannot verify', config.body.canVerifyPlayers, false);

  const refused = await call('POST', '/api/players/verify', { action: 'resolve', riotId: 'RTLine#GLHF' });
  eq('35 and refuses rather than pretending', refused.status, 502);
  ok(
    '36 naming both missing keys',
    /HenrikDev/i.test(refused.body.error?.hint ?? '') && /RIOT_ACCOUNT_KEY/i.test(refused.body.error?.hint ?? ''),
    refused.body.error?.hint,
  );

  const junk = await call('POST', '/api/players/verify', { action: 'wat' });
  eq('37 an unknown action is a 400', junk.status, 400);

  /*
   * The KEYED_ROUTES question, answered in an assertion rather than in a
   * comment: a session key is typed into OBS and read out over screen shares,
   * and this route turns one into an oracle for "does this Riot ID exist" and a
   * way to burn a tournament's lookup budget from outside.
   *
   * This asserts the LIST, not a check in the handler - there is deliberately
   * none. Adding '/api/players/verify' to KEYED_ROUTES turns 38 red.
   */
  const tournaments = await call('GET', '/api/tournaments');
  const sessionKey = tournaments.body.tournaments?.[0]?.productions?.[0]?.sessionKey;
  ok('38a the tournament minted a session key', Boolean(sessionKey));
  const keyed = await fetch(`${BASE}/api/players/verify?key=${encodeURIComponent(sessionKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'resolve', riotId: 'RTLine#GLHF' }),
  });
  eq('38 a session key cannot verify a player', keyed.status, 403);

  // A viewer may watch a production. Spending its lookup budget is not watching.
  await call('POST', '/api/admin/users', { action: 'create', username: 'guest', password: 'another-long-password' });
  const guestList = await call('GET', '/api/admin/users');
  const guest = (guestList.body.users ?? []).find((entry) => entry.username === 'guest');
  const tournamentId = tournaments.body.tournaments?.[0]?.id;
  await call('POST', '/api/tournaments', {
    action: 'member',
    id: tournamentId,
    userId: guest?.id,
    level: 'viewer',
  });

  const guestJar = [];
  await call('POST', '/api/auth/login', { username: 'guest', password: 'another-long-password' }, guestJar);
  const asViewer = await call('POST', '/api/players/verify', { action: 'resolve', riotId: 'RTLine#GLHF' }, guestJar);
  eq('39 a viewer cannot verify a player', asViewer.status, 403);

  // And redaction, in the same suite as the feature that produces the value.
  const logs = await call('GET', '/api/admin/logs');
  const buffer = JSON.stringify(logs.body);
  ok('40 no puuid reaches the admin log buffer', !buffer.includes(CANONICAL) && !buffer.includes(ENCRYPTED));
  ok('41 nor stdout', !serverLog.includes(CANONICAL) && !serverLog.includes(ENCRYPTED));
} finally {
  server.kill();
  await wait(400);
  rmSync(STATE, { recursive: true, force: true });
}

console.log(`\nplayer-verify: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exit(failures.length ? 1 : 0);
