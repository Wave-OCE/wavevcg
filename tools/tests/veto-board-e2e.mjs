/**
 * The map veto board, RENDERED.
 *
 * The second suite here that opens a graphic, and it has to for the same reason
 * bracket-graphic-e2e does: everything this covers is geometry and motion, and
 * every state assertion in veto-e2e stays green while the board paints in the
 * wrong shape. Delete the line that derives the ban columns and nothing else in
 * this repo notices.
 *
 * Three things it is about:
 *
 *   ALWAYS TWO ROWS of bans, columns derived. A Bo1's six bans used to draw
 *   two across and three down - taller than the map panels beside them, with a
 *   column of empty frame to the right and the whole board reading
 *   bottom-heavy.
 *
 *   THE MAP'S OWN ART inside a revealed box. The catalogue is stubbed with
 *   `page.route`, so no Chromium reaches Riot's CDN and the assertions do not
 *   depend on a network or on which maps are in rotation this act.
 *
 *   A REVEAL MOVES. It is the one moment an audience is watching this graphic
 *   for, and it used to snap. Measured mid-flight rather than by reading the
 *   stylesheet, because a transition that is declared and never triggered
 *   reads identically to one that works.
 *
 *   node tools/tests/veto-board-e2e.mjs
 */
const playwright = await import(new URL('../../node_modules/playwright/index.js', import.meta.url).href);
const chromium = playwright.chromium ?? playwright.default.chromium;

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openAsAdmin } from './harness.mjs';

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8183;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-vbo-'));

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

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

/*
 * A stand-in splash per map.
 *
 * Stubbed rather than fetched, for the reason matchid-ui-e2e stubs `/api/match`:
 * an assertion about whether a box shows art must not be able to fail because a
 * CDN was slow, and a suite must never depend on which maps are in the rotation
 * the day it runs. An SVG data URI decodes with no network at all.
 */
const swatch = (label) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="760"><rect width="480" height="760" fill="#2d6"/><text x="20" y="60" font-size="40">${label}</text></svg>`,
  )}`;

const POOL = ['Ascent', 'Bind', 'Haven', 'Split', 'Lotus', 'Sunset', 'Icebox'];

const ban = (map, who, short) => ({ kind: 'ban', map, by: who, byShort: short });
const pick = (map, who, short) => ({
  kind: 'pick',
  map,
  by: who,
  byShort: short,
  side: 'attack',
  sideBy: 'Jail Time',
  sideByShort: 'JAIL',
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

  const { cookie, key, tournamentId } = await openAsAdmin(BASE, 'boss', 'a-long-enough-password', 'Veto Board Cup');

  /*
   * Written to PROGRAM, because that is what an OBS URL with no `?bus=` reads -
   * the unqualified-means-air rule. A suite writing the default (preview) and
   * then opening the default (program) would assert against an empty board and
   * never know why.
   */
  const put = async (state) =>
    fetch(`${BASE}/api/veto-board?session=${tournamentId}&bus=program`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ state }),
    });

  const send = async (body) =>
    fetch(`${BASE}/api/veto-board?session=${tournamentId}&bus=program`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    });

  const board = (rows, revealed) => ({
    layout: 'full',
    left: { name: 'Crusaders', shortName: 'CRU' },
    right: { name: 'Jail Time', shortName: 'JAIL' },
    rows,
    revealed,
    showSides: true,
    anim: { visible: true, cue: 1 },
  });

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.route('**/api/valorant-assets', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ agents: [], maps: POOL.map((name) => ({ name, splash: swatch(name), icon: '' })) }),
    }),
  );

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // ------------------------------------------------- a Bo1: six bans, one map ---

  const bo1 = [
    ban('Ascent', 'Crusaders', 'CRU'),
    ban('Bind', 'Jail Time', 'JAIL'),
    ban('Haven', 'Crusaders', 'CRU'),
    ban('Split', 'Jail Time', 'JAIL'),
    ban('Lotus', 'Crusaders', 'CRU'),
    ban('Sunset', 'Jail Time', 'JAIL'),
    { kind: 'decider', map: 'Icebox', by: '', byShort: '' },
  ];
  await put(board(bo1, [true, true, true, false, false, false, false]));

  await page.goto(`${BASE}/veto-board.html?key=${encodeURIComponent(key)}&session=${tournamentId}`);
  await page.waitForSelector('.full-ban', { timeout: 8000 });
  await wait(1200);

  const geometry = async () =>
    page.evaluate(() => {
      const bans = document.getElementById('full-bans');
      const kids = [...bans.children];
      return {
        count: kids.length,
        columns: getComputedStyle(bans).gridTemplateColumns.split(' ').filter(Boolean).length,
        rows: new Set(kids.map((n) => Math.round(n.getBoundingClientRect().top))).size,
        width: Math.round(bans.getBoundingClientRect().width),
      };
    });

  const bo1Shape = await geometry();
  eq('1. a Bo1 draws its six bans', bo1Shape.count, 6);
  eq('2. ...three across', bo1Shape.columns, 3);
  /*
   * THE ONE THIS SUITE EXISTS FOR. Two rows, always - measured off the painted
   * boxes' own tops rather than off the grid declaration, so a rule that says
   * three columns while something else wraps them into three rows still fails.
   */
  eq('3. ...and ALWAYS two rows', bo1Shape.rows, 2);

  // ---------------------------------------------------- the art in the boxes ---

  const art = async () =>
    page.evaluate(() => {
      const shown = (img) => Boolean(img) && !img.hidden && Boolean(img.getAttribute('src'));
      const bans = [...document.querySelectorAll('.full-ban')];
      return {
        revealedBansWithArt: bans.filter((n) => n.classList.contains('is-revealed') && shown(n.querySelector('.full-ban-art'))).length,
        hiddenBansWithArt: bans.filter((n) => !n.classList.contains('is-revealed') && shown(n.querySelector('.full-ban-art'))).length,
        mapsWithArt: [...document.querySelectorAll('.full-map')].filter((n) => shown(n.querySelector('.full-map-art'))).length,
      };
    });

  const early = await art();
  eq('4. a revealed ban shows the map it took off the board', early.revealedBansWithArt, 3);
  /*
   * The half that matters more. A box whose map has NOT been revealed must
   * carry no art at all - painting it and merely hiding it behind an opacity
   * would put the answer in the DOM of a page anybody can open with the session
   * key, which is the same mistake as painting a veto token.
   */
  eq('5. ...and an unrevealed one gives nothing away', early.hiddenBansWithArt, 0);
  eq('6. ...nor does an unrevealed map panel', early.mapsWithArt, 0);

  // ----------------------------------------------------- the reveal has to MOVE ---
  /*
   * Caught in flight. Reading the stylesheet would prove only that a transition
   * is declared; what is being asserted is that it is TRIGGERED - that the box
   * is part-way between states a beat after the reveal lands, and settled a
   * moment later. A snap would read 1 at both samples.
   */
  await send({ action: 'reveal', all: true });
  await wait(140);
  const flight = await page.evaluate(() => {
    const panel = [...document.querySelectorAll('.full-map')].pop();
    return {
      art: Number(getComputedStyle(panel.querySelector('.full-map-art')).opacity),
      name: Number(getComputedStyle(panel.querySelector('.full-map-name')).opacity),
    };
  });
  ok('7. the map art is mid-flight a beat after the reveal', flight.art > 0 && flight.art < 1, JSON.stringify(flight));
  /*
   * BOTH ends, and the lower one is not padding: `< 1` alone passed against a
   * deliberate break that deleted the arriving rule entirely, because a name
   * that never appears is also not 1. Found by breaking it.
   */
  ok('8. ...and so is its name', flight.name > 0 && flight.name < 1, JSON.stringify(flight));

  await wait(1400);
  const settled = await page.evaluate(() => {
    const panel = [...document.querySelectorAll('.full-map')].pop();
    return {
      art: Number(getComputedStyle(panel.querySelector('.full-map-art')).opacity),
      name: Number(getComputedStyle(panel.querySelector('.full-map-name')).opacity),
      scrim: Number(getComputedStyle(panel.querySelector('.full-map-scrim')).opacity),
    };
  });
  eq('9. ...and it settles fully open', settled.art, 1);
  eq('10. ...name and all', settled.name, 1);
  // The scrim exists to keep the name readable over a bright splash, so it has
  // to arrive WITH the art rather than sit there over an empty panel.
  eq('11. the legibility scrim comes up with the art', settled.scrim, 1);

  const full = await art();
  eq('12. every ban now carries its map', full.revealedBansWithArt, 6);
  eq('13. ...and every map panel too', full.mapsWithArt, 1);

  // ------------------------------------------------- the cue must NOT have moved ---
  /*
   * `reveal` is not the cue. If it bumped one the whole board would fly on
   * again every time a captain banned a map, which is the precise failure the
   * counter was invented to prevent - and it is loud, because this graphic is
   * on air for the whole veto.
   */
  const afterReveal = await (await fetch(`${BASE}/api/veto-board?session=${tournamentId}`, { headers: { Cookie: cookie } })).json();
  eq('14. revealing a step does not bump the cue', afterReveal.state.anim.cue, 1);

  // ------------------------------------------------------- a Bo3: four bans ---

  const bo3 = [
    ban('Ascent', 'Crusaders', 'CRU'),
    ban('Bind', 'Jail Time', 'JAIL'),
    pick('Haven', 'Crusaders', 'CRU'),
    pick('Split', 'Jail Time', 'JAIL'),
    ban('Lotus', 'Crusaders', 'CRU'),
    ban('Sunset', 'Jail Time', 'JAIL'),
    { kind: 'decider', map: 'Icebox', by: '', byShort: '' },
  ];
  await put(board(bo3, Array.from({ length: 7 }, () => true)));
  await wait(1200);

  const bo3Shape = await geometry();
  eq('15. a Bo3 draws its four bans', bo3Shape.count, 4);
  eq('16. ...two across', bo3Shape.columns, 2);
  eq('17. ...and still two rows', bo3Shape.rows, 2);
  ok('18. so the ban block is NARROWER than a Bo1\'s', bo3Shape.width < bo1Shape.width, `${bo3Shape.width} vs ${bo1Shape.width}`);

  const bo3Maps = await page.evaluate(() => document.querySelectorAll('.full-map').length);
  eq('19. ...beside three map panels', bo3Maps, 3);

  // Two bans is the shape a format with a short veto would produce, and the
  // rule has to hold at the bottom of its range too: one column, two rows,
  // never a single row of two.
  await put(board([ban('Ascent', 'Crusaders', 'CRU'), ban('Bind', 'Jail Time', 'JAIL'), pick('Haven', 'Crusaders', 'CRU')], [true, true, true]));
  await wait(900);
  const tiny = await geometry();
  eq('20. two bans draw one column', tiny.columns, 1);
  eq('21. ...and two rows, not one', tiny.rows, 2);

  // ------------------------------------------------------- the lower third ---
  /*
   * Untouched, and asserted because it is the layout an operator actually uses
   * while a veto is happening - the full screen is the board at the end of it.
   * A change to one must not quietly take the other with it.
   */
  await put({ ...board(bo3, Array.from({ length: 7 }, () => true)), layout: 'lower' });
  await wait(900);
  const lower = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.cell')];
    return {
      cells: cells.length,
      revealed: cells.filter((n) => n.classList.contains('is-revealed')).length,
      fullHidden: document.getElementById('full').hidden,
      mapOpacity: cells.length ? Number(getComputedStyle(cells[0].querySelector('.cell-map')).opacity) : -1,
    };
  });
  eq('22. the lower third still draws a cell per step', lower.cells, 7);
  eq('23. ...revealed', lower.revealed, 7);
  eq('24. ...with the full-screen block put away', lower.fullHidden, true);
  eq('25. ...and its own reveal transition still lands', lower.mapOpacity, 1);

  ok('26. no page errors', errors.length === 0, errors.join(' | '));
} catch (error) {
  fail += 1;
  console.log('THREW', error.stack);
  console.log(log.slice(-1200));
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
