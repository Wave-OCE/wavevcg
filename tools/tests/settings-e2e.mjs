/**
 * The two administrator switches: tracker.gg, and the multi-account post-match
 * watch. Asserts the server enforces them, not just that the panel hides.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

import { addMember, makeTournament } from './harness.mjs';

// The checkout this suite lives in, resolved from the suite's own location so
// that moving the tree does not break it.
const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8125;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-set-'));

let passed = 0;
let failed = 0;
const ok = (name, condition, detail = '') => {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
};

// TRACKER_ENABLED on, so the switch is a switch rather than a missing
// capability. Playwright never actually launches: every assertion below is
// refused before a browser would be needed, or asks for a source that is off.
const server = spawn(process.execPath, ['server.js'], {
  cwd: PROJECT,
  env: {
    ...process.env,
    PORT: String(PORT),
    STATE_DIR: STATE,
    ADMIN_USERNAME: 'boss',
    ADMIN_PASSWORD: 'a-long-enough-password',
    TRACKER_ENABLED: 'true',
    /*
     * Pinned, because loadDotEnv only fills what is ABSENT - so without these
     * the henrikVerify block below would pass or fail on whether the developer
     * running it happens to have keys in .env. A Henrik key that is present but
     * nonsense is exactly what is wanted: HENRIK_AVAILABLE is a Boolean() of
     * it, and with the switch off nothing ever dials out with it.
     */
    HENRIK_API_KEY: 'pinned-not-a-real-key',
    RIOT_ACCOUNT_KEY: '',
    RIOT_API_KEY: '',
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
    return { status: response.status, json, text };
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
  await boss('/api/auth/login', json({ username: 'boss', password: 'a-long-enough-password' }));

  /*
   * A production to look at, before any lookup will answer.
   *
   * The switches themselves are server-wide and do not need one - but the
   * routes they gate are the match lookups, and those sit behind the session
   * gate. An account on no tournament is refused with "No such session." before
   * the switch is ever consulted, so without this every assertion below about a
   * tracker refusal would be passing on the wrong 403.
   */
  const tournament = await makeTournament(BASE, boss.cookie(), 'Settings');

  // -------------------------------------------------------- defaults on ---
  let r = await boss('/api/admin/settings');
  ok('settings read', r.status === 200, JSON.stringify(r.json));
  ok('tracker defaults on', r.json?.settings?.tracker === true);
  ok('watch defaults on', r.json?.settings?.watch === true);
  ok('tracker reports available', r.json?.available?.tracker === true);

  r = await boss('/api/config');
  ok('config says tracker is on', r.json?.trackerEnabled === true);
  ok('config says watch is on', r.json?.watchEnabled === true);
  ok('config says tracker is available', r.json?.trackerAvailable === true);

  // ---------------------------------------------------- only admins may ---
  r = await boss('/api/admin/users', json({ action: 'create', username: 'operator', password: 'another-long-password' }));
  ok('made a second account', r.status === 200, JSON.stringify(r.json?.error));
  const operatorId = r.json?.created?.id;
  ok('the new account has an id', Boolean(operatorId));

  const op = agent();
  await op('/api/auth/login', json({ username: 'operator', password: 'another-long-password' }));

  /*
   * The second account works ON the competition, as an editor.
   *
   * It used to need nothing but a login, because an account was a production.
   * It now needs to be a member of one, and an editor rather than a viewer,
   * because two of the assertions below are about what happens once a request
   * is PAST the session gate: that the watch switch refuses everybody and not
   * just administrators, and that the tracker-login permission refuses somebody
   * who is otherwise entitled to drive this production. A stranger would be
   * refused earlier, for a different reason, and prove neither.
   */
  await addMember(BASE, boss.cookie(), tournament.id, operatorId, 'editor');

  r = await op('/api/admin/settings');
  ok('a non-admin cannot read the switches', r.status === 403, `got ${r.status}`);
  r = await op('/api/admin/settings', json({ settings: { watch: false } }));
  ok('a non-admin cannot throw them', r.status === 403, `got ${r.status}`);
  r = await anon('/api/admin/settings', json({ settings: { watch: false } }));
  ok('nor can a stranger', r.status === 401, `got ${r.status}`);

  // ------------------------------------------- the tracker login permission ---
  //
  // A per-account flag, off by default. It is not implied by having an account:
  // what it opens is an interactive keyboard on a real browser on this machine.

  r = await boss('/api/account/me');
  ok('an admin may open a tracker login', r.json?.user?.mayOpenTrackerLogin === true, JSON.stringify(r.json?.user));
  ok('an admin does not need the flag set', r.json?.user?.trackerLogin === false, JSON.stringify(r.json?.user));

  r = await op('/api/account/me');
  ok('a new account may not', r.json?.user?.mayOpenTrackerLogin === false, JSON.stringify(r.json?.user));

  r = await op('/api/tracker/login', json({}));
  ok('and is refused when it tries', r.status === 403, `got ${r.status}`);
  ok('the refusal says who can change it', /administrator/i.test(r.json?.error?.message ?? ''), r.json?.error?.message);

  r = await op('/tracker-login/vnc.html');
  ok('the viewer is refused too', r.status === 403, `got ${r.status}`);

  r = await anon('/tracker-login/vnc.html');
  ok('and to a stranger it is a 401', r.status === 401, `got ${r.status}`);

  // Granting it.
  r = await boss('/api/admin/users', json({ action: 'update', id: operatorId, trackerLogin: true }));
  ok('an admin can grant it', r.status === 200, JSON.stringify(r.json?.error));
  ok('the listing reports it', r.json?.users?.find((u) => u.id === operatorId)?.trackerLogin === true);

  r = await op('/api/account/me');
  ok('the account now says it may', r.json?.user?.mayOpenTrackerLogin === true);

  // 503 rather than 403: past the permission, and refused only because no solve
  // is running. That is the check under test - the proxy is not the subject.
  r = await op('/tracker-login/vnc.html');
  ok('the viewer is past the permission', r.status === 503, `got ${r.status}`);

  // Revoking it.
  r = await boss('/api/admin/users', json({ action: 'update', id: operatorId, trackerLogin: false }));
  ok('an admin can revoke it', r.json?.users?.find((u) => u.id === operatorId)?.trackerLogin === false);

  r = await op('/api/tracker/login', json({}));
  ok('and it is refused again', r.status === 403, `got ${r.status}`);

  r = await op('/api/admin/users', json({ action: 'update', id: operatorId, trackerLogin: true }));
  ok('a non-admin cannot grant it to themselves', r.status === 403, `got ${r.status}`);

  // With the source switched off, the permission is moot for everybody.
  await boss('/api/admin/settings', json({ settings: { tracker: false } }));
  r = await boss('/api/tracker/login', json({}));
  ok('even an admin is refused when the source is off', r.status === 400, `got ${r.status}`);
  await boss('/api/admin/settings', json({ settings: { tracker: true } }));

  // --------------------------------------------------------- watch, off ---
  r = await boss('/api/admin/settings', json({ settings: { watch: false } }));
  ok('watch switches off', r.status === 200 && r.json?.settings?.watch === false, JSON.stringify(r.json));
  ok('the other switches are untouched', r.json?.settings?.tracker === true && r.json?.settings?.discord === true);

  r = await boss('/api/matches?provider=henrik&handle=TenZ%23SEN&watch=1');
  ok('a watch lookup is refused', r.status === 403, `got ${r.status}`);
  ok('the refusal names the setting', /several accounts/.test(r.json?.error?.message ?? ''), r.json?.error?.message);

  r = await op('/api/matches?provider=henrik&handle=TenZ%23SEN&watch=1');
  ok('refused for everyone, not just admins', r.status === 403, `got ${r.status}`);

  r = await boss('/api/config');
  ok('config now says watch is off', r.json?.watchEnabled === false);

  r = await boss('/api/admin/health');
  ok('health reports the watch is off', r.json?.watch === false);

  // A plain lookup is untouched by the watch switch. Henrik may answer 4xx from
  // upstream for a made-up handle, but never the 403 above.
  r = await boss('/api/matches?provider=henrik&handle=TenZ%23SEN');
  ok('an ordinary lookup still runs', r.status !== 403, `got ${r.status}`);

  r = await boss('/api/admin/settings', json({ settings: { watch: true } }));
  ok('watch switches back on', r.json?.settings?.watch === true);
  r = await boss('/api/matches?provider=henrik&handle=TenZ%23SEN&watch=1');
  ok('a watch lookup runs again', r.status !== 403, `got ${r.status}`);

  // ------------------------------------------------------- tracker, off ---
  r = await boss('/api/admin/settings', json({ settings: { tracker: false } }));
  ok('tracker switches off', r.json?.settings?.tracker === false);

  r = await boss('/api/matches?provider=tracker&handle=TenZ%23SEN');
  ok('a tracker lookup is refused', r.status === 400, `got ${r.status}`);
  ok('the refusal points at the panel', /switched off/.test(r.json?.error?.message ?? ''), r.json?.error?.message);

  r = await boss('/api/match?provider=tracker&handle=TenZ%23SEN&matchId=abc');
  ok('a tracker detail is refused', r.status === 400, `got ${r.status}`);

  r = await boss('/api/account?provider=tracker&riotId=TenZ%23SEN');
  ok('a tracker account lookup is refused', r.status === 400, `got ${r.status}`);

  r = await boss('/api/tracker/login', json({}));
  ok('the Cloudflare login is refused', r.status === 400, `got ${r.status}`);
  ok('and says why', /switched off/.test(r.json?.error?.message ?? ''), r.json?.error?.message);

  r = await boss('/api/config');
  ok('config now says tracker is off', r.json?.trackerEnabled === false);
  ok('but still reports it as available', r.json?.trackerAvailable === true);

  r = await boss('/api/admin/health');
  ok('health separates off from unavailable', r.json?.tracker?.enabled === false && r.json?.tracker?.available === true);
  ok('health says no browser is open', r.json?.tracker?.browserOpen === false);

  // HenrikDev must be entirely unaffected.
  r = await boss('/api/matches?provider=henrik&handle=TenZ%23SEN');
  ok('HenrikDev is unaffected', !/switched off/.test(r.json?.error?.message ?? ''), r.json?.error?.message);

  r = await boss('/api/admin/settings', json({ settings: { tracker: true } }));
  ok('tracker switches back on', r.json?.settings?.tracker === true);
  r = await boss('/api/config');
  ok('config follows it back on', r.json?.trackerEnabled === true);

  // -------------------------------------------------------- persistence ---
  r = await boss('/api/admin/settings', json({ settings: { watch: false, tracker: false, discord: false } }));
  ok('all three switch off together', r.json?.settings?.watch === false && r.json?.settings?.tracker === false && r.json?.settings?.discord === false);

  // ------------------------------------------------------- discord, off ---
  // The switch is enforced in the gate, not just hidden in a panel. Discord is
  // unconfigured for this run, so the routes must be gone either way - what is
  // asserted here is that the SETTING exists, round-trips and defaults on.
  r = await boss('/api/admin/settings');
  ok('the discord switch exists', typeof r.json?.settings?.discord === 'boolean', JSON.stringify(r.json?.settings));
  ok('and reports unavailable without the environment', r.json?.available?.discord === false, JSON.stringify(r.json?.available));

  r = await boss('/api/auth/discord/start');
  ok('the start route is absent when unconfigured', r.status === 404, String(r.status));
  r = await boss('/api/auth/discord/callback?code=x&state=y');
  ok('so is the callback', r.status === 404, String(r.status));

  // ------------------------------------------- henrik as a verify fallback ---
  /*
   * The one switch in SETTING_FIELDS that defaults OFF, and the assertion is
   * worth having precisely because it contradicts the rule the rest of the file
   * follows. A well-meaning tidy-up that gave it `default: true` for
   * consistency would turn HenrikDev back into a source that engages by itself
   * and silently changes which API can re-check a player - with nothing else in
   * this suite noticing.
   */
  r = await boss('/api/admin/settings');
  ok('the henrik verify switch exists', typeof r.json?.settings?.henrikVerify === 'boolean', JSON.stringify(r.json?.settings));
  ok('and it is the one that defaults OFF', r.json?.settings?.henrikVerify === false, String(r.json?.settings?.henrikVerify));
  ok('a configured key reads as available', r.json?.available?.henrik === true, JSON.stringify(r.json?.available));

  /*
   * ENFORCED, not merely hidden. With no Riot key and the fallback off there is
   * no source at all, and the refusal has to say which of the two problems it
   * is: an operator holding a Henrik key must not be sent looking for one.
   *
   * Nothing dials out here. Riot refuses locally for want of a key, and Henrik
   * is never constructed - which is the whole point of the assertion.
   */
  r = await boss('/api/players/verify', json({ action: 'resolve', riotId: 'Nobody#XXXX' }));
  ok('verification is refused with no source', r.status >= 400, String(r.status));
  ok(
    'and the refusal names the SWITCH rather than a missing key',
    /switched off/i.test(`${r.json?.error?.hint ?? ''} ${r.json?.error?.message ?? ''}`),
    `${r.json?.error?.message ?? ''} | ${r.json?.error?.hint ?? ''}`,
  );

  r = await boss('/api/config');
  ok('config reports the fallback off', r.json?.henrikVerifyEnabled === false, String(r.json?.henrikVerifyEnabled));
  ok('and offers no verify button with no source at all', r.json?.canVerifyPlayers === false, String(r.json?.canVerifyPlayers));

  await boss('/api/admin/settings', json({ settings: { henrikVerify: true } }));
  r = await boss('/api/config');
  ok('switching it on restores the button', r.json?.canVerifyPlayers === true, String(r.json?.canVerifyPlayers));
  ok('and names henrik as what would mint the id', r.json?.verifySource === 'henrik', String(r.json?.verifySource));
  await boss('/api/admin/settings', json({ settings: { henrikVerify: false } }));
} catch (error) {
  failed += 1;
  console.log(`  THREW ${error.stack}`);
} finally {
  server.kill('SIGTERM');
  await wait(700);
  server.kill('SIGKILL');
}

// It has to survive the process to count: read the file back off disk.
try {
  const saved = JSON.parse(await readFile(path.join(STATE, 'settings.json'), 'utf8'));
  ok('the switches are on disk', saved.watch === false && saved.tracker === false, JSON.stringify(saved));
} catch (error) {
  ok('the switches are on disk', false, error.message);
}

/*
 * And that a settings.json written before a switch existed reads as the
 * default rather than as off - a new feature arriving disabled on every server
 * that upgrades is exactly the surprise sanitiseSettings exists to prevent.
 */
try {
  const { sanitiseSettings } = await import(
    new URL('../../public/settings-schema.js', import.meta.url).href
  );
  const old = sanitiseSettings({ version: 1, tracker: false });
  ok('an unknown switch defaults on', old.watch === true, JSON.stringify(old));
  ok('a known one is kept', old.tracker === false, JSON.stringify(old));
  ok('rubbish falls back to the defaults', sanitiseSettings(null).watch === true);
  ok('a non-boolean is not coerced', sanitiseSettings({ watch: 'yes' }).watch === true);
} catch (error) {
  ok('schema check ran', false, error.message);
}

try {
  rmSync(STATE, { recursive: true, force: true });
} catch {
  /* windows */
}

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\n--- server log ---\n' + log.slice(-3000));
  process.exitCode = 1;
}
