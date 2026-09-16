/**
 * The winner scene's two layout controls, measured on a real 1920x1080 stage.
 *
 * The name cap exists because the band used to shrink-wrap its own text: that
 * made fitText's "does it fit" question compare a number against itself, so it
 * always said yes - no squeeze, no tricode fallback, and a long org measured
 * -158px to 2078px on a 1920 frame. Every assertion about centring and width
 * below fails again if that band ever stops being the column.
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
const PORT = 8161;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-wlay-'));

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

const STAGE_W = 1920;

try {
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
  const { cookie, key } = await openAsAdmin(BASE, 'boss', 'a-long-enough-password', 'Winner layout');

  // A crest, uploaded the way an operator uploads one. The winner scene hides
  // its logo slot when empty, and the gap under the crest is one of the two this
  // measures - so without a real logo there is nothing to measure between.
  const CREST = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><circle cx="100" cy="100" r="90" fill="#4ea8de"/></svg>';
  const crestUpload = await fetch(`${BASE}/api/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', Cookie: cookie },
    body: CREST,
  });
  const CREST_URL = (await crestUpload.json()).url ?? '';

  const current = async () => (await (await fetch(`${BASE}/api/winner?key=${encodeURIComponent(key)}`)).json()).state;
  const put = async (patch) => {
    const s = await current();
    const next = { ...s, ...patch, seq: { ...s.seq, ...(patch.seq ?? {}) }, style: { ...s.style, ...(patch.style ?? {}) } };
    /*
     * Air. This suite measures what a browser source paints, and a browser
     * source shows air - so a write that named no bus would stage, and the
     * page would sit on the state from before the fixture.
     */
    const response = await fetch(`${BASE}/api/winner?bus=program`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ state: next }),
    });
    if (!response.ok) throw new Error(`save failed: ${response.status}`);
    return (await response.json()).state ?? next;
  };

  // ------------------------------------------------------------ defaults ---
  const base = await current();
  ok('the name cap defaults to 70% of the frame', base.style.winnerNameWidth === 0.7, String(base.style.winnerNameWidth));
  ok('vertical spacing defaults to unchanged', base.style.bandGap === 1, String(base.style.bandGap));
  ok('the crest uploaded', CREST_URL !== '', 'no crest to measure gaps around');

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const show = async (patch) => {
    await put({ seq: { active: true, stage: 1, restart: false, inMs: 100, cue: 4 }, ...patch });
    await page.waitForTimeout(700);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
  };

  const settled = async (read) => {
    let last = null;
    for (let i = 0; i < 12; i += 1) {
      const now = await read();
      if (last && JSON.stringify(now) === JSON.stringify(last)) return now;
      last = now;
      await page.waitForTimeout(250);
    }
    return last;
  };

  const nameBoxOnce = () =>
    page.evaluate(() => {
      const n = document.querySelector('.winner-name');
      const band = n.parentElement;
      const r = n.getBoundingClientRect();
      return {
        text: n.textContent,
        bandW: Math.round(band.getBoundingClientRect().width),
        // The band carries the reveal transform. Measuring painted geometry
        // while it is still parked reads --travel (240px) as an off-centre
        // squeeze, which is a real measurement of a meaningless moment.
        bandTransform: getComputedStyle(band).transform,
        sceneLive: document.querySelector('.scene-winner').classList.contains('is-live'),
        left: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
        centre: Math.round((r.left + r.right) / 2),
        scaleX: Number((getComputedStyle(n).transform.match(/matrix\(([^,]+)/)?.[1] ?? 1)),
        transform: getComputedStyle(n).transform,
        fontPx: Math.round(parseFloat(getComputedStyle(n).fontSize)),
        crestTop: Math.round(document.querySelector('.winner-logo').getBoundingClientRect().top),
        kickerTop: Math.round(document.querySelector('.winner-kicker').getBoundingClientRect().top),
      };
    });

  const nameBox = async () => {
    const box = await settled(async () => {
      const now = await nameBoxOnce();
      // Not settled until the reveal has finished.
      return now.bandTransform === 'none' ? now : { ...now, pending: Date.now() };
    });
    return box;
  };

  // The stage is pinned on every put, not set once: the server owns sequence
  // position and auto-advance will walk it off the winner scene between checks.
  // autoAdvance off, or the server walks the sequence off the winner scene
  // mid-measurement - which reads as a 240px off-centre squeeze, because that
  // is --travel and the band has gone back to its parked position.
  const LIVE = { active: true, stage: 1, restart: false, inMs: 100, autoAdvance: false };

  const withName = async (name, shortName = 'XXX', style = {}) => {
    await put({ left: { name, shortName, colour: '#4ea8de', score: 2, logo: '' }, winner: 'left', style, seq: LIVE });
    await page.goto(`${BASE}/winner.html?key=${encodeURIComponent(key)}`);
    await page.waitForSelector('.scene-winner.is-live', { timeout: 10000 });
    await page.evaluate(() => document.fonts.ready);
    return nameBox();
  };

  await put({ seq: LIVE });

  // ------------------------------------------------ the band is the column ---
  const short = await withName('SENTINELS');
  ok('THE BAND IS THE COLUMN, NOT THE TEXT', short.bandW === 1620, `${short.bandW} - a shrink-wrapped band defeats the fitter`);
  ok('a short name is left alone', short.fontPx === 190, String(short.fontPx));
  const centred = (box) => Math.abs(box.centre - 960) <= 1;
  ok('and sits on the centre line', centred(short), String(short.centre));

  const long = await withName('EDWARD GAMING');
  ok('A LONG NAME SHRINKS RATHER THAN CONDENSING', long.transform === 'none', long.transform);
  ok('its type is smaller', long.fontPx < 190 && long.fontPx > 150, String(long.fontPx));
  // Within, not exactly: the size is floored to whole pixels, so the painted
  // width lands a hair under the ceiling rather than on it.
  ok('to within the cap', long.width <= Math.round(0.7 * STAGE_W), `${long.width} vs ${Math.round(0.7 * STAGE_W)}`);
  ok('and stays on the centre line', centred(long), String(long.centre));

  // The regression the flex centring fixed: an inline-block wider than its line
  // box is pinned to the start, so the squeeze happened off-centre.
  const veryLong = await withName('SENTINELS ACADEMY');
  ok('a name wider than the band still centres', centred(veryLong), `${veryLong.centre} - off-centre squeeze is back`);
  ok('and is capped', veryLong.width <= Math.round(0.7 * STAGE_W), String(veryLong.width));
  ok('the longer name gets the smaller type', veryLong.fontPx < long.fontPx, `${long.fontPx} -> ${veryLong.fontPx}`);
  ok('and is still not condensed', veryLong.transform === 'none', veryLong.transform);

  // Shrinking buys real headroom, so the tricode is a last resort rather than
  // the answer to any name over thirteen characters.
  const stillNamed = await withName('GIANTX ACADEMY ROSTER', 'GXA');
  ok('a very long name keeps its name rather than tricoding', stillNamed.text === 'GIANTX ACADEMY ROSTER', stillNamed.text);
  ok('at a legible size', stillNamed.fontPx > 100, String(stillNamed.fontPx));

  const absurd = await withName('GIANTX ACADEMY ROSTER SQUAD TWO', 'GXA');
  ok('an absurd name still falls back to the tricode', absurd.text === 'GXA', absurd.text);
  ok('and the tricode is centred', centred(absurd), String(absurd.centre));
  ok('and the tricode is back at full size', absurd.fontPx === 190, String(absurd.fontPx));

  // The floor: nothing to fall back on, so it shrinks as far as it may and the
  // band's overflow clips whatever is left.
  const floored = await withName('GIANTX ACADEMY ROSTER SQUAD TWO ALPHA BETA', '');
  ok('with no tricode it floors rather than vanishing', floored.fontPx >= Math.floor(190 * 0.45) && floored.fontPx <= 110, String(floored.fontPx));

  // The whole point of reserving a full-size line: which team won must not move
  // the crest above it.
  ok(
    'NOTHING ABOVE THE NAME MOVES, WHATEVER THE NAME IS',
    short.crestTop === long.crestTop &&
      short.crestTop === veryLong.crestTop &&
      short.crestTop === stillNamed.crestTop &&
      short.kickerTop === veryLong.kickerTop,
    JSON.stringify([short.crestTop, long.crestTop, veryLong.crestTop, stillNamed.crestTop]),
  );

  // Nothing may leave the frame at any setting, which is what was broken.
  for (const share of [0.3, 0.7, 1]) {
    const box = await withName('GIANTX ACADEMY ROSTER SQUAD TWO', '', { winnerNameWidth: share });
    ok(`at ${Math.round(share * 100)}% nothing leaves the frame`, box.left >= 0 && box.right <= STAGE_W, JSON.stringify(box));
    ok(`at ${Math.round(share * 100)}% it stays centred`, centred(box), JSON.stringify(box));
  }

  // The slider actually moves the cap.
  const narrow = await withName('EDWARD GAMING', '', { winnerNameWidth: 0.4 });
  const wide = await withName('EDWARD GAMING', '', { winnerNameWidth: 1 });
  ok('a narrower cap paints narrower', narrow.width < wide.width, `${narrow.width} vs ${wide.width}`);
  ok('the narrow cap is honoured', narrow.width <= Math.round(0.4 * STAGE_W), String(narrow.width));
  ok('a narrower cap means smaller type', narrow.fontPx < wide.fontPx, `${narrow.fontPx} vs ${wide.fontPx}`);
  ok('at 100% the column is the limit, not the frame', wide.width <= 1620, String(wide.width));

  // ------------------------------------------------------ vertical spacing ---
  const gaps = async (bandGap) => {
    await put({ left: { name: 'SENTINELS', shortName: 'SEN', colour: '#4ea8de', score: 2, logo: CREST_URL }, winner: 'left', style: { bandGap, eventLogoPlacement: 'hidden' }, seq: LIVE });
    await page.goto(`${BASE}/winner.html?key=${encodeURIComponent(key)}`);
    await page.waitForSelector('.scene-winner.is-live', { timeout: 10000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700);
    return page.evaluate(() => {
      const box = (sel) => {
        const n = document.querySelector(sel);
        if (!n || n.hidden) return null;
        const r = n.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, h: Math.round(r.height) };
      };
      const kicker = box('.scene-winner .winner-kicker');
      const logo = box('.scene-winner .winner-logo');
      const name = box('.scene-winner .winner-name-band');
      return {
        kickerToLogo: Math.round(logo.top - kicker.bottom),
        logoToName: Math.round(name.top - logo.bottom),
        kickerH: kicker.h,
        logoH: logo.h,
        nameFont: getComputedStyle(document.querySelector('.winner-name')).fontSize,
      };
    });
  };

  const g1 = await gaps(1);
  ok('the kicker-to-crest gap is its designed 40px', g1.kickerToLogo === 40, String(g1.kickerToLogo));
  ok('the crest-to-name gap is its designed 44px', g1.logoToName === 44, String(g1.logoToName));

  const gWide = await gaps(1.8);
  ok('THE GAPS OPEN UP', gWide.kickerToLogo === 72 && gWide.logoToName === 79, JSON.stringify(gWide));

  const gTight = await gaps(0.4);
  ok('and close down', gTight.kickerToLogo === 16 && gTight.logoToName === 18, JSON.stringify(gTight));

  ok(
    'SPACING MOVES ONLY THE SPACE',
    g1.kickerH === gWide.kickerH && g1.logoH === gWide.logoH && g1.nameFont === gWide.nameFont,
    JSON.stringify({ one: g1, wide: gWide }),
  );

  // The other two scenes take it as well - it is one control for all three.
  const sceneGap = async (stage, sel, prev, bandGap) => {
    await put({ style: { bandGap, eventLogoPlacement: 'hidden' }, seq: { ...LIVE, stage } });
    await page.goto(`${BASE}/winner.html?key=${encodeURIComponent(key)}`);
    await page.waitForSelector('.scene.is-live', { timeout: 10000 });
    await page.waitForTimeout(700);
    return page.evaluate(([a, b]) => {
      const one = document.querySelector(a);
      const two = document.querySelector(b);
      if (!one || !two) return null;
      return Math.round(two.getBoundingClientRect().top - one.getBoundingClientRect().bottom);
    }, [prev, sel]);
  };

  const mapOne = await sceneGap(0, '.map-headline', '.map-title', 1);
  const mapWide = await sceneGap(0, '.map-headline', '.map-title', 1.8);
  ok('the map scene takes the spacing too', mapWide !== null && mapOne !== null && mapWide > mapOne, `${mapOne} -> ${mapWide}`);

  const scoreOne = await sceneGap(2, '.score-teams', '.score-headline', 1);
  const scoreWide = await sceneGap(2, '.score-teams', '.score-headline', 1.8);
  ok('and so does the score scene', scoreWide !== null && scoreOne !== null && scoreWide > scoreOne, `${scoreOne} -> ${scoreWide}`);

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
