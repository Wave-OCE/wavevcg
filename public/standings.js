/**
 * Standings - output renderer.
 *
 * Point an OBS browser source at /standings.html (1920x1080, transparent).
 * State arrives over SSE like every other output here.
 *
 * ## Arithmetic, never measurement
 *
 * The grid shape and the scale come from `standingsLayout` in the schema, which
 * works both out from the number of groups and the number of rows in each. That
 * is the same rule the bracket follows and the reason is the same: this page is
 * routinely rendered by OBS while nothing is visible, and anything that
 * measured itself there would read zero and paint the whole board on one spot.
 *
 * What is NOT absolutely positioned is everything inside a table. A table is a
 * stack of rows in ordinary flow - unlike a bracket, where a match sits at a
 * fractional row between the two that feed it - so the layout needs no
 * measurement to begin with. The pixel constants are written back out as custom
 * properties so the stylesheet lays out at exactly the numbers the fit assumed.
 *
 * ## The three rules every output page here follows
 *
 *   Never recreate an element that is already on screen - walking to the next
 *   pool repaints these rows, it does not rebuild them.
 *   Never write markup; everything goes in through textContent.
 *   Layout must not move when data changes. A row is the same height whatever
 *   is in it, and a long org name is clipped rather than allowed to push a
 *   column.
 */

import {
  STANDINGS_FRAME,
  STANDINGS_METRICS,
  shownGroups,
  standingsLayout,
  standingsScale,
  standingsThrough,
} from './standings-schema.js';
import { api, PAGE_BUS } from './session.js';
import { pick } from './brand.js';
import { watchBrand } from './brand-stream.js';

const STAGE_W = 1920;
const STAGE_H = 1080;

const stage = document.getElementById('stage');
const board = document.getElementById('board');
const tables = document.getElementById('tables');
const stageName = document.getElementById('stage-name');
const eyebrow = document.getElementById('eyebrow');
const eventLogo = document.getElementById('event-logo');
const eventLogoImg = document.getElementById('event-logo-img');

/*
 * An image that fails to load must be INVISIBLE, not a broken-image marker. A
 * crest URL that 404s - a media file deleted, a CDN that moved - otherwise
 * paints Chrome's broken icon on a live broadcast, and nothing about the state
 * says anything is wrong, because nothing is: the string is a good URL that
 * happens not to answer.
 */
function guard(node) {
  node.addEventListener('error', () => {
    node.hidden = true;
  });
  node.addEventListener('load', () => {
    node.hidden = false;
  });
  return node;
}
guard(eventLogoImg);

function el(tag, className, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (tag === 'img') guard(node);
  return node;
}

/*
 * The constants the stylesheet lays out at, from the ONE place that holds them.
 *
 * Written once, at import: they never move. The schema owns them because the
 * fit has to be computed from them with no DOM at all, and the alternative -
 * the same six numbers in a stylesheet - is a fit that is arithmetically
 * correct about a table nobody is looking at.
 */
const root = document.documentElement;
root.style.setProperty('--table-w', `${STANDINGS_METRICS.tableW}px`);
root.style.setProperty('--row-h', `${STANDINGS_METRICS.rowH}px`);
root.style.setProperty('--head-h', `${STANDINGS_METRICS.headH}px`);
root.style.setProperty('--name-h', `${STANDINGS_METRICS.nameH}px`);
root.style.setProperty('--gap-x', `${STANDINGS_METRICS.gapX}px`);
root.style.setProperty('--gap-y', `${STANDINGS_METRICS.gapY}px`);

/** The fixed columns either side of the stat block. See standings.css. */
const RANK_W = 52;

const signed = (value) => (value > 0 ? `+${value}` : String(value));

/**
 * Which stat columns are on, in the order a table reads them.
 *
 * W-L is ONE cell rather than two columns, because "3-1" is how a record is
 * said out loud and two columns of single digits is 190px spent on 60px of
 * information. Maps are given as the two numbers a rulebook uses; ROUNDS are
 * given as a DIFFERENCE, because 213-171 across four columns is noise and the
 * only thing anybody does with round counts is subtract them.
 */
const statsOf = (state) =>
  [
    state.showRecord !== false && { head: 'W-L', width: 96, value: (row) => `${row.won}-${row.lost}` },
    state.showMaps !== false && { head: 'Maps', width: 96, value: (row) => `${row.mapsWon}-${row.mapsLost}` },
    state.showRounds === true && {
      head: 'Rnd',
      width: 88,
      value: (row) => signed((row.roundsWon ?? 0) - (row.roundsLost ?? 0)),
    },
  ].filter(Boolean);

/** One line: a rank, a crest and a name, and however many stat cells are on. */
function makeRow() {
  const row = el('div', 'row');
  const team = el('div', 'cell-team');
  team.append(el('img', null, { alt: '' }), el('span', 'cell-name'));
  row.append(el('div', 'cell-rank'), team);
  return row;
}

/** Grow or shrink a row's stat cells. Never rebuilt - see the header. */
function fitCells(row, count) {
  let cells = row.querySelectorAll('.cell-stat').length;
  while (cells < count) {
    row.append(el('div', 'cell-stat'));
    cells += 1;
  }
  while (cells > count) {
    row.lastElementChild.remove();
    cells -= 1;
  }
}

function paintRow(row, line, index, stats, state) {
  fitCells(row, stats.length);
  row.style.setProperty('--i', String(index));

  const isHead = line === null;
  row.classList.toggle('is-head', isHead);
  row.classList.toggle('is-through', !isHead && standingsThrough(state, line));

  row.querySelector('.cell-rank').textContent = isHead ? '#' : String(line.rank || '');

  const logo = row.querySelector('.cell-team img');
  const art = isHead || state.showLogos === false ? '' : line.logo || '';
  if (art) {
    if (logo.getAttribute('src') !== art) logo.setAttribute('src', art);
  } else {
    logo.hidden = true;
    logo.removeAttribute('src');
  }

  /*
   * The full name, not the tricode. A bracket slot is 224px and read across a
   * room, so it takes the short form; a table row has three times that and the
   * table is the place an audience looks up who somebody actually is. The
   * tricode is the fallback for a team that has no name rather than the other
   * way round.
   */
  row.querySelector('.cell-name').textContent = isHead
    ? 'Team'
    : (line.name || line.shortName || '').toUpperCase();

  const cells = row.querySelectorAll('.cell-stat');
  stats.forEach((stat, at) => {
    cells[at].textContent = isHead ? stat.head.toUpperCase() : stat.value(line);
  });
}

/** One group: its name, its column heads, and its teams. */
function makeTable() {
  const table = el('div', 'table');
  table.append(el('div', 'table-name'));
  return table;
}

function paintTable(table, group, stats, state, named) {
  const name = table.querySelector('.table-name');
  name.textContent = (group.name || '').toUpperCase();
  name.hidden = !named;

  // One head row plus one per team. The head is index 0 of the stagger, so a
  // table arrives from the top down the way it is read.
  const wanted = (group.rows ?? []).length + 1;
  let rows = table.querySelectorAll('.row').length;
  while (rows < wanted) {
    table.append(makeRow());
    rows += 1;
  }
  while (rows > wanted) {
    table.lastElementChild.remove();
    rows -= 1;
  }

  const all = table.querySelectorAll('.row');
  paintRow(all[0], null, 0, stats, state);
  (group.rows ?? []).forEach((line, index) => paintRow(all[index + 1], line, index + 1, stats, state));
}

/*
 * Size the grid, then centre it in the frame.
 *
 * ARITHMETIC, not measurement - `standingsLayout` answers with the shape and
 * the size from the row counts alone, and `standingsScale` folds in the
 * operator's own adjustment. Asking the DOM would mean measuring a page OBS
 * renders while nothing is on screen.
 *
 * The scale goes on `#tables` and never on `#stage`: `fitStage` owns that one
 * and rewrites it on every resize, so a second transform written there is wiped
 * by the next one - the trap the bracket's `drawScale` and the veto board's
 * `boardScale` both already walked into.
 */
function placeTables(state) {
  const layout = standingsLayout(state);
  const scale = standingsScale(state);

  tables.style.setProperty('--cols', String(layout.cols));
  tables.style.transform = scale === 1 ? '' : `scale(${scale})`;

  const availW = STAGE_W - STANDINGS_FRAME.left - STANDINGS_FRAME.right;

  /*
   * CENTRED ACROSS, HUNG FROM THE TOP - and the asymmetry is the fix for
   * something only a screenshot showed.
   *
   * Centring both ways is what the bracket does, and it is right there: a draw
   * sheet is the whole graphic and the header sits above it. Here the header is
   * a caption in the top left and the tables belong UNDER it, so vertically
   * centring a short one left 200 pixels of nothing between the two and the
   * board read as a graphic whose top half had failed to load. Four pools fill
   * the frame and hid it completely; one pool is stark.
   *
   * Across, centring stays: a single 1020px table pinned to the left margin
   * would sit in the left half of the frame with eight hundred pixels of empty
   * beside it, which is the "built for a different show" failure the bracket's
   * own centring note is about.
   */
  tables.style.left = `${Math.round(STANDINGS_FRAME.left + Math.max(0, (availW - layout.width * scale) / 2))}px`;
  tables.style.top = `${STANDINGS_FRAME.top}px`;
}

/**
 * Play the rows in again.
 *
 * Nothing is recreated when the operator walks to the next pool - the same row
 * elements are repainted with a different pool's teams - so there is no arrival
 * for the browser to animate. Dropping the class, forcing the reflow that
 * establishes the resting computed style, and putting it back is what makes the
 * stagger replayable. Without the reflow the two writes collapse into one and
 * nothing moves at all.
 */
function replay() {
  tables.classList.remove('is-in');
  void tables.offsetWidth;
  tables.classList.add('is-in');
}

function render(state) {
  if (!state) return;

  /*
   * The two colours the operator owns, as custom properties on the board.
   *
   * Set rather than removed when blank: `setProperty(name, '')` clears the
   * declaration, so the stylesheet's own value comes back and "unset" is a real
   * state rather than a black graphic.
   *
   * NOTE THE NAMES MEAN WHAT THEY SAY HERE, unlike the bracket's - whose
   * `accent` is its highlight and whose `trim` is its accent, a mismatch that
   * predates the word "highlight" existing in this codebase and is written up
   * as a trap. The event's accent is this graphic's accent and the event's
   * highlight is its highlight, with nothing crossed over.
   */
  const paint = brand();
  board.style.setProperty('--accent', pick(state.accent, paint, 'accent'));
  board.style.setProperty('--highlight', pick(state.highlight, paint, 'highlight'));

  stageName.textContent = (state.stageName || '').toUpperCase();
  eyebrow.textContent = (state.heading || '').toUpperCase();
  eyebrow.hidden = !state.heading;

  const logo = state.eventLogo || '';
  eventLogo.hidden = !logo;
  if (logo && eventLogoImg.getAttribute('src') !== logo) eventLogoImg.setAttribute('src', logo);

  const groups = shownGroups(state);
  const stats = statsOf(state);
  const named = standingsLayout(state).named;

  tables.style.setProperty(
    '--row-cols',
    [`${RANK_W}px`, '1fr', ...stats.map((stat) => `${stat.width}px`)].join(' '),
  );

  let count = tables.children.length;
  while (count < groups.length) {
    tables.append(makeTable());
    count += 1;
  }
  while (count > groups.length) {
    tables.lastElementChild.remove();
    count -= 1;
  }
  groups.forEach((group, index) => paintTable(tables.children[index], group, stats, state, named));

  placeTables(state);
  board.classList.toggle('is-on', Boolean(state.anim?.visible));
}

/*
 * The cue: replay the entrance, and only on a transport press. Walking to the
 * next pool, or a result landing behind the scenes, must not fly the whole
 * board on again - which is the failure the counter was invented to prevent.
 */
let lastCue = null;

/** Which pool was on screen last, so a step can be told from a repaint. */
let lastShown = null;

/*
 * The last state handed to this page, kept so a colour change can redraw it.
 * The stream only pushes when the STANDINGS move, and a finished table sitting
 * on air makes no such push - so without this an event accent typed mid-show
 * would reach every other graphic and not this one.
 */
let latest = null;

function apply(state) {
  latest = state;

  const cue = state?.anim?.cue ?? 0;
  if (lastCue !== null && cue !== lastCue && state?.anim?.visible) {
    board.classList.remove('is-on');
    void board.offsetWidth;
  }
  lastCue = cue;

  render(state);

  /*
   * A STEP IS AN ARRIVAL; A REPAINT IS NOT.
   *
   * Keyed on what is actually on screen rather than on the index alone, because
   * switching the layout from "one at a time" to "all" changes the board
   * completely while leaving the index where it was - and a board that changed
   * without animating reads as a graphic that has frozen.
   */
  const shown = `${state?.layout ?? 'all'}:${state?.group ?? 0}`;
  const stepped = lastShown !== null && shown !== lastShown;
  lastShown = shown;
  if (stepped || tables.classList.contains('is-in') === false) replay();
}

function fitStage() {
  stage.style.transform = `scale(${Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H)})`;
}

window.addEventListener('resize', fitStage);
fitStage();

const stream = new EventSource(api('/api/standings/events', PAGE_BUS));

/*
 * The event's colours, on the connection this page already has. The repaint is
 * not optional in spirit: a tournament's accent can change while a table is on
 * air and the frame has to follow, which is the whole of "inherit".
 */
const brand = watchBrand(stream, () => {
  if (latest) render(latest);
});

stream.addEventListener('standings', (event) => {
  try {
    apply(JSON.parse(event.data).state);
  } catch (error) {
    console.warn(`ignored a malformed standings update: ${error.message}`);
  }
});

stream.addEventListener('error', () => console.warn('standings stream dropped - reconnecting'));
