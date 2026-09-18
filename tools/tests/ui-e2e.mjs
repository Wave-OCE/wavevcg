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

import { grantCapability, makeAccount, makeTournament, openAsAdmin, signIn } from './harness.mjs';

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

  /*
   * A production is a tournament now, and an account has no key of its own - so
   * there is nothing for this dashboard to show until one exists. A brand-new
   * administrator signing in is on no tournament at all and gets 403 "No such
   * session." from every graphics route, which is the real first-run state and
   * is tournament-ui-e2e's subject. This suite is about everything downstream
   * of having one, so it is made over the API and the browser starts from there.
   */
  const { cookie: bossCookie, tournamentId: showId, key: showKey } = await openAsAdmin(
    BASE,
    'boss',
    'a-long-enough-password',
    'Main show',
  );

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
    await page.click(`#graphic-strip .tab[data-tab="${tab}"]`);
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
  await page.click('#graphic-strip .tab[data-tab="graphic"]');
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
  /*
   * And it is the TOURNAMENT's key, not the account's. The panel is still
   * headed "Your OBS key" but there is no such thing any more - it shows the
   * key of whichever production the page is looking at, so this asserts the
   * identity rather than just that something key-shaped is printed.
   */
  ok('and it is the key of the tournament on screen', shownKey === showKey, `${shownKey} vs ${showKey}`);
  /*
   * Access moved, so this assertion did too.
   *
   * It used to read "no other accounts", because a production was an account
   * and who may operate it was a list of grants held on me. Membership belongs
   * to the tournament now, so this panel's job is to say where the list went -
   * and an operator who cannot find the Access tab is exactly the failure worth
   * a test.
   */
  ok(
    'the account tab sends you to the Tournament page for access',
    (await page.textContent('#acc-grants')).includes('Tournament page'),
    await page.textContent('#acc-grants'),
  );

  // --------------------------------------------------------------- admin ---
  await page.click('.tab[data-tab="admin"]');
  await page.waitForSelector('#adm-users', { timeout: 4000 });
  await page.fill('#adm-username', 'operator');
  await page.fill('#adm-password', 'another-long-password');
  await page.click('#adm-create');
  await page.waitForFunction(() => document.querySelectorAll('.admin-row').length === 2, null, { timeout: 6000 });
  ok('an admin can make an account from the UI', (await page.locator('.admin-row').count()) === 2);
  ok('health rendered', (await page.textContent('#adm-health')).includes('Node'));

  // ------------------------------------------------------------- access ---
  /*
   * The grant moved, so this block did.
   *
   * It used to be a row on the Account tab, because a production was an account
   * and "who can operate my graphics" was a list of grants held on me. It is
   * membership on the tournament now - the same three levels meaning the same
   * three things, hung off the thing being shared instead of off a person.
   *
   * The reload is worth flagging rather than hiding. The old panel repainted
   * the moment an admin made an account, and that was asserted ("grantable at
   * once") because the obvious next move is to share a production with the
   * person you just created. The Tournament page builds its Add list from the
   * `grantable` array of the single /api/account/me it fetched at boot and
   * never refetches it, so an account made afterwards does not appear until the
   * page is reloaded. The assertion is kept and the reload is explicit, because
   * that is a gap in the page rather than in this suite.
   */
  await page.reload();
  await page.waitForSelector('#whoami:not([hidden])', { timeout: 8000 });
  await page.click('.rail-item[data-tab="tournament"]');
  await page.waitForSelector('.subtabs[data-for="tournament"] .subtab[data-view="tou-access"]', { timeout: 8000 });
  await page.click('.subtabs[data-for="tournament"] .subtab[data-view="tou-access"]');
  await page.waitForSelector('#tou-members .access-row', { timeout: 6000 });
  ok('the owner is on the members list', (await page.textContent('#tou-members')).includes('boss'));

  const addable = await page.$$eval('#tou-add-who option', (nodes) => nodes.map((n) => n.textContent));
  ok('the new account can be added to the production', addable.includes('operator'), JSON.stringify(addable));

  await page.selectOption('#tou-add-who', { label: 'operator' });
  await page.selectOption('#tou-add-level', 'editor');
  await page.click('#tou-add-go');
  await page.waitForFunction(
    () => [...document.querySelectorAll('#tou-members .access-row')].some((row) => row.textContent.includes('operator')),
    null,
    { timeout: 6000 },
  );
  ok('adding them as an editor takes', true);

  /*
   * And a second production, this one the operator's own.
   *
   * Two of them, for two reasons. The selector only appears when there is
   * somewhere to go - one entry and the topbar hides it - and `is-guest` is now
   * worth asserting in BOTH directions: it used to mean "this is not my
   * account" and means "I do not own this tournament", so an owner on their own
   * must come out clean or the border becomes permanent and stops being read.
   *
   * Made after the membership above on purpose. With no ?session= the server
   * opens the newest tournament the caller can see, and the bare /api/media
   * fetch further down depends on which one that is.
   */
  const roster = await fetch(`${BASE}/api/account/me`, { headers: { Cookie: bossCookie } }).then((r) => r.json());
  const operatorId = roster.grantable?.find((entry) => entry.username === 'operator')?.id;
  ok('the new account is visible over the API too', Boolean(operatorId), JSON.stringify(roster.grantable));
  await grantCapability(BASE, bossCookie, operatorId, 'manageTournaments');
  const { cookie: opCookie } = await signIn(BASE, 'operator', 'another-long-password');
  const ownShow = await makeTournament(BASE, opCookie, 'Operator own show');
  ok('the operator has a production of their own', Boolean(ownShow.key));

  // ------------------------------------------- an account on no tournament ---
  /*
   * The ordinary first minute of using this program, and it used to be the
   * worst-looking one.
   *
   * An account on no tournament gets a 403 from every per-tournament route,
   * which is correct - but the panels below just came out empty, so "there is
   * nothing here yet" and "this is broken" looked identical. Global was worse
   * than empty: it read `.state` off the 403 body and threw, so what actually
   * reached a brand new operator on first sign-in was a toast reading
   * "Global settings unavailable: Cannot read properties of undefined (reading
   * 'mapName')".
   *
   * This account is made and signed in BEFORE it is given anything, which is
   * the only way to see that state - every other account in this file already
   * owns a tournament by the time a browser reaches it.
   */
  await makeAccount(BASE, bossCookie, 'nomad', 'yet-another-password');
  const lost = await browser.newContext();
  const lostPage = await lost.newPage();
  const lostErrors = [];
  lostPage.on('pageerror', (error) => lostErrors.push(String(error)));
  await lostPage.goto(`${BASE}/login.html`);
  await lostPage.fill('#login-username', 'nomad');
  await lostPage.fill('#login-password', 'yet-another-password');
  await lostPage.click('#login-submit');
  await lostPage.waitForSelector('#whoami:not([hidden])', { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 900));

  ok(
    'an account on no tournament is TOLD so',
    await lostPage.evaluate(() => {
      const banner = document.getElementById('no-tournament');
      return Boolean(banner) && !banner.hidden && banner.textContent.trim().length > 0;
    }),
  );
  ok(
    'and the page carries the cue, not just a line of text',
    await lostPage.evaluate(() => document.body.classList.contains('is-adrift')),
  );
  /*
   * NOT the guest border. Those two cues must stay distinguishable: the guest
   * one means "careful, somebody else's stream" and is the only thing on this
   * dashboard that stops a graphic going to the wrong show. If a brand new
   * account saw it on first sign-in, operators would learn to ignore it.
   */
  ok(
    'and it is not the on-air guest warning',
    await lostPage.evaluate(() => !document.body.classList.contains('is-guest')),
  );

  // Global is the panel that threw. It must now explain itself instead.
  await lostPage.click('.rail-item[data-tab="global"]');
  await new Promise((r) => setTimeout(r, 700));
  ok(
    'the Global panel says why it is empty rather than throwing',
    /no tournament/i.test(await lostPage.textContent('#ged-shared')),
    await lostPage.textContent('#ged-shared'),
  );
  ok('no page error reached a brand new account', lostErrors.length === 0, JSON.stringify(lostErrors.slice(0, 2)));
  await lost.close();

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
  /*
   * "(yours)" is gone with the idea it named - nobody owns a production by
   * owning an account. Every entry is a tournament and what differs is the
   * level you hold on it, so that is what the selector prints.
   */
  ok('the selector says what you are on each', options.some((text) => text.includes('- owner')), JSON.stringify(options));
  ok('and names the shared one as an editor', options.some((text) => text.includes('Main show - editor')), JSON.stringify(options));

  // The half of the redefinition a suite can lose silently: their own show,
  // which is what opens by default, must NOT be marked.
  ok(
    'an owner on their own production is not a guest',
    !(await opPage.evaluate(() => document.body.classList.contains('is-guest'))),
  );

  await opPage.selectOption('#session-target', { label: 'Main show - editor' });
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

  /*
   * A different PRODUCTION does not see it, which is the modern form of "a
   * different account does not".
   *
   * The list is filtered on two axes now - files claimed by you, plus files
   * claimed by the tournament you are on - and that is deliberate: a colleague
   * on the same tournament is SUPPOSED to see the logo you uploaded to it, or
   * the picker hides artwork from the person you are running the show with. So
   * the isolation that is still real is between productions, and this asks for
   * it from an account that is neither the uploader nor a member of the
   * tournament the file was claimed by. The bare fetch carries no ?session=, so
   * it lands on the operator's own show - see the note on why that one is newer.
   */
  const otherList = await opPage.evaluate(() => fetch("/api/media").then((r) => r.json()));
  ok("another production does not see it", otherList.media?.length === 0, JSON.stringify(otherList));

  // And the other side of that same rule, so the filter cannot quietly become
  // "nobody sees anything": on the tournament it was uploaded to, the editor
  // sharing it does.
  const sharedList = await opPage.evaluate((id) =>
    fetch(`/api/media?session=${id}`).then((r) => r.json()), showId);
  ok("but an editor on the tournament it belongs to does", sharedList.media?.length === 1, JSON.stringify(sharedList));

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

  /*
   * The permissions live in a per-account MODAL now, and the row is a name and
   * a Manage button. That was not a cosmetic move: CAPABILITY_FIELDS is a list,
   * so every permission added to the schema added a button to every row, and
   * the row had already pushed Delete out through the side of its panel on an
   * administrator who also held the tracker permission.
   *
   * So the first thing asserted is the property that keeps it fixed - the row
   * does not grow with the schema - because every assertion below would stay
   * green if somebody put the buttons back on the row.
   */
  ok(
    "an account row carries one button, whatever the schema says",
    (await opRow.locator("button").count()) === 1,
    String(await opRow.locator("button").count()),
  );

  const manage = async (row) => {
    await row.locator("button", { hasText: "Manage" }).click();
    await page.waitForSelector(".rl-modal", { timeout: 6000 });
  };
  const shut = async () => {
    if (await page.$(".rl-modal")) {
      await page.locator(".rl-modal-foot .btn-ghost").last().click();
      await page.waitForFunction(() => !document.querySelector(".rl-modal"), null, { timeout: 6000 });
    }
  };
  const capButton = () => page.locator(".rl-modal button", { hasText: "Tracker login" });

  await manage(adminRow);
  ok("an admin shows the permission as implicit", (await capButton().textContent()).includes("admin"));
  ok("and offers no toggle", await capButton().isDisabled());
  await shut();

  await manage(opRow);
  ok("a new account starts off", (await capButton().textContent()).includes("off"));

  page.once("dialog", (dialog) => dialog.accept());
  await capButton().click();
  /*
   * The dialog STAYS OPEN and repaints, which is the point of managing an
   * account in one place - granting three permissions should be one visit, not
   * three. Waiting on the modal rather than on the row is also what makes this
   * assertion about the write rather than about the list behind it.
   */
  await page.waitForFunction(
    () => {
      const modal = document.querySelector(".rl-modal");
      return Boolean(modal) && [...modal.querySelectorAll("button")].some((b) => b.textContent.includes("Tracker login on"));
    },
    null,
    { timeout: 6000 },
  );
  ok("granting it takes, without closing the editor", true);

  const granted = await opPage.evaluate(() => fetch("/api/account/me").then((r) => r.json()).then((d) => d.user.mayOpenTrackerLogin));
  ok("the granted account agrees", granted === true, String(granted));

  // No dialog handler here: revoking is not confirmed, only granting is. A
  // `once` handler that never fires stays registered and then swallows the next
  // dialog - which is how this collided with the switches block below.
  await capButton().click();
  await page.waitForFunction(
    () => {
      const modal = document.querySelector(".rl-modal");
      return Boolean(modal) && [...modal.querySelectorAll("button")].some((b) => b.textContent.includes("Tracker login off"));
    },
    null,
    { timeout: 6000 },
  );
  ok("revoking it takes", true);
  await shut();
  ok("and the editor closes on Close", (await page.$$(".rl-modal")).length === 0);

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
