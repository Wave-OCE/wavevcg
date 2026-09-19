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

/*
 * A logo the page can actually DECODE, and a TALL one.
 *
 * `/media/cru.png` is enough to assert that a src reaches the element, and
 * useless for measuring where the mark sits: nothing serves it out of a
 * throwaway STATE_DIR, so the broken-image guard hides it and every box
 * measures zero. It is deliberately taller than it is wide, because a square
 * mark is centred by accident in a box that is not centring anything.
 *
 * Short on purpose too - the board's `side()` sanitiser slices a logo at 500
 * characters, and a chatty data URI arrives truncated and fails to decode.
 */
const LOGO = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420"><rect width="300" height="420" fill="#8a2030"/><circle cx="150" cy="150" r="110" fill="#fff"/></svg>',
)}`;

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

  // ================================ three colours that mean three things =====
  /*
   * This graphic had none: `--accent` and `--ban` were literals in the
   * stylesheet, under a comment claiming they were set from the graphic's own
   * fields that had never been true.
   *
   * THREE DIFFERENT COLOURS, deliberately. A trim, a highlight and a ban that
   * all happened to be the same value would pass whichever way the three were
   * wired, which is the shape of test that lets a mix-up through - and mixing
   * these up is loud: a board announcing its bans in the sponsor's trim, or a
   * picked map wearing the colour of a banned one.
   */
  await put({ ...board(bo3, Array.from({ length: 7 }, () => true)), layout: 'full', accent: '#0d1a2b', highlight: '#ab12cd', banColour: '#22ee44' });
  await wait(900);

  const vars = await page.evaluate(() => {
    const board = document.getElementById('board');
    const read = (n) => getComputedStyle(board).getPropertyValue(n).trim();
    const of = (sel, prop) => {
      const node = document.querySelector(sel);
      return node ? getComputedStyle(node)[prop] : '(missing)';
    };
    return {
      accent: read('--accent'),
      highlight: read('--highlight'),
      ban: read('--ban'),
      vs: of('.full-vs', 'color'),
      picker: of('.full-map-meta b', 'color'),
    };
  });
  eq('27. the trim is the colour this graphic set', vars.accent, '#0d1a2b');
  eq('28. a map that went through wears the highlight', vars.highlight, '#ab12cd');
  eq('29. a map that is gone wears the ban colour', vars.ban, '#22ee44');
  /*
   * PAINTED, not just declared. The variables above prove the state reached the
   * board; these two prove the stylesheet spends them on the right things - the
   * VS divider is furniture and the picker's name is attached to a map that was
   * taken, so they must not be the same colour.
   */
  eq('30. the VS divider takes the trim, not the ban colour', vars.vs, 'rgb(13, 26, 43)');
  eq('31. and whoever took a map takes the highlight', vars.picker, 'rgb(171, 18, 205)');

  /*
   * ACCENT AND HIGHLIGHT INHERIT; THE BAN COLOUR DOES NOT.
   *
   * A ban reads red by a convention older than any one tournament. Tying it to
   * an event trim would mean a board whose sponsor is green announcing its bans
   * in green, so it keeps its own default and its own field.
   */
  await put({ ...board(bo3, Array.from({ length: 7 }, () => true)), layout: 'full', accent: '', highlight: '', banColour: '#22ee44' });
  await fetch(`${BASE}/api/tournaments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ action: 'update', id: tournamentId, fields: { accent: '#0d1a2b', highlight: '#ab12cd' } }),
  });
  await wait(1000);
  const inherited = await page.evaluate(() => {
    const board = document.getElementById('board');
    const read = (n) => getComputedStyle(board).getPropertyValue(n).trim();
    return { accent: read('--accent'), highlight: read('--highlight'), ban: read('--ban') };
  });
  eq('32. a blank accent takes the one the EVENT set', inherited.accent, '#0d1a2b');
  eq('33. a blank highlight takes the one the EVENT set', inherited.highlight, '#ab12cd');
  eq('34. ...and the ban colour is untouched by either', inherited.ban, '#22ee44');

  /*
   * THE ASSERTION THAT ACTUALLY PINS IT, and 34 above does not.
   *
   * Wiring `banColour` through the same inherit chain as the other two is
   * invisible while the board carries a colour of its own - the override wins
   * either way, so a deliberate break of exactly that shape passed 34 without
   * a murmur. What distinguishes them is a board that has NEVER had a ban
   * colour set, beside an event whose trim is something else entirely: the
   * default has to be this graphic's own red, not the event's.
   *
   * A ban reads red by a convention older than any one tournament. A board
   * whose sponsor is navy must not announce its bans in navy.
   */
  await put({ ...board(bo3, Array.from({ length: 7 }, () => true)), layout: 'full', accent: '', highlight: '', banColour: '' });
  await wait(900);
  const untouched = await page.evaluate(() => {
    const board = document.getElementById('board');
    const read = (n) => getComputedStyle(board).getPropertyValue(n).trim();
    return { accent: read('--accent'), ban: read('--ban') };
  });
  eq('34a. a board that set no ban colour still bans in red', untouched.ban, '#ff4655');
  ok('34b. ...which is NOT what the event trim is', untouched.accent !== untouched.ban, JSON.stringify(untouched));

  // ============================================ the team behind the box =====
  /*
   * Their mark, large and faint behind every box they acted on. It exists for
   * the one thing a veto board is worst at: reading WHO did what at a glance,
   * on a stream, in two seconds - which 15px of small caps cannot do.
   *
   * A logo when they have one, their TRICODE when they do not, and nothing at
   * all when the switch is off. The third is the one an operator will reach
   * for, so it is asserted rather than assumed.
   */
  const withLogos = {
    ...board(bo3, Array.from({ length: 7 }, () => true)),
    layout: 'full',
    left: { name: 'Crusaders', shortName: 'CRU', logo: '/media/cru.png' },
    right: { name: 'Jail Time', shortName: 'JAIL' },
  };
  await put(withLogos);
  await wait(900);

  const marks = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.full-ban')].map((n) => ({
        logo: n.querySelector('.full-ban-team')?.getAttribute('src') ?? '',
        tri: n.querySelector('.full-ban-tri')?.textContent ?? '',
      })),
    );
  const shown = await marks();
  ok('35. a team with a logo shows it behind their boxes', shown.some((m) => m.logo === '/media/cru.png'), JSON.stringify(shown));
  ok('36. ...and a team with none shows their tricode instead', shown.some((m) => m.tri === 'JAIL'), JSON.stringify(shown));
  ok('37. ...never both on one box', shown.every((m) => !(m.logo && m.tri)), JSON.stringify(shown));

  await put({ ...withLogos, showTeamArt: false });
  await wait(900);
  const off = await marks();
  ok('38. the switch turns every mark off', off.every((m) => !m.logo && !m.tri), JSON.stringify(off));

  /*
   * And the cross arrives WITH the ban. It used to be painted from the first
   * frame, so a box reading "JAIL TO BAN" already had a strike through it -
   * saying a map was gone before anybody had taken it. Nobody noticed while the
   * box was otherwise empty; the team's mark made it busy enough to look at.
   */
  await put({ ...withLogos, showTeamArt: true, revealed: [true, true, false, false, false, false, false] });
  await wait(900);
  const crosses = await page.evaluate(() =>
    [...document.querySelectorAll('.full-ban')].map((n) => ({
      revealed: n.classList.contains('is-revealed'),
      ink: Number(getComputedStyle(n, '::before').opacity),
    })),
  );
  ok('39. a revealed ban is struck through', crosses.filter((c) => c.revealed).every((c) => c.ink > 0.5), JSON.stringify(crosses));
  ok('40. ...and one nobody has taken is NOT', crosses.filter((c) => !c.revealed).every((c) => c.ink === 0), JSON.stringify(crosses));

  // =========================== the lower third shows its maps too ===========
  /*
   * It had no map image AT ALL. Stage 21 gave the full-screen layout its
   * splashes and stopped there, so the same board said two different amounts
   * depending on which way it was laid out - and the lower third is the one an
   * operator actually has up WHILE a veto is happening.
   */
  await put({ ...board(bo3, [true, true, true, true, false, false, false]), layout: 'lower' });
  await wait(1200);

  const cells = await page.evaluate(() => {
    const painted = (img) => Boolean(img) && !img.hidden && Boolean(img.getAttribute('src'));
    return [...document.querySelectorAll('.cell')].map((cell) => {
      const art = cell.querySelector('.cell-art');
      return {
        revealed: cell.classList.contains('is-revealed'),
        ban: cell.classList.contains('is-ban'),
        art: painted(art),
        filter: art ? getComputedStyle(art).filter : '(missing)',
        scrim: Number(getComputedStyle(cell.querySelector('.cell-scrim')).opacity),
      };
    });
  });

  eq('41. a revealed cell carries the map it is naming', cells.filter((c) => c.revealed && c.art).length, 4);
  /*
   * The half that matters more, and the same rule the full-screen box follows:
   * an unrevealed cell carries no art at all rather than art behind an opacity.
   * This page is opened with the session key, so the answer must not be sitting
   * in its DOM - the same reasoning as never painting a veto token.
   */
  eq('42. ...and an unrevealed one gives nothing away', cells.filter((c) => !c.revealed && c.art).length, 0);
  /*
   * A BAN AND A PICK MUST NOT LOOK ALIKE. Gone-versus-playing is the whole
   * distinction this board draws, and at a glance on a stream a full-colour
   * splash reads as "this one is on" whatever the ring around it says.
   */
  ok(
    '43. a banned map\'s art is drained',
    cells.filter((c) => c.revealed && c.ban).every((c) => c.filter !== 'none'),
    JSON.stringify(cells.filter((c) => c.ban)),
  );
  ok(
    '44. ...and a picked one\'s is not',
    cells.filter((c) => c.revealed && !c.ban).every((c) => c.filter === 'none'),
    JSON.stringify(cells.filter((c) => !c.ban)),
  );
  /*
   * The scrim is legibility, not decoration: it must arrive WITH the art, or a
   * cell with no art wears a dark wash for no reason - which is exactly what
   * the full-screen panel's scrim note already records.
   */
  ok(
    '45. the legibility scrim comes up only where there is art',
    cells.every((c) => (c.art ? c.scrim === 1 : c.scrim === 0)),
    JSON.stringify(cells.map((c) => [c.art, c.scrim])),
  );

  // ==================== the team mark is centred, and gets out of the way ====
  /*
   * MEASURED, because this is the class of fault no state assertion sees: the
   * mark was an <img> styled as though it were a wrapper around one, so
   * `.full-ban-team img` matched nothing and the cap and fit were applied to
   * nothing. What was left was an absolutely positioned replaced element with
   * `width: auto`, which takes its own intrinsic width and ignores `right` once
   * `left` is set - so it sat against the LEFT edge of its tile with the
   * padding pushing it further in. Every box reported exactly the size it had
   * asked for; only looking at it showed anything was wrong.
   */
  const marked = {
    ...board(bo3, [true, false, false, false, false, false, false]),
    layout: 'full',
    left: { name: 'Crusaders', shortName: 'CRU', logo: LOGO },
    right: { name: 'Jail Time', shortName: 'JAIL', logo: LOGO },
  };
  await put(marked);
  await wait(1200);

  const placed = await page.evaluate(() =>
    [...document.querySelectorAll('.full-ban')]
      .map((node) => {
        const mark = node.querySelector('.full-ban-team');
        if (!mark || mark.hidden || !mark.getAttribute('src')) return null;
        const tile = node.getBoundingClientRect();
        const box = mark.getBoundingClientRect();
        return {
          revealed: node.classList.contains('is-revealed'),
          offCentre: Math.round(box.left + box.width / 2 - (tile.left + tile.width / 2)),
          width: Math.round(box.width),
          tile: Math.round(tile.width),
          opacity: Number(getComputedStyle(mark).opacity),
        };
      })
      .filter(Boolean),
  );

  ok('46. the mark is painted at all', placed.length === 4, JSON.stringify(placed));
  ok('47. ...centred in the box it sits behind', placed.every((m) => Math.abs(m.offCentre) <= 1), JSON.stringify(placed));
  ok('48. ...and never wider than it', placed.every((m) => m.width <= m.tile), JSON.stringify(placed));

  /*
   * AND IT GETS OUT OF THE WAY. The mark answers "who is acting here", which is
   * the most useful thing an empty box has to say and the least useful thing a
   * filled one does - once the map is revealed the art is the subject and the
   * line below it already names the team. Two images competing for the same two
   * seconds is what it was doing before.
   */
  ok(
    '49. an unrevealed box wears its team mark',
    placed.filter((m) => !m.revealed).every((m) => m.opacity > 0),
    JSON.stringify(placed),
  );
  ok(
    '50. ...and a revealed one has put it away for the map',
    placed.filter((m) => m.revealed).every((m) => m.opacity === 0),
    JSON.stringify(placed),
  );

  // ================================= the operator's own size handle =========
  /*
   * ON `.board`, NEVER ON `#stage`.
   *
   * `fitStage` owns `#stage`'s transform and rewrites it on every resize, so a
   * second scale written there is wiped by the next one - the trap the
   * bracket's `drawScale` already walked into. Asserted as BOTH halves: the
   * board moved, and the stage did not. Reading only the board would stay green
   * against an implementation that wrote to the stage as well.
   */
  await put({ ...marked, boardScale: 1.35 });
  await wait(900);
  const sized = await page.evaluate(() => ({
    board: getComputedStyle(document.getElementById('board')).transform,
    origin: getComputedStyle(document.getElementById('board')).transformOrigin,
    stage: getComputedStyle(document.getElementById('stage')).transform,
  }));
  eq('51. the board takes the size the operator set', sized.board, 'matrix(1.35, 0, 0, 1.35, 0, 0)');
  eq('52. ...and the fit to the OBS canvas is left alone', sized.stage, 'matrix(1, 0, 0, 1, 0, 0)');
  eq('53. ...growing about the middle of the frame on the full-screen layout', sized.origin, '960px 540px');

  /*
   * The lower third is hung off the bottom edge and belongs there, so it grows
   * UPWARD rather than walking up the screen as it gets bigger.
   */
  await put({ ...marked, layout: 'lower', boardScale: 1.35 });
  await wait(900);
  const lowerOrigin = await page.evaluate(() => getComputedStyle(document.getElementById('board')).transformOrigin);
  eq('54. ...and off the bottom edge on the lower third', lowerOrigin, '960px 1080px');

  /*
   * A `scale`, not a `ratio`. `ratio()` caps at 1, so a multiplier run through
   * it would silently clamp every enlargement to "no change" while the slider
   * claimed otherwise - and the range has to hold at the top as well as the
   * bottom, or an operator's typo reaches air as a board six times too big.
   */
  await put({ ...marked, boardScale: 9 });
  await wait(700);
  const clamped = await (await fetch(`${BASE}/api/veto-board?session=${tournamentId}`, { headers: { Cookie: cookie } })).json();
  eq('55. a size past the top of the range is clamped, not obeyed', clamped.state.boardScale, 1.6);
  await put({ ...marked, boardScale: 1.2 });
  await wait(700);
  const kept = await (await fetch(`${BASE}/api/veto-board?session=${tournamentId}`, { headers: { Cookie: cookie } })).json();
  eq('56. ...and a size ABOVE 1 is kept, which a ratio would have thrown away', kept.state.boardScale, 1.2);

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
