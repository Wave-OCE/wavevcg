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

import { VETO_BOARD_LAYOUT_KEYS, groupedRows, sideOfRow } from './veto-board-schema.js';
import { api, PAGE_BUS } from './session.js';
import { pick } from './brand.js';
import { watchBrand } from './brand-stream.js';

const STAGE_W = 1920;
const STAGE_H = 1080;

const stage = document.getElementById('stage');
const board = document.getElementById('board');
const strip = document.getElementById('strip');
const full = document.getElementById('full');
/*
 * The map art, resolved at PAINT TIME from the live catalogue rather than
 * copied into the snapshot.
 *
 * That looks like it contradicts the copy-not-link rule this graphic is built
 * on, and it does not: what the snapshot must freeze is the COMPETITION - who
 * banned what, in which order - because that is what two people with no account
 * drive from their phones and what a schedule edit must not be able to move. A
 * map's official splash is a catalogue asset, the same as an agent portrait,
 * and every other output page here resolves one the same way (post-match.js and
 * select.js both do exactly this). Freezing it would mean a board loaded before
 * an art refresh painting last season's key art beside a board loaded after it.
 *
 * Retried, and it never blocks a render: names and boxes go to air regardless
 * and the art upgrades the frame when it lands. A source that started before
 * the server had the catalogue would otherwise draw every veto of the broadcast
 * with empty boxes.
 */
let mapsByName = new Map();

const mapKey = (value) => String(value ?? '').trim().toLowerCase();

const mapArt = (name) => mapsByName.get(mapKey(name))?.splash ?? '';

async function loadCatalogue(attempt = 1) {
  try {
    const response = await fetch('/api/valorant-assets');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    mapsByName = new Map((data.maps ?? []).map((entry) => [mapKey(entry.name), entry]));
    if (latestState) render(latestState);
    return;
  } catch (error) {
    console.warn(`valorant-api catalogue unavailable (${error.message}) - drawing the board without map art`);
  }
  if (attempt >= 6) return;
  setTimeout(() => loadCatalogue(attempt + 1), Math.min(2000 * 2 ** attempt, 30000));
}

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
  if (tag === 'img') guard(node);
  return node;
}

/*
 * An image that fails to load must be INVISIBLE, not a broken-image marker.
 *
 * The house rule, applied here because this page now paints map art from a
 * remote catalogue: a splash URL that 404s - an art refresh that moved, a CDN
 * that changed - would otherwise put Chrome's broken-image icon in the middle
 * of a veto board on air, with nothing about the state saying anything is
 * wrong, because nothing is. The box degrades to the flat panel it used to be.
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

for (const img of document.querySelectorAll('img')) guard(img);

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
  /*
   * The art first, so it sits under the scrim and the type in PAINT ORDER
   * rather than needing a z-index to say the same thing - the arrangement the
   * full-screen tile already uses.
   *
   * The lower third had no map image at all: it got the name and the
   * full-screen layout got the art, which is the half of stage 21 that was
   * never done. A splash with a cross through it lands before a word does,
   * which is the whole argument for having it on either layout.
   */
  body.append(
    el('img', 'cell-art', { alt: '' }),
    el('div', 'cell-scrim'),
    el('div', 'cell-map'),
    el('div', 'cell-wait'),
  );
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
    /*
     * Resolved at PAINT TIME from the catalogue, never frozen into the
     * snapshot - the same call the full-screen tile makes, and for the reason
     * in the header: what the snapshot must freeze is the COMPETITION, and a
     * map's splash is a catalogue asset like an agent portrait.
     *
     * An UNREVEALED box carries no art at all rather than art behind an
     * opacity, because this page is opened with the session key and the answer
     * must not be sitting in its DOM. `setArt` is also what keeps `hidden` off
     * it - see the note there.
     */
    setArt(cell.querySelector('.cell-art'), shown ? mapArt(row.map) : '');
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

/**
 * Point an <img> at a map splash, or at nothing.
 *
 * Compared before assigning, because writing the same `src` restarts the decode
 * and, on a box that is mid-transition, visibly flickers.
 *
 * IT MUST NOT SET `hidden`, and that is the whole reason this is a function
 * with a note on it. `[hidden]` is `display: none` in this stylesheet, and an
 * element arriving from `display: none` has no previous computed style to
 * transition FROM - so the art snapped to full opacity while the name beside it
 * faded in, and the reveal the operator had just pressed was half an animation.
 * Caught by measuring the box 140ms after a reveal; every state assertion
 * around it was green, and a stylesheet that declares a transition looks
 * identical to one that is actually triggered.
 *
 * So an unrevealed box simply has no `src`. An <img> with no source and an
 * empty `alt` paints nothing, it is already at `opacity: 0` from not carrying
 * `.is-revealed`, and it keeps a computed style for the transition to start
 * from. `hidden` is left to `guard()` and means one thing only: this URL did not
 * load, so show nothing rather than a broken-image marker on air.
 */
function setArt(img, src) {
  if (!img) return;
  // A blank src would make the browser re-request the PAGE, so the attribute
  // goes rather than being emptied.
  if (!src) {
    img.removeAttribute('src');
    return;
  }
  if (img.getAttribute('src') !== src) img.setAttribute('src', src);
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
  /*
   * ALWAYS TWO ROWS, columns derived - `ceil(bans / 2)`.
   *
   * It was a fixed two columns, so a Bo1's six bans drew three rows deep and
   * three columns wide of empty frame sat beside them; the block was taller
   * than the maps it was next to and the whole board read bottom-heavy. Two
   * rows is the constant because the maps block beside it is one row of tall
   * panels, and the two only balance when the bans are wide rather than deep.
   *
   * Arithmetic written into a custom property, not a measurement: this page is
   * rendered by OBS while nothing is on screen, and anything asking its own
   * width there reads zero. The same rule the bracket's layout follows.
   */
  fullBans.style.setProperty('--ban-cols', String(Math.max(1, Math.ceil(bans.length / 2))));

  while (fullBans.children.length < bans.length) {
    const node = el('div', 'full-ban');
    /*
     * Both lines exist from the start and cross-fade, which is the same shape
     * the lower third's `.cell-map` / `.cell-wait` pair uses - and the reason
     * is the same: swapping one element's textContent cannot be animated, and
     * building the revealed line when it arrives would resize the box.
     */
    node.append(
      /*
       * The team mark FIRST, so the map art paints over it. An unrevealed box
       * is all mark; a revealed one is the map with the mark showing through.
       * Paint order rather than a z-index, which would be the same statement
       * made somewhere the next reader has to go and look for.
       */
      el('span', 'full-ban-tri'),
      el('img', 'full-ban-team', { alt: '' }),
      el('img', 'full-ban-art', { alt: '' }),
      el('span', 'full-ban-wait'),
      el('span', 'full-ban-done'),
    );
    fullBans.append(node);
  }
  while (fullBans.children.length > bans.length) fullBans.lastElementChild.remove();
  bans.forEach((row, index) => {
    const node = fullBans.children[index];
    const who = (row.byShort || row.by || '').toUpperCase();
    // Unrevealed says WHO is banning and not what - the tile is there, waiting.
    node.querySelector('.full-ban-wait').textContent = `${who} TO BAN`;
    node.querySelector('.full-ban-done').textContent = `${who} BANS ${(row.map || '').toUpperCase()}`;
    // A banned map shows its art too, darkened and struck through: the audience
    // is being told what is GONE, and a name alone is the weakest way to say it.
    setArt(node.querySelector('.full-ban-art'), row.shown ? mapArt(row.map) : '');

    /*
     * Their logo, or their tricode when they have no logo, or nothing.
     *
     * `sideOfRow` matches the row back to a seat because a row records who
     * acted by NAME - the board resolves seats to names on purpose so nothing
     * dereferences a seat while it paints, and this is the one place that needs
     * the seat back. A decider nobody chose matches nothing and shows nothing,
     * which is correct rather than a gap.
     */
    const team = state.showTeamArt === false ? null : sideOfRow(row, state);
    const teamLogo = node.querySelector('.full-ban-team');
    const teamTri = node.querySelector('.full-ban-tri');
    setArt(teamLogo, team?.logo ?? '');
    // The tricode only when there is no logo to show, so a team with both does
    // not paint one on top of the other.
    teamTri.textContent = team && !team.logo ? (team.shortName || team.name || '').toUpperCase() : '';

    node.classList.add('is-shown');
    node.classList.toggle('is-revealed', row.shown);
  });

  while (fullMaps.children.length < maps.length) {
    const node = el('div', 'full-map');
    // The art first, so it sits under the scrim and the type in paint order
    // rather than needing a z-index to say the same thing.
    node.append(
      el('img', 'full-map-art', { alt: '' }),
      el('div', 'full-map-scrim'),
      el('div', 'full-map-name'),
      el('div', 'full-map-meta'),
    );
    fullMaps.append(node);
  }
  while (fullMaps.children.length > maps.length) fullMaps.lastElementChild.remove();
  maps.forEach((row, index) => {
    const node = fullMaps.children[index];
    setArt(node.querySelector('.full-map-art'), row.shown ? mapArt(row.map) : '');
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

/*
 * The last state drawn, kept so the CATALOGUE arriving can redraw it.
 *
 * Without it a board that went up before the art landed would stay artless for
 * the whole broadcast - the stream only pushes on a change, and a veto that is
 * already complete makes none.
 */
let latestState = null;

function render(state) {
  if (!state) return;
  latestState = state;

  /*
   * Three colours, three meanings - see the stylesheet. The accent and the
   * highlight fall back to the EVENT's when this board has none of its own;
   * the ban colour does not, because a ban reads red by a convention older than
   * any one tournament and tying it to an event trim would announce bans in
   * whatever colour the sponsor happens to be.
   */
  const paint = brand();
  board.style.setProperty('--accent', pick(state.accent, paint, 'accent'));
  board.style.setProperty('--highlight', pick(state.highlight, paint, 'highlight'));
  board.style.setProperty('--ban', state.banColour || '');

  /*
   * The operator's size handle, on `.board` and NEVER on `#stage`.
   *
   * `fitStage` owns `#stage`'s transform and rewrites it on every resize, so a
   * second scale written there would be wiped by the next one - the trap the
   * bracket's `drawScale` already walked into and solved by putting its own
   * factor on an inner element. Written as a custom property rather than as a
   * transform here, so the stylesheet keeps the per-layout origin beside the
   * rule that uses it.
   */
  board.style.setProperty('--board-scale', String(state.boardScale ?? 1));

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

// The event's colours, on the connection this page already has. A veto board is
// up for the whole draft, so following a restyle live matters here.
const brand = watchBrand(stream, () => {
  if (latestState) render(latestState);
});

// After the stream is subscribed, so the first frame is never held up by the
// art - names and boxes go to air and the splashes upgrade the frame later.
loadCatalogue();
