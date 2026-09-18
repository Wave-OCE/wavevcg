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
const eqv = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
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

  /*
   * THE PANEL HAS NO TEXT INPUT. Everything about one team is in the modal, and
   * this is the assertion that keeps it that way - a well-meaning "just put the
   * name box back on the page" undoes the whole reason the form moved, and every
   * other assertion in this block would stay green while it happened.
   */
  ok(
    '20a2. the team panel itself carries no text input',
    (await page.$$('#wed-teams input[type="text"]')).length === 0,
    String((await page.$$('#wed-teams input[type="text"]')).length),
  );

  await page.click('#wed-teams button:has-text("Add team")');
  await wait(500);
  ok('20b. the editor opens as a modal', await page.isVisible('.rl-modal'));
  ok('20b2. ...on document.body, outside the painted panel', await page.evaluate(() => document.querySelector('.rl-modal').parentElement === document.body));
  ok('20b3. ...with a roster editor in it', (await page.$('.rl-modal .roster-rows')) !== null);

  await page.fill('.rl-modal input[type=text]', 'Sentinels');
  await page.click('.rl-modal .roster-rows button:has-text("Add player")');
  await wait(250);
  const rosterInputs = await page.$$('.rl-modal .roster-row input');
  ok('20c. a row has a name and a Riot ID', rosterInputs.length === 2);

  await rosterInputs[1].fill('not-a-riot-id');
  await wait(150);
  ok(
    '20d. a malformed Riot ID is marked',
    await page.$eval('.rl-modal .roster-row input:nth-of-type(2)', (i) => i.classList.contains('is-wrong')),
  );
  await rosterInputs[1].fill('TenZ#SEN');
  await wait(150);
  ok(
    '20e. ...and unmarked once it looks right',
    await page.$eval('.rl-modal .roster-row input:nth-of-type(2)', (i) => !i.classList.contains('is-wrong')),
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
  const strays = await page.$eval('.rl-modal .roster-rows', (node) =>
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
  ok('20h. every roster row carries a verify control', (await page.$('.rl-modal .roster-state .mini-btn')) !== null);
  ok(
    '20i. ...disabled on a server with no keys',
    await page.$eval('.rl-modal .roster-state .mini-btn', (b) => b.disabled),
  );
  ok(
    '20j. ...and it says why rather than just being dead',
    // Both remedies, because there are two reasons the button can be dead and
    // they are fixed by different people: an environment variable and a
    // restart, or an administrator throwing a switch.
    /RIOT_ACCOUNT_KEY/.test(await page.$eval('.rl-modal .roster-state .mini-btn', (b) => b.title)) &&
      /HenrikDev fallback/i.test(
      await page.$eval('.rl-modal .roster-state .mini-btn', (b) => b.title),
    ),
    await page.$eval('.rl-modal .roster-state .mini-btn', (b) => b.title),
  );

  await page.click('.rl-modal-foot .btn-primary');
  await wait(900);
  ok('20k0. saving closes the editor', (await page.$$('.rl-modal')).length === 0);
  const saved = await (await fetch(`${BASE}/api/teams`, { headers: { Cookie: jar.join('; ') } })).json();
  const squad = saved.teams?.[0]?.players ?? [];
  ok('20k. the roster reached the server', squad.length === 1, JSON.stringify(saved.teams?.[0]));
  ok('20l. ...with both fields', squad[0]?.displayName === 'Zekken' && squad[0]?.riotId === 'TenZ#SEN');
  ok('20m. ...and an empty puuid waiting to be filled', squad[0]?.puuid === '');

  /*
   * ONE WRITE, so Cancel really does mean nothing happened - which a form
   * saving on every change could never promise, and which is the whole reason
   * an editor is worth moving into a dialog.
   *
   * The cost of that promise is that Cancel, Escape and the backdrop all throw
   * the work away, and two of those three are reflexes. So leaving with
   * something typed ASKS first - see modal.js - and what follows is both
   * halves: the prompt appears, and taking the destructive answer still writes
   * nothing at all.
   */
  await page.click('#wed-teams .team-card .mini-btn');
  await wait(600);
  ok('20m2. a saved team reopens in the modal', await page.isVisible('.rl-modal'));

  /*
   * NOT A NAG, and this is the assertion that keeps it one.
   *
   * Escape with nothing typed has to close immediately. A prompt in front of an
   * operator who changed nothing is the one that teaches people to dismiss the
   * prompt without reading it - on the dialog where it is telling the truth
   * about thirty players.
   */
  await page.keyboard.press('Escape');
  await wait(400);
  ok(
    '20m2a. leaving an untouched form does not ask',
    (await page.$$('.rl-modal')).length === 0,
    'a prompt with nothing to discard is a prompt nobody reads',
  );

  await page.click('#wed-teams .team-card .mini-btn');
  await wait(600);
  await page.fill('.rl-modal input[type=text]', 'Never Saved');
  await page.keyboard.press('Escape');
  await wait(400);
  ok('20m2b. Escape with something typed asks first', (await page.$$('.rl-modal-ask')).length === 1);
  ok('20m2c. ...and the dialog is still there underneath', (await page.$$('.rl-modal')).length === 1);

  /*
   * THE PROMPT IS NOT A SECOND DIALOG. A second showModal() takes the focus
   * trap with it and strands the first, which is the one rule modal.js has
   * always had - and this is exactly the case where the first has to survive,
   * because it is holding the work being asked about.
   */
  const askShape = await page.evaluate(() => {
    const dialog = document.querySelector('dialog.rl-modal');
    const ask = dialog?.querySelector('.rl-modal-ask');
    if (!ask) return null;
    const box = ask.getBoundingClientRect();
    return {
      dialogs: document.querySelectorAll('dialog').length,
      inside: dialog.contains(ask),
      focused: document.activeElement?.textContent ?? '',
      /*
       * `inset: 0` against a modal <dialog>, which the UA sheet positions and
       * which is therefore the containing block for it. Measured rather than
       * assumed: a browser that ever stopped doing that would paint this prompt
       * off the corner of the screen with nothing else failing.
       */
      covers: Math.abs(box.width - dialog.clientWidth) < 1.5 && Math.abs(box.height - dialog.clientHeight) < 1.5,
    };
  });
  ok('20m2d. the prompt is inside the open dialog, not a second one', askShape?.dialogs === 1 && askShape?.inside === true, JSON.stringify(askShape));
  ok('20m2e. ...and covers it', askShape?.covers === true, JSON.stringify(askShape));
  ok('20m2f. ...with the SAFE answer focused', askShape?.focused === 'Keep editing', JSON.stringify(askShape));

  /*
   * And the destructive answer stays on the FAR side of it at phone width.
   *
   * `.rl-modal-danger` reorders itself under 520px for the footer's sake, so
   * borrowing that class for its colour put Discard where Keep editing sits on
   * every wider screen - exactly the mis-tap the footer rule exists to prevent,
   * introduced by reusing the rule that prevents it. Give the discard button
   * `rl-modal-danger` back and this goes red at 420px.
   */
  await page.setViewportSize({ width: 420, height: 900 });
  await wait(250);
  const askOrder = await page.evaluate(() => {
    const row = document.querySelector('.rl-modal-ask-row');
    if (!row) return null;
    return [...row.children]
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
      .map((node) => node.textContent);
  });
  ok('20m2f2. ...and the destructive answer stays left of it on a phone', askOrder?.[0] === 'Discard changes', JSON.stringify(askOrder));
  await page.setViewportSize({ width: 1500, height: 950 });
  await wait(250);

  await page.click('.rl-modal-ask .btn-primary');
  await wait(300);
  ok('20m2g. Keep editing puts the form back', (await page.$$('.rl-modal-ask')).length === 0);
  ok(
    '20m2h. ...with what was typed still in it',
    (await page.inputValue('.rl-modal input[type=text]')) === 'Never Saved',
    await page.inputValue('.rl-modal input[type=text]'),
  );

  await page.click('.rl-modal-foot .btn-ghost >> nth=-1');
  await wait(400);
  ok('20m2i. Cancel asks too, not only Escape', (await page.$$('.rl-modal-ask')).length === 1);
  await page.click('.rl-modal-ask .rl-modal-ask-danger');
  await wait(700);
  const teamsAfterCancel = await (await fetch(`${BASE}/api/teams`, { headers: { Cookie: jar.join('; ') } })).json();
  ok('20m3. cancelling writes nothing', !JSON.stringify(teamsAfterCancel.teams).includes('Never Saved'), JSON.stringify(teamsAfterCancel.teams?.[0]?.name));
  ok('20m4. ...and closes the editor', (await page.$$('.rl-modal')).length === 0);

  // ------------------------------------------------- the player search ---
  /*
   * The Players page, which is a search across BOTH libraries now.
   *
   * It used to be a list of the alias library - every account the agent select
   * feed had reported, newest first - and the thing wrong with that was not the
   * ordering. A squad typed onto the Teams page an hour before doors is not in
   * the feed's library at all, so searching for a player by name on the page
   * called Players found nothing while the Teams page had them all along.
   *
   * So the first assertion is that the player just saved on the Teams tab is
   * findable here. Nothing else in this file would notice if the merge in
   * players-index.js silently dropped one of its two sources.
   */
  await page.click('.subtabs[data-for="tournament"] .subtab[data-view="tou-players"]');
  await wait(900);

  ok('20n. the Players sub-page is a search', (await page.$('#ply-search')) !== null);
  ok(
    '20o. ...and a roster player is IN it, not only feed records',
    (await page.$$('.ply-card')).length >= 1 && /Zekken/.test(await page.textContent('.ply-results')),
    await page.textContent('.ply-count'),
  );
  ok(
    '20p. ...showing which team they are on',
    /SEN|Sentinels/.test(await page.textContent('.ply-origin')),
    await page.textContent('.ply-origin'),
  );

  /*
   * THE CARET, and here it is met by the SHAPE of the panel rather than by a
   * modal: the search box and the results are siblings and only the results are
   * ever replaced. A well-meaning refactor that rebuilt the whole panel on each
   * keystroke would leave every assertion above green and make the box unusable
   * - one letter, then focus gone.
   */
  await page.click('#ply-search');
  await page.type('#ply-search', 'Zekken', { delay: 30 });
  await wait(350);
  ok('20q. typing in the search keeps every letter', (await page.inputValue('#ply-search')) === 'Zekken');
  ok(
    '20r. ...and the box still has focus after the list repaints',
    await page.evaluate(() => document.activeElement?.id === 'ply-search'),
    await page.evaluate(() => document.activeElement?.id ?? 'none'),
  );
  ok('20s. the search actually filters', (await page.$$('.ply-card')).length === 1, String((await page.$$('.ply-card')).length));

  await page.fill('#ply-search', 'nobody-by-that-name');
  await wait(300);
  ok('20t. ...and says so when nothing matches', (await page.$$('.ply-card')).length === 0);

  /*
   * The SHAPE of a card, asked before anything types into one.
   *
   * A box has to hold four things to be worth being a box - a face, the name
   * that goes on air, the handle underneath it, and the two controls - and a
   * card missing one of them still paints, still lays out, and looks fine in a
   * grid of one. The fifth part of this is the interesting one: the card must
   * hold NO input at all, which is what makes the search caret safe by
   * structure rather than by a rule somebody has to remember. Put an inline
   * name box back and this goes red before any of the caret assertions run.
   */
  await page.fill('#ply-search', 'Zekken');
  await wait(300);
  const card = await page.evaluate(() => {
    const box = document.querySelector('.ply-card');
    if (!box) return null;
    const photo = box.querySelector('.ply-card-photo');
    return {
      photo: !!photo,
      placeholder: photo?.classList.contains('is-empty') ?? false,
      initials: photo?.querySelector('.ply-card-initials')?.textContent ?? '',
      name: box.querySelector('.ply-name')?.textContent ?? '',
      riot: box.querySelector('.ply-riot')?.textContent ?? '',
      verify: box.querySelector('.roster-state .mini-btn')?.textContent ?? '',
      tools: [...box.querySelectorAll('.ply-card-tools > .mini-btn')].map((b) => b.textContent),
      fields: box.querySelectorAll('input, textarea, select').length,
      width: Math.round(box.getBoundingClientRect().width),
    };
  });
  ok('20t2. a card has somewhere for a face', card?.photo === true, JSON.stringify(card));
  ok(
    '20t3. ...a blank placeholder when there is no photo, carrying their initials',
    card?.placeholder === true && card?.initials === 'ZE',
    `${card?.placeholder} ${card?.initials}`,
  );
  ok('20t4. ...the name that goes on air', /Zekken/.test(card?.name ?? ''), card?.name);
  ok('20t5. ...the Riot ID under it', /#/.test(card?.riot ?? ''), card?.riot);
  ok('20t6. ...a verify control', card?.verify === 'Verify' || card?.verify === '\u2713', card?.verify);
  ok('20t7. ...and one Edit button', JSON.stringify(card?.tools) === '["Edit"]', JSON.stringify(card?.tools));
  ok('20t8. a card holds no input, so the search caret cannot be taken by a repaint', card?.fields === 0, String(card?.fields));

  /*
   * Several cards across the width rather than one band each - the whole reason
   * this stopped being a list. A card that filled the panel would leave every
   * assertion above green and the page looking exactly as oddly spaced as it
   * did before.
   */
  const panelWidth = await page.evaluate(() => Math.round(document.querySelector('.ply-grid').getBoundingClientRect().width));
  ok(
    '20t9. ...and a card is a box, not a full-width row',
    card.width < panelWidth * 0.75,
    `card ${card.width} of ${panelWidth}`,
  );

  /*
   * Renaming here writes the ROSTER, not a second copy. One name in one place
   * whichever door you came in by - which is the whole point of folding the
   * alias library into the player editor, and is invisible to any assertion
   * that only looks at the page.
   *
   * Through the MODAL now, which is also where the photo went: the inline box
   * this replaced committed on blur, and the media control beside it wrote on
   * every keystroke of a pasted URL, so a half-typed address reached the roster
   * and the lineup graphic before the paste had finished.
   */
  await page.click('.ply-card-tools > .mini-btn');
  await wait(600);
  ok('20u1. Edit opens the editor', await page.isVisible('.rl-modal'));
  ok(
    '20u2. ...with the photo control in it, not a bare URL box',
    (await page.$('.rl-modal .logo-preview')) !== null,
  );
  await page.fill('.rl-modal input[type=text] >> nth=0', 'ZEK');
  await page.click('.rl-modal-foot .btn-primary');
  await wait(900);
  ok('20u3. ...and saving closes it', (await page.$$('.rl-modal')).length === 0);
  const renamed = await (await fetch(`${BASE}/api/teams`, { headers: { Cookie: jar.join('; ') } })).json();
  ok(
    '20u4. a rename on the Players page writes the team roster',
    renamed.teams?.[0]?.players?.[0]?.displayName === 'ZEK',
    JSON.stringify(renamed.teams?.[0]?.players?.[0]),
  );
  const folded = await (await fetch(`${BASE}/api/aliases`, { headers: { Cookie: jar.join('; ') } })).json();
  ok(
    '20v. ...and folds through to the alias library, so the cards say it too',
    (folded.players ?? []).some((row) => row.alias === 'ZEK'),
    JSON.stringify(folded.players),
  );

  // ========================================== a spreadsheet of teams =========
  /*
   * The case this exists for: a competition's entry form arrives as a sheet
   * with thirty-two orgs and a hundred and sixty players in it, and the
   * alternative is opening the team editor a hundred and sixty times. That is
   * where misspelled Riot IDs come from, and a misspelled Riot ID is a player
   * the lobby matcher never finds.
   *
   * The PARSING is covered in team-roster.mjs, with no server and no browser,
   * which is what lets it assert on exactly what a sheet turns into. What is
   * here is the half only a browser can answer: that the button exists, that
   * what it reads reaches the same import review the JSON library file uses,
   * and that pressing the button puts the teams AND their players on the
   * server.
   *
   * It runs LAST of the team assertions on purpose - it adds two teams that
   * sort ahead of Sentinels, and the player search and the rename above both
   * read the first row of something.
   */
  await page.click('.subtabs[data-for="tournament"] .subtab[data-view="tou-teams"]');
  await wait(700);

  ok('20w. the panel offers a spreadsheet import', (await page.$('#wed-teams button:has-text("Import a spreadsheet")')) !== null);

  await page.click('#wed-teams button:has-text("Import a spreadsheet")');
  await wait(500);
  ok('20w2. ...as a modal', await page.isVisible('.rl-modal'));

  /*
   * AND THE PANEL STILL HAS NO TEXT INPUT. 20a2 above says it has none and this
   * says why the import had to be a dialog: the paste box IS a text input, the
   * panel is rebuilt from scratch whenever any team is saved, and a textarea
   * living in there would be emptied mid-paste by an event with nothing to do
   * with it. On document.body it cannot be reached.
   */
  const panelInputs = await page.$$('#wed-teams input[type="text"], #wed-teams textarea');
  ok('20w3. ...leaving the panel itself still free of text inputs', panelInputs.length === 0, String(panelInputs.length));

  await page.fill(
    '.rl-modal textarea',
    [
      'Team Name,Tricode,Region,Colour,Player Name,Riot ID,Seed',
      'Rivertown,RIV,Americas,#2244cc,Alpha,Alpha#NA1,1',
      'Rivertown,,,,Bravo,Bravo#NA1,1',
      'Hillside,HILL,EMEA,not-a-colour,Charlie,CharlieNoTag,2',
    ].join('\n'),
  );
  await page.click('.rl-modal .csv-actions .btn-small');
  await wait(900);

  ok('20w4. reading it closes the dialog', (await page.$$('.rl-modal')).length === 0);
  const importPanel = (await page.textContent('#wed-teams')).replace(/\s+/g, ' ');
  ok('20w5. ...and hands off to the ordinary import review', /Import teams/.test(importPanel), importPanel.slice(0, 80));
  ok('20w6. ...counting the players as well as the teams', /2 teams and 3 players/.test(importPanel), importPanel.slice(0, 200));

  /*
   * What the sheet got wrong, ON THE PAGE with a line number against each one -
   * not in a toast. A toast is gone in four seconds, and a sheet with sixty
   * malformed Riot IDs in it is something an operator goes back to the
   * spreadsheet to fix.
   */
  const problems = await page.$$eval('#wed-teams .csv-problem', (nodes) => nodes.map((n) => n.textContent));
  ok('20w7. the sheet\'s problems are listed on the page', problems.length === 3, JSON.stringify(problems));
  ok('20w8. ...each naming its line', problems.every((text) => /^line \d+/.test(text)), JSON.stringify(problems));
  ok('20w9. ...including a colour that is not hex', problems.some((text) => /not-a-colour/.test(text)), JSON.stringify(problems));
  ok('20w10. ...a Riot ID that will never verify', problems.some((text) => /CharlieNoTag/.test(text)), JSON.stringify(problems));
  ok('20w11. ...and a column it does not understand', problems.some((text) => /Seed/.test(text)), JSON.stringify(problems));

  await page.click('#wed-teams .team-form-actions .btn-primary');
  await wait(1400);
  const imported = await (await fetch(`${BASE}/api/teams`, { headers: { Cookie: jar.join('; ') } })).json();
  const river = imported.teams.find((team) => team.name === 'Rivertown');
  const hill = imported.teams.find((team) => team.name === 'Hillside');
  ok('20w12. the teams reached the server', Boolean(river && hill), JSON.stringify(imported.teams.map((t) => t.name)));
  ok('20w13. ...with their tricode and region', river?.shortName === 'RIV' && river?.region === 'Americas', JSON.stringify(river));
  ok('20w14. ...their colour', river?.colour === '#2244cc', String(river?.colour));
  ok('20w15. ...and their ROSTERS', river?.players?.length === 2, JSON.stringify(river?.players?.map((p) => p.displayName)));
  ok('20w16. a value the sheet got wrong did not land', hill?.colour === '', String(hill?.colour));
  ok('20w17. ...while a malformed Riot ID was kept as typed', hill?.players?.[0]?.riotId === 'CharlieNoTag', JSON.stringify(hill?.players?.[0]));

  /*
   * A player who came in on a sheet is a player, so the roster fold has to have
   * reached the alias library too - the same write a typed roster makes. This
   * is the assertion that a spreadsheet does not produce a second-class player.
   */
  const foldedIn = await (await fetch(`${BASE}/api/aliases`, { headers: { Cookie: jar.join('; ') } })).json();
  ok(
    '20w18. an imported player is named in the alias library as well',
    (foldedIn.players ?? []).some((row) => row.alias === 'Alpha'),
    JSON.stringify((foldedIn.players ?? []).map((r) => r.alias)),
  );

  /*
   * The roster paste inside the team editor, and the structural fact the whole
   * thing rides on: it lives OUTSIDE `.roster-rows`, which `paint()` replaces
   * every time a row is added or a verification lands. A textarea inside that
   * container would be emptied by pressing Add player - the caret rule, inside
   * a dialog that already met it by separation. Move it in and 20x2 goes red.
   */
  await page.click('#wed-teams .team-card:has-text("Rivertown") .mini-btn');
  await wait(700);
  ok('20x. the team editor offers a roster paste', (await page.$('.rl-modal .csv-fold')) !== null);
  ok(
    '20x2. ...outside the rows that repaint',
    await page.evaluate(
      () => !document.querySelector('.rl-modal .roster-rows')?.contains(document.querySelector('.rl-modal .csv-fold')),
    ),
  );

  await page.click('.rl-modal .csv-fold > summary');
  await wait(300);
  await page.fill('.rl-modal .csv-fold textarea', 'Player name\tRiot ID\nCharlie\tCharlie#NA1\nAlpha\tAlpha#MOVED');
  await page.click('.rl-modal .csv-fold .csv-actions .btn-small');
  await wait(600);

  const rosterNow = await page.$$eval('.rl-modal .roster-row input:first-of-type', (nodes) => nodes.map((n) => n.value));
  const idsNow = await page.$$eval('.rl-modal .roster-row input:nth-of-type(2)', (nodes) => nodes.map((n) => n.value));
  ok('20x3. a pasted roster ADDS who it names', rosterNow.includes('Charlie'), JSON.stringify(rosterNow));
  ok('20x4. ...updates who it matches', idsNow[rosterNow.indexOf('Alpha')] === 'Alpha#MOVED', JSON.stringify(idsNow));
  ok('20x5. ...and removes nobody it did not mention', rosterNow.includes('Bravo'), JSON.stringify(rosterNow));

  // And it is a DRAFT like everything else in this dialog - nothing reaches the
  // server until Save, which is what the whole modal exists to promise.
  const beforeSave = await (await fetch(`${BASE}/api/teams`, { headers: { Cookie: jar.join('; ') } })).json();
  ok(
    '20x6. a pasted roster is not written until the team is saved',
    !JSON.stringify(beforeSave.teams).includes('Alpha#MOVED'),
    JSON.stringify(beforeSave.teams.find((t) => t.name === 'Rivertown')?.players),
  );

  await page.click('.rl-modal-foot .btn-primary');
  await wait(1200);
  const afterSave = await (await fetch(`${BASE}/api/teams`, { headers: { Cookie: jar.join('; ') } })).json();
  const squadNow = afterSave.teams.find((team) => team.name === 'Rivertown')?.players ?? [];
  ok('20x7. saving writes it', squadNow.some((p) => p.riotId === 'Alpha#MOVED'), JSON.stringify(squadNow));
  ok('20x8. ...all three of them', squadNow.length === 3, JSON.stringify(squadNow.map((p) => p.displayName)));

  // ------------------------------------------------------- the map veto ---
  /*
   * The panel, and the one property that matters more than any of its
   * behaviour: the links are CREDENTIALS and must never be painted.
   *
   * This page is open on a laptop at a desk that is very often being
   * screen-shared or filmed, so a link printed in full is one frame away from
   * being everybody's - which is why they sit behind Copy buttons. Every other
   * assertion here would stay green if somebody "helpfully" showed the URL.
   */
  await page.click('.subtabs[data-for="tournament"] .subtab[data-view="tou-veto"]');
  await wait(900);
  ok('28a. the Map veto panel opens', await page.isVisible('#tou-veto'));
  ok('28b. ...and the module built into it', (await page.$$('.veto-pool-map')).length > 0, 'veto-dashboard.js did not paint');

  // Tick a pool, then make a veto through the modal - the operator's own path.
  const poolBoxes = page.locator('.veto-pool-map input');
  const poolCount = Math.min(7, await poolBoxes.count());
  for (let i = 0; i < poolCount; i += 1) {
    await poolBoxes.nth(i).check();
    await wait(140);
  }
  await page.click('#veto-body button:has-text("New veto")');
  await page.waitForSelector('.rl-modal', { timeout: 6000 });
  await page.fill('.rl-modal input[aria-label="Veto name"]', 'Grand final');
  await page.fill('.rl-modal input[aria-label="Team A name"]', 'Crusaders');
  await page.fill('.rl-modal input[aria-label="Team B name"]', 'Jail Time');
  await page.click('.rl-modal-foot .btn-primary');
  await wait(1100);

  ok('28c. a veto can be made', (await page.$$('.veto-card')).length === 1, String((await page.$$('.veto-card')).length));
  ok(
    '28d. ...laid out in the standard order for the format',
    (await page.$$eval('.veto-board-kind', (nodes) => nodes.map((n) => n.textContent))).join('|').toLowerCase().includes('bans'),
    await page.$$eval('.veto-board-kind', (nodes) => nodes.map((n) => n.textContent).join('|')),
  );
  ok('28e. ...with seven steps for a Bo3 on a seven-map pool', (await page.$$('.veto-board-step')).length === 7, String((await page.$$('.veto-board-step')).length));
  ok('28f. ...and a link to copy for each side plus the referee', (await page.$$('.veto-links .mini-btn')).length === 4, String((await page.$$('.veto-links .mini-btn')).length));

  const vetoState = await (await fetch(`${BASE}/api/veto`, { headers: { Cookie: jar.join('; ') } })).json();
  const vetoToken = Object.values(vetoState.tokens ?? {})[0]?.a ?? '';
  ok('28g. the server did mint a link', vetoToken.length > 20);
  ok(
    '28h. ...and NOTHING paints it on the page',
    await page.evaluate((t) => !document.documentElement.outerHTML.includes(t), vetoToken),
    'A VETO LINK IS ON SCREEN',
  );


  /*
   * WHAT THE COPY BUTTON ACTUALLY PRODUCES - and this is the assertion that
   * was missing, not a nice-to-have.
   *
   * veto-e2e has 57 assertions about the public route and every one of them
   * builds its own URL from a tournament id it already knows. So the ROUTE was
   * covered from every angle - wrong token, wrong tournament, out of turn,
   * rotation, redaction - and the one line that composes the address a captain
   * is actually sent was covered by nothing at all. It read the tournament id
   * out of the dashboard's own query string, which is empty in the ordinary
   * case (an operator with one tournament opens the dashboard at `/` and the
   * server resolves which from the cookie), so every link ever copied was
   * `?session=&k=...` and every captain who opened one was told the link was
   * incomplete.
   *
   * Nothing above would have caught it: 28f counts the buttons, 28g checks a
   * token exists, 28h checks it is not painted. So this one presses the button
   * and opens what it produces, in a FRESH context with no cookie, which is
   * what a captain on a phone actually is.
   */
  let prompted = '';
  /*
   * Registered for this click ONLY, and taken off again straight after.
   *
   * The Copy handler falls back to window.prompt when the clipboard is refused,
   * so a listener is needed - but a standing one eats the next dialog in the
   * file as well, and the later `page.once('dialog')` then fails with "cannot
   * accept dialog which is already handled". A listener that outlives what it
   * was for is a fixture that breaks somebody else's test.
   */
  const grabPrompt = async (dialog) => {
    prompted = dialog.defaultValue();
    await dialog.dismiss();
  };
  page.on('dialog', grabPrompt);
  await page.evaluate(() => {
    window.__copied = '';
    try {
      navigator.clipboard.writeText = async (text) => {
        window.__copied = text;
      };
    } catch {
      /* the prompt path above catches it */
    }
  });
  await page.click('.veto-links .mini-btn');
  await wait(500);
  page.off('dialog', grabPrompt);
  const copied = (await page.evaluate(() => window.__copied)) || prompted;
  ok('28i. the Copy button produces a link at all', /\/veto\.html\?/.test(copied), copied || '(nothing copied)');

  /*
   * The id is read back off the PICKER rather than out of the same /api/veto
   * response the dashboard used - otherwise this would only be asserting that
   * the server agrees with itself.
   */
  const tournamentId = await page.$eval('#tou-select', (node) => node.value);
  const copiedSession = new URL(copied).searchParams.get('session');
  eqv('28j. ...naming the tournament, not an empty session', copiedSession, tournamentId);
  ok('28k. ...and carrying the token', new URL(copied).searchParams.get('k') === vetoToken, 'wrong or missing token');

  // `captainBox`, not `guest` - this file already has a `guest` further down,
  // and it is a signed-in stranger rather than somebody with no account at all.
  const captainBox = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const phone = await captainBox.newPage();
  await phone.goto(copied);
  await wait(1400);
  // Whitespace collapsed, because the page is mostly indentation and a raw
  // slice of it prints as a blank failure detail - which is what the first run
  // of this assertion did, and a failure that says nothing is half a test.
  const captain = (await phone.textContent('body')).replace(/\s+/g, ' ').trim();
  ok('28l. a captain with no account can open it', !/link is incomplete/i.test(captain), captain.slice(0, 160) || '(the page painted nothing)');
  ok('28m. ...and is shown the veto they were sent', /Crusaders|Jail Time/.test(captain), captain.slice(0, 200) || '(the page painted nothing)');
  await captainBox.close();

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

  /*
   * Adding a desk is a dialog now, not a window.prompt. The three prompts this
   * panel used to raise were replaced because of the REMOVAL one: a prompt
   * cannot say what it is about to take in a way anybody reads, and the box you
   * type a new name into and the box you type an existing name into to destroy
   * a desk were two visually identical prompts one button apart.
   */
  await page.click('#tou-desks button:has-text("Add production")');
  await page.waitForSelector('.rl-modal', { timeout: 6000 });
  await page.fill('.rl-modal input[type=text]', 'Court 2');
  await page.click('.rl-modal-foot .btn-primary');
  await wait(1200);
  ok('26f2. the add dialog closes', (await page.$$('.rl-modal')).length === 0);
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
  ok('26j. both desks now offer Manage', (await page.$$('#tou-desks button:has-text("Manage")')).length === 2);

  /*
   * THE TYPED-BACK NAME, and the half of it worth asserting: the button is dead
   * until the name matches. A confirm dialog is answered "yes" by reflex and a
   * name is not, and this takes a whole desk's graphics with it - so the guard
   * being live BEFORE the click, rather than being a second dialog after it, is
   * the property that makes it a guard at all.
   */
  await page.click('#tou-desks .desk-row:nth-of-type(2) button:has-text("Manage")');
  await page.waitForSelector('.rl-modal', { timeout: 6000 });
  const removeBtn = page.locator('.rl-modal-foot .rl-modal-danger');
  ok('26k. remove starts disabled', await removeBtn.isDisabled());
  await page.fill('.rl-modal input[aria-label="Type the name to confirm"]', 'not the name');
  await wait(200);
  ok('26l. ...and a wrong name does not arm it', await removeBtn.isDisabled());
  await page.fill('.rl-modal input[aria-label="Type the name to confirm"]', 'Court 2');
  await wait(200);
  ok('26m. ...the exact name arms it', !(await removeBtn.isDisabled()));

  // Cancel, because the desks are wanted for the assertions further down.
  await page.click('.rl-modal-foot .btn-ghost >> nth=-1');
  await wait(400);
  ok('26n. cancelling leaves both desks alone', (await page.$$('#tou-desks .desk-row')).length === 2);

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
   *
   * It asks first now, for the reason in modal.js: this dialog holds both
   * teams, the series length and every map row, none of it written until Save,
   * and Cancel is a reflex. The match editor is the one that gets the guard for
   * the same reason the team editor does - the whole of it is a draft.
   */
  await page.click('.sch-node');
  await wait(600);
  await page.fill('.sch-modal .sch-map:nth-child(2) input[type="text"]', 'Never saved');
  await page.click('.sch-modal-foot .btn-ghost >> nth=1');
  await wait(500);
  ok('27u0. cancelling a match with a map typed asks first', (await page.$$('.rl-modal-ask')).length === 1);
  await page.click('.rl-modal-ask .rl-modal-ask-danger');
  await wait(800);
  const afterCancel = await (await fetch(`${BASE}/api/schedule?session=${cupId}`, { headers: { Cookie: jar.join('; ') } })).json();
  ok('27u. cancelling writes nothing', !JSON.stringify(afterCancel.schedule).includes('Never saved'));
  ok('27v. ...and closes the editor', (await page.$$('.sch-modal')).length === 0);

  /*
   * Escape is the platform's, which is the reason to use a real dialog - and
   * with nothing typed it still closes in one press. That is the guard not
   * being a nag, asserted on a second dialog: the map rows this editor pads out
   * to `bestOf` on the way up are the FORM filling itself in, and a snapshot
   * taken before that happened would make every Bo3 open already dirty.
   */
  await page.click('.sch-node');
  await wait(500);
  await page.keyboard.press('Escape');
  await wait(500);
  ok('27w. escape closes the editor', (await page.$$('.sch-modal')).length === 0);
  ok('27w2. ...without asking, because nothing was typed', (await page.$$('.rl-modal-ask')).length === 0);

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

  // ------------------------------------ swapping tournament swaps the DATA ---
  /*
   * Reported from a live deployment, in two halves that turned out to be one
   * bug: "I created a new tournament and it doesn't update the teams/players
   * library - I had to refresh the whole page", and "after swapping between
   * tournaments the library no longer appeared for the tournament that had
   * teams".
   *
   * Which tournament a REQUEST means comes from `?session=` in the URL and
   * nowhere else. Neither the create button nor the Tournament page's own
   * picker wrote it - they set a module-local variable, wrote a localStorage
   * pointer and repainted - so both changed what the page DISPLAYED without
   * changing what it ADDRESSED. Measured before the fix: the heading read
   * "Alpha Cup", the settings under it were Alpha's, and the team library
   * beneath them was empty, because every fetch still answered for whichever
   * tournament the URL named.
   *
   * Everything here runs on its own page and its own two tournaments, so it
   * depends on nothing above it and disturbs nothing below.
   */
  {
    const make = async (name) => (await post('/api/tournaments', { action: 'create', name })).tournament;
    const alpha = await make('Swap Alpha');
    await fetch(`${BASE}/api/teams?session=${alpha.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: jar.join('; ') },
      body: JSON.stringify({ action: 'save', team: { name: 'Swapworthy', shortName: 'SWP', players: [] } }),
    });
    // Beta second, so it is the NEWEST - which is what an unqualified request
    // resolves to, and therefore the tournament a bare `/` opens on.
    const beta = await make('Swap Beta');

    const desk = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    const deskErrors = [];
    desk.on('pageerror', (event) => deskErrors.push(String(event)));
    await signIn(desk, 'boss', 'a-long-enough-password');

    const openTeams = async () => {
      await desk.click('.rail-item[data-tab="tournament"]');
      await wait(500);
      await desk.click('.subtabs[data-for="tournament"] .subtab[data-view="tou-teams"]');
      await wait(800);
    };
    const shelf = async () => desk.$$eval('#wed-teams .team-card-name', (nodes) => nodes.map((n) => n.textContent.trim()));
    const named = async () =>
      desk.evaluate(() => {
        const node = document.getElementById('tou-select');
        return node?.options[node.selectedIndex]?.textContent ?? '';
      });
    const urlSession = () => new URL(desk.url()).searchParams.get('session') ?? '';

    await openTeams();
    ok('31. a bare URL opens on the tournament the SERVER resolves', (await named()).includes('Swap Beta'), await named());
    ok('32. ...and its library is the one that belongs to it', (await shelf()).length === 0, JSON.stringify(await shelf()));

    /*
     * THE ONE THE OPERATOR REPORTED. Pick the tournament that has the teams,
     * using the picker that is actually on the page they are looking at.
     */
    await desk.selectOption('#tou-select', alpha.id);
    await wait(1800);
    await openTeams();
    eqv('33. picking a tournament writes it into the URL', urlSession(), alpha.id);
    ok('34. ...and the heading follows', (await named()).includes('Swap Alpha'), await named());
    ok('35. ...AND SO DOES THE LIBRARY', JSON.stringify(await shelf()) === '["Swapworthy"]', JSON.stringify(await shelf()));

    await desk.selectOption('#tou-select', beta.id);
    await wait(1800);
    await openTeams();
    ok('36. swapping back takes the library with it', (await shelf()).length === 0, JSON.stringify(await shelf()));

    /*
     * And creating one LANDS on it, rather than leaving the page displaying the
     * previous tournament while every request resolves to the new one - which
     * is what "I had to refresh the whole page" was describing.
     */
    desk.once('dialog', (dialog) => dialog.accept('Swap Gamma'));
    await desk.click('#tou-new');
    await wait(2000);
    const gamma = (await (await fetch(`${BASE}/api/tournaments`, { headers: { Cookie: jar.join('; ') } })).json()).tournaments.find(
      (entry) => entry.name === 'Swap Gamma',
    );
    eqv('37. creating a tournament lands the page on it', urlSession(), gamma.id);
    await openTeams();
    ok('38. ...with its own empty library, not the last one\'s', (await shelf()).length === 0, JSON.stringify(await shelf()));

    /*
     * The page must not be able to disagree with the server about this. Both
     * reads say which tournament an unqualified request resolves to; without
     * them the browser has to reimplement `defaultFor`, and a second
     * implementation of that rule is invisible when it drifts.
     */
    const listed = await (await fetch(`${BASE}/api/tournaments`, { headers: { Cookie: jar.join('; ') } })).json();
    eqv('39. the tournament list says which one is current', listed.current, gamma.id);
    const account = await (await fetch(`${BASE}/api/account/me`, { headers: { Cookie: jar.join('; ') } })).json();
    eqv('40. ...and so does the account, for the topbar', account.current, gamma.id);

    ok('41. nothing threw while swapping', deskErrors.length === 0, deskErrors.join(' | '));
    await desk.close();
  }

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
