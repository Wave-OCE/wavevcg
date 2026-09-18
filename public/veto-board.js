/**
 * Map veto board - output renderer.
 *
 * Point an OBS browser source at /veto-board.html (1920x1080, transparent) and
 * leave it. State arrives over SSE, like every other output here.
 *
 * Three rules, and the first two are the ones every output page in this package
 * follows:
 *
 *   NEVER RECREATE AN ELEMENT that is already on screen. A repaint that rebuilt
 *   the DOM would restart every transition, so revealing the fourth ban would
 *   flash the three above it. Cells are built once for the rows they represent
 *   and afterwards only their text, classes and images change.
 *
 *   NEVER WRITE MARKUP. Everything goes in through textContent. Map names come
 *   from a catalogue and team names from an operator, but a veto is also driven
 *   by two people holding links, which puts strangers one step from this page.
 *
 *   LAYOUT MUST NOT MOVE WHEN DATA CHANGES. A cell arriving animates opacity
 *   and transform and nothing else; the strip is laid out for every row it will
 *   ever hold from the moment the board loads, so the fifth ban appearing does
 *   not shuffle the four beside it.
 */

import { VETO_BOARD_LAYOUT_KEYS, groupedRows } from './veto-board-schema.js';
import { api, PAGE_BUS } from './session.js';

const STAGE_W = 1920;
const STAGE_H = 1080;

const stage = document.getElementById('stage');
const board = document.getElementById('board');
const strip = document.getElementById('strip');
const full = document.getElementById('full');
const fullBans = document.getElementById('full-bans');
const fullMaps = document.getElementById('full-maps');
const logoBar = document.getElementById('logo-bar');
const logoLower = document.getElementById('logo-lower');
const fullLogo = document.getElementById('full-logo');
const logoFull = document.getElementById('logo-full');
const fullLeft = document.getElementById('full-left');
const fullRight = document.getElementById('full-right');

function el(tag, className, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/** What the head of a lower-third cell says: who, and what they did. */
const headWords = (row) => {
  if (row.kind === 'decider') return { who: 'DECIDER', what: 'MAP' };
  return {
    who: (row.byShort || row.by || '').toUpperCase(),
    what: row.kind === 'ban' ? 'VETO MAP' : 'SELECT MAP',
  };
};

/** The side line under a picked map: "JAIL PICKS / DEF". */
const sideWords = (row) => {
  if (row.kind === 'ban') return '';
  const who = (row.sideByShort || row.sideBy || '').toUpperCase();
  const side = row.side === 'attack' ? 'ATK' : row.side === 'defence' ? 'DEF' : '';
  if (!who || !side) return '';
  return `${who} ${side}`;
};

// ------------------------------------------------------------ lower third ---

/*
 * Cells are keyed by index and reused, so a board that grows by one does not
 * rebuild the ones already on screen and restart their transitions.
 *
 * Every cell carries BOTH a map and a placeholder, and only one of them is on
 * at a time. Building the map element when it is revealed would mean the box
 * changing size as it fills, which is the layout moving when the data changes.
 */
function lowerCell() {
  const cell = el('div', 'cell');
  const head = el('div', 'cell-head');
  head.append(el('span', 'who'), el('span', 'what'));
  const body = el('div', 'cell-body');
  body.append(el('div', 'cell-map'), el('div', 'cell-wait'));
  cell.append(head, body, el('div', 'cell-foot'));
  return cell;
}

function paintLower(state) {
  const rows = state.rows ?? [];

  while (strip.children.length < rows.length) strip.append(lowerCell());
  while (strip.children.length > rows.length) strip.lastElementChild.remove();

  const flags = state.revealed ?? [];

  rows.forEach((row, index) => {
    const cell = strip.children[index];
    const words = headWords(row);
    const shown = flags[index] === true;

    // The head is never hidden. Whose turn it is and whether they are banning
    // or picking is not the secret - the MAP is.
    cell.querySelector('.who').textContent = words.who;
    cell.querySelector('.what').textContent = words.what;
    cell.querySelector('.cell-map').textContent = (row.map || '').toUpperCase();
    cell.querySelector('.cell-foot').textContent = shown && state.showSides ? sideWords(row) : '';
    cell.classList.toggle('is-ban', row.kind === 'ban');

    /*
     * The shape is always up; only the data arrives. `is-shown` stays on every
     * cell so the strip is complete from the first frame - what moves is
     * `is-revealed`, which swaps the placeholder for the map.
     */
    cell.classList.add('is-shown');
    cell.classList.toggle('is-revealed', shown);
  });
}

// ------------------------------------------------------------ full screen ---

function paintFull(state) {
  const { bans, maps } = groupedRows(state.rows, state.revealed);

  fullLeft.textContent = (state.left.name || '').toUpperCase();
  fullRight.textContent = (state.right.name || '').toUpperCase();

  /*
   * Grouped, and that is a LAYOUT decision. The record keeps the true order and
   * `reveal` still counts in it, so walking the board out reveals steps in the
   * sequence they happened even though they are drawn in two blocks. A grouping
   * that reached back into the record would make the board evidence of an order
   * nobody played.
   */
  while (fullBans.children.length < bans.length) {
    fullBans.append(el('div', 'full-ban'));
  }
  while (fullBans.children.length > bans.length) fullBans.lastElementChild.remove();
  bans.forEach((row, index) => {
    const node = fullBans.children[index];
    const who = (row.byShort || row.by || '').toUpperCase();
    // Unrevealed says WHO is banning and not what - the tile is there, waiting.
    node.textContent = row.shown ? `${who} BANS ${(row.map || '').toUpperCase()}` : `${who} TO BAN`;
    node.classList.add('is-shown');
    node.classList.toggle('is-revealed', row.shown);
  });

  while (fullMaps.children.length < maps.length) {
    const node = el('div', 'full-map');
    node.append(el('div', 'full-map-name'), el('div', 'full-map-meta'));
    fullMaps.append(node);
  }
  while (fullMaps.children.length > maps.length) fullMaps.lastElementChild.remove();
  maps.forEach((row, index) => {
    const node = fullMaps.children[index];
    node.querySelector('.full-map-name').textContent = row.shown ? (row.map || '').toUpperCase() : '';
    const meta = node.querySelector('.full-map-meta');
    meta.textContent = '';
    if (row.kind === 'decider') {
      meta.append(document.createTextNode('DECIDER'));
    } else {
      const picker = el('b');
      picker.textContent = (row.byShort || row.by || '').toUpperCase();
      meta.append(picker, document.createTextNode(' PICKS'));
    }
    if (row.shown && state.showSides && sideWords(row)) {
      meta.append(document.createElement('br'), document.createTextNode(sideWords(row)));
    }
    node.classList.add('is-shown');
    node.classList.toggle('is-revealed', row.shown);
  });
}

// ----------------------------------------------------------------- render ---

let lastCue = null;

function render(state) {
  if (!state) return;

  const layout = VETO_BOARD_LAYOUT_KEYS.includes(state.layout) ? state.layout : 'lower';
  board.classList.toggle('is-lower', layout === 'lower');
  board.classList.toggle('is-full', layout === 'full');
  strip.hidden = layout !== 'lower';
  full.hidden = layout !== 'full';

  const logo = state.eventLogo || '';
  logoBar.hidden = layout !== 'lower' || !logo;
  fullLogo.hidden = layout !== 'full' || !logo;
  if (logo) {
    if (logoLower.getAttribute('src') !== logo) logoLower.setAttribute('src', logo);
    if (logoFull.getAttribute('src') !== logo) logoFull.setAttribute('src', logo);
  }

  if (layout === 'lower') paintLower(state);
  else paintFull(state);

  /*
   * The cue, and the one thing it means here: replay the ENTRANCE.
   *
   * It moves only when the operator presses Show, so an edit - or a reveal, or
   * a fresh Load - leaves it alone and the board stays where it is. Without the
   * comparison the whole graphic would fly on again every time a captain banned
   * a map, which is the failure the counter was invented to prevent.
   */
  const cue = state.anim?.cue ?? 0;
  if (lastCue !== null && cue !== lastCue && state.anim?.visible) {
    board.classList.remove('is-on');
    // Forced reflow, so removing and re-adding the class in one frame is two
    // state changes rather than none.
    void board.offsetWidth;
  }
  lastCue = cue;

  board.classList.toggle('is-on', Boolean(state.anim?.visible));
}

// ------------------------------------------------------------------ scale ---

function fitStage() {
  const scale = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
  stage.style.transform = `scale(${scale})`;
}

window.addEventListener('resize', fitStage);
fitStage();

// ------------------------------------------------------------- connection ---

const stream = new EventSource(api('/api/veto-board/events', PAGE_BUS));

stream.addEventListener('vetoBoard', (event) => {
  try {
    render(JSON.parse(event.data).state);
  } catch (error) {
    console.warn(`ignored a malformed veto board update: ${error.message}`);
  }
});

stream.addEventListener('error', () => console.warn('veto board stream dropped - reconnecting'));
