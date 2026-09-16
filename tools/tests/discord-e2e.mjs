/**
 * End-to-end over the real server: the Discord role-gated sign-in.
 *
 * Discord itself is a fake on a second port, reached through DISCORD_API_BASE
 * and DISCORD_AUTHORIZE_URL - the same `config.baseUrl ?? CONSTANT` seam
 * providers.js uses. Nothing about the flow is stubbed inside the server: it
 * really mints a PKCE challenge, really exchanges a code, really reads a member
 * object and really decides on the roles it finds.
 *
 * Runs against a throwaway STATE_DIR. It cannot touch live operator config.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

// The checkout this suite lives in, resolved from the suite's own location so
// that moving the tree does not break it.
const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8127;
const FAKE_PORT = 8128;
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-discord-'));

const GUILD = '111111111111111111';
const ROLE_OPERATOR = '222222222222222222';
const ROLE_CASTER = '333333333333333333';
const ROLE_ADMIN = '444444444444444444';

let passed = 0;
let failed = 0;
const ok = (name, condition, detail = '') => {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
};

// ------------------------------------------------------------ fake discord ---

/**
 * What the next member read will answer with. The suite rewrites this between
 * cases rather than starting a new server each time.
 */
const discord = {
  member: null,
  memberStatus: 200,
  tokenStatus: 200,
  exchanges: 0,
  lastForm: null,
};

const fakeDiscord = createServer((req, res) => {
  const url = new URL(req.url, FAKE);

  if (url.pathname === '/oauth2/token' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      discord.exchanges += 1;
      discord.lastForm = Object.fromEntries(new URLSearchParams(body));
      res.writeHead(discord.tokenStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(discord.tokenStatus === 200 ? { access_token: 'fake-access-token' } : { error: 'nope' }));
    });
    return;
  }

  if (url.pathname === `/users/@me/guilds/${GUILD}/member`) {
    res.writeHead(discord.memberStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(discord.member ?? {}));
    return;
  }

  // The authorize page. A browser would render it; the suite only ever reads
  // the URL the server sent it to.
  if (url.pathname === '/oauth2/authorize') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><p>fake consent');
    return;
  }

  res.writeHead(404).end();
});

// ------------------------------------------------------------- the server ---

const server = spawn(process.execPath, ['server.js'], {
  cwd: PROJECT,
  env: {
    ...process.env,
    PORT: String(PORT),
    STATE_DIR: STATE,
    ADMIN_USERNAME: 'boss',
    ADMIN_PASSWORD: 'a-long-enough-password',
    TRACKER_ENABLED: 'false',
    LOG_LEVEL: 'warn',
    DISCORD_ENABLED: 'true',
    DISCORD_CLIENT_ID: 'fake-client-id',
    DISCORD_CLIENT_SECRET: 'fake-client-secret',
    DISCORD_GUILD_ID: GUILD,
    DISCORD_ROLE_OPERATOR: `${ROLE_OPERATOR}, ${ROLE_CASTER}`,
    DISCORD_ROLE_ADMIN: ROLE_ADMIN,
    DISCORD_ROLE_NAME: 'Production',
    DISCORD_PUBLIC_ORIGIN: BASE,
    DISCORD_API_BASE: FAKE,
    DISCORD_AUTHORIZE_URL: `${FAKE}/oauth2/authorize`,
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

/** A browser: keeps both cookies, follows nothing automatically. */
function agent() {
  const jar = new Map();
  const call = async (target, options = {}) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const response = await fetch(target.startsWith('http') ? target : `${BASE}${target}`, {
      ...options,
      redirect: 'manual',
      headers: { ...(options.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) },
    });
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (value === '') jar.delete(name);
      else jar.set(name, value);
    }
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: response.status, headers: response.headers, text, json, location: response.headers.get('location') };
  };
  call.jar = jar;
  return call;
}

/** Walk one whole sign-in, and hand back the callback's response. */
async function signIn(who, { mode = 'signin', tamper = null, agentToUse = null } = {}) {
  const me = agentToUse ?? agent();
  discord.member = who;

  const started = await call(me, mode);
  if (started.status !== 302) return { started, callback: null, me };

  const authorize = new URL(started.location);
  const state = tamper?.state ?? authorize.searchParams.get('state');
  const callback = await me(`/api/auth/discord/callback?code=${tamper?.code ?? 'fake-code'}&state=${encodeURIComponent(state)}`);
  return { started, callback, me, authorize };
}

const call = (me, mode) => (mode === 'link' ? me('/api/auth/discord/start') : me('/api/auth/discord/start'));

const member = (id, username, roles, nick = undefined) => ({ user: { id, username }, roles, ...(nick ? { nick } : {}) });

const errorOf = (response) => new URL(response.location, BASE).searchParams.get('e');
const noteOf = (response) => new URL(response.location, BASE).searchParams.get('discord');

// ------------------------------------------------------------------ tests ---

try {
  await new Promise((resolve) => fakeDiscord.listen(FAKE_PORT, '127.0.0.1', resolve));
  if (!(await ready())) throw new Error(`server never came up:\n${log}`);

  // ------------------------------------------------------------- state ---
  const anon = agent();
  const state = await anon('/api/auth/state');
  ok('state advertises Discord', state.json?.discord?.role === 'Production', JSON.stringify(state.json?.discord));
  ok('state does not leak the client id', !state.text.includes('fake-client-id'), state.text);
  ok('state does not leak the guild id', !state.text.includes(GUILD), state.text);
  ok('state does not leak a role id', !state.text.includes(ROLE_OPERATOR), state.text);

  // ------------------------------------------------------------- start ---
  const begin = await anon('/api/auth/discord/start?next=%2Findex.html');
  ok('start redirects', begin.status === 302, String(begin.status));
  const auth = new URL(begin.location);
  ok('start points at the authorize URL', auth.origin + auth.pathname === `${FAKE}/oauth2/authorize`, begin.location);
  ok('start asks for the two scopes', auth.searchParams.get('scope') === 'identify guilds.members.read');
  ok('start sends a PKCE challenge', (auth.searchParams.get('code_challenge') ?? '').length > 20);
  ok('start uses S256', auth.searchParams.get('code_challenge_method') === 'S256');
  ok('start sends the redirect URI', auth.searchParams.get('redirect_uri') === `${BASE}/api/auth/discord/callback`);
  ok('start forces consent', auth.searchParams.get('prompt') === 'consent');
  ok('start never sends the secret', !begin.location.includes('fake-client-secret'), begin.location);
  ok('start sets a flow cookie', anon.jar.has('rl_oauth'));
  ok('the flow cookie is not the login cookie', !anon.jar.has('rl_session'));

  const startPost = await anon('/api/auth/discord/start', { method: 'POST' });
  ok('start refuses POST', startPost.status === 405, String(startPost.status));

  const crossSite = await agent()('/api/auth/discord/start', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  ok('start refuses a cross-site navigation', errorOf(crossSite) === 'start', crossSite.location);

  // --------------------------------------------------------- callback ---
  const noCookie = await agent()('/api/auth/discord/callback?code=x&state=y');
  ok('a callback with no flow cookie is refused', errorOf(noCookie) === 'expired', noCookie.location);

  const wrongState = await signIn(member('900000000000000001', 'nobody', [ROLE_OPERATOR]), {
    tamper: { state: 'not-the-right-state' },
  });
  ok('a callback with the wrong state is refused', errorOf(wrongState.callback) === 'expired', wrongState.callback.location);

  const shortState = await signIn(member('900000000000000002', 'nobody', [ROLE_OPERATOR]), { tamper: { state: 'x' } });
  ok('a short state does not crash the server', shortState.callback.status === 302, String(shortState.callback.status));
  ok('a short state is refused', errorOf(shortState.callback) === 'expired', shortState.callback.location);

  // ------------------------------------------------------- the role gate ---
  const outsider = await signIn(member('900000000000000010', 'outsider', ['999999999999999999']));
  ok('somebody with no permitted role is refused', errorOf(outsider.callback) === 'norole', outsider.callback.location);
  ok('and got no login cookie', !outsider.me.jar.has('rl_session'));

  discord.memberStatus = 404;
  const notInGuild = await signIn(member('900000000000000011', 'stranger', [ROLE_OPERATOR]));
  ok('somebody outside the guild is refused', errorOf(notInGuild.callback) === 'norole', notInGuild.callback.location);
  discord.memberStatus = 200;

  const malformed = await signIn({ user: { id: '900000000000000012', username: 'weird' }, roles: 'not-an-array' });
  ok('a malformed roles field fails closed', errorOf(malformed.callback) === 'norole', malformed.callback.location);

  discord.memberStatus = 500;
  const down = await signIn(member('900000000000000013', 'unlucky', [ROLE_OPERATOR]));
  ok('Discord being down is reported as unavailable', errorOf(down.callback) === 'unavailable', down.callback.location);
  discord.memberStatus = 200;

  discord.tokenStatus = 400;
  const badSecret = await signIn(member('900000000000000014', 'unlucky', [ROLE_OPERATOR]));
  ok('a refused exchange is reported as misconfigured', errorOf(badSecret.callback) === 'misconfigured', badSecret.callback.location);
  discord.tokenStatus = 200;

  // ------------------------------------------------------- a real sign-in ---
  const casterId = '900000000000000100';
  const first = await signIn(member(casterId, 'caster', [ROLE_OPERATOR]));
  ok('a role holder is signed in', first.callback.status === 302, String(first.callback.status));
  ok('and lands on the path they asked for', new URL(first.callback.location, BASE).pathname === '/', first.callback.location);
  ok('and gets a login cookie', first.me.jar.has('rl_session'));
  ok('and the flow cookie is cleared', !first.me.jar.has('rl_oauth'));

  const me = await first.me('/api/account/me');
  ok('the account exists', me.json?.user?.username === 'caster', JSON.stringify(me.json?.user));
  ok('it is not an admin', me.json?.user?.role === 'user', me.json?.user?.role);
  ok('it has no password', me.json?.user?.hasPassword === false);
  ok('it is marked as a Discord account', me.json?.user?.discord?.tag === 'caster');
  ok('and never ships a hash', !me.text.includes('"hash"'), me.text.slice(0, 200));

  ok('the exchange sent the PKCE verifier', Boolean(discord.lastForm?.code_verifier));
  ok('the exchange sent the secret in the body, not a URL', discord.lastForm?.client_secret === 'fake-client-secret');

  // -------------------------------------------------------- the replay ---
  // The one an attacker actually runs: reuse a captured cookie and state.
  const captured = await signIn(member('900000000000000101', 'replayer', [ROLE_OPERATOR]));
  ok('the first use works', captured.me.jar.has('rl_session'));

  const replayAgent = agent();
  replayAgent.jar.set('rl_oauth', captured.me.jar.get('rl_oauth') ?? 'gone');
  const capturedState = new URL(captured.started.location).searchParams.get('state');
  const before = discord.exchanges;
  const replay = await replayAgent(`/api/auth/discord/callback?code=fake-code&state=${encodeURIComponent(capturedState)}`);
  ok('a replayed flow is refused', errorOf(replay) === 'expired', replay.location);
  ok('and never reached Discord', discord.exchanges === before, `${discord.exchanges} vs ${before}`);
  ok('and minted no login', !replayAgent.jar.has('rl_session'));

  // ------------------------------------------------- the same person again ---
  const again = await signIn(member(casterId, 'caster-renamed-on-discord', [ROLE_OPERATOR]));
  const againMe = await again.me('/api/account/me');
  ok('the same snowflake reuses the account', againMe.json?.user?.username === 'caster', againMe.json?.user?.username);
  ok('a Discord rename does not rename the operator', againMe.json?.user?.username === 'caster');
  ok('but the displayed handle follows', againMe.json?.user?.discord?.tag === 'caster-renamed-on-discord');

  // ------------------------------------------------------ a second role id ---
  const second = await signIn(member('900000000000000200', 'analyst', [ROLE_CASTER]));
  ok('the second permitted role also works', second.me.jar.has('rl_session'), second.callback.location);

  // ---------------------------------------------------- username collision ---
  const clash = await signIn(member('900000000000000300', 'caster', [ROLE_OPERATOR]));
  const clashMe = await clash.me('/api/account/me');
  ok('a colliding handle is suffixed', clashMe.json?.user?.username === 'caster-2', clashMe.json?.user?.username);

  const messy = await signIn(member('900000000000000301', 'Riot | Xander!!', [ROLE_OPERATOR]));
  const messyMe = await messy.me('/api/account/me');
  ok('an unusable handle is sanitised', /^[a-z0-9][a-z0-9._-]{1,31}$/.test(messyMe.json?.user?.username ?? ''), messyMe.json?.user?.username);

  const squatter = await signIn(member('900000000000000302', 'boss', [ROLE_OPERATOR]));
  const squatterMe = await squatter.me('/api/account/me');
  ok('the bootstrap admin name cannot be squatted', squatterMe.json?.user?.username !== 'boss', squatterMe.json?.user?.username);
  ok('and the squatter is not an admin', squatterMe.json?.user?.role === 'user');

  // ------------------------------------------------------------ next path ---
  const bounced = agent();
  await bounced('/api/auth/discord/start?next=%2F%5Cevil.com');
  const evil = await signIn(member('900000000000000400', 'wanderer', [ROLE_OPERATOR]), { agentToUse: bounced });
  ok('an off-origin next is not followed', !String(evil.callback.location).includes('evil.com'), evil.callback.location);

  // -------------------------------------------------------- the admin role ---
  const bossAgent = agent();
  const asBoss = await bossAgent('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'a-long-enough-password' }),
  });
  ok('the password door still works', asBoss.status === 200, String(asBoss.status));

  const promoted = await signIn(member(casterId, 'caster', [ROLE_OPERATOR, ROLE_ADMIN]));
  const promotedMe = await promoted.me('/api/account/me');
  ok('the admin role promotes an existing account', promotedMe.json?.user?.role === 'admin', promotedMe.json?.user?.role);

  const demoted = await signIn(member(casterId, 'caster', [ROLE_OPERATOR]));
  const demotedMe = await demoted.me('/api/account/me');
  ok('losing the admin role demotes again', demotedMe.json?.user?.role === 'user', demotedMe.json?.user?.role);

  // A brand new admin-role holder must NOT be born an admin.
  const newAdmin = await signIn(member('900000000000000500', 'newcomer', [ROLE_OPERATOR, ROLE_ADMIN]));
  const newAdminMe = await newAdmin.me('/api/account/me');
  ok('a new account is never born an admin', newAdminMe.json?.user?.role === 'user', newAdminMe.json?.user?.role);

  // ----------------------------------------------------------- disabled ---
  const list = await bossAgent('/api/admin/users');
  const target = list.json?.users?.find((u) => u.username === 'analyst');
  ok('the admin list marks a Discord account', Boolean(target?.discord?.tag), JSON.stringify(target?.discord));
  ok('the admin list carries the snowflake', target?.discord?.id === '900000000000000200', JSON.stringify(target?.discord));

  await bossAgent('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'update', id: target.id, disabled: true }),
  });
  const blocked = await signIn(member('900000000000000200', 'analyst', [ROLE_CASTER]));
  ok('a disabled account cannot sign in with Discord', errorOf(blocked.callback) === 'disabled', blocked.callback.location);
  ok('and gets no login cookie', !blocked.me.jar.has('rl_session'));

  // ------------------------------------------------------ no account swap ---
  const swap = await signIn(member(casterId, 'caster', [ROLE_OPERATOR]), { agentToUse: bossAgent });
  ok('signing in as somebody else does not swap the session', noteOf(swap.callback) === 'notswitched', swap.callback.location);
  const stillBoss = await bossAgent('/api/account/me');
  ok('and the original login survives', stillBoss.json?.user?.username === 'boss', stillBoss.json?.user?.username);

  // ---------------------------------------------------------- linking ---
  const bossLink = await bossAgent('/api/account/discord/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  ok('link hands back an authorize URL', String(bossLink.json?.authorize ?? '').startsWith(`${FAKE}/oauth2/authorize`), bossLink.text);
  ok('link sets a flow cookie', bossAgent.jar.has('rl_oauth'));

  const linkState = new URL(bossLink.json.authorize).searchParams.get('state');
  const bossSnowflake = '900000000000000900';
  discord.member = member(bossSnowflake, 'boss-on-discord', [ROLE_OPERATOR]);

  // THE CRITICAL: the signed cookie alone must decide nothing. A different
  // browser holding it - or the same one after signing out - must be refused.
  const thief = agent();
  thief.jar.set('rl_oauth', bossAgent.jar.get('rl_oauth'));
  const stolen = await thief(`/api/auth/discord/callback?code=fake-code&state=${encodeURIComponent(linkState)}`);
  ok('a link cookie alone cannot bind an identity', noteOf(stolen) === 'notyours', stolen.location);

  const stillUnlinked = await bossAgent('/api/account/me');
  ok('and the account is untouched', stillUnlinked.json?.user?.discord === null, JSON.stringify(stillUnlinked.json?.user?.discord));

  // The real one, from the browser that asked.
  const relink = await bossAgent('/api/account/discord/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const goodState = new URL(relink.json.authorize).searchParams.get('state');
  const linked = await bossAgent(`/api/auth/discord/callback?code=fake-code&state=${encodeURIComponent(goodState)}`);
  ok('the owner can link', noteOf(linked) === 'linked', linked.location);

  const bossNow = await bossAgent('/api/account/me');
  ok('the link is recorded', bossNow.json?.user?.discord?.tag === 'boss-on-discord', JSON.stringify(bossNow.json?.user?.discord));
  ok('and the password door is still open', bossNow.json?.user?.hasPassword === true);

  // ----------------------------------------------------- clear password ---
  const wrongPass = await bossAgent('/api/account/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: 'not-the-password', clearPassword: true }),
  });
  ok('clearing a password needs the current one', wrongPass.status === 403, String(wrongPass.status));

  const lastAdmin = await bossAgent('/api/account/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: 'a-long-enough-password', clearPassword: true }),
  });
  ok('the last password-holding admin cannot remove their password', lastAdmin.status >= 400, String(lastAdmin.status));
  ok('and the reason names the fix', /another administrator/i.test(lastAdmin.text), lastAdmin.text.slice(0, 200));

  // ------------------------------------------------------------ unlink ---
  const unlinkNoPass = await first.me('/api/account/discord/unlink', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  ok('a passwordless account cannot unlink itself', unlinkNoPass.status >= 400, String(unlinkNoPass.status));
  ok('and is told to get a password first', /password/i.test(unlinkNoPass.text), unlinkNoPass.text.slice(0, 200));

  const unlinked = await bossAgent('/api/account/discord/unlink', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  ok('an account with a password can unlink', unlinked.status === 200, unlinked.text.slice(0, 200));
  const afterUnlink = await bossAgent('/api/account/me');
  ok('and the link is gone', afterUnlink.json?.user?.discord === null);
  ok('and they are still signed in', afterUnlink.json?.user?.username === 'boss');

  // ------------------------------------------------------- admin unlink ---
  const users2 = await bossAgent('/api/admin/users');
  const casterRow = users2.json?.users?.find((u) => u.username === 'caster');
  const adminUnlink = await bossAgent('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'unlink-discord', id: casterRow.id }),
  });
  ok('an admin cannot strand a passwordless account', adminUnlink.status >= 400, String(adminUnlink.status));
  ok('there is no admin link action at all', /Unknown user action/.test(
    (await bossAgent('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'link-discord', id: casterRow.id, discordId: '900000000000000999' }),
    })).text,
  ));

  // --------------------------------------------------------- admin CSRF ---
  const noType = await bossAgent('/api/admin/users', { method: 'POST', body: JSON.stringify({ action: 'sign-out', id: casterRow.id }) });
  ok('an admin POST with no Content-Type is refused', noType.status === 415, String(noType.status));

  const formType = await bossAgent('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'action=delete',
  });
  ok('an admin POST with a form Content-Type is refused', formType.status === 415, String(formType.status));

  // ------------------------------------------------------------- health ---
  const health = await bossAgent('/api/admin/health');
  ok('health reports Discord as available', health.json?.discord?.available === true, JSON.stringify(health.json?.discord));
  ok('health reports it enabled', health.json?.discord?.enabled === true);
  ok('health counts both roles', health.json?.discord?.roles === 2, String(health.json?.discord?.roles));
  ok('health counts linked accounts', health.json?.discord?.linked >= 1, String(health.json?.discord?.linked));
  ok('health never ships a secret', !health.text.includes('fake-client-secret') && !health.text.includes(GUILD), health.text.slice(0, 300));

  // --------------------------------------------------- the kill switch ---
  // A hidden panel is a courtesy, not a control: the switch has to be enforced
  // in the gate. This is the case settings-e2e cannot reach, because there
  // Discord is unconfigured and the routes are absent for a different reason.
  const settingsOn = await bossAgent('/api/admin/settings');
  ok('the switch reports available', settingsOn.json?.available?.discord === true, JSON.stringify(settingsOn.json?.available));
  ok('and defaults on', settingsOn.json?.settings?.discord === true, JSON.stringify(settingsOn.json?.settings));

  await bossAgent('/api/admin/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { discord: false } }),
  });

  const offState = await agent()('/api/auth/state');
  ok('the login page stops advertising Discord', offState.json?.discord === null, JSON.stringify(offState.json?.discord));

  const offStart = await agent()('/api/auth/discord/start');
  ok('start is refused while switched off', offStart.status === 404, String(offStart.status));

  const offCallback = await agent()('/api/auth/discord/callback?code=x&state=y');
  ok('the callback is refused too', offCallback.status === 404, String(offCallback.status));

  const offLink = await bossAgent('/api/account/discord/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  ok('linking is refused while switched off', offLink.status === 404, String(offLink.status));

  // A live session is NOT ended by the switch - it stops new sign-ins.
  const stillIn = await first.me('/api/account/me');
  ok('an existing Discord session survives the switch', stillIn.json?.user?.username === 'caster', stillIn.text.slice(0, 120));

  await bossAgent('/api/admin/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { discord: true } }),
  });
  const backOn = await agent()('/api/auth/discord/start');
  ok('and it comes straight back on', backOn.status === 302, String(backOn.status));

  // ------------------------------------------------------ nothing leaked ---
  ok('the client secret never reaches the log', !log.includes('fake-client-secret'));
  ok('the access token never reaches the log', !log.includes('fake-access-token'));
  const logs = await bossAgent('/api/admin/logs');
  ok('nor the log buffer', !logs.text.includes('fake-client-secret') && !logs.text.includes('fake-access-token'));
  ok('nor an authorization code', !logs.text.includes('fake-code'), logs.text.slice(0, 300));
} catch (error) {
  failed += 1;
  console.log('THREW', error.stack);
  console.log(log.slice(-2000));
} finally {
  fakeDiscord.close();
  server.kill('SIGTERM');
  await wait(600);
  server.kill('SIGKILL');
  try {
    rmSync(STATE, { recursive: true, force: true });
  } catch {
    /* windows holds handles briefly */
  }
}

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
