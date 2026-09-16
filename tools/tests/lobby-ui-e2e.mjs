/**
 * The lobby staging panel, driven in a real browser.
 *
 * The two that matter: the agent names an operator reads are the *public* ones
 * resolved from the catalogue (the feed sends "Sarge"), and the board does not
 * reflow as a lobby fills up one event at a time.
 */
const playwright = await import(new URL('../../node_modules/playwright/index.js', import.meta.url).href);
const chromium = playwright.chromium ?? playwright.default.chromium;

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

// The checkout this suite lives in, resolved from the suite's own location so
// that moving the tree does not break it.
const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8172;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-lobbyui-'));

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
    LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (c) => (log += c));
server.stderr.on('data', (c) => (log += c));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;

const roster = (index, name, character, teammate) => ({
  gameId: 21640,
  feature: 'match_info',
  event: 'roster',
  category: 'match_info',
  eventIndex: index,
  data: JSON.stringify({ name, player_id: `pid-${index}`, character, rank: 21, local: false, teammate }),
});

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
  const key = (await login.json()).user.sessionKey;

  const hook = (body) =>
    fetch(`${BASE}/api/lobby?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${BASE}/login.html`);
  await page.fill('#login-username', 'boss');
  await page.fill('#login-password', 'a-long-enough-password');
  await page.click('#login-submit');
  await page.waitForSelector('#whoami:not([hidden])', { timeout: 10000 });
  await page.waitForTimeout(1600);

  // ------------------------------------------------------------ present ---
  // Its own page now, not a section under the lookup. The two were unrelated
  // jobs sharing a column: lookup answers "what happened in that game", this
  // answers "who is in this lobby", and they happen at opposite ends of a map.
  await page.click('.rail-item[data-tab="setup"]');
  await page.waitForTimeout(400);
  ok('the panel is on the Match setup page', await page.locator('#lobby-panel').isVisible());
  ok('and NOT on the lookup tab', await page.evaluate(() => {
    const panel = document.getElementById('lobby-panel');
    return panel !== null && panel.closest('#tab-lookup') === null;
  }));

  const hookUrl = await page.textContent('#lobby-hook');
  ok('the hook URL is absolute', /^https?:\/\//.test(hookUrl), hookUrl);
  ok('and carries the session key', hookUrl.includes(key) || hookUrl.includes(encodeURIComponent(key)), hookUrl);
  ok('and points at /api/lobby', hookUrl.includes('/api/lobby'), hookUrl);

  const exportUrl = await page.textContent('#lobby-export');
  ok('the GStack URL is absolute', /^https?:\/\//.test(exportUrl), exportUrl);
  ok('and points at /api/gstack', exportUrl.includes('/api/gstack'), exportUrl);
  ok('and is not the same URL as the hook', exportUrl !== hookUrl);

  ok('Stage starts disabled', await page.locator('#lobby-stage').isDisabled());
  ok('the pill says it is waiting', /waiting/i.test(await page.textContent('#lobby-state')));

  // Ten rows painted from the start - five a side, empty.
  const rowsAtRest = await page.locator('#lobby-left .lobby-row').count();
  ok('five rows a side before anything arrives', rowsAtRest === 5, String(rowsAtRest));

  // The board must not move as the lobby fills. Measured, not assumed.
  const boxBefore = await page.locator('.lobby-board').boundingBox();

  // ----------------------------------------------------- the hook fills ---
  await hook([
    roster(0, 'Ally1#AAA', 'Sarge', true),
    roster(1, 'Ally2#AAA', 'Wraith', true),
    roster(5, 'Foe1#BBB', 'Thorne', false),
  ]);
  await page.waitForTimeout(700);

  ok('the left column filled', (await page.textContent('#lobby-left')).includes('Ally1#AAA'));
  ok('the right column filled', (await page.textContent('#lobby-right')).includes('Foe1#BBB'));

  /*
   * The point of the whole exercise. The feed said "Sarge"; an operator must
   * see Brimstone, because that is what the catalogue resolved and therefore
   * what GStack will be given a uuid for.
   */
  const leftText = await page.textContent('#lobby-left');
  ok('internal agent names are resolved for the operator', leftText.includes('Brimstone'), leftText.trim());
  ok('and the internal name is not shown', !leftText.includes('Sarge'), leftText.trim());
  ok('the second agent resolved too', leftText.includes('Omen'), leftText.trim());

  const boxAfter = await page.locator('.lobby-board').boundingBox();
  ok(
    'the board did not reflow as it filled',
    Math.abs(boxBefore.height - boxAfter.height) < 1 && Math.abs(boxBefore.y - boxAfter.y) < 1,
    `${JSON.stringify(boxBefore)} -> ${JSON.stringify(boxAfter)}`,
  );

  ok('Stage is now offered', await page.locator('#lobby-stage').isEnabled());
  ok('and the pill says it is not staged yet', /not staged/i.test(await page.textContent('#lobby-state')));

  // ------------------------------------------------------------- stage ---
  await page.click('#lobby-stage');
  await page.waitForTimeout(600);
  ok('the pill reports it staged', /staged/i.test(await page.textContent('#lobby-state')));

  const served = await (await fetch(`${BASE}/api/gstack?key=${encodeURIComponent(key)}`)).json();
  ok('the export has the staged players', served.attackers.length === 2, JSON.stringify(served.attackers));
  ok(
    'and carries the uuid GStack matches on',
    /^[0-9a-f-]{36}$/i.test(served.attackers[0].lockedAgentCharacterId ?? ''),
    JSON.stringify(served.attackers[0]),
  );

  // -------------------------------------------------------------- swap ---
  await page.click('#lobby-swap');
  await page.waitForTimeout(500);
  ok('swap moves the enemy to the left', (await page.textContent('#lobby-left')).includes('Foe1#BBB'));
  ok('and the ally to the right', (await page.textContent('#lobby-right')).includes('Ally1#AAA'));
  ok('and the labels say what happened', /was enemies/i.test(await page.textContent('#lobby-left-label')));

  const swappedExport = await (await fetch(`${BASE}/api/gstack?key=${encodeURIComponent(key)}`)).json();
  ok('the export swapped with it', swappedExport.attackers[0].player === 'Foe1#BBB', JSON.stringify(swappedExport.attackers));

  // ------------------------------------------------------------- clear ---
  await page.click('#lobby-clear');
  await page.waitForTimeout(500);
  ok('the board empties', !(await page.textContent('#lobby-left')).includes('Foe1#BBB'));
  ok('five rows remain', (await page.locator('#lobby-left .lobby-row').count()) === 5);
  const afterClear = await (await fetch(`${BASE}/api/gstack?key=${encodeURIComponent(key)}`)).json();
  ok('and the export is empty again', afterClear.attackers.length === 0 && afterClear.staged === false);

  // ------------------------------------------------------ no page errors ---
  ok('no uncaught page errors', errors.length === 0, errors.join(' | '));
} catch (error) {
  fail += 1;
  console.log('  THREW ', error.stack ?? error.message);
} finally {
  if (browser) await browser.close();
  server.kill();
  await wait(300);
  rmSync(STATE, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('\n--- server log ---\n' + log.split('\n').slice(-40).join('\n'));
process.exit(fail ? 1 : 0);
