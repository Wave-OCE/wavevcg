/**
 * The Companion panel on the Account tab, in a real browser.
 *
 * This panel IS the operator documentation - Companion discovers nothing for
 * itself, so every variable name has to be read off this page and typed in by
 * hand. A table that renders empty, or a name here that the server does not
 * send, is a silent failure at the far end: a wrong JSON path never errors, it
 * just leaves the button showing a stale value forever.
 *
 * So the assertions are mostly "the names on the page are exactly the names on
 * the wire", checked against a live socket rather than against the schema the
 * page was built from - which would prove nothing.
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
const PORT = 8164;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-cui-'));

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

/** Collect everything one control channel sends for a moment. */
function listen(key) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/api/companion?key=${encodeURIComponent(key)}`);
  const seen = [];
  socket.addEventListener('message', (event) => seen.push(JSON.parse(event.data)));
  return {
    socket,
    seen,
    ready: new Promise((resolve) => {
      socket.addEventListener('open', () => resolve(true));
      socket.addEventListener('error', () => resolve(false));
    }),
    close: () => socket.close(),
  };
}

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

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('#login-username', 'boss');
  await page.fill('#login-password', 'a-long-enough-password');
  await page.click('#login-submit');
  await page.waitForURL((url) => !url.pathname.includes('login'), { timeout: 8000 });
  await page.waitForSelector('#whoami:not([hidden])', { timeout: 6000 });

  await page.click('.tab[data-tab="account"]');
  await page.waitForSelector('#acc-companion-panel', { timeout: 5000 });

  // ------------------------------------------------------ default closed ---
  ok('the panel is on the Account tab', await page.isVisible('#acc-companion-panel'));
  ok('it starts saying there is no key', await page.isVisible('#acc-companion-off'), 'the "no key" note was hidden');
  ok('and shows no URL', !(await page.isVisible('#acc-companion-on')), 'a URL was shown before a key existed');
  ok('the only button offered is to create one', await page.isVisible('#acc-companion-new'));
  ok('with nothing to copy yet', !(await page.isVisible('#acc-companion-copy')));
  ok('and nothing to remove', !(await page.isVisible('#acc-companion-clear')));
  ok(
    'the create button says what it does',
    (await page.textContent('#acc-companion-new')).toLowerCase().includes('create'),
    await page.textContent('#acc-companion-new'),
  );

  // --------------------------------------------------------- the tables ---
  /*
   * Built from the schema at first paint, so they are there before any key
   * exists - somebody sizing up whether to use this at all should be able to
   * read what it can do.
   */
  await page.click('#acc-companion-panel details:nth-of-type(1) summary');
  const opRows = await page.$$eval('#acc-companion-ops tr', (rows) =>
    rows.map((row) => row.querySelector('code')?.textContent ?? ''),
  );
  ok('the actions table has rows', opRows.length > 20, String(opRows.length));
  ok('every row names a graphic and an op', opRows.every((t) => /^(scoreboard|winner|select)\.\w+/.test(t)), opRows.find((t) => !/^(scoreboard|winner|select)\./.test(t)) ?? '');
  for (const op of ['scoreboard.swap', 'scoreboard.swapNames', 'scoreboard.sort', 'winner.next', 'winner.prev', 'winner.toggle', 'select.clockStart']) {
    ok(`the table documents ${op}`, opRows.some((t) => t.startsWith(op)), opRows.join(' '));
  }
  ok('the one that takes a number says so', opRows.some((t) => t.startsWith('winner.stage') && t.includes('+')), opRows.find((t) => t.startsWith('winner.stage')) ?? 'missing');

  const danger = await page.$$eval('#acc-companion-ops tr.is-danger code', (nodes) => nodes.map((n) => n.textContent));
  ok('the unconfirmed ones are marked', danger.some((t) => t.includes('reset')), danger.join(', '));

  await page.click('#acc-companion-panel details:nth-of-type(2) summary');
  const varRows = await page.$$eval('#acc-companion-vars tr code', (nodes) => nodes.map((n) => n.textContent));
  ok('the variables table has rows', varRows.length > 30, String(varRows.length));
  ok('no variable name contains a dot', varRows.every((t) => !t.includes('.')), varRows.find((t) => t.includes('.')) ?? '');
  ok('the 1/0 twins are not listed twice', varRows.every((t) => !t.endsWith('_n')), varRows.find((t) => t.endsWith('_n')) ?? '');
  ok('but they are explained', (await page.textContent('#acc-companion-vars')).includes('_n as 1/0'), 'no note about the twins');
  ok('the per-seat variables are listed', varRows.includes('select_slot10_agent'), 'seat 10 missing');

  // The module's own help page is wrong about this, so the panel must not be.
  const feedbackHelp = await page.textContent('#acc-companion-panel details:nth-of-type(2)');
  ok('the panel warns the separator is a dot', /separator is a dot/i.test(feedbackHelp), 'no warning about the separator');
  ok('and that a wrong path fails silently', /silently/i.test(feedbackHelp), 'no warning about silent failure');
  ok('and says where to put the feedbacks', /single spare button/i.test(feedbackHelp), 'no advice on the config button');

  // ---------------------------------------------------------- minting ---
  await page.click('#acc-companion-new');
  await page.waitForSelector('#acc-companion-on:not([hidden])', { timeout: 5000 });
  ok('creating a key reveals the URL', await page.isVisible('#acc-companion-on'));
  ok('the "no key" note goes away', !(await page.isVisible('#acc-companion-off')));
  ok('a copy button appears', await page.isVisible('#acc-companion-copy'));
  ok('and a remove button', await page.isVisible('#acc-companion-clear'));
  ok(
    'the create button becomes a replace button',
    (await page.textContent('#acc-companion-new')).toLowerCase().includes('replace'),
    await page.textContent('#acc-companion-new'),
  );

  const url = (await page.textContent('#acc-companion-url')).trim();
  ok('the URL is a websocket URL', url.startsWith(`ws://127.0.0.1:${PORT}/api/companion?key=`), url.replace(/key=.*/, 'key=...'));

  // It has to be the host the dashboard is actually reachable on, not a
  // hostname the server guessed at.
  ok('on the host the dashboard is open on', url.includes(`127.0.0.1:${PORT}`), url.replace(/key=.*/, 'key=...'));

  const controlKey = new URL(url).searchParams.get('key');
  const sessionKey = (await page.textContent('#acc-key')).trim();
  ok('and carries a key that is not the OBS key', controlKey && controlKey !== sessionKey, 'THE PANEL SHOWS THE SESSION KEY');

  // ------------------------------------- the page against the real wire ---
  /*
   * The assertion this suite exists for. Every name printed on the page is
   * typed into Companion by hand, and a name the server never sends produces
   * no error anywhere - just a button that never updates.
   */
  const live = listen(controlKey);
  ok('the URL from the page actually connects', await live.ready, 'the pasted URL did not open');
  await wait(700);

  const sent = new Set();
  for (const message of live.seen) {
    if (message.type !== 'state') continue;
    for (const key of Object.keys(message)) {
      if (key === 'type' || key === 'graphic' || key === 'reason') continue;
      sent.add(key);
    }
  }
  ok('the socket sent a snapshot for all three graphics', new Set(live.seen.filter((m) => m.type === 'state').map((m) => m.graphic)).size === 3, String(live.seen.length));

  const missing = varRows.filter((name) => !sent.has(name));
  ok('EVERY VARIABLE ON THE PAGE IS ONE THE SERVER SENDS', missing.length === 0, missing.join(', '));

  const undocumented = [...sent].filter((name) => !name.endsWith('_n') && !varRows.includes(name));
  ok('and the server sends nothing the page does not list', undocumented.length === 0, undocumented.join(', '));

  const twins = varRows.filter((name) => sent.has(`${name}_n`));
  ok('the lamps really do arrive as 1/0 as well', twins.length > 5, String(twins.length));

  // And every documented op is one the server accepts.
  const answers = [];
  live.socket.addEventListener('message', (event) => answers.push(JSON.parse(event.data)));
  for (const row of opRows) {
    const op = row.split(/\s/)[0];
    if (op.endsWith('.reset')) continue; // would wipe the state the rest reads
    live.socket.send(op.startsWith('winner.stage') ? JSON.stringify({ op: 'winner.stage', value: 1 }) : op);
    await wait(45);
  }
  await wait(500);
  const unknown = answers.filter((m) => m.type === 'error' && /is not something/.test(m.message ?? ''));
  ok('EVERY ACTION ON THE PAGE IS ONE THE SERVER KNOWS', unknown.length === 0, unknown.map((m) => m.op).join(', '));

  live.close();

  // ---------------------------------------------------------- removing ---
  page.on('dialog', (dialog) => dialog.accept());
  await page.click('#acc-companion-clear');
  await page.waitForSelector('#acc-companion-off:not([hidden])', { timeout: 5000 });
  ok('removing the key hides the URL', !(await page.isVisible('#acc-companion-on')));
  ok('and offers to create one again', (await page.textContent('#acc-companion-new')).toLowerCase().includes('create'));

  const dead = listen(controlKey);
  ok('and the removed key no longer connects', (await dead.ready) === false, 'a withdrawn key still opened a channel');
  dead.close();

  // ------------------------------------------------------- the switch ---
  await page.click('.tab[data-tab="admin"]');
  await page.waitForSelector('#adm-settings', { timeout: 5000 });
  const switchRow = await page.$$eval('#adm-settings', (nodes) => nodes[0]?.textContent ?? '');
  ok('the admin panel lists the Companion switch', /Companion/i.test(switchRow), switchRow.slice(0, 200));

  ok('no page error was raised', errors.length === 0, errors.join(' | '));
  ok('and no control key reached the server log', !log.includes(controlKey), 'CONTROL KEY LEAKED TO LOG');
} catch (error) {
  failed += 1;
  console.log('THREW', error.stack);
  console.log(log.slice(-1500));
} finally {
  await browser?.close();
  server.kill('SIGKILL');
  await wait(400);
  try {
    rmSync(STATE, { recursive: true, force: true });
  } catch {
    /* windows */
  }
}

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
