/**
 * The browser half: does a real dashboard load, sign in, keep its stream, show
 * the right production, and hand out OBS URLs that actually work?
 *
 * Playwright, against a server on a throwaway STATE_DIR.
 */
// Resolved out of the project rather than by bare name: this suite lives
// outside the checkout, so there is no node_modules beside it.
const playwright = await import(new URL('../../node_modules/playwright/index.js', import.meta.url).href);
 const chromium = playwright.chromium ?? playwright.default.chromium;
import { spawn } from 'node:child_process';
import { SETTING_FIELDS } from '../../public/settings-schema.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

// The checkout this suite lives in, resolved from the suite's own location so
// that moving the tree does not break it.
const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8124;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-ui-'));

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
let browser;

try {
  for (let i = 0; i < 60; i += 1) {
    try {
      await fetch(`${BASE}/api/auth/state`);
      break;
    } catch {
      await wait(250);
    }
  }

  browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));

  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  // ------------------------------------------------------------ redirect ---
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  ok('unsigned dashboard lands on the login', page.url().includes('/login.html'), page.url());
  ok('the login carries the destination', page.url().includes('next='), page.url());

  // --------------------------------------------------------------- login ---
  await page.fill('#login-username', 'boss');
  await page.fill('#login-password', 'nope');
  await page.click('#login-submit');
  await page.waitForSelector('#login-error:not([hidden])', { timeout: 4000 });
  ok('a wrong password shows an error', (await page.textContent('#login-error')).includes('Wrong'), await page.textContent('#login-error'));

  await page.fill('#login-password', 'a-long-enough-password');
  await page.click('#login-submit');
  await page.waitForURL((url) => !url.pathname.includes('login'), { timeout: 8000 });
  ok('a right password lands on the dashboard', page.url().replace(BASE, '') === '/' || page.url() === `${BASE}/`, page.url());

  await page.waitForSelector('#whoami:not([hidden])', { timeout: 6000 });
  errors.length = 0; // the deliberate wrong-password 401 above is not a defect
  ok('the topbar names the account', (await page.textContent('#whoami-user')).includes('boss'));
  ok('the admin tab is shown to an admin', !(await page.getAttribute('.tab[data-tab="admin"]', 'hidden')) === true || (await page.isVisible('.tab[data-tab="admin"]')));
  ok('the page is not marked as a guest', !(await page.evaluate(() => document.body.classList.contains('is-guest'))));

  // --------------------------------------------------------- the graphic ---
  await page.click('.rail-item[data-section="graphics"]');
  await page.click('.tab[data-tab="graphic"]');
  await page.waitForFunction(() => document.getElementById('g-obs-url')?.textContent?.includes('key='), null, { timeout: 8000 });
  const obsUrl = await page.textContent('#g-obs-url');
  ok('the OBS URL carries a key', obsUrl.includes('/post-match.html?key='), obsUrl);

  // ------------------------------------------------ the settings groups ---
  /*
   * Every editor card belongs to exactly one group the bar offers, and the open
   * group is exactly what is on screen.
   *
   * This is here because the failure is silent. A card whose data-group is a
   * typo, or a group renamed on the bar but not on the cards, does not throw and
   * does not look broken - it simply never appears again, and the first person
   * to find out is an operator looking for the music settings mid-series.
   */
  for (const [tab, groups] of [
    ['graphic', ['data', 'animation', 'style']],
    ['winner', ['data', 'sequence', 'music', 'style']],
    ['select', ['roster', 'animation', 'style']],
  ]) {
    await page.click(`.subtabs[data-for="graphics"] .tab[data-tab="${tab}"]`);
    await page.waitForTimeout(500);

    const shape = await page.evaluate((t) => {
      const bar = document.querySelector(`.card-tabs[data-cards="${t}"]`);
      const grid = document.querySelector(`.editor-grid[data-cards="${t}"]`);
      const panels = [...(grid?.querySelectorAll(':scope > .panel') ?? [])];
      return {
        offered: [...(bar?.querySelectorAll('.card-tab') ?? [])].map((b) => b.dataset.group),
        onCards: panels.map((p) => p.dataset.group),
        orphans: panels.filter((p) => !p.dataset.group).map((p) => p.id),
      };
    }, tab);

    ok(`${tab}: the bar offers the groups it should`, shape.offered.join(',') === groups.join(','), shape.offered.join(','));
    ok(`${tab}: every card names a group`, shape.orphans.length === 0, shape.orphans.join(','));
    ok(
      `${tab}: no card names a group the bar does not offer`,
      shape.onCards.every((g) => shape.offered.includes(g)),
      shape.onCards.filter((g) => !shape.offered.includes(g)).join(','),
    );
    ok(
      `${tab}: every group has at least one card`,
      shape.offered.every((g) => shape.onCards.includes(g)),
      shape.offered.filter((g) => !shape.onCards.includes(g)).join(','),
    );

    // And pressing each one shows exactly its own cards - not a superset, which
    // is what a stale class or a missed panel would leave behind.
    for (const group of groups) {
      await page.click(`.card-tabs[data-cards="${tab}"] .card-tab[data-group="${group}"]`);
      await page.waitForTimeout(200);
      const seen = await page.evaluate((t) => {
        const grid = document.querySelector(`.editor-grid[data-cards="${t}"]`);
        return [...grid.querySelectorAll(':scope > .panel')]
          .filter((p) => !p.classList.contains('is-off-view'))
          .map((p) => p.dataset.group);
      }, tab);
      ok(
        `${tab}/${group}: shows its own cards and only those`,
        seen.length > 0 && seen.every((g) => g === group),
        seen.join(',') || 'nothing visible',
      );
    }
  }

  // The transport must never be inside a group - it is what an operator reaches
  // for mid-map, and a click to find it is a click too many.
  const transportOpen = await page.evaluate(() =>
    ['g-take-bar', 'preview-frame'].every((id) => {
      const el = document.getElementById(id);
      return el && !el.closest('.editor-grid') && !el.classList.contains('is-off-view');
    }));
  ok('the take bar and preview sit outside the groups', transportOpen);

  // Back to the scoreboard AND to its Data group. The group is remembered per
  // graphic, so returning to the tab does not reset it - the loop above left
  // this one on Style, and everything below types into the rosters.
  await page.click('.subtabs[data-for="graphics"] .tab[data-tab="graphic"]');
  await page.waitForTimeout(300);
  await page.click('.card-tabs[data-cards="graphic"] .card-tab[data-group="data"]');
  await page.waitForTimeout(500);


  /*
   * Narrowed in CSS, not in the text.
   *
   * A hostname plus a session key is ~74 characters and used to stretch the
   * toolbar. The box is now a fixed width with an ellipsis - but the copy
   * button reads `textContent`, so the element still has to hold the whole
   * URL. Shortening the string would copy a broken one, and that is the
   * regression this guards.
   */
  const urlBox = await page.evaluate(() => {
    const node = document.getElementById("g-obs-url");
    return {
      text: node.textContent,
      title: node.title,
      boxWidth: Math.round(node.closest(".obs-url").getBoundingClientRect().width),
      truncated: node.scrollWidth > node.clientWidth,
      ellipsis: getComputedStyle(node).textOverflow,
    };
  });
  ok("the URL box is a fixed width", urlBox.boxWidth === 340, String(urlBox.boxWidth));
  ok("it truncates on screen", urlBox.truncated && urlBox.ellipsis === "ellipsis", JSON.stringify(urlBox));
  ok("but still holds the whole URL for Copy", urlBox.text === obsUrl && urlBox.text.includes("key="));
  ok("and the full URL is on hover", urlBox.title === obsUrl);
  ok("the text itself was never shortened", !urlBox.text.includes("…"), urlBox.text);

  // The dashboard's own state, edited through the real controls.
  await page.waitForSelector('#ed-left input', { timeout: 8000 });
  const teamInput = page.locator('#ed-left input[type="text"]').first();
  await teamInput.fill('CLOUD9');
  await page.waitForTimeout(700);
  /*
   * The dashboard stages. Typing reaches preview and stops there until somebody
   * takes it - which is the whole preview/program feature, asserted from the
   * only place it can be asserted honestly: a real browser driving real inputs.
   */
  const staged = await page.evaluate(() => fetch('/api/graphic?bus=preview').then((r) => r.json()));
  ok('typing a team name stages it', staged.state.left.teamName === 'CLOUD9', staged.state.left.teamName);
  const air = await page.evaluate(() => fetch('/api/graphic?bus=program').then((r) => r.json()));
  ok('AND DOES NOT REACH AIR', air.state.left.teamName !== 'CLOUD9', air.state.left.teamName);
  /*
   * Waited for, not slept on.
   *
   * The two assertions above ask the SERVER, and it already has the edit. This
   * one asks the BROWSER, which only repaints once the push comes back down the
   * stream - so a fixed pause was a race, and it lost about one run in three.
   * Still a real assertion: it fails if the note never appears.
   */
  await page.waitForSelector('#g-staged:not([hidden])', { timeout: 5000 }).catch(() => {});
  ok('the take bar says so', await page.isVisible('#g-staged'), 'no "differs from air" note');

  // ------------------------------------------------- the OBS URL really works ---
  const obs = await context.newPage();
  const obsErrors = [];
  obs.on('pageerror', (error) => obsErrors.push(String(error)));
  // A browser source has no cookie, so this proves the key alone is enough.
  const bare = await browser.newContext();
  const barePage = await bare.newPage();
  barePage.on('pageerror', (error) => obsErrors.push(String(error)));
  await barePage.goto(obsUrl, { waitUntil: 'networkidle' });
  const showsName = () =>
    barePage.evaluate(() => Boolean([...document.querySelectorAll('*')].find((n) => n.textContent?.trim() === 'CLOUD9')));

  // The OBS URL carries no bus, so it is air - and air has not been taken yet.
  ok('AN OBS SOURCE SHOWS AIR, NOT WHAT IS STAGED', (await showsName()) === false, 'a staged name reached a browser source');

  // Now cut it across, through the real button.
  await page.click('#g-take');
  await page.waitForTimeout(900);
  ok('the take clears the staged note', !(await page.isVisible('#g-staged')), 'still says it differs');
  ok('AND THE OBS SOURCE NOW RENDERS IT', await showsName(), await barePage.title());
  ok('the OBS page threw nothing', obsErrors.length === 0, obsErrors.join(' | '));
  await obs.close();

  // Without the key it must not.
  const naked = await bare.newPage();
  const response = await naked.goto(`${BASE}/post-match.html`, { waitUntil: 'networkidle' });
  ok('post-match.html itself still serves', response.status() === 200);
  const leaked = await naked.evaluate(() => document.body.textContent.includes('CLOUD9'));
  ok('an OBS source with no key shows nothing', !leaked);
  await naked.close();
  await bare.close();

  // ------------------------------------------------------------- account ---
  await page.click('.tab[data-tab="account"]');
  await page.waitForSelector('#acc-key', { timeout: 4000 });
  const shownKey = await page.textContent('#acc-key');
  ok('the account tab shows the key', obsUrl.includes(shownKey), `${shownKey} vs ${obsUrl}`);
  ok('the access list explains itself when alone', (await page.textContent('#acc-grants')).includes('no other accounts'));

  // --------------------------------------------------------------- admin ---
  await page.click('.tab[data-tab="admin"]');
  await page.waitForSelector('#adm-users', { timeout: 4000 });
  await page.fill('#adm-username', 'operator');
  await page.fill('#adm-password', 'another-long-password');
  await page.click('#adm-create');
  await page.waitForFunction(() => document.querySelectorAll('.admin-row').length === 2, null, { timeout: 6000 });
  ok('an admin can make an account from the UI', (await page.locator('.admin-row').count()) === 2);
  ok('health rendered', (await page.textContent('#adm-health')).includes('Node'));

  // The new account should appear in the access list without a reload.
  await page.click('.tab[data-tab="account"]');
  await page.waitForFunction(() => document.querySelectorAll('.access-row').length === 1, null, { timeout: 6000 });
  ok('the new account is grantable at once', (await page.locator('.access-row').count()) === 1);

  // Grant editor, and check the second account sees it.
  await page.locator('.access-row .btn', { hasText: 'Editor' }).click();
  await page.waitForTimeout(500);

  const second = await browser.newContext();
  const opPage = await second.newPage();
  const opErrors = [];
  opPage.on('pageerror', (error) => opErrors.push(String(error)));
  await opPage.goto(`${BASE}/login.html`);
  await opPage.fill('#login-username', 'operator');
  await opPage.fill('#login-password', 'another-long-password');
  await opPage.click('#login-submit');
  await opPage.waitForSelector('#whoami:not([hidden])', { timeout: 8000 });

  const options = await opPage.$$eval('#session-target option', (nodes) => nodes.map((n) => n.textContent));
  ok('the shared production appears in the selector', options.length === 2, JSON.stringify(options));
  ok('the selector marks your own', options.some((text) => text.includes('(yours)')), JSON.stringify(options));

  await opPage.selectOption('#session-target', { label: 'boss - editor' });
  await opPage.waitForURL((url) => url.searchParams.has('session'), { timeout: 6000 });
  await opPage.waitForSelector('#whoami:not([hidden])', { timeout: 6000 });
  ok('operating a shared production marks the page', await opPage.evaluate(() => document.body.classList.contains('is-guest')));

  await opPage.click('.rail-item[data-section="graphics"]');
  await opPage.click('.tab[data-tab="graphic"]');
  await opPage.waitForFunction(
    () => document.querySelector('#ed-left input[type="text"]')?.value === 'CLOUD9',
    null,
    { timeout: 8000 },
  );
  ok("the guest dashboard shows the owner's graphic", true);

  const guestObs = await opPage.textContent('#g-obs-url');
  ok('the guest OBS URL points at the owner', guestObs.includes(shownKey), guestObs);
  ok('no page errors on the guest dashboard', opErrors.length === 0, opErrors.join(' | '));

  // ------------------------------------------------------------- upload ---
  // A real drop through the media control: the CSRF rule refuses a write whose
  // Content-Type a form could have set, and a File with no type has none.
  const upload = await page.evaluate(async () => {
    // A 1x1 PNG, as bytes, with the type stripped the way a bare file drop is.
    const png = Uint8Array.from(atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    ), (c) => c.charCodeAt(0));
    const response = await fetch("/api/media", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: png,
    });
    return { status: response.status, body: await response.json() };
  });
  ok("an upload is accepted", upload.status === 200 && upload.body.url?.startsWith("/media/"), JSON.stringify(upload));

  const listed = await page.evaluate(() => fetch("/api/media").then((r) => r.json()));
  ok("the upload is listed for its owner", listed.media?.length === 1, JSON.stringify(listed));

  const otherList = await opPage.evaluate(() => fetch("/api/media").then((r) => r.json()));
  ok("another account does not see it", otherList.media?.length === 0, JSON.stringify(otherList));

  const formShaped = await page.evaluate(() =>
    fetch("/api/media", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" }).then((r) => r.status),
  );
  ok("a form-shaped upload is refused", formShaped === 415, String(formShaped));
  errors.length = 0; // that 415 was asked for
  // ------------------------------------------ the tracker login permission ---
  await page.click(String.raw`.tab[data-tab="admin"]`);
  await page.waitForSelector(".admin-row", { timeout: 6000 });

  // Matched on the name cell, not on row text: the boss row carries a button
  // labelled "Make operator", so a hasText filter for "operator" hits both rows.
  const rowFor = (name) =>
    page.locator(".admin-row").filter({
      has: page.locator(".admin-name", { hasText: new RegExp("^" + name + "$") }),
    });
  const adminRow = rowFor("boss");
  const opRow = rowFor("operator");

  ok("an admin row shows the permission as implicit", (await adminRow.locator("button", { hasText: "Tracker login" }).textContent()).includes("admin"));
  ok("and offers no toggle", await adminRow.locator("button", { hasText: "Tracker login" }).isDisabled());
  ok("a new account starts off", (await opRow.locator("button", { hasText: "Tracker login" }).textContent()).includes("off"));

  page.once("dialog", (dialog) => dialog.accept());
  await opRow.locator("button", { hasText: "Tracker login" }).click();
  await page.waitForFunction(
    () => [...document.querySelectorAll(".admin-row")].some((r) => r.textContent.includes("operator") && r.textContent.includes("Tracker login on")),
    null,
    { timeout: 6000 },
  );
  ok("granting it takes", true);

  const granted = await opPage.evaluate(() => fetch("/api/account/me").then((r) => r.json()).then((d) => d.user.mayOpenTrackerLogin));
  ok("the granted account agrees", granted === true, String(granted));

  // No dialog handler here: revoking is not confirmed, only granting is. A
  // `once` handler that never fires stays registered and then swallows the next
  // dialog - which is how this collided with the switches block below.
  await opRow.locator("button", { hasText: "Tracker login" }).click();
  await page.waitForFunction(
    () => [...document.querySelectorAll(".admin-row")].some((r) => r.textContent.includes("operator") && r.textContent.includes("Tracker login off")),
    null,
    { timeout: 6000 },
  );
  ok("revoking it takes", true);

  const revoked = await opPage.evaluate(() => fetch("/api/tracker/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).then((r) => r.status));
  ok("a revoked account is refused a solve", revoked === 403, String(revoked));
  opErrors.length = 0; // that 403 was asked for

  // ---------------------------------------------------- server switches ---
  await page.click(String.raw`.tab[data-tab="admin"]`);
  await page.waitForSelector(".setting-row", { timeout: 6000 });
  // Counted from the schema rather than hard-coded, so adding a switch does not
  // fail a test that was never about how many there are.
  ok("every switch renders", (await page.locator(".setting-row").count()) === SETTING_FIELDS.length, String(SETTING_FIELDS.length));

  // Discord is not configured for this run, so its switch must read as
  // unavailable rather than merely off - the same three states tracker gets.
  ok("discord is disabled without the environment", await page.locator("#set-discord").isDisabled());
  ok("and says why", (await page.textContent(".setting-row:has(#set-discord) .setting-state")).includes("DISCORD_ENABLED"));

  // TRACKER_ENABLED is not set for this run, so the tracker switch must read
  // as unavailable rather than merely off - two states a checkbox alone hides.
  const trackerBox = page.locator("#set-tracker");
  ok("tracker is disabled without the environment", await trackerBox.isDisabled());
  ok("and says why", (await page.textContent(".setting-row:has(#set-tracker) .setting-state")).includes("TRACKER_ENABLED"));

  // The attribute, not visibility: the panel lives on the lookup tab, which is
  // not the tab we are on.
  ok("the watch panel is not hidden", (await page.locator("#watch-panel").getAttribute("hidden")) === null);

  // Throw the watch switch and confirm the server, not just the page, agrees.
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#set-watch").uncheck();
  await page.waitForFunction(
    () => fetch("/api/config").then((r) => r.json()).then((c) => c.watchEnabled === false),
    null,
    { timeout: 6000 },
  );
  ok("the watch switch reaches the server", true);

  const refused = await page.evaluate(() =>
    fetch("/api/matches?provider=henrik&handle=TenZ%23SEN&watch=1").then((r) => r.status),
  );
  ok("a watch lookup is refused once off", refused === 403, String(refused));
  errors.length = 0; // that 403 was asked for

  await page.reload();
  await page.waitForSelector("#whoami:not([hidden])", { timeout: 8000 });
  ok("the watch panel is hidden after a reload", (await page.locator("#watch-panel").getAttribute("hidden")) !== null);

  await page.click(String.raw`.tab[data-tab="admin"]`);
  await page.waitForSelector("#set-watch", { timeout: 6000 });
  ok("the switch stayed off across the reload", !(await page.locator("#set-watch").isChecked()));

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#set-watch").check();
  await page.waitForFunction(
    () => fetch("/api/config").then((r) => r.json()).then((c) => c.watchEnabled === true),
    null,
    { timeout: 6000 },
  );
  ok("it switches back on", true);

  const opSees = await opPage.evaluate(() => fetch("/api/admin/settings").then((r) => r.status));
  ok("a non-admin cannot reach the switches", opSees === 403, String(opSees));
  opErrors.length = 0; // that 403 was asked for
  // ---------------------------------------------------------------- log ---
  await page.click(String.raw`.tab[data-tab="admin"]`);
  await page.waitForFunction(() => document.getElementById("adm-log")?.textContent?.length > 0, null, {
    timeout: 8000,
  });
  const logText = await page.textContent("#adm-log");
  ok("the log panel fills", logText.length > 50, String(logText.length));
  ok("it shows a sign-in", logText.includes("signed in"), logText.slice(0, 200));

  // The one that matters: this panel is rendered in a browser, so anything in
  // it has already left the server.
  ok("the session key is not on the page", !logText.includes(shownKey), "the key reached the panel");
  ok("no password is on the page", !logText.includes("a-long-enough-password"));
  ok("keyed URLs are redacted", !logText.includes("key=") || logText.includes("key=<hidden>"), logText.slice(0, 300));

  ok("the level selector is filled", (await page.locator("#adm-log-level option").count()) === 4);
  ok("and shows the current level", (await page.inputValue("#adm-log-level")) === "info");

  // Filtering is client-side over what has been fetched.
  await page.fill("#adm-log-filter", "signed in");
  const filtered = await page.textContent("#adm-log");
  ok("filtering narrows it", filtered.length < logText.length && filtered.includes("signed in"));
  await page.fill("#adm-log-filter", "");

  // Raising the level has to reach the server, not just the select.
  await page.selectOption("#adm-log-level", "debug");
  await page.waitForFunction(
    () => fetch("/api/admin/logs?limit=1").then((r) => r.json()).then((d) => d.level === "debug"),
    null,
    { timeout: 6000 },
  );
  ok("the level change reaches the server", true);
  // --------------------------------------------------- connection budget ---
  const streams = await page.evaluate(() => window.performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/events')).length);
  ok('the dashboard opened exactly one multiplexed stream', streams <= 1, String(streams));

  ok('no page errors on the owner dashboard', errors.length === 0, errors.join(' | '));

  await second.close();
} catch (error) {
  failed += 1;
  console.log(`  THREW ${error.stack}`);
} finally {
  await browser?.close().catch(() => {});
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
  console.log('\n--- server log ---\n' + log.slice(-3000));
  process.exitCode = 1;
}
