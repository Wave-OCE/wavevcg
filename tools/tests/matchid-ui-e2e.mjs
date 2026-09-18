/**
 * The match-id panel, driven in a real browser.
 *
 * /api/match is stubbed, so no Chromium is launched and the live tracker.gg
 * profile is never opened - the point here is the wiring, not the provider.
 */
const playwright = await import(new URL('../../node_modules/playwright/index.js', import.meta.url).href);
const chromium = playwright.chromium ?? playwright.default.chromium;

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

import { openAsAdmin } from './harness.mjs';

// The checkout this suite lives in, resolved from the suite's own location so
// that moving the tree does not break it.
const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8152;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-midui-'));
const PROFILE = mkdtempSync(path.join(tmpdir(), 'rl-midprof-'));

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
    // Pointed away from the real one. resetProfile() deletes what it is given.
    PROFILE_DIR: PROFILE,
    ADMIN_USERNAME: 'boss',
    ADMIN_PASSWORD: 'a-long-enough-password',
    TRACKER_ENABLED: 'true',
    LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (c) => (log += c));
server.stderr.on('data', (c) => (log += c));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ID = '0e2a1c5f-7b3d-4a91-8c2e-5f6a7b8c9d0e';
const ID2 = 'aabbccdd-1122-3344-5566-778899aabbcc';
let browser;

const FAKE_MATCH = {
  provider: 'tracker',
  matchId: ID,
  map: 'Pearl',
  mode: 'Custom',
  teams: [
    { id: 'Blue', won: false, roundsWon: 8, roundsPlayed: 21 },
    { id: 'Red', won: true, roundsWon: 13, roundsPlayed: 21 },
  ],
  players: Array.from({ length: 10 }, (_, i) => ({
    id: `p${i}`,
    name: `Player${i}`,
    tag: 'TAG',
    teamId: i < 5 ? 'Blue' : 'Red',
    agent: 'Jett',
    kills: 20 - i,
    deaths: 10,
    assists: 5,
    acs: 300 - i * 10,
    adr: 150,
    firstKills: 2,
    hsPct: 25,
    kast: 70,
  })),
  rounds: [],
};

try {
  /*
   * Read-backs say bus=preview. This suite drives the DASHBOARD, and since
   * the preview/program split a dashboard stages - so what it typed is on
   * preview until somebody takes it, and reading air would compare against
   * the state from before the test started.
   */
  for (let i = 0; i < 80; i += 1) {
    try {
      await fetch(`${BASE}/api/auth/state`);
      break;
    } catch {
      await wait(250);
    }
  }

  /*
   * The key comes off a tournament now, not off the login. An account has none,
   * so signing in and reading `user.sessionKey` gets undefined - and the
   * webhook this whole suite is about would be posted to `key=undefined`. The
   * tournament has to exist first, which is the real order of operations rather
   * than setup noise.
   */
  const { key } = await openAsAdmin(BASE, 'boss', 'a-long-enough-password', 'Match id panel');

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // The stub. Records what the page asked for, answers however we tell it to.
  let asked = null;
  let answer = { status: 404, body: { error: { status: 404, message: 'That match could not be found on tracker.gg.', hint: 'tracker.gg has probably not indexed it yet. Wait a few seconds and press the button again.' } } };
  await page.route('**/api/match?**', async (route) => {
    asked = new URL(route.request().url());
    await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body) });
  });

  await page.goto(`${BASE}/login.html`);
  await page.fill('#login-username', 'boss');
  await page.fill('#login-password', 'a-long-enough-password');
  await page.click('#login-submit');
  await page.waitForSelector('#whoami:not([hidden])', { timeout: 10000 });
  await page.waitForTimeout(700);

  // ------------------------------------------------------- tracker only ---
  ok('the panel is hidden on henrik', await page.locator('#match-id-panel').isHidden());

  // The radio itself is styled out of the way; the label is what a person clicks.
  await page.locator('label:has(input[name="provider"][value="tracker"])').click();
  await page.waitForTimeout(400);
  ok('and shown on tracker', await page.locator('#match-id-panel').isVisible());

  const hookUrl = await page.textContent('#match-id-hook');
  ok('the webhook URL is absolute', /^https?:\/\//.test(hookUrl), hookUrl);
  ok('and carries the session key', hookUrl.includes(encodeURIComponent(key)) || hookUrl.includes(key), hookUrl);
  ok('and points at the new route', hookUrl.includes('/api/match-id'), hookUrl);

  ok('the button starts disabled', await page.locator('#match-id-go').isDisabled());

  // ------------------------------------------------ the webhook fills it ---
  await fetch(`${BASE}/api/match-id?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: ID,
  });
  await page.waitForFunction((want) => document.getElementById('match-id-input')?.value === want, ID, { timeout: 6000 });
  ok('THE WEBHOOK AUTO-POPULATED THE BOX', (await page.inputValue('#match-id-input')) === ID);
  ok('the pill says where it came from', /from the client/i.test(await page.textContent('#match-id-state')));
  ok('and the button is now enabled', await page.locator('#match-id-go').isEnabled());

  // ------------------------------------------------------ the miss case ---
  await page.click('#match-id-go');
  await page.waitForFunction(() => /not found yet/i.test(document.getElementById('match-id-state')?.textContent ?? ''), null, { timeout: 8000 });
  ok('a miss says it is not there yet', /not found yet/i.test(await page.textContent('#match-id-state')));

  ok('the request carried the match id', asked?.searchParams.get('matchId') === ID, String(asked));
  ok('and the tracker provider', asked?.searchParams.get('provider') === 'tracker', String(asked));
  ok('and NO handle', !asked?.searchParams.get('handle'), String(asked?.searchParams.get('handle')));

  const detailText = await page.textContent('#match-details');
  ok('the hint is shown in the details panel', /not indexed it yet/i.test(detailText), detailText.slice(0, 160));
  ok('the button is usable again for a retry', await page.locator('#match-id-go').isEnabled());

  // ------------------------------------------------------- the hit case ---
  answer = { status: 200, body: FAKE_MATCH };
  await page.click('#match-id-go');
  await page.waitForFunction(() => /loaded/i.test(document.getElementById('match-id-state')?.textContent ?? ''), null, { timeout: 8000 });
  ok('a hit says loaded', /loaded/i.test(await page.textContent('#match-id-state')));
  ok('the details panel filled', /Player0/.test(await page.textContent('#match-details')));

  // The whole point: it reaches the graphics tab exactly like a list pick.
  await page.waitForFunction(() => !document.getElementById('g-import')?.disabled, null, { timeout: 6000 });
  ok('THE GRAPHICS IMPORT BUTTON IS ARMED', await page.locator('#g-import').isEnabled());

  await page.click('.rail-item[data-section="match"]');
  await page.click('.tab[data-tab="graphic"]');
  await page.click('#g-import');
  await page.waitForTimeout(900);
  const graphic = await (await fetch(`${BASE}/api/graphic?bus=preview&key=${encodeURIComponent(key)}`)).json();
  ok('the import landed on the scoreboard', graphic.state?.left?.players?.[0]?.name === 'Player0', JSON.stringify(graphic.state?.left?.players?.[0]));
  ok('with the round score', graphic.state?.right?.roundsWon === 13, String(graphic.state?.right?.roundsWon));
  ok('and the map', graphic.state?.map === 'Pearl', graphic.state?.map);

  await page.click('.tab[data-tab="lookup"]');
  await page.waitForTimeout(300);

  // ------------------------------------------- typing is not overwritten ---
  await page.click('#match-id-input');
  await page.fill('#match-id-input', 'half-typed-thing');
  await fetch(`${BASE}/api/match-id?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: ID2,
  });
  await page.waitForTimeout(900);
  ok('a new id does NOT clobber the box while focused', (await page.inputValue('#match-id-input')) === 'half-typed-thing', await page.inputValue('#match-id-input'));
  ok('but the pill flags that one is waiting', /waiting/i.test(await page.textContent('#match-id-state')));

  await page.click('#match-id-panel h3'); // blur
  await page.waitForTimeout(400);
  ok('and it lands once the box is left alone', (await page.inputValue('#match-id-input')) === ID2, await page.inputValue('#match-id-input'));

  // ------------------------------------------------------------- clear ---
  await page.click('#match-id-clear');
  await page.waitForTimeout(200);
  ok('clear empties the box', (await page.inputValue('#match-id-input')) === '');
  ok('and disables the button again', await page.locator('#match-id-go').isDisabled());

  // ----------------------------------------- the other panel still works ---
  ok('the watch panel is still visible', await page.locator('#watch-panel').isVisible());

  ok('no page errors', errors.length === 0, errors.join(' | '));
} catch (error) {
  fail += 1;
  console.log('THREW', error.stack);
  console.log(log.slice(-1500));
} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGKILL');
  await wait(500);
  for (const dir of [STATE, PROFILE]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows */
    }
  }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
