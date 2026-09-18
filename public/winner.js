/**
 * Winner sequence - output renderer.
 *
 * Point an OBS browser source at /winner.html (1920x1080) and leave it. State
 * arrives over SSE from the local server, so the dashboard and OBS stay in sync
 * even though they are separate browser processes.
 *
 * Built on the same two rules as the scoreboard renderer:
 *   - Never recreate an element. A repaint that rebuilt the DOM would flash
 *     every logo and map splash mid-sequence.
 *   - Never write markup. All text goes in via textContent, so nothing in the
 *     graphic state can become executable.
 *
 * And one more that only a sequence needs: the position on air is the server's,
 * not this page's. Nothing here decides to advance - it plays what it is told,
 * which is why two browser sources and the dashboard preview stay in step.
 */

import { teamColour } from './teams.js';
import { api, PAGE_BUS } from './session.js';
import { pick } from './brand.js';
import { watchBrand } from './brand-stream.js';
import {
  FACET_COLS,
  FACET_ROWS,
  MOSAIC_COLS,
  MOSAIC_RINGS,
  MOSAIC_ROWS,
  MOSAIC_SIZE,
  OPENING_SLATS,
  PEAK_STAGE,
  PRISM_COLS,
  PRISM_RINGS,
  PRISM_ROWS,
  PRISM_SIZE,
  PULSE_RINGS,
  WINNER_MAP_ROWS,
  WINNER_STAGES,
  WINNER_STAGE_KEYS,
  bandLeadMs,
  easingCurve,
  eventLogoInScene,
  isOverlayEntry,
  openingMs,
  resolveWinner,
  seriesScore,
  stageBands,
  upcomingNotes,
} from './winner-schema.js';

const STAGE_W = 1920;
const STAGE_H = 1080;

const stage = document.getElementById('stage');
const wrap = document.getElementById('stage-wrap');

// --------------------------------------------------------------- skeleton ---

function el(tag, className, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

// The backdrop's slats. Built here rather than in the HTML so the count comes
// from the schema and the markup cannot drift away from it.
const backdrop = document.getElementById('backdrop');
for (let index = 0; index < OPENING_SLATS; index += 1) backdrop.append(el('div', 'slat'));
const slats = [...backdrop.children];

/*
 * The facet grid. Each tile overscans its cell so the skew cannot open a wedge
 * between neighbours, and the whole grid overscans the frame so the lean cannot
 * expose a corner. `--facet-from` alternates by row, which is what makes them
 * cross the frame rather than all drift the same way.
 */
const FACET_SKEW = -13; // degrees

/*
 * How far each tile reaches past its cell, as a fraction of one.
 *
 * It has to beat the skew, not just cover rounding. A skew about the centre
 * displaces the top and bottom edges sideways by tan(skew) x half the cell
 * height - about 42px for these cells - so an overscan smaller than that leaves
 * a sliver of frame uncovered at the corners, where the lean runs out of tile.
 * At 0.16 it did, by three pixels, and 35 pixels of game feed showed through the
 * settled backdrop.
 */
const FACET_OVERSCAN = 0.24;

const facetGrid = document.getElementById('facets');
const cellW = 100 / FACET_COLS;
const cellH = 100 / FACET_ROWS;

for (let row = 0; row < FACET_ROWS; row += 1) {
  for (let col = 0; col < FACET_COLS; col += 1) {
    const facet = el('div', 'facet');
    facet.style.left = `${col * cellW - cellW * FACET_OVERSCAN}%`;
    facet.style.top = `${row * cellH - cellH * FACET_OVERSCAN}%`;
    facet.style.width = `${cellW * (1 + FACET_OVERSCAN * 2)}%`;
    facet.style.height = `${cellH * (1 + FACET_OVERSCAN * 2)}%`;
    facet.style.setProperty('--facet-skew', `${FACET_SKEW}deg`);
    facet.style.setProperty('--facet-from', `${row % 2 ? -160 : 160}%`);
    facet.dataset.step = String(col + row); // the diagonal cascade
    facetGrid.append(facet);
  }
}

const facets = [...facetGrid.children];

/*
 * The prism lattice.
 *
 * A rotated square grid, which tiles exactly: a diamond whose bounding box is
 * PRISM_SIZE shares each of its four edges with a neighbour when rows step half
 * a box down and every other row is offset half a box across. So this is a
 * genuine backdrop once it lands, not a pattern over one.
 *
 * A diamond with a bounding box of d is a square of side d/root-2 turned 45
 * degrees, which is where the division comes from. The grid starts one row and
 * one column outside the frame so the offset rows have no gap at the edges.
 *
 * Delay comes from a ring index rather than a position, because arriving
 * symmetrically is the whole idea - every tile the same distance from the middle
 * has to move at the same moment or it reads as a wipe again. The radius is
 * normalised against the frame, so the rings are ellipses matching 16:9 and
 * reach the corners at the same time they reach the sides.
 */
const prismGrid = document.getElementById('prism');
const prismSide = PRISM_SIZE / Math.SQRT2;

const prismRadii = [];

for (let row = -1; row < PRISM_ROWS - 1; row += 1) {
  for (let col = -1; col < PRISM_COLS - 1; col += 1) {
    // Alternate rows sit half a box across - the offset is what interlocks them.
    const odd = Math.abs(row % 2) === 1;
    const centreX = (col + (odd ? 0.5 : 0)) * PRISM_SIZE;
    const centreY = row * (PRISM_SIZE / 2);

    const tile = el('div', 'prism-tile');
    tile.style.left = `${centreX - prismSide / 2}px`;
    tile.style.top = `${centreY - prismSide / 2}px`;
    tile.style.width = `${prismSide}px`;
    tile.style.height = `${prismSide}px`;

    prismRadii.push(Math.hypot((centreX - STAGE_W / 2) / (STAGE_W / 2), (centreY - STAGE_H / 2) / (STAGE_H / 2)));
    prismGrid.append(tile);
  }
}

const prismTiles = [...prismGrid.children];

/*
 * Rings are spread across the range the lattice actually occupies, not across
 * 0..1.
 *
 * No tile is ever centred exactly on the middle of the frame - with an even
 * number of columns the four innermost straddle it - so measuring against an
 * absolute radius leaves ring 0 empty and the whole opening starts a stagger
 * step after the cue, while claiming in OPENING_STEPS to have used it. That is
 * a gap at the front of the animation and a server timing the scene change off
 * a duration nothing spends. Normalising makes the nearest tile ring 0 and the
 * furthest the last ring, whatever the lattice is sized to.
 */
{
  const near = Math.min(...prismRadii);
  const span = Math.max(...prismRadii) - near || 1;
  prismTiles.forEach((tile, index) => {
    tile.dataset.ring = String(Math.round(((prismRadii[index] - near) / span) * (PRISM_RINGS - 1)));
  });
}

/*
 * The mosaic grid.
 *
 * The prism above, with the rotation taken out and the interlocking arithmetic
 * with it. An axis-aligned grid tiles by simply being a grid, so there is no
 * half-offset row, no division by root-2 to turn a bounding box into a side,
 * and no ring of tiles outside the frame to hide the offset at the edges. Tiles
 * are laid from the top-left and the layer's overflow clips whatever hangs off
 * the bottom, which at 240px is half a row.
 *
 * Rings are measured exactly as the prism measures them - normalised against
 * the frame, so they are ellipses matching 16:9 and reach the corners at the
 * same moment they reach the sides.
 */
const mosaicGrid = document.getElementById('mosaic');
const mosaicRadii = [];

for (let row = 0; row < MOSAIC_ROWS; row += 1) {
  for (let col = 0; col < MOSAIC_COLS; col += 1) {
    const tile = el('div', 'mosaic-tile');
    tile.style.left = `${col * MOSAIC_SIZE}px`;
    tile.style.top = `${row * MOSAIC_SIZE}px`;
    tile.style.width = `${MOSAIC_SIZE}px`;
    tile.style.height = `${MOSAIC_SIZE}px`;

    // The tile's own centre, not its corner: a ring measured from the corner
    // puts the top-left tile of each quadrant a step ahead of its mirror image,
    // and the symmetry is the entire reason these arrive in rings.
    const centreX = (col + 0.5) * MOSAIC_SIZE;
    const centreY = (row + 0.5) * MOSAIC_SIZE;
    mosaicRadii.push(Math.hypot((centreX - STAGE_W / 2) / (STAGE_W / 2), (centreY - STAGE_H / 2) / (STAGE_H / 2)));

    mosaicGrid.append(tile);
  }
}

const mosaicTiles = [...mosaicGrid.children];

// Normalised over the range the grid occupies, for the reason spelled out over
// the prism's rings: no tile sits exactly on the centre of the frame, so an
// absolute radius leaves ring 0 empty and the opening wastes a stagger step it
// has already told the server about.
{
  const near = Math.min(...mosaicRadii);
  const span = Math.max(...mosaicRadii) - near || 1;
  mosaicTiles.forEach((tile, index) => {
    tile.dataset.ring = String(Math.round(((mosaicRadii[index] - near) / span) * (MOSAIC_RINGS - 1)));
  });
}

// The pulse opening's rings. Same reasoning as the slats: the count is the
// schema's, because the server times the opening from it.
const pulseGrid = document.getElementById('pulse');
for (let index = 0; index < PULSE_RINGS; index += 1) pulseGrid.append(el('div', 'pulse-ring'));
const pulseRings = [...pulseGrid.children];

// One row per map in the series, same reasoning.
const scoreMaps = document.getElementById('score-maps');
for (let index = 0; index < WINNER_MAP_ROWS; index += 1) {
  const row = el('div', 'score-map', { 'data-band': '', 'data-row': index });
  row.append(el('div', 'score-map-name', { 'data-bind': `maps.${index}.name` }));

  // The dash is not decoration: without it "13" and "7" sit side by side and
  // read as one number, and 9-13 and 13-11 are genuinely ambiguous.
  const score = el('div', 'score-map-score');
  score.append(
    el('span', 'score-map-num', { 'data-bind': `maps.${index}.left`, 'data-lead': `maps.${index}.leftAhead` }),
    el('span', 'score-map-dash', {}),
    el('span', 'score-map-num', { 'data-bind': `maps.${index}.right`, 'data-lead': `maps.${index}.rightAhead` }),
  );
  row.append(score);

  // Sits where the score would be, and replaces it on an unplayed map. The score
  // column is the one that is failing to say anything useful on those rows -
  // 0 - 0 is not a result - so the note answers the question the numbers could
  // not. Putting it under the map name instead would make one row in the list
  // taller than its neighbours, which reads as a mistake rather than a state.
  row.append(el('div', 'score-map-note', { 'data-bind': `maps.${index}.note` }));

  scoreMaps.append(row);
}

// ------------------------------------------------------------- collections ---

const scenes = WINNER_STAGE_KEYS.map((key) => stage.querySelector(`[data-scene="${key}"]`));
const textTargets = [...stage.querySelectorAll('[data-bind]')];
const imageTargets = [...stage.querySelectorAll('[data-img]')];
const fitTargets = [...stage.querySelectorAll('[data-fit]')];
const leadTargets = [...stage.querySelectorAll('[data-lead]')];
const winnerScene = stage.querySelector('.scene-winner');
// The one fitted heading with an operator-settable ceiling. The map name is
// sized by its own scene and the score names by the row they share with a
// crest, so neither has a share of the frame worth arguing about.
const winnerName = stage.querySelector('.winner-name');
const cornerMark = document.getElementById('event-logo');
const sceneMarks = [...stage.querySelectorAll('[data-mark]')];
const plate = document.getElementById('plate');
const textureLines = document.getElementById('texture-lines');
const winnerSub = stage.querySelector('.winner-sub');
const winnerLogo = stage.querySelector('.winner-logo');
const scoreLogoLeft = stage.querySelector('.score-team-left .score-logo');
const scoreLogoRight = stage.querySelector('.score-team-right .score-logo');

/**
 * A logo URL that 404s would otherwise draw the browser's broken-image icon,
 * which is far worse on air than showing nothing. The failed URLs are remembered
 * because `error` only fires when the src is assigned.
 */
const failedImages = new Set();

for (const node of imageTargets) {
  node.addEventListener('error', () => {
    const src = node.getAttribute('src');
    if (src) failedImages.add(src);
    node.hidden = true;
  });
}

/** The bands of a scene that will actually paint - a hidden one is not a step. */
const bandsOf = (scene) => [...scene.querySelectorAll('[data-band]')].filter((node) => !node.hidden);

// ------------------------------------------------------------ view model ---

let mapsByName = new Map();

const key = (value) => String(value ?? '').trim().toLowerCase();

const findMap = (name) => mapsByName.get(key(name)) ?? null;

function buildView(state) {
  const side = resolveWinner(state);
  const champion = state[side];

  const view = {
    eventLogo: state.eventLogo,
    mapKicker: state.mapKicker,
    mapHeadline: state.mapHeadline,
    scoreHeadline: state.scoreHeadline,
    winnerHeadline: state.winnerHeadline,
    winnerSubtitle: state.winnerSubtitle,
    map: {
      name: state.mapName,
      // The override wins, then the official splash, then nothing - the scene
      // still works as a title card with no plate behind it.
      image: state.style.showMapSplash ? state.mapImage || findMap(state.mapName)?.splash || '' : '',
    },
    winner: {
      name: champion.name,
      // What fitText falls back to when the full name will not fit at a
      // readable width. Without it here there is nothing to fall back to.
      shortName: champion.shortName,
      logo: champion.logo,
      colour: champion.colour,
    },
    maps: {},
  };

  // Counted from the map rows unless the operator took the count off, so the
  // number beside the crest and the rows underneath it cannot disagree.
  const series = seriesScore(state);

  for (const half of ['left', 'right']) {
    const team = state[half];
    view[half] = {
      name: team.name,
      shortName: team.shortName,
      logo: team.logo,
      region: state.style.showRegion ? team.region : '',
      score: String(series[half]),
    };
  }

  view.left.ahead = series.left > series.right;
  view.right.ahead = series.right > series.left;

  const notes = upcomingNotes(state);

  state.maps.forEach((row, index) => {
    view.maps[index] = {
      name: row.name,
      left: String(row.left ?? 0),
      right: String(row.right ?? 0),
      leftAhead: (row.left ?? 0) > (row.right ?? 0),
      rightAhead: (row.right ?? 0) > (row.left ?? 0),
      // Present in `notes` at all means "listed but not played" - the string may
      // still be empty, which is the fade-only case.
      upcoming: index in notes,
      note: notes[index] ?? '',
    };
  });

  return view;
}

const read = (source, path) => path.split('.').reduce((value, part) => (value == null ? value : value[part]), source);

// ------------------------------------------------------------- rendering ---

/*
 * `accent` is NOT in this map any more - it is resolved below, because blank
 * means "the event's" rather than "black". Everything else here is a plain
 * value with no inheritance behind it.
 */
const STYLE_VARS = {
  bg: '--bg',
  text: '--text',
  dimText: '--dim-text',
  panel: '--panel',
};

function applyStyle(style, view) {
  const root = document.documentElement.style;
  for (const [field, variable] of Object.entries(STYLE_VARS)) root.setProperty(variable, style[field]);
  // The graphic's own accent, or the event's when it has none.
  root.setProperty('--accent', pick(style.accent, brand(), 'accent'));
  root.setProperty('--bg-opacity', String(style.bgOpacity));
  root.setProperty('--scrim', String(style.scrim));
  root.setProperty('--font', `"${style.font}"`);
  root.setProperty('--plate-blur', `${style.plateBlur}px`);
  root.setProperty('--plate-dim', String(style.plateDim));
  root.setProperty('--upcoming-dim', String(style.upcomingDim));
  // One multiplier, read by every slot the logo can appear in. Unitless, so
  // each slot multiplies its own px sizes and keeps its own anchor.
  root.setProperty('--event-logo-scale', String(style.eventLogoScale));
  // Likewise for the vertical gaps between bands, in all three scenes.
  root.setProperty('--band-gap', String(style.bandGap));

  /*
   * The winner name's ceiling, in stage pixels.
   *
   * Resolved here rather than in CSS because fitText works in numbers, not in
   * lengths - and the setting is a share of the 1920 stage, which is a constant
   * this file already owns. Written before the refit at the end of render(), so
   * the next measurement uses it.
   */
  if (winnerName) winnerName.dataset.fitMax = String(Math.round(style.winnerNameWidth * STAGE_W));

  stage.classList.toggle('uppercase', style.uppercase);
  stage.classList.toggle('plate-off', !style.plateBehind);

  applyTexture(style);

  // Scoped to the winner scene on purpose. Recolouring the whole overlay from
  // the champion's palette would mean the map card is already flying their
  // colours two scenes before the result is revealed.
  // Resolved rather than read straight: a team colour may now be blank, meaning
  // "wear the side you are on" - and an end-of-series graphic has no sides, so
  // blank has to land on the fallback rather than on no accent at all.
  const teamAccent = style.useTeamColour ? teamColour(view.winner.colour, '') : '';
  // The winning team's own colour still wins on this scene, and under it the
  // graphic's accent, and under THAT the event's. Three layers, most specific
  // first, which is the same order every other colour in this program resolves.
  winnerScene.style.setProperty('--accent', teamAccent || pick(style.accent, brand(), 'accent'));
}

/**
 * The backdrop's finish.
 *
 * The URL goes into a CSS url(), which is a good deal further than a src
 * attribute reaches, so it is written with the DOM rather than assembled into a
 * custom property somebody else parses. encodeURI is belt to the sanitiser's
 * braces: it escapes the quote and the backslash, which are the only two
 * characters that could close the url() early and start meaning something else.
 */
function applyTexture(style) {
  const root = document.documentElement.style;
  const usable = style.texture === 'image' ? Boolean(style.textureImage) : style.texture !== 'none';

  stage.dataset.texture = usable ? style.texture : 'none';
  root.setProperty('--texture-opacity', String(style.textureOpacity));
  root.setProperty('--texture-scale', `${style.textureScale}px`);
  root.setProperty('--texture-blend', style.textureBlend);
  // Tiling and filling are two different jobs, and neither wants the other's
  // repeat rule: a cover image repeated is a cover image with seams.
  root.setProperty('--texture-size', style.textureTile ? `${style.textureScale}px` : 'cover');
  root.setProperty('--texture-repeat', style.textureTile ? 'repeat' : 'no-repeat');

  const url = style.texture === 'image' ? style.textureImage : '';
  const next = url ? `url("${encodeURI(url)}")` : '';
  if (textureLines.style.backgroundImage !== next) textureLines.style.backgroundImage = next;
}

/**
 * Two ways for a name to give way, and each heading picks one.
 *
 * `scaleX` condenses: the letters get narrower and the baseline does not move,
 * which is what a heading sharing a row with a crest wants - the score names and
 * the map name are set beside or above fixed furniture, and moving their
 * baseline would move that furniture with them.
 *
 * `size` shrinks the type properly, letters keeping their proportions. That is
 * the honest answer for the winner's name, which is the one heading on the whole
 * sequence set large enough that condensing it is legible as condensing rather
 * than as a typeface. It is opt-in per node (`data-fit-mode`) rather than a
 * global change, because the other three headings still want the first
 * behaviour.
 */
const MIN_SQUEEZE = 0.5;

/**
 * How small the type may get before the tricode is the better answer.
 *
 * Lower than the condensing floor, and deliberately: 50%-wide letters look like
 * a rendering fault, where a name at half size just looks like a long name set
 * smaller. Shrinking buys real headroom that condensing never had.
 */
const MIN_SHRINK = 0.45;

/**
 * Below this, condensing stops being a design choice and starts looking like a
 * fault. A team with a tricode has a better answer than 40%-wide letters, and
 * the tricode field exists for exactly this - so past this point the graphic
 * says SEN rather than a squashed "Sentinels Academy".
 */
const SWAP_TO_SHORT = 0.72;

/**
 * The same decision for a heading that shrinks instead, and it comes later.
 *
 * The 0.72 above is a judgement about *condensed* letters, not about long
 * names, so it does not carry over: a proportionally smaller name is still the
 * team's actual name and reads as one a good deal further down. Falling back to
 * a tricode any earlier would be throwing away the name for no reason.
 */
const SWAP_TO_SHORT_SHRINK = 0.55;

function fitText(node) {
  // The full name is preferred; `data-short` is what it falls back to. Reset
  // before measuring or a previous swap decides this one.
  const full = node.dataset.full ?? node.textContent;
  const short = node.dataset.short ?? '';
  if (node.textContent !== full) node.textContent = full;

  const shrinks = node.dataset.fitMode === 'size';

  /*
   * Both levers are cleared, not just the one in use.
   *
   * Measuring has to happen at the node's natural width, and a node carrying
   * last pass's font size would be measured at that size and then "fitted"
   * again from there - a name that got shorter would never grow back. Clearing
   * both rather than the active one costs nothing and means the mode can change
   * without leaving a stale lever behind.
   */
  node.style.transform = shrinks ? '' : 'scale(1)';
  node.style.fontSize = '';

  const parent = node.parentElement;
  if (!parent) return;

  // Read after the reset, so this is the size the stylesheet asked for rather
  // than whatever the last fit left behind.
  const baseSize = shrinks ? Number.parseFloat(getComputedStyle(node).fontSize) : 0;

  const allowance = Number.parseFloat(node.dataset.fit) || 1;
  const style = getComputedStyle(parent);
  const column = parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);

  /*
   * An absolute ceiling, on top of the share of the column.
   *
   * The two are different questions and both have to be answerable. The column
   * is what the layout can give; `--fit-max` is what the operator will allow,
   * and they set it as a share of the 1920 frame because that is the thing they
   * are looking at. Whichever is smaller wins.
   */
  const cap = Number.parseFloat(node.dataset.fitMax) || Infinity;
  const available = Math.min(column * allowance, cap);
  // offsetWidth, not scrollWidth: these are inline-blocks sized to their own
  // text, so their layout width *is* the width of the glyphs. scrollWidth was
  // reporting overflow out of a full-width block, which is a different number
  // from where the text actually ends.
  const needed = node.offsetWidth;

  if (!(available > 0) || !needed || needed <= available) return;

  let ratio = available / needed;

  // Only worth swapping if the short form actually buys something.
  if (short && short !== full && ratio < (shrinks ? SWAP_TO_SHORT_SHRINK : SWAP_TO_SHORT)) {
    node.textContent = short;
    const shortNeeded = node.offsetWidth;
    if (shortNeeded <= available) return;
    ratio = available / shortNeeded;
  }

  const applied = Math.max(shrinks ? MIN_SHRINK : MIN_SQUEEZE, ratio);

  if (!shrinks) {
    node.style.transform = `scaleX(${applied})`;
    return;
  }

  // Floored to whole pixels rather than rounded: rounding up would put the
  // name a hair past the ceiling it was just measured against, which is the one
  // direction that matters.
  node.style.fontSize = `${Math.floor(baseSize * applied)}px`;
}

const refit = () => fitTargets.forEach(fitText);

/**
 * Everything that can change a text measurement after the fact, because getting
 * this wrong puts a team name underneath a crest on air.
 *
 * `fonts.ready` resolves once, and only covers fonts pending at that moment - a
 * page that loaded with empty names never asked for the display weight, so the
 * font arrives later and every measurement taken before it is stale.
 * `loadingdone` fires for each batch instead.
 */
document.fonts?.ready.then(refit).catch(() => {});
document.fonts?.addEventListener?.('loadingdone', refit);

// And a general net: a crest appearing, a region line filling in, anything that
// resizes the box a name is being fitted into. Transforms do not affect layout,
// so writing the squeeze back cannot re-trigger this.
const fitObserver = new ResizeObserver(() => refit());
for (const node of fitTargets) {
  if (node.parentElement) fitObserver.observe(node.parentElement);
}

function render(state) {
  const view = buildView(state);
  applyStyle(state.style, view);
  // Safe to reveal: every scene is in its resting state, so "ready" lifts the
  // paint block without putting anything on air.
  stage.dataset.ready = '';

  for (const node of textTargets) {
    const value = read(view, node.dataset.bind);
    const next = value === null || value === undefined ? '' : String(value);

    // A fitted node's text is fitText's to decide - it may be showing the
    // tricode. Compared against the full form it was given, so a swap does not
    // read as a change and get undone on the next state push.
    if (node.dataset.fit !== undefined) {
      if (node.dataset.full !== next) {
        node.dataset.full = next;
        node.textContent = next;
      }
      const short = node.dataset.shortBind ? String(read(view, node.dataset.shortBind) ?? '') : '';
      if (node.dataset.short !== short) node.dataset.short = short;
    } else if (node.textContent !== next) {
      node.textContent = next;
    }
  }

  for (const node of imageTargets) {
    const url = read(view, node.dataset.img) || '';
    // Only touch src when it actually changed: reassigning the same URL is
    // usually a no-op, but "usually" is not good enough on air.
    if (url && node.getAttribute('src') !== url) node.setAttribute('src', url);
    if (!url) node.removeAttribute('src');
    node.hidden = !url || failedImages.has(url);
  }

  for (const node of leadTargets) {
    node.classList.toggle('is-ahead', Boolean(read(view, node.dataset.lead)));
  }

  document.getElementById('score-left').classList.toggle('is-ahead', view.left.ahead);
  document.getElementById('score-right').classList.toggle('is-ahead', view.right.ahead);

  // Hiding rather than leaving empty is what keeps the band count honest: an
  // invisible band would still take a stagger step and stretch the scene.
  //
  // An upcoming map is still a band, and deliberately: it is on the list, it is
  // part of what the score line is saying, and it arrives with the rest.
  for (const row of scoreMaps.children) {
    const map = view.maps[Number(row.dataset.row)];
    row.hidden = !map?.name;
    row.classList.toggle('is-upcoming', Boolean(map?.upcoming));
  }
  winnerSub.hidden = !view.winnerSubtitle;

  // Either the corner ident or the scenes the placement names - never both, and
  // never anything without a logo behind it. Hidden rather than transparent,
  // because an in-scene mark is a band: an invisible one would still take a
  // stagger step and stretch the scene it is in.
  const placement = view.eventLogo ? state.style.eventLogoPlacement : 'hidden';
  cornerMark.hidden = placement !== 'corner';
  for (const mark of sceneMarks) mark.hidden = !eventLogoInScene(state, mark.dataset.mark);
  // No splash means no plate: the scrim alone over a flat backdrop is a vignette
  // for nothing.
  plate.hidden = !view.map.image || failedImages.has(view.map.image);

  // Logo slots collapse when empty rather than reserving space. On the winner
  // scene that also removes a band, which is why stageBands() has to know about
  // the crest; on the score line the band is the whole row, so it does not.
  for (const [slot, url] of [
    [winnerLogo, view.winner.logo],
    [scoreLogoLeft, view.left.logo],
    [scoreLogoRight, view.right.logo],
  ]) {
    if (slot) slot.hidden = !url || failedImages.has(url);
  }

  checkBandCounts(state);

  // Last, so a scene never animates in over half-written text.
  applySeq(state.seq, state.audio);

  // Layout has to have settled before anything can be measured.
  requestAnimationFrame(refit);
}

/**
 * The server times auto-advance from a band count it works out without a
 * browser. If the layout and the schema ever disagree, scenes start changing
 * before or after they have finished arriving, so it is worth saying so loudly.
 */
let warnedBands = false;

function checkBandCounts(state) {
  if (warnedBands) return;
  WINNER_STAGES.forEach((entry, index) => {
    const actual = bandsOf(scenes[index]).length;
    const expected = stageBands(state, entry.key);
    if (actual === expected) return;
    warnedBands = true;
    console.warn(`scene "${entry.key}" paints ${actual} bands but stageBands() says ${expected}`);
  });
}

// ------------------------------------------------------------- sequence ---

/**
 * Reading offsetHeight forces the pending style change to be committed. Without
 * it the browser coalesces "hidden" and "shown" into a single recalculation and
 * nothing animates at all.
 */
const commit = () => void stage.offsetHeight;

/** Apply a change with the transitions switched off, then switch them back on. */
function instantly(change) {
  stage.classList.add('anim-off');
  change();
  commit();
  stage.classList.remove('anim-off');
}

function applySeqConfig(seq) {
  stage.dataset.transition = seq.transition;
  stage.dataset.opening = seq.opening;
  stage.style.setProperty('--in-ms', `${seq.inMs}ms`);
  stage.style.setProperty('--out-ms', `${seq.outMs}ms`);
  stage.style.setProperty('--stage-ms', `${seq.stageMs}ms`);
  stage.style.setProperty('--ease', easingCurve(seq.easing));
  stage.style.setProperty('--travel', `${seq.travel}px`);

  // A shade ahead of the first band, so the splash is already up when the text
  // lands on it rather than fading in underneath text that is already there.
  stage.style.setProperty('--plate-delay', `${Math.round(bandLeadMs(seq, true) * 0.7)}ms`);

  // Slats fan out from the middle rather than running left to right: a sequential
  // stagger across seven pieces reads as a wipe with extra steps, where an
  // outward one reads as the frame being pulled apart.
  const middle = (slats.length - 1) / 2;
  slats.forEach((slat, index) => {
    slat.style.setProperty('--slat-delay', `${Math.round(Math.abs(index - middle)) * seq.openStaggerMs}ms`);
  });

  // Facets cascade along the diagonal, so their step is column plus row.
  for (const facet of facets) {
    facet.style.setProperty('--facet-delay', `${Number(facet.dataset.step) * seq.openStaggerMs}ms`);
  }

  // The prism arrives in rings out from the middle, so its step is the ring.
  for (const tile of prismTiles) {
    tile.style.setProperty('--prism-delay', `${Number(tile.dataset.ring) * seq.openStaggerMs}ms`);
  }

  // The mosaic, the same way - it is the prism on a square grid.
  for (const tile of mosaicTiles) {
    tile.style.setProperty('--mosaic-delay', `${Number(tile.dataset.ring) * seq.openStaggerMs}ms`);
  }

  // The pulse throws one ring per step, in order.
  pulseRings.forEach((ring, index) => {
    ring.style.setProperty('--pulse-delay', `${index * seq.openStaggerMs}ms`);
  });
}

/**
 * The one-shot flourishes - the impact flash, the streak bolt, the content kick.
 * They are CSS animations, so the class going on is what plays them and it has
 * to come off again or a replay would find it already there and do nothing.
 */
let openingTimer = null;

function playOpening(seq) {
  clearTimeout(openingTimer);
  stage.classList.remove('is-opening');
  commit(); // so re-adding it below counts as a change
  stage.classList.add('is-opening');
  openingTimer = setTimeout(() => stage.classList.remove('is-opening'), openingMs(seq));
}

/**
 * The same one-shot, for the scene change that has a flourish of its own.
 *
 * Never played on the overlay's own arrival: the opening is already the loudest
 * thing that will happen, and a bar crossing the frame underneath it just makes
 * two events out of one.
 */
let glintTimer = null;

function playGlint(seq) {
  clearTimeout(glintTimer);
  stage.classList.remove('is-glint');
  commit();
  stage.classList.add('is-glint');
  glintTimer = setTimeout(() => stage.classList.remove('is-glint'), seq.stageMs);
}

/** Stagger the bands of the scene that is about to arrive. */
function setBandDelays(scene, seq, first) {
  const lead = bandLeadMs(seq, first);
  bandsOf(scene).forEach((node, index) => {
    node.style.setProperty('--band-delay', `${lead + index * seq.staggerMs}ms`);
  });
}

/** @type {Map<Element, number>} scenes still playing their exit */
const leaving = new Map();

function stopLeaving(scene) {
  clearTimeout(leaving.get(scene));
  leaving.delete(scene);
  scene.classList.remove('is-leaving', 'is-gone');
}

function leave(scene, seq, instant) {
  if (instant) {
    instantly(() => {
      stopLeaving(scene);
      scene.classList.remove('is-live');
    });
    return;
  }

  scene.classList.remove('is-live');
  scene.classList.add('is-leaving');
  commit(); // so the class change below is a transition and not a jump
  scene.classList.add('is-gone');

  // Held painted for the length of its exit, then dropped back to hidden. If it
  // is cued again before then, stopLeaving cancels this.
  clearTimeout(leaving.get(scene));
  leaving.set(
    scene,
    setTimeout(() => stopLeaving(scene), seq.stageMs),
  );
}

let liveScene = null;

function playScene(index, seq, { instant = false, first = false } = {}) {
  const next = scenes[index];
  if (!next) return;

  // Drives the map plate: sharp under the map card, soft and dark behind the
  // rest. Set before the scene changes so the two cross over together.
  stage.dataset.stage = WINNER_STAGE_KEYS[index] ?? WINNER_STAGE_KEYS[0];

  for (const scene of scenes) {
    if (scene !== next && scene.classList.contains('is-live')) leave(scene, seq, instant);
  }

  // Replaying the scene that is already up: drop it back to its resting state
  // first, or there is nothing for the stagger to animate from.
  if (liveScene === next) instantly(() => next.classList.remove('is-live'));
  stopLeaving(next);

  setBandDelays(next, seq, first);

  if (instant) instantly(() => next.classList.add('is-live'));
  else next.classList.add('is-live');

  if (seq.transition === 'glint' && !instant && !first) playGlint(seq);

  liveScene = next;
}

/** Rewind everything to off air without playing it, ready to be cued again. */
function rewind(seq) {
  instantly(() => {
    for (const scene of scenes) {
      stopLeaving(scene);
      scene.classList.remove('is-live');
    }
    liveScene = null;
    stage.dataset.active = 'false';
    // Back to the edge the entry sweeps in from.
    stage.dataset.park = 'left';
  });
  setBandDelays(scenes[seq.stage] ?? scenes[0], seq, true);
}

function enter(seq) {
  rewind(seq);
  commit(); // transitions are live again, and we are still off air
  stage.dataset.active = 'true';
  playOpening(seq);
  playScene(seq.stage, seq, { first: true });
}

function exit(seq) {
  // The sweep carries on out the right rather than retreating the way it came.
  stage.dataset.park = 'right';
  stage.dataset.active = 'false';
  liveScene = null;
  // Left painted for the length of the exit so it fades with the backdrop
  // instead of vanishing a frame early.
  setTimeout(() => {
    if (stage.dataset.active === 'false') rewind(seq);
  }, seq.outMs);
}

// null until the first state arrives, which is what distinguishes "the page just
// loaded" from "the operator cued something".
let lastCue = null;
let lastActive = null;
let lastStage = null;

let lastMusic = null;

function applySeq(seq, audio) {
  applySeqConfig(seq);

  if (lastCue === null) {
    lastCue = seq.cue;
    lastActive = seq.active;
    lastStage = seq.stage;
    lastMusic = seq.music;

    // A source starting mid-broadcast can either play the opening or simply be
    // there. Playing it is the default because OBS commonly loads the page at
    // the moment the scene goes live. Either way it arrives at the stage the
    // server says is current, not at the top - restarting the sequence here
    // would leave this page one scene behind an auto-advance already counted.
    const opened = seq.active && seq.animateOnLoad;

    if (opened) enter(seq);
    else if (seq.active) {
      instantly(() => {
        stage.dataset.active = 'true';
        stage.dataset.park = 'left';
      });
      playScene(seq.stage, seq, { instant: true });
    } else {
      rewind(seq);
    }

    // A source that joins a sequence already running picks the music up where
    // it is rather than starting the sting again from the top.
    applyAudio(audio, seq, opened);
    return;
  }

  // Typing in the dashboard pushes state constantly, so nothing here moves
  // without one of these actually changing.
  //
  // The two are kept apart deliberately. Music is a boolean, so it can be
  // compared directly and needs no cue of its own - and must not borrow the
  // graphic's, because a cue bump is precisely what tells this page to re-run
  // the scene it is on. Fading the music down is not a reason to replay a card
  // that is sitting on air.
  const graphicMoved = seq.cue !== lastCue || seq.active !== lastActive || seq.stage !== lastStage;
  const musicChanged = seq.music !== lastMusic;
  if (!graphicMoved && !musicChanged) return;

  const wasActive = lastActive;
  lastCue = seq.cue;
  lastActive = seq.active;
  lastStage = seq.stage;
  lastMusic = seq.music;

  if (graphicMoved) {
    // `restart` is what tells an Activate or a Replay apart from stepping Back
    // to the first scene, which must not play the opening again.
    if (!seq.active) {
      if (wasActive) exit(seq);
      else rewind(seq);
    } else if (!wasActive || isOverlayEntry(seq)) {
      enter(seq);
    } else {
      playScene(seq.stage, seq);
    }
  }

  applyAudio(audio, seq);
}

// ----------------------------------------------------------------- music ---

/**
 * The music bed.
 *
 * Three levels rather than one: under the map and score cards, up when the
 * winner lands, then back to something a caster can talk over. Whether it is
 * running at all is `seq.music`, which the transport owns - so an operator who
 * asked for the music to carry on after the graphic leaves gets exactly that,
 * and Fade music is the thing that ends it.
 *
 * Silent inside an iframe on purpose. The dashboard preview is the same page,
 * and an operator monitoring OBS does not want their browser tab playing the
 * same sting a frame out of step with it.
 */
const bed = document.getElementById('bed');
const isPreview = window.self !== window.top;

let fadeTimer = null;
let settleTimer = null;
let bedLevel = 0;

/** Linear ramp. Short enough and frequent enough that easing would not show. */
function rampTo(target, ms) {
  clearInterval(fadeTimer);
  fadeTimer = null;

  const level = (value) => {
    bedLevel = value;
    bed.volume = Math.min(1, Math.max(0, value));
    // Silence is a stop, not a quiet: a looping track left running at zero would
    // still be decoding, and would still be mid-bar when the next cue arrives.
    if (bed.volume === 0) bed.pause();
  };

  const from = bedLevel;
  const distance = target - from;

  // Covers a zero-length fade as well as one that has nowhere to go, and both
  // have to land on the same place as the animated path.
  if (!ms || !distance) {
    level(target);
    return;
  }

  const started = performance.now();
  fadeTimer = setInterval(() => {
    const progress = Math.min(1, (performance.now() - started) / ms);
    level(from + distance * progress);
    if (progress >= 1) {
      clearInterval(fadeTimer);
      fadeTimer = null;
    }
  }, 40);
}

function stopBed(audio, { instant = false } = {}) {
  clearTimeout(settleTimer);
  settleTimer = null;
  if (bed.paused && bedLevel === 0) return;
  if (instant) {
    rampTo(0, 0);
    bed.pause();
    return;
  }
  rampTo(0, audio.fadeOutMs);
}

/**
 * Which level the bed should be sitting at right now.
 *
 * An arc rather than a switch: a bed under the build-up, a lift on the winner,
 * and then out of the way. Keyed on the scene marked `peak` in the schema, not
 * on the last one - the winner is the moment the music is for, and it is no
 * longer the scene the sequence ends on.
 *
 * Everything past the peak is ambient, and that is the same number as before the
 * sequence started, deliberately. Both are the sound of a show carrying on
 * around the music: an operator setting up beforehand, a caster reading a score
 * line afterwards. Coming back *up* to the bed for the score line would undo the
 * hand-back the lift just paid for.
 */
function levelFor(audio, seq) {
  if (!seq.active) return audio.ambientVolume;
  if (seq.stage === PEAK_STAGE) return audio.peakVolume;
  return seq.stage > PEAK_STAGE ? audio.ambientVolume : audio.bedVolume;
}

/**
 * @param {object} audio the audio config
 * @param {object} seq   the command channel
 */
function applyAudio(audio, seq) {
  // The preview never makes a sound; loading the track there would also mean
  // downloading the bed twice for no reason.
  if (isPreview) return;

  bed.loop = audio.loop;

  if (!audio.enabled || !audio.track || !seq.music) {
    stopBed(audio);
    return;
  }

  if (bed.getAttribute('src') !== audio.track) {
    bed.setAttribute('src', audio.track);
    bedLevel = 0;
    bed.volume = 0;
  }

  const target = levelFor(audio, seq);
  // Starting from silence is the only thing that rewinds the track. An operator
  // who cued the music early and then hit Activate wants the bed to lift, not
  // to jump back to the top of the sting - and a Replay of the graphic is not a
  // reason to restart the music either.
  const starting = bed.paused;

  if (starting) {
    bed.currentTime = 0;
    bedLevel = 0;
    bed.volume = 0;
    // Autoplay is allowed in an OBS browser source but not in an ordinary tab
    // opened by hand, and a rejected promise here is not an error worth
    // shouting about - it just means nobody has clicked the page yet.
    bed.play().catch(() => {});
  }

  rampTo(target, starting ? audio.fadeInMs : audio.rampMs);

  clearTimeout(settleTimer);
  settleTimer = null;

  // The retreat to ambient is measured from the winner scene landing, which is
  // the only place it makes sense: it is the sound of a moment being handed
  // back to the casters. Advancing to the score line does the same thing on its
  // own, so this is what covers a sequence left holding on the winner.
  if (seq.active && seq.stage === PEAK_STAGE) {
    settleTimer = setTimeout(() => {
      settleTimer = null;
      rampTo(audio.ambientVolume, audio.rampMs);
    }, audio.settleAfterMs);
  }
}

// ----------------------------------------------------------------- scale ---

function fitStage() {
  const scale = Math.min(wrap.clientWidth / STAGE_W, wrap.clientHeight / STAGE_H);
  stage.style.transform = `scale(${scale})`;
}

window.addEventListener('resize', fitStage);
fitStage();

// ------------------------------------------------------------ connection ---

let latestState = null;

// Subscribe first so the first frame is not held up by the catalogue fetch;
// names and numbers paint immediately and the map splash fills in after.
const stream = new EventSource(api('/api/winner/events', PAGE_BUS));

// The event's colours, on the connection this page already has. The repaint
// matters: a splash can be up for a minute and has to follow a restyle.
const brand = watchBrand(stream, () => {
  if (latestState) render(latestState);
});

stream.addEventListener('winner', (event) => {
  try {
    latestState = JSON.parse(event.data).state;
    render(latestState);
  } catch (error) {
    console.warn(`ignored a malformed winner update: ${error.message}`);
  }
});

stream.addEventListener('error', () => console.warn('winner stream dropped - reconnecting'));

(async () => {
  try {
    const response = await fetch('/api/valorant-assets');
    if (response.ok) {
      const data = await response.json();
      mapsByName = new Map(data.maps.map((map) => [key(map.name), map]));
    }
  } catch {
    // The splash is decoration; the map name still goes to air without it.
    console.warn('valorant-api catalogue unavailable - rendering without the map splash');
  }
  if (latestState) render(latestState);
})();
