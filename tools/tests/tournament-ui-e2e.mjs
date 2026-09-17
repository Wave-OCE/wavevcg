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
    /*
     * Pinned empty, because otherwise this suite's result depends on whose
     * machine it runs on.
     *
     * loadDotEnv only fills a variable that is not already in process.env, so a
     * spawn that says nothing about these inherits whatever the developer has
     * in their own .env - and the verify assertions below would pass on a
     * machine with no keys and fail on one with them, for no reason connected
     * to the code. An empty string is still "in process.env", so this wins.
     */
    HENRIK_API_KEY: '',
    RIOT_API_KEY: '',
    RIOT_ACCOUNT_KEY: '',
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

  // --- the team library and its roster --------------------------------------

  /*
   * A reload, and it is covering a real gap rather than being impatient.
   *
   * winner-dashboard.js builds the team library once at startup. On a fresh
   * install that startup happens while the account is on no tournament, so
   * /api/teams answers 403 and the editor is never built - and nothing rebuilds
   * it when a tournament appears a moment later. So an operator who makes their
   * very first tournament finds the Teams page empty until they reload, with
   * nothing saying why.
   *
   * The fix belongs in those dashboards: they need to re-initialise when the
   * production changes, which is also what would let the picker switch
   * tournaments without a reload. Until then this reload is what the operator
   * has to do, so it is what the suite does.
   */
  await page.reload();
  await wait(1200);
  errors.length = 0;
  await page.click('.rail-item[data-tab="tournament"]');
  await wait(400);

  await page.click('.subtabs[data-for="tournament"] .subtab[data-view="tou-teams"]');
  await wait(400);
  /*
   * Asked of the PANEL, not of #wed-teams. That element carries display:contents
   * so the library's children sit directly in the panel - which means it has no
   * layout box of its own, and every visibility check on it answers false
   * however well the page is working.
   */
  ok('20a. the Teams sub-page shows the library', await page.isVisible('#tou-teams'));
  ok('20b. ...with a roster editor', (await page.$('#wed-teams .roster-rows')) !== null);

  await page.fill('#wed-teams input[type=text]', 'Sentinels');
  await page.click('#wed-teams .roster-rows button:has-text("Add player")');
  await wait(250);
  const rosterInputs = await page.$$('#wed-teams .roster-row input');
  ok('20c. a row has a name and a Riot ID', rosterInputs.length === 2);

  await rosterInputs[1].fill('not-a-riot-id');
  await wait(150);
  ok(
    '20d. a malformed Riot ID is marked',
    await page.$eval('#wed-teams .roster-row input:nth-of-type(2)', (i) => i.classList.contains('is-wrong')),
  );
  await rosterInputs[1].fill('TenZ#SEN');
  await wait(150);
  ok(
    '20e. ...and unmarked once it looks right',
    await page.$eval('#wed-teams .roster-row input:nth-of-type(2)', (i) => !i.classList.contains('is-wrong')),
  );

  /*
   * The caret. The roster repaints on its own for exactly this reason - the
   * note above teamSaveBtn records that rebuilding the panel replaces the input
   * being typed into, so a name had to be entered one letter and one click at a
   * time. Typing a whole word and getting a whole word back is the assertion
   * that keeps that fix from being undone by a well-meaning repaint.
   */
  await rosterInputs[0].fill('');
  await rosterInputs[0].type('Zekken');
  await wait(150);
  ok('20f. typing a name keeps every letter of it', (await rosterInputs[0].inputValue()) === 'Zekken');

  /*
   * No stray "null" anywhere in the roster block.
   *
   * replaceChildren and append STRINGIFY what they are handed, so a conditional
   * child that resolves to null appends the text "null" to the page. Two of
   * them were doing exactly that under this roster, and every DOM assertion in
   * this file passed while it happened - the rows, the inputs and the buttons
   * were all present and correct, and the junk was in text nodes nobody asked
   * about. It took a screenshot to see.
   *
   * Asked of the child NODES, not of the text, and the first attempt at this
   * assertion is why. Testing textContent for /\bnull\b/ passed on genuinely
   * broken code: the stray nodes concatenate straight against their neighbours
   * as "...×nullAdd playernull", so there is no word boundary on either side of
   * either one and the pattern never matched. It was green against a page
   * visibly painting the word twice.
   *
   * Every child here is built by el(), so a text node among them is always the
   * bug and never the design.
   */
  const strays = await page.$eval('#wed-teams .roster-rows', (node) =>
    [...node.childNodes].filter((child) => child.nodeType === 3).map((child) => child.data),
  );
  ok('20g. the roster block appends no stray text nodes', strays.length === 0, JSON.stringify(strays));

  /*
   * The verification control exists and refuses politely.
   *
   * This server has no HenrikDev or Riot key, which is the state most installs
   * start in, so the button must be present, disabled, and carry a title that
   * says why - rather than being absent (leaving an operator to wonder where
   * the feature went) or enabled and failing on click.
   */
  ok('20h. every roster row carries a verify control', (await page.$('#wed-teams .roster-state .mini-btn')) !== null);
  ok(
    '20i. ...disabled on a server with no keys',
    await page.$eval('#wed-teams .roster-state .mini-btn', (b) => b.disabled),
  );
  ok(
    '20j. ...and it says why rather than just being dead',
    /no HenrikDev or Riot account key/i.test(
      await page.$eval('#wed-teams .roster-state .mini-btn', (b) => b.title),
    ),
    await page.$eval('#wed-teams .roster-state .mini-btn', (b) => b.title),
  );

  await page.click('#wed-teams button:has-text("Add team")');
  await wait(800);
  const saved = await (await fetch(`${BASE}/api/teams`, { headers: { Cookie: jar.join('; ') } })).json();
  const squad = saved.teams?.[0]?.players ?? [];
  ok('20k. the roster reached the server', squad.length === 1, JSON.stringify(saved.teams?.[0]));
  ok('20l. ...with both fields', squad[0]?.displayName === 'Zekken' && squad[0]?.riotId === 'TenZ#SEN');
  ok('20m. ...and an empty puuid waiting to be filled', squad[0]?.puuid === '');

  await page.click('.subtabs[data-for="tournament"] .subtab[data-view="tou-access"]');
  await wait(300);

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

  /*
   * --- the archive/delete split, as the owner sees it ---------------------
   *
   * The split is enforced on the server, but this is where it is EXPRESSED:
   * the irreversible button is not on the page at all until the reversible
   * step has been taken, so it cannot be reached by a mis-click on a picker.
   */
  /*
   * --- the productions list, and the topbar selector it feeds ---------------
   *
   * Back to Settings FIRST. A remembered sub-tab is not restored by returning
   * to the section, and the assertions above left this page on another panel -
   * a hidden card is still in the DOM, still bound and still readable, so every
   * assertion below that READS would pass while the one that CLICKS times out
   * thirty seconds later naming nothing. That is the wed-audio bug exactly.
   */
  await page.click('.subtabs[data-for="tournament"] .subtab[data-view="tou-settings"]');
  await wait(400);

  ok('26a. the Settings panel lists the desks', (await page.$('#tou-desks .desk-row')) !== null, 'buildDesks did not paint');
  ok(
    '26b. a new tournament has exactly one',
    (await page.$$('#tou-desks .desk-row')).length === 1,
    String((await page.$$('#tou-desks .desk-row')).length),
  );
  ok('26c. ...called Main', (await page.textContent('#tou-desks .desk-name')) === 'Main');
  /*
   * No Remove on the only desk. The server refuses it too, but a button that
   * exists gets pressed - and what it would leave behind is a tournament with
   * no graphics and no OBS URL.
   */
  ok('26d. the only desk offers no Remove', !(await page.$('#tou-desks .desk-row button:has-text("Remove")')));
  ok('26e. the topbar desk selector is hidden with one desk', !(await page.isVisible('#desk-target-wrap')));
  /*
   * And the label that was wrong: the first selector lists TOURNAMENTS, and it
   * said "Production" until productions became a real thing with a different
   * meaning.
   */
  ok(
    '26f. the tournament selector is labelled Tournament',
    (await page.textContent('.whoami-target span')).trim() === 'Tournament',
    await page.textContent('.whoami-target span'),
  );

  page.once('dialog', (d) => d.accept('Court 2'));
  await page.click('#tou-desks button:has-text("Add production")');
  await wait(1200);
  ok('26g. an owner can add a desk', (await page.$$('#tou-desks .desk-row')).length === 2, String((await page.$$('#tou-desks .desk-row')).length));
  /*
   * The topbar lives in account.js and was not involved in that write. It
   * follows because refreshAccount fires `account-changed` - without it the new
   * desk appeared in this list and in no selector anywhere until a reload.
   */
  ok('26h. the topbar selector appears', await page.isVisible('#desk-target-wrap'));
  ok(
    '26i. ...carrying both desks',
    (await page.$$eval('#desk-target option', (o) => o.map((x) => x.textContent))).join(',') === 'Main,Court 2',
    await page.$$eval('#desk-target option', (o) => o.map((x) => x.textContent).join(',')),
  );
  ok('26j. both desks now offer Remove', (await page.$$('#tou-desks button:has-text("Remove")')).length === 2);

  /*
   * --- the Schedule sub-page ------------------------------------------------
   *
   * The shape first, as the note at the top of this file says: a panel
   * correctly hidden and a panel never wired look identical to every DOM
   * assertion, and the difference surfaces eight seconds later as a timeout
   * naming nothing.
   */
  await page.click('.subtabs[data-for="tournament"] .subtab[data-view="tou-schedule"]');
  await wait(600);
  ok('27a. the Schedule panel opens', await page.isVisible('#tou-schedule'));
  ok('27b. ...and the module built into it', (await page.$('#sch-body .sch-stages')) !== null, 'schedule-dashboard.js did not paint');
  ok(
    '27c. ...saying what to do first',
    (await page.textContent('#sch-body')).includes('Add a stage'),
    (await page.textContent('#sch-body')).slice(0, 80),
  );

  page.once('dialog', (d) => d.accept('Playoffs'));
  await page.click('#sch-body button:has-text("Add stage")');
  await wait(900);
  ok('27d. a stage can be added', (await page.textContent('.sch-stage')).startsWith('Playoffs'), await page.textContent('.sch-stage'));
  ok('27e. ...and its fixture count is on the pill', (await page.textContent('.sch-stage')).includes('(0)'));

  await page.click('#sch-body button:has-text("Add fixture")');
  await wait(800);
  ok('27f. a fixture can be added', (await page.$$('.sch-fixture')).length === 1, String((await page.$$('.sch-fixture')).length));
  ok('27g. ...and starts as scheduled', (await page.textContent('.sch-fixture .sch-status')) === 'Scheduled');

  /*
   * No stray text nodes. replaceChildren STRINGIFIES what it is handed, so a
   * conditional child resolving to null paints the word "null" on the page -
   * which happened under the roster editor and took a screenshot to see. Asked
   * of the node types, because a textContent regexp for /\bnull\b/ was ALSO
   * green against that bug: the strays concatenate against their neighbours and
   * have no word boundary on either side.
   */
  const schedStrays = await page.$eval('#sch-body', (node) => {
    const out = [];
    const walk = (parent) => {
      for (const child of parent.childNodes) {
        if (child.nodeType === 3 && child.data.trim()) out.push(child.data.trim());
        else if (child.nodeType === 1) walk(child);
      }
    };
    walk(node);
    return out.filter((textNode) => /^(null|undefined)$/.test(textNode));
  });
  ok('27h. the Schedule panel appends no stray null', schedStrays.length === 0, JSON.stringify(schedStrays));


  /*
   * --- the bracket, and the match editor ------------------------------------
   *
   * The stage added above is a round robin by default, so it draws a table.
   * Switching it to a bracket is what puts a drawing on the page, and doing it
   * through the select is the operator's own path rather than a fixture posted
   * behind the page's back.
   */
  await page.selectOption('#sch-body select[aria-label="Stage kind"]', 'bracket');
  await wait(900);
  ok('27i. a bracket stage draws a bracket', await page.isVisible('.sch-bracket'));
  ok('27j. ...with a node for the fixture', (await page.$$('.sch-node')).length === 1, String((await page.$$('.sch-node')).length));
  ok('27k. ...and no standings table', (await page.$$('#sch-body .sch-table')).length === 0);

  /*
   * THE CARET RULE, asserted as the shape rather than by typing.
   *
   * This page meets it by SEPARATION: every input that carries a caret lives in
   * the modal, which is built once and never touched by paint(). If a text box
   * ever appears on the page itself, the page can no longer repaint freely and
   * the failure is a caret jumping mid-word - which no other assertion here
   * would catch.
   */
  ok(
    '27l. the page itself has no text input',
    (await page.$$('#tou-schedule input[type="text"]')).length === 0,
    String((await page.$$('#tou-schedule input[type="text"]')).length),
  );

  await page.click('.sch-node');
  await wait(600);
  ok('27m. clicking a match opens the editor', await page.isVisible('.sch-modal'));
  ok('27n. ...as a real modal dialog', await page.evaluate(() => document.querySelector('.sch-modal').open === true));
  /*
   * On document.body, NOT inside the painted host. That is what makes the
   * separation above true rather than merely intended: a repaint replaces
   * everything under #sch-body, and anything holding a caret in there would go
   * with it.
   */
  ok('27o. ...outside the painted host', await page.evaluate(() => document.querySelector('.sch-modal').parentElement === document.body));
  ok('27p. ...carrying a map row per map of the series', (await page.$$('.sch-modal .sch-map')).length === 3, String((await page.$$('.sch-modal .sch-map')).length));

  // Typing, then provoking a repaint of the page behind it. The box must
  // survive, or the separation is decorative.
  await page.fill('.sch-modal .sch-map:nth-child(1) input[type="text"]', 'Ascent');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('teams-changed', { detail: [] })));
  await wait(400);
  ok(
    '27q. a repaint behind the modal does not eat what is being typed',
    (await page.inputValue('.sch-modal .sch-map:nth-child(1) input[type="text"]')) === 'Ascent',
    await page.inputValue('.sch-modal .sch-map:nth-child(1) input[type="text"]'),
  );

  await page.fill('.sch-modal .sch-map:nth-child(1) input[type="number"] >> nth=0', '13');
  await page.fill('.sch-modal .sch-map:nth-child(1) input[type="number"] >> nth=1', '7');
  await wait(300);
  ok('27r. the running tally follows the boxes', (await page.textContent('.sch-modal .sch-result-score')).trim() === '1 - 0', (await page.textContent('.sch-modal .sch-result-score')).trim());

  await page.click('.sch-modal-foot .btn-primary');
  await wait(900);
  ok('27s. saving closes the editor', (await page.$$('.sch-modal')).length === 0);
  const savedSchedule = await (await fetch(`${BASE}/api/schedule?session=${cupId}`, { headers: { Cookie: jar.join('; ') } })).json();
  ok(
    '27t. ...and the result reached the schedule',
    savedSchedule.schedule.fixtures[0]?.maps?.[0]?.name === 'Ascent' && savedSchedule.schedule.fixtures[0]?.maps?.[0]?.left === 13,
    JSON.stringify(savedSchedule.schedule.fixtures[0]?.maps?.[0]),
  );

  /*
   * And Cancel writes NOTHING, which is the promise a modal makes that an
   * inline editor writing on every change never could.
   */
  await page.click('.sch-node');
  await wait(600);
  await page.fill('.sch-modal .sch-map:nth-child(2) input[type="text"]', 'Never saved');
  await page.click('.sch-modal-foot .btn-ghost >> nth=1');
  await wait(800);
  const afterCancel = await (await fetch(`${BASE}/api/schedule?session=${cupId}`, { headers: { Cookie: jar.join('; ') } })).json();
  ok('27u. cancelling writes nothing', !JSON.stringify(afterCancel.schedule).includes('Never saved'));
  ok('27v. ...and closes the editor', (await page.$$('.sch-modal')).length === 0);

  // Escape is the platform's, which is the reason to use a real dialog.
  await page.click('.sch-node');
  await wait(500);
  await page.keyboard.press('Escape');
  await wait(500);
  ok('27w. escape closes the editor', (await page.$$('.sch-modal')).length === 0);

  // Back to Settings, or the assertions below type into a hidden card. A
  // remembered sub-tab is not restored by returning to the section.
  await page.click('.subtabs[data-for="tournament"] .subtab[data-view="tou-settings"]');
  await wait(400);

  ok('28a. an owner sees Export on a live tournament', await page.isVisible('#tou-export'));
  ok('28b. ...and no Delete', !(await page.isVisible('#tou-delete')));
  ok('28c. an editor gets no Delete either', !(await guest.isVisible('#tou-delete')));

  await post('/api/tournaments', { action: 'archive', id: cupId, archived: true });
  await page.reload();
  await wait(1000);
  await page.click('.rail-item[data-tab="tournament"]');
  await wait(500);
  ok('28d. Delete appears once it is archived', await page.isVisible('#tou-delete'));
  /*
   * And Export must SURVIVE archiving, which is the one that was wrong first
   * time: it was hidden behind mayEdit(), which is false on an archived
   * tournament - so the only copy an owner could take of a competition
   * disappeared at exactly the moment the Delete button appeared beside it.
   */
  ok('28e. ...and Export is still there, which is the whole point', await page.isVisible('#tou-export'));

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
