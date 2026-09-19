/**
 * The two new controls in the dashboard: the mosaic opening and the event logo
 * size slider - plus the assertion that adding a readout to rangeField left
 * every existing ratio slider alone.
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
const PORT = 8156;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-wui-'));

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
    LOG_LEVEL: 'error',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (c) => (log += c));
server.stderr.on('data', (c) => (log += c));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;

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
   * The output page is reached with a key, and a key names a tournament rather
   * than an account - the login response carries none any more. So one is made
   * before anything is measured; everything below is unchanged, because what
   * this suite is about is what a browser source paints.
   */
  const { cookie, key } = await openAsAdmin(BASE, 'boss', 'a-long-enough-password', 'Winner UI');

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1900, height: 1200 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${BASE}/login.html`);
  await page.fill('#login-username', 'boss');
  await page.fill('#login-password', 'a-long-enough-password');
  await page.click('#login-submit');
  await page.waitForSelector('#whoami:not([hidden])', { timeout: 10000 });

  await page.click('.rail-item[data-section="graphics"]');
  await page.click('.tab[data-tab="winner"]');
  await page.waitForTimeout(1200);

  // The editor cards are grouped under the preview now, one group at a time,
  // so a suite opens the group it is about to touch. The cards are all still in
  // the DOM and still bound - reading one works whichever group is open - but
  // clicking into a shut one does not, which is the operator's experience too.
  await page.click('.card-tabs[data-cards="winner"] .card-tab[data-group="sequence"]');
  await page.waitForTimeout(400);

  // ------------------------------------------------- the opening dropdown ---
  const openingSelect = page.locator('select').filter({ has: page.locator('option[value="mosaic"]') }).first();
  ok('an Opening select offers mosaic', (await openingSelect.count()) === 1, String(await openingSelect.count()));

  const labels = await page.evaluate(() => {
    const option = [...document.querySelectorAll('option')].find((o) => o.value === 'mosaic');
    const select = option?.closest('select');
    return {
      label: option?.textContent ?? null,
      order: [...(select?.options ?? [])].map((o) => o.value),
    };
  });
  ok('and labels it', labels.label === 'Mosaic - lit grid', String(labels.label));
  ok('right after Prism', labels.order.indexOf('mosaic') === labels.order.indexOf('prism') + 1, labels.order.join(','));

  await openingSelect.selectOption('mosaic');
  await page.waitForTimeout(900);
  const savedOpening = (await (await fetch(`${BASE}/api/winner?bus=preview&key=${encodeURIComponent(key)}`)).json()).state.seq.opening;
  ok('picking it saves', savedOpening === 'mosaic', savedOpening);

  const helpText = await page.textContent('.winner-tab, #tab-winner');
  ok('the help text explains it', /Mosaic is the same in squares/.test(helpText), 'not described');

  // ------------------------------------------------- the size slider ---
  // Style panel - so open the Style group first.
  await page.click('.card-tabs[data-cards="winner"] .card-tab[data-group="style"]');
  await page.waitForTimeout(400);

  // Find the range whose field label mentions the logo.
  const sizeField = page.locator('.g-field.has-readout').filter({ hasText: /event logo size/i }).first();
  ok('the size field renders with a readout', (await sizeField.count()) === 1, String(await sizeField.count()));

  const slider = sizeField.locator('input[type="range"]');
  const bounds = await slider.evaluate((n) => ({ min: n.min, max: n.max, step: n.step, value: n.value }));
  ok('the range comes from the schema', bounds.min === '0.3' && bounds.max === '2', JSON.stringify(bounds));
  ok('the step comes from the schema', bounds.step === '0.05', bounds.step);
  ok('it starts at 1', Number(bounds.value) === 1, bounds.value);
  ok('and reads 100%', (await sizeField.locator('.g-readout').textContent()) === '100%', await sizeField.locator('.g-readout').textContent());

  // Drag it with the keyboard, which steps by exactly one step.
  await slider.focus();
  for (let i = 0; i < 6; i += 1) await slider.press('ArrowRight');
  await page.waitForTimeout(900);

  const after = await sizeField.locator('.g-readout').textContent();
  ok('the readout follows the slider', after === '130%', after);

  const savedScale = (await (await fetch(`${BASE}/api/winner?bus=preview&key=${encodeURIComponent(key)}`)).json()).state.style.eventLogoScale;
  ok('and the value is saved', savedScale === 1.3, String(savedScale));

  // Down past 1 to the floor.
  await slider.focus();
  for (let i = 0; i < 40; i += 1) await slider.press('ArrowLeft');
  await page.waitForTimeout(900);
  ok('it floors at 30%', (await sizeField.locator('.g-readout').textContent()) === '30%', await sizeField.locator('.g-readout').textContent());
  const floored = (await (await fetch(`${BASE}/api/winner?bus=preview&key=${encodeURIComponent(key)}`)).json()).state.style.eventLogoScale;
  ok('the floor is what the server stored', floored === 0.3, String(floored));

  // Up to the ceiling - the case a `ratio` type would have silently clamped to 1.
  await slider.focus();
  for (let i = 0; i < 60; i += 1) await slider.press('ArrowRight');
  await page.waitForTimeout(900);
  ok('it ceilings at 200%', (await sizeField.locator('.g-readout').textContent()) === '200%', await sizeField.locator('.g-readout').textContent());
  const ceiling = (await (await fetch(`${BASE}/api/winner?bus=preview&key=${encodeURIComponent(key)}`)).json()).state.style.eventLogoScale;
  ok('THE SERVER KEPT A VALUE ABOVE 1', ceiling === 2, String(ceiling));

  // ------------------------------------------ existing sliders untouched ---
  /*
   * SCOPED TO THE WINNER TAB, which it was not.
   *
   * It asked `document` for every range input and expected exactly three with a
   * readout - but the dashboard holds every tab in the DOM at once, so the
   * count was really "every scale field in the whole program". The moment the
   * bracket gained one of its own it read four, and the failure said "only the
   * scale fields grew a readout" about a page where exactly that was still
   * true. A question about one graphic has to be asked of that graphic.
   *
   * The intent is unchanged and is the thing worth pinning: a `scale` gets a
   * readout because a bare handle cannot be steered back to a default, and a
   * `ratio` does not because a proportion has no default to return to.
   */
  const plain = await page.evaluate(() => {
    const ranges = [...document.querySelectorAll('#tab-winner input[type="range"]')];
    const withReadout = ranges.filter((r) => r.closest('.g-field')?.classList.contains('has-readout'));
    return {
      total: ranges.length,
      withReadout: withReadout.length,
      labelled: withReadout.map((r) => r.closest('.g-field')?.querySelector('span')?.textContent ?? '?'),
    };
  });
  ok('several sliders exist', plain.total > 3, JSON.stringify(plain));
  ok('only the scale fields grew a readout', plain.withReadout === 3, JSON.stringify(plain));
  /*
   * Named, not just counted. Three of anything is a number that happens to be
   * right; these are the three fields the rule is ABOUT, so a future swap that
   * moved a readout from one slider to another would keep the count and still
   * be wrong.
   */
  ok(
    '...and they are the three that are scales',
    plain.labelled.length === 3 && plain.labelled.every((label) => /size|width|spacing/i.test(label)),
    JSON.stringify(plain.labelled),
  );

  // A plain ratio slider must still round-trip.
  const opacity = page.locator('.g-field').filter({ hasText: /backdrop opacity/i }).locator('input[type="range"]').first();
  await opacity.focus();
  await opacity.press('ArrowLeft');
  await page.waitForTimeout(900);
  const bgOpacity = (await (await fetch(`${BASE}/api/winner?bus=preview&key=${encodeURIComponent(key)}`)).json()).state.style.bgOpacity;
  ok('a plain ratio slider still saves', bgOpacity === 0.95, String(bgOpacity));

  // ------------------------------------------------ the grid texture ---
  const textureSelect = page.locator('select').filter({ has: page.locator('option[value="grid"]') }).first();
  ok('a Texture select offers grid', (await textureSelect.count()) === 1, String(await textureSelect.count()));

  const texLabels = await page.evaluate(() => {
    const option = [...document.querySelectorAll('option')].find((o) => o.value === 'grid');
    const select = option?.closest('select');
    return { label: option?.textContent ?? null, order: [...(select?.options ?? [])].map((o) => o.value) };
  });
  ok('and labels it Neon grid', texLabels.label === 'Neon grid', String(texLabels.label));
  ok('right after the lattice', texLabels.order.indexOf('grid') === texLabels.order.indexOf('lattice') + 1, texLabels.order.join(','));

  await textureSelect.selectOption('grid');
  await page.waitForTimeout(900);
  const savedTexture = (await (await fetch(`${BASE}/api/winner?bus=preview&key=${encodeURIComponent(key)}`)).json()).state.style.texture;
  ok('picking it saves', savedTexture === 'grid', savedTexture);

  const texHelp = await page.textContent('#tab-winner');
  ok('the help pairs it with the mosaic', /grid is the mosaic/.test(texHelp), 'not described');
  ok('and the size label no longer says lattice only', !/lattice cell/.test(texHelp), 'stale label');

  // ------------------------------------------------ the layout controls ---
  const layoutField = (label) => page.locator('.g-field.has-readout').filter({ hasText: label }).first();

  const nameField = layoutField(/winner name max width/i);
  ok('the name width slider renders', (await nameField.count()) === 1, String(await nameField.count()));
  ok('and reads 70% by default', (await nameField.locator('.g-readout').textContent()) === '70%', await nameField.locator('.g-readout').textContent());
  const nameBounds = await nameField.locator('input[type="range"]').evaluate((n) => ({ min: n.min, max: n.max }));
  ok('over 30-100% of the frame', nameBounds.min === '0.3' && nameBounds.max === '1', JSON.stringify(nameBounds));

  const gapField = layoutField(/vertical spacing/i);
  ok('the spacing slider renders', (await gapField.count()) === 1, String(await gapField.count()));
  ok('and reads 100% by default', (await gapField.locator('.g-readout').textContent()) === '100%', await gapField.locator('.g-readout').textContent());

  const gapSlider = gapField.locator('input[type="range"]');
  await gapSlider.focus();
  for (let i = 0; i < 8; i += 1) await gapSlider.press('ArrowRight');
  await page.waitForTimeout(900);
  ok('spacing follows the slider', (await gapField.locator('.g-readout').textContent()) === '140%', await gapField.locator('.g-readout').textContent());
  const savedGap = (await (await fetch(`${BASE}/api/winner?bus=preview&key=${encodeURIComponent(key)}`)).json()).state.style.bandGap;
  ok('and is saved above 1', savedGap === 1.4, String(savedGap));

  const layoutHelp = await page.textContent('#tab-winner');
  ok('the layout help explains the cap', /caps the winner name as a share of the frame/.test(layoutHelp), 'not described');
  ok('and points at the logo size', /after changing the logo size/.test(layoutHelp), 'not described');

  ok('no page errors', errors.length === 0, errors.join(' | '));
} catch (error) {
  fail += 1;
  console.log('THREW', error.stack);
  console.log(log.slice(-1500));
} finally {
  await browser?.close().catch(() => {});
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
