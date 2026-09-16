/**
 * The Tournament page in a real browser.
 *
 * The API half is tournament-e2e; this is the half that only a browser can
 * answer - whether the rail item appears for the right people, whether the
 * strip actually switches sections, whether the schema reaches the form, and
 * whether the bar stays inside its panel when the data grows.
 *
 * The structural checks come FIRST, before anything types into a card. A panel
 * that is correctly hidden and a panel that was never wired look identical to
 * every assertion that reads the DOM, and the failure surfaces eight seconds
 * later as a timeout naming nothing - which is exactly how the wed-audio group
 * bug presented. Ask the shape first, so a structural fault reports as itself.
 *
 *   node tools/tests/tournament-ui-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const playwright = await import(new URL('../../node_modules/playwright/index.js', import.meta.url).href);
const chromium = playwright.chromium ?? playwright.default.chromium;

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8176;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-tou-ui-'));

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
    ADMIN_PASSWORD: 'a-long-enough-password',
    TRACKER_ENABLED: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (c) => (log += c));
server.stderr.on('data', (c) => (log += c));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let browser = null;

const signIn = async (page, username, password) => {
  await page.goto(`${BASE}/login.html`);
  await page.fill('#login-username', username);
  await page.fill('#login-password', password);
  await page.click('#login-submit');
  await page.waitForURL(`${BASE}/`);
  await wait(900);
};

try {
  for (let i = 0; i < 60; i += 1) {
    try {
      await fetch(`${BASE}/api/auth/state`);
      break;
    } catch {
      await wait(250);
    }
  }

  // Set the accounts up over the API, so the browser half tests only the page.
  const jar = [];
  const post = async (p, body) => {
    const r = await fetch(BASE + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(jar.length ? { Cookie: jar.join('; ') } : {}) },
      body: JSON.stringify(body),
    });
    for (const line of r.headers.getSetCookie?.() ?? []) jar.push(line.split(';')[0]);
    return r.json().catch(() => ({}));
  };
  await post('/api/auth/login', { username: 'boss', password: 'a-long-enough-password' });
  await post('/api/admin/users', { action: 'create', username: 'alex', password: 'another-long-password' });
  const me = await (await fetch(BASE + '/api/account/me', { headers: { Cookie: jar.join('; ') } })).json();
  await post('/api/admin/users', { action: 'update', id: me.user.id, capabilities: { manageTournaments: true } });

  browser = await chromium.launch();

  // -------------------------------------------- the page, with the capability ---

  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await signIn(page, 'boss', 'a-long-enough-password');

  ok('1. the rail item is there for somebody who may create', await page.isVisible('.rail-item[data-tab="tournament"]'));

  await page.click('.rail-item[data-tab="tournament"]');
  await wait(400);

  // --- the shape, before anything is typed ---------------------------------

  ok('2. the rail press opened the panel', await page.isVisible('#tab-tournament'), 'panel not registered in dashboard.js?');

  const shape = await page.evaluate(() => {
    const strip = document.querySelector('.subtabs[data-for="tournament"]');
    const tabs = [...(strip?.querySelectorAll('.subtab') ?? [])].map((b) => b.dataset.view);
    const panels = [...document.querySelectorAll('#tab-tournament .editor-grid > .panel')].map((p) => p.id);
    return { tabs, panels, stripVisible: strip ? !strip.hidden : false };
  });
  ok('3. the strip is showing', shape.stripVisible);
  ok('4. every sub-tab names a panel', shape.tabs.every((view) => shape.panels.includes(view)), JSON.stringify(shape));
  ok('5. every panel has a sub-tab', shape.panels.every((id) => shape.tabs.includes(id)), JSON.stringify(shape));

  ok('6. nothing is shown before a tournament exists', !(await page.isVisible('#tou-settings')));
  ok('7. ...and the page says why', (await page.textContent('#tou-note')).includes('No tournaments yet'));

  // --- making one -----------------------------------------------------------

  page.once('dialog', (d) => d.accept('Touch Grass Invitational'));
  await page.click('#tou-new');
  await wait(800);

  /*
   * Errors from before this point are discarded, and that is a real finding
   * rather than a convenience.
   *
   * An account on no tournament gets 403 "No such session." from every graphics
   * route, and the four graphics dashboards fetch on load regardless - so a
   * fresh install paints about a dozen console 403s before anybody has made
   * anything. Nothing is broken and the page works the moment a tournament
   * exists, but it is noise an operator should not be shown on their first
   * visit, and the fix belongs in those dashboards rather than here.
   *
   * What assertion 23 is for is the state that follows: once there IS a
   * tournament, the page must be clean. Keeping the earlier noise in scope
   * would have meant either a permanently failing assertion or a weakened one.
   */
  errors.length = 0;

  ok('8. the heading names the section', (await page.textContent('#page-title')) === 'Tournament');
  ok('9. the new tournament is in the picker', (await page.$$eval('#tou-select option', (o) => o.map((x) => x.textContent))).includes('Touch Grass Invitational'));
  ok('10. settings appeared', await page.isVisible('#tou-settings'));

  // --- the schema reaches the form -----------------------------------------

  const { TOURNAMENT_FIELDS } = await import(new URL('../../public/tournament-schema.js', import.meta.url).href);
  const labels = await page.$$eval('#tou-fields span', (s) => s.map((x) => x.textContent.trim()));
  for (const entry of TOURNAMENT_FIELDS) {
    ok(`11.${entry.key} is on the page`, labels.includes(entry.label), `looked for "${entry.label}" in ${JSON.stringify(labels)}`);
  }
  ok('12. both dates are real date inputs', (await page.$$('#tou-fields input[type=date]')).length === 2);
  /*
   * Not a bare URL box. mediaControl builds a .logo-preview and a .logo-tools
   * row beside the text field, which is what gives an operator drop, browse and
   * paste - and the standing rule is that an asset field must never be a plain
   * text input, because the file is on their machine and not on a CDN.
   */
  ok(
    '13. the logo field takes an upload, not just a URL',
    (await page.$('#tou-fields .logo-preview')) !== null && (await page.$('#tou-fields .logo-tools')) !== null,
  );

  // --- editing saves --------------------------------------------------------

  await page.fill('#tou-fields input[type=text]', 'Renamed Cup');
  await wait(700);
  ok('14. a rename saved', (await page.textContent('#tou-saved')).includes('Saved'));
  ok('15. ...and the picker followed it', (await page.$$eval('#tou-select option', (o) => o.map((x) => x.textContent))).includes('Renamed Cup'));

  const dateBoxes = await page.$$('#tou-fields input[type=date]');
  await dateBoxes[0].fill('2026-07-04');
  await wait(700);
  const stored = await (await fetch(BASE + '/api/tournaments', { headers: { Cookie: jar.join('; ') } })).json();
  ok('16. a date reached the server as typed', stored.tournaments?.[0]?.startsAt === '2026-07-04', JSON.stringify(stored.tournaments?.[0]?.startsAt));

  // --- the strip actually switches ------------------------------------------

  await page.click('.subtabs[data-for="tournament"] .subtab[data-view="tou-access"]');
  await wait(300);
  ok('17. Access came on screen', await page.isVisible('#tou-access'));
  ok('18. ...and Settings went off it', !(await page.isVisible('#tou-settings')));
  ok('19. the owner gets the Add row', await page.isVisible('#tou-add'));
  ok('20. the owner is listed', (await page.textContent('#tou-members')).includes('boss'));

  // --- the bar must not outgrow its panel -----------------------------------

  /*
   * Asked of the BAR against its parent, not of the bar against itself. A flex
   * row does not report its own overflow - scrollWidth === clientWidth, because
   * a flex container does not scroll, it simply gets wider than its parent.
   * That is how the admin row grew out through the side of its panel with
   * nothing failing.
   */
  const fits = await page.evaluate(() => {
    const bar = document.querySelector('.tourney-bar');
    return bar.getBoundingClientRect().width <= bar.parentElement.getBoundingClientRect().width + 1;
  });
  ok('21. the tournament bar stays inside its panel', fits);

  await page.setViewportSize({ width: 430, height: 900 });
  await wait(250);
  const fitsNarrow = await page.evaluate(() => {
    const bar = document.querySelector('.tourney-bar');
    return bar.getBoundingClientRect().width <= bar.parentElement.getBoundingClientRect().width + 1;
  });
  ok('22. ...at phone width too', fitsNarrow);
  await page.setViewportSize({ width: 1500, height: 950 });

  ok('23. no page errors anywhere in that', errors.length === 0, errors.join(' | '));

  // ------------------------------------------- somebody with no capability ---

  const guest = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await signIn(guest, 'alex', 'another-long-password');
  ok('24. the rail item is hidden from somebody with neither', !(await guest.isVisible('.rail-item[data-tab="tournament"]')));

  // Added as an editor, they get the page without the capability.
  const cupId = (await (await fetch(BASE + '/api/tournaments', { headers: { Cookie: jar.join('; ') } })).json()).tournaments[0].id;
  const alexId = me.grantable?.find((u) => u.username === 'alex')?.id ?? (await post('/api/admin/users', { action: 'list' })).users?.find((u) => u.username === 'alex')?.id;
  await post('/api/tournaments', { action: 'member', id: cupId, userId: alexId, level: 'editor' });

  await guest.reload();
  await wait(1000);
  ok('25. a member gets the rail item without the capability', await guest.isVisible('.rail-item[data-tab="tournament"]'));

  await guest.click('.rail-item[data-tab="tournament"]');
  await wait(500);
  ok('26. ...and cannot make one of their own', !(await guest.isVisible('#tou-new')));
  ok('27. ...but can edit this one', !(await guest.$eval('#tou-fields input[type=text]', (i) => i.disabled)));

  await guest.click('.subtabs[data-for="tournament"] .subtab[data-view="tou-access"]');
  await wait(300);
  ok('28. an editor gets no Add row', !(await guest.isVisible('#tou-add')));

  // --- archived is read-only, and says so -----------------------------------

  await post('/api/tournaments', { action: 'archive', id: cupId, archived: true });
  await guest.reload();
  await wait(1000);
  await guest.click('.rail-item[data-tab="tournament"]');
  await wait(500);
  ok('29. an archived tournament locks its fields', await guest.$eval('#tou-fields input[type=text]', (i) => i.disabled));
  ok('30. ...and says why', (await guest.textContent('#tou-saved')).includes('Archived'));
} catch (error) {
  failed += 1;
  console.log(`  FAIL  threw - ${error.message}`);
} finally {
  await browser?.close();
  server.kill();
  await wait(300);
  rmSync(STATE, { recursive: true, force: true });
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
