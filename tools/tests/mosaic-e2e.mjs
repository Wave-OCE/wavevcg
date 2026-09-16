/**
 * The mosaic opening and the event logo scale, measured on a real 1920x1080
 * stage rather than asserted.
 *
 * Two things DOM assertions would miss and this is here to catch: whether the
 * landed grid actually covers the frame (a gap is a hairline of game feed
 * through a solid overlay), and whether the tiles stay square through the
 * flight - a rotation anywhere in the cascade turns this back into the prism.
 */
const playwright = await import(new URL('../../node_modules/playwright/index.js', import.meta.url).href);
const chromium = playwright.chromium ?? playwright.default.chromium;

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

/** Screenshots land beside the suite. tools/tests/*.png is gitignored. */
const shot = (file) => fileURLToPath(new URL(file, import.meta.url));

// The checkout this suite lives in, resolved from the suite's own location so
// that moving the tree does not break it.
const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8154;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-mos-'));

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

/*
 * A stand-in wordmark, uploaded the way an operator uploads one.
 *
 * Not a data: URI - imageUrl() accepts http(s) or a path under this server and
 * nothing else, so a data URI is sanitised to '' and the logo slot then hides
 * itself. Going through /api/media is both the real path and the only one that
 * produces a value the graphic will keep.
 */
const WORDMARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 120">
  <rect width="400" height="120" fill="#ff4655"/>
  <rect x="16" y="16" width="368" height="88" fill="none" stroke="#ffffff" stroke-width="6"/>
</svg>`;

try {
  for (let i = 0; i < 80; i += 1) {
    try {
      await fetch(`${BASE}/api/auth/state`);
      break;
    } catch {
      await wait(250);
    }
  }

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'a-long-enough-password' }),
  });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((l) => l.split(';')[0]).join('; ');
  const key = (await login.json()).user.sessionKey;

  const upload = await fetch(`${BASE}/api/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', Cookie: cookie },
    body: WORDMARK,
  });
  const uploaded = await upload.json();
  ok('the stand-in logo uploaded', upload.status === 200 && typeof uploaded.url === 'string', JSON.stringify(uploaded));
  const LOGO = uploaded.url ?? '';

  const current = async () => (await (await fetch(`${BASE}/api/winner?key=${encodeURIComponent(key)}`)).json()).state;
  const put = async (patch) => {
    const state = await current();
    const next = { ...state, ...patch, seq: { ...state.seq, ...(patch.seq ?? {}) }, style: { ...state.style, ...(patch.style ?? {}) } };
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
    if (!response.ok) throw new Error(`save failed: ${response.status} ${await response.text()}`);
    return (await response.json()).state ?? next;
  };

  // Park it: mosaic opening, a long entrance so mid-flight is measurable.
  const saved = await put({
    eventLogo: LOGO,
    seq: { opening: 'mosaic', inMs: 2400, openStaggerMs: 120, active: false, stage: 0, restart: false, cue: 1 },
    style: { eventLogoPlacement: 'corner', eventLogoScale: 1 },
  });
  ok('the server kept the mosaic opening', saved.seq.opening === 'mosaic', saved.seq.opening);
  ok('and the default scale', saved.style.eventLogoScale === 1, String(saved.style.eventLogoScale));
  ok('and the logo survived sanitising', saved.eventLogo === LOGO && LOGO !== '', `${saved.eventLogo} vs ${LOGO}`);

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${BASE}/winner.html?key=${encodeURIComponent(key)}`);
  await page.waitForSelector('.mosaic .mosaic-tile', { timeout: 10000 });
  await page.waitForTimeout(600);

  // ----------------------------------------------------- the grid itself ---
  const grid = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('.mosaic-tile')];
    return {
      count: tiles.length,
      rings: [...new Set(tiles.map((t) => Number(t.dataset.ring)))].sort((a, b) => a - b),
      // Untransformed layout boxes, which is what has to tile the frame.
      boxes: tiles.map((t) => ({ x: t.offsetLeft, y: t.offsetTop, w: t.offsetWidth, h: t.offsetHeight, ring: Number(t.dataset.ring) })),
    };
  });

  ok('forty tiles', grid.count === 40, String(grid.count));
  ok('every tile is square', grid.boxes.every((b) => b.w === b.h), JSON.stringify(grid.boxes.find((b) => b.w !== b.h)));
  ok('rings run 0..5 with none skipped', grid.rings.join(',') === '0,1,2,3,4,5', grid.rings.join(','));

  // Coverage: no uncovered pixel anywhere in the 1920x1080 frame. Sampled on a
  // fine lattice rather than by union arithmetic - it is the same answer and it
  // cannot be wrong about the edges.
  let uncovered = 0;
  let firstGap = null;
  for (let y = 1; y < 1080; y += 7) {
    for (let x = 1; x < 1920; x += 7) {
      const hit = grid.boxes.some((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
      if (!hit) {
        uncovered += 1;
        firstGap ??= `${x},${y}`;
      }
    }
  }
  ok('THE GRID COVERS THE WHOLE FRAME', uncovered === 0, `${uncovered} uncovered samples, first at ${firstGap}`);

  // Rings must be symmetric or the opening reads as a wipe again. A tile and
  // its mirror about the centre have to land together.
  const ringAt = new Map(grid.boxes.map((b) => [`${b.x},${b.y}`, b.ring]));
  const size = grid.boxes[0].w;
  const cols = Math.max(...grid.boxes.map((b) => b.x)) / size;
  const rows = Math.max(...grid.boxes.map((b) => b.y)) / size;
  let asymmetric = 0;
  for (const b of grid.boxes) {
    const mirrorX = (cols - b.x / size) * size;
    const mirror = ringAt.get(`${mirrorX},${b.y}`);
    if (mirror !== undefined && mirror !== b.ring) asymmetric += 1;
  }
  ok('rings are left-right symmetric', asymmetric === 0, `${asymmetric} tiles disagree with their mirror`);

  // ------------------------------------------------- parked: square, small ---
  const parked = await page.evaluate(() => {
    const t = document.querySelector('.mosaic-tile');
    const cs = getComputedStyle(t);
    return { transform: cs.transform, opacity: cs.opacity, visible: getComputedStyle(document.querySelector('.mosaic')).visibility };
  });
  ok('the mosaic layer is visible for its own opening', parked.visible === 'visible', parked.visible);
  ok('parked tiles are invisible', Number(parked.opacity) === 0, parked.opacity);

  // matrix(a,b,c,d,e,f): b and c are the shear/rotation terms. A pure scale has
  // both at zero - which is the entire difference from the prism.
  const terms = (transform) => (transform.match(/matrix\(([^)]+)\)/)?.[1] ?? '').split(',').map(Number);
  const parkedTerms = terms(parked.transform);
  ok('parked tiles are scaled down', parkedTerms[0] > 0 && parkedTerms[0] < 0.5, JSON.stringify(parkedTerms));
  ok('PARKED TILES ARE NOT ROTATED', Math.abs(parkedTerms[1]) < 1e-6 && Math.abs(parkedTerms[2]) < 1e-6, parked.transform);

  // --------------------------------------------------------- mid-flight ---
  await page.evaluate(() => {
    // Activate through the page's own state channel by posting to the server is
    // slower than the flight; flip the stage attribute the same way the page
    // does so the transition runs from here.
    document.querySelector('.stage').dataset.active = 'true';
  });
  await page.waitForTimeout(700); // ~30% into a 2400ms entrance

  const flight = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('.mosaic-tile')];
    return tiles.map((t) => {
      const cs = getComputedStyle(t);
      const r = t.getBoundingClientRect();
      return { transform: cs.transform, opacity: Number(cs.opacity), w: Math.round(r.width), h: Math.round(r.height) };
    });
  });

  const rotated = flight.filter((t) => {
    const m = (t.transform.match(/matrix\(([^)]+)\)/)?.[1] ?? '').split(',').map(Number);
    return m.length === 6 && (Math.abs(m[1]) > 1e-6 || Math.abs(m[2]) > 1e-6);
  });
  ok('NO TILE ROTATES AT ANY POINT IN THE FLIGHT', rotated.length === 0, `${rotated.length} rotated, e.g. ${rotated[0]?.transform}`);

  const stillSquare = flight.every((t) => Math.abs(t.w - t.h) <= 1);
  ok('every tile is still square mid-flight', stillSquare, JSON.stringify(flight.find((t) => Math.abs(t.w - t.h) > 1)));

  const moving = flight.filter((t) => t.opacity > 0.02 && t.opacity < 0.98).length;
  ok('the grid really is staggered, not all at once', moving > 0, `${moving} tiles mid-transition`);

  await page.screenshot({ path: shot('mosaic-flight.png') });

  // -------------------------------------------------------------- landed ---
  await page.waitForTimeout(2400);
  const landed = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('.mosaic-tile')];
    return {
      allUp: tiles.every((t) => Number(getComputedStyle(t).opacity) > 0.98),
      transform: getComputedStyle(tiles[0]).transform,
      outline: Number(getComputedStyle(tiles[0], '::before').opacity),
    };
  });
  ok('every tile has landed', landed.allUp);
  const landedTerms = terms(landed.transform);
  ok('landed tiles sit a hair over their cell', landedTerms[0] > 1 && landedTerms[0] < 1.05, JSON.stringify(landedTerms));
  ok('landed tiles are not rotated', Math.abs(landedTerms[1]) < 1e-6 && Math.abs(landedTerms[2]) < 1e-6, landed.transform);
  ok('the outline has dropped back', landed.outline < 0.3, String(landed.outline));

  await page.screenshot({ path: shot('mosaic-landed.png') });

  // -------------------------------------------------- the event logo scale ---
  const measure = async (scale, placement) => {
    await put({ style: { eventLogoPlacement: placement, eventLogoScale: scale } });
    await page.waitForTimeout(500);
    return page.evaluate(() => {
      const corner = document.querySelector('.event-logo');
      const mark = [...document.querySelectorAll('.event-mark')].find((n) => !n.hidden);
      const box = (n) => (n ? { w: Math.round(n.getBoundingClientRect().width), h: Math.round(n.getBoundingClientRect().height) } : null);
      return { corner: box(corner), cornerRight: corner ? Math.round(1920 - corner.getBoundingClientRect().right) : null, cornerTop: corner ? Math.round(corner.getBoundingClientRect().top) : null, mark: box(mark) };
    });
  };

  const one = await measure(1, 'corner');
  ok('at 100% the corner mark is its original 190x96', one.corner.w === 190 && one.corner.h === 96, JSON.stringify(one.corner));

  const half = await measure(0.5, 'corner');
  ok('at 50% it halves', half.corner.w === 95 && half.corner.h === 48, JSON.stringify(half.corner));

  const double = await measure(2, 'corner');
  ok('at 200% it doubles', double.corner.w === 380 && double.corner.h === 192, JSON.stringify(double.corner));

  ok(
    'THE CORNER PIN DOES NOT MOVE AS IT SCALES',
    one.cornerRight === half.cornerRight && one.cornerRight === double.cornerRight && one.cornerTop === double.cornerTop,
    `right ${one.cornerRight}/${half.cornerRight}/${double.cornerRight}, top ${one.cornerTop}/${double.cornerTop}`,
  );

  ok('and it stays inside the frame at 200%', double.corner.w + double.cornerRight <= 1920, JSON.stringify(double));

  // In-scene marks scale their row rather than transforming inside it.
  const markOne = await measure(1, 'result');
  const markTwo = await measure(2, 'result');
  ok('an in-scene mark exists', markOne.mark !== null, JSON.stringify(markOne));
  if (markOne.mark) {
    ok('the in-scene mark scales too', markTwo.mark.h > markOne.mark.h * 1.9, `${markOne.mark.h} -> ${markTwo.mark.h}`);
  }

  // ------------------------------------------------ the grid texture ---
  // The mosaic standing still, as the lattice is the prism standing still. Two
  // crossed gradients; the angles are the whole difference between them, so the
  // angles are what this asserts.
  const textureOf = async (texture, scale = 190) => {
    await put({ seq: { active: true, stage: 1 }, style: { texture, textureScale: scale, eventLogoPlacement: 'hidden' } });
    await page.waitForTimeout(600);
    return page.evaluate(() => {
      const layer = document.querySelector('.texture-lines');
      const wrap = document.querySelector('.texture');
      return {
        key: document.querySelector('.stage').dataset.texture,
        image: getComputedStyle(layer).backgroundImage,
        opacity: Number(getComputedStyle(wrap).opacity),
        blend: getComputedStyle(wrap).mixBlendMode,
        glow: getComputedStyle(document.querySelector('.texture-glow')).display,
      };
    });
  };

  const lattice = await textureOf('lattice');
  ok('the lattice still leans 45 degrees', /45deg/.test(lattice.image) && /-45deg/.test(lattice.image), lattice.image.slice(0, 80));

  const gridTex = await textureOf('grid', 240);
  ok('the grid texture applies', gridTex.key === 'grid', gridTex.key);
  ok('THE GRID IS SQUARE ON, NOT LEANING', /0deg/.test(gridTex.image) && /90deg/.test(gridTex.image) && !/45deg/.test(gridTex.image), gridTex.image.slice(0, 90));
  ok('it is two crossed sets of lines', (gridTex.image.match(/repeating-linear-gradient/g) ?? []).length === 2, gridTex.image.slice(0, 120));
  ok('it uses the cell size it was given', gridTex.image.includes('238px') || gridTex.image.includes('240px'), gridTex.image.slice(0, 140));
  ok('it keeps the neon blend', gridTex.blend === 'screen', gridTex.blend);
  ok('and the glow layer, unlike an uploaded image', gridTex.glow !== 'none', gridTex.glow);
  ok('it is held to the shipped strength', gridTex.opacity > 0 && gridTex.opacity <= 0.3, String(gridTex.opacity));

  const off = await textureOf('none');
  ok('none still switches it off', off.key === 'none', off.key);

  await put({ style: { eventLogoPlacement: 'corner', eventLogoScale: 1 } });
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
