/**
 * Agent select strip - output renderer.
 *
 * Point an OBS browser source at /select.html (1920x1080, transparent) and leave
 * it. State arrives over SSE from the local server, so the dashboard, the
 * preview and OBS stay in step even though they are separate browser processes.
 *
 * Built on the same two rules as the other outputs:
 *   - Never recreate an element. A repaint that rebuilt the DOM would flash
 *     every portrait mid-lobby.
 *   - Never write markup. All text goes in via textContent, so nothing that
 *     arrives on the roster webhook can become executable - which matters more
 *     here than anywhere else in the package, because this is the one graphic
 *     whose contents are typed by strangers in a game lobby.
 */

import {
  SELECT_SIDE_SIZE,
  TIMER_SNAP_MS,
  agentLabel,
  easingCurve,
  findAgent,
  sideSlots,
  timerElapsed,
  timerRemainingMs,
} from './select-schema.js';
import { mapDisplayName } from './maps.js';
import { teamColour } from './teams.js';
import { api, PAGE_BUS } from './session.js';
import { pick } from './brand.js';
import { watchBrand } from './brand-stream.js';

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

/**
 * One card. Built here rather than written out ten times in the HTML so the
 * count comes from the schema and the markup cannot drift away from it.
 *
 * Every part is always present and only ever hidden, because a card that built
 * its own contents when somebody picked would rebuild - and therefore reload -
 * a portrait every time the same player changed their mind.
 */
function buildCard(half, seat) {
  const card = el('div', 'card', { 'data-card': '', 'data-half': half, 'data-seat': seat });

  const media = el('div', 'card-media');
  media.append(el('div', 'card-wash'), el('img', 'card-portrait', { alt: '' }), el('div', 'card-scrim'));

  const body = el('div', 'card-body');
  // Both are fitted rather than ellipsised: on a card this narrow "Butte..." is
  // not a name, and condensing a little is what keeps it one.
  body.append(el('span', 'card-name', { 'data-fit': '1' }), el('span', 'card-agent', { 'data-fit': '1' }));

  /*
   * The frame is a second element because a card has two independent things to
   * say with one transform, and one transform cannot say both.
   *
   * The outer card carries the entrance - it flies in, turns, lifts. The frame
   * inside it carries the pick scale, which shrinks while a player is still
   * deciding and grows when they commit. Declared on one element, whichever
   * rule the cascade picked would silently cancel the other: the entrance lost,
   * taking its stagger and its fade with it, and every arrival looked identical
   * because none of them were running.
   */
  const frame = el('div', 'card-frame');
  frame.append(
    el('div', 'card-seat'),
    media,
    el('img', 'card-role', { alt: '' }),
    body,
    el('div', 'card-pulse'),
  );

  card.append(frame);
  return card;
}

const cardHosts = {
  left: document.getElementById('cards-left'),
  right: document.getElementById('cards-right'),
};

/** @type {{left: HTMLElement[], right: HTMLElement[]}} */
const cards = { left: [], right: [] };

for (const half of ['left', 'right']) {
  for (let seat = 0; seat < SELECT_SIDE_SIZE; seat += 1) {
    const card = buildCard(half, seat);
    cardHosts[half].append(card);
    cards[half].push(card);
  }
}

const mapCard = document.getElementById('map-card');
const identSides = [...stage.querySelectorAll('.ident-side')];
const identVs = stage.querySelector('.ident-vs');
const timerBar = document.getElementById('timer');
const timerFills = [...timerBar.querySelectorAll('.timer-fill')];

const textTargets = [...stage.querySelectorAll('[data-bind]')];
const imageTargets = [...stage.querySelectorAll('[data-img]')];
const fitTargets = [...stage.querySelectorAll('[data-fit]')];

/**
 * A logo URL that 404s would otherwise draw the browser's broken-image icon,
 * which is far worse on air than showing nothing. The failed URLs are remembered
 * because `error` only fires when the src is assigned.
 */
const failedImages = new Set();

const watchImage = (node) =>
  node.addEventListener('error', () => {
    const src = node.getAttribute('src');
    if (src) failedImages.add(src);
    node.hidden = true;
  });

for (const node of imageTargets) watchImage(node);
for (const half of ['left', 'right']) {
  for (const card of cards[half]) {
    watchImage(card.querySelector('.card-portrait'));
    watchImage(card.querySelector('.card-role'));
  }
}

/** Assign a src only when it actually changed - reassigning is usually a no-op,
    and "usually" is not good enough on air. */
function setImage(node, url) {
  const usable = url && !failedImages.has(url);
  if (usable && node.getAttribute('src') !== url) node.setAttribute('src', url);
  if (!url) node.removeAttribute('src');
  node.hidden = !usable;
  return Boolean(usable);
}

// ------------------------------------------------------------ view model ---

let agents = [];
let mapsByName = new Map();
// Kept whole as well as indexed: mapDisplayName needs the code table, which is
// not something a name index can carry.
let catalogue = { maps: [], agents: [], mapCodes: {} };

const key = (value) => String(value ?? '').trim().toLowerCase();

const read = (source, path) =>
  path.split('.').reduce((value, part) => (value == null ? value : value[part]), source);

function buildView(state) {
  /*
   * Resolved again here, and not redundantly.
   *
   * The server resolves a map event on the way in, but only if it had the
   * catalogue at that moment - a map reported in the first seconds after a cold
   * start can be stored as "Duality". Doing it again at render means the
   * catalogue arriving late still fixes what is on screen, and it costs a lookup
   * against a name that is almost always already right.
   */
  const mapName = mapDisplayName(catalogue, state.mapName);

  return {
    eventLogo: state.eventLogo,
    map: {
      name: mapName,
      // The override wins, then the official splash, then nothing - the card
      // still works as a title with no picture behind it.
      image: state.mapImage || mapsByName.get(key(mapName))?.splash || '',
    },
    left: { ...state.left },
    right: { ...state.right },
  };
}

// ------------------------------------------------------------- rendering ---

const STYLE_VARS = {
  bg: '--bg',
  panel: '--panel',
  text: '--text',
  dimText: '--dim-text',
};

function applyStyle(style, state) {
  const root = document.documentElement.style;
  for (const [field, variable] of Object.entries(STYLE_VARS)) root.setProperty(variable, style[field]);

  // The graphic's own trim, or the event's. Not in STYLE_VARS because that
  // loop writes values verbatim and this one has a chain behind it.
  root.setProperty('--accent', pick(style.accent, brand(), 'accent'));
  root.setProperty('--bg-opacity', String(style.bgOpacity));
  root.setProperty('--font', `"${style.font}"`);
  root.setProperty('--offset-y', `${style.offsetY}px`);
  root.setProperty('--pick-opacity', String(style.pickOpacity));
  root.setProperty('--pick-scale', String(style.pickScale));
  root.setProperty('--pulse-ms', `${style.pulseMs}ms`);

  /*
   * The two team colours drive the side labels, the card rules and the pulse, so
   * they are set once here rather than per card.
   *
   * Resolved rather than read: a team with no colour of its own wears the colour
   * of the side it is playing, and the production can force both sides to the
   * plain attack/defence pair whatever the teams have saved.
   */
  const force = state.colourSource === 'sides';
  root.setProperty('--left', teamColour(state.left.colour, state.left.side, { force }));
  root.setProperty('--right', teamColour(state.right.colour, state.right.side, { force }));

  root.setProperty('--timer-height', `${style.timerHeight}px`);
  root.setProperty('--timer-track', String(style.timerTrack));

  stage.classList.toggle('uppercase', style.uppercase);
  stage.dataset.align = style.align;
  timerBar.hidden = !style.showTimer;
  // Off is a state of its own rather than a zero-length animation, which would
  // simply freeze the ring at whichever end it stopped on.
  stage.dataset.pulse = style.pulseMs > 0 ? 'on' : 'off';
  stage.toggleAttribute('data-seats', style.showEmptyNumbers);

  mapCard.hidden = !style.showMap;
}

/**
 * Paint one card from one roster slot.
 *
 * The three states are decided here and expressed as two classes, because CSS is
 * where the difference between them belongs - this function should not know how
 * faded a provisional pick is.
 */
function renderCard(card, slot, style, colour) {
  const picked = Boolean(String(slot.character ?? '').trim());
  const agent = picked ? findAgent(agents, slot.character) : null;

  const locked = picked && Boolean(slot.locked);

  /*
   * The grow on lock-in is the RELEASE of the provisional 0.88, not a rule of
   * its own - so it only animates if the browser ever sat at the 0.88. A card
   * that arrives picked and locked in one repaint never did: measured in plain
   * Chrome, the frame went 1 -> 1 with no intermediate value at all.
   *
   * That is not a vMix fault and not hypothetical. The feed folds a whole array
   * of events into one state push, so a client that batches a pick with its
   * lock, or that only emits once the player has committed, lands here in
   * exactly that shape. It looks browser-specific only because the dashboard's
   * two controls are seconds apart and so always animate.
   *
   * The fix has to put the card AT the provisional scale, not merely into the
   * class that leads there - the 0.88 is itself transitioned, so staging it with
   * transitions live just starts a 310ms move toward 0.88 that the lock then
   * reverses, which is the imperceptible wobble this looked like at first.
   * `instantly` is the existing helper for exactly that: suppress, change,
   * commit, release.
   *
   * Costs one forced layout per card that arrives already locked - ten a lobby,
   * not one per repaint, because a card already in the right classes never
   * enters this branch.
   */
  if (locked && !card.classList.contains('is-picked') && !stage.classList.contains('anim-off')) {
    instantly(() => {
      card.classList.add('is-picked');
      card.classList.remove('is-locked');
    });
  }

  card.classList.toggle('is-picked', picked);
  card.classList.toggle('is-locked', locked);
  card.style.setProperty('--side', colour);

  const portrait = card.querySelector('.card-portrait');
  setImage(portrait, agent?.portrait ?? agent?.icon ?? '');

  const role = card.querySelector('.card-role');
  setImage(role, style.showRole ? (agent?.role?.icon ?? '') : '');

  // The agent's own gradient, so a card reads as belonging to that agent even
  // where the portrait is mostly transparent. The colours arrive as 8-digit hex
  // with the alpha last, which is exactly what CSS expects.
  const wash = card.querySelector('.card-wash');
  const gradient = agent?.gradient ?? [];
  wash.style.setProperty('--wash-a', gradient[0] ? `#${gradient[0]}` : 'transparent');
  wash.style.setProperty('--wash-b', gradient[gradient.length - 1] ? `#${gradient[gradient.length - 1]}` : 'transparent');

  // Falls back to the internal name rather than to nothing: "Sarge" on air is
  // bad, but it is visible and fixable, where a blank card looks like the feed
  // failed.
  const agentText = picked && style.showAgentName ? agentLabel(agents, slot.character) : '';

  for (const [node, next] of [
    [card.querySelector('.card-name'), picked || slot.name ? String(slot.name ?? '') : ''],
    [card.querySelector('.card-agent'), agentText],
  ]) {
    // Compared against the full form rather than what is on screen, because what
    // is on screen may be a squeezed copy of it - and comparing the two would
    // make every repaint look like a change.
    if (node.dataset.full === next) continue;
    node.dataset.full = next;
    node.textContent = next;
  }
}

function render(state) {
  const view = buildView(state);
  applyStyle(state.style, state);
  // Safe to reveal: everything is in its resting state, so "ready" lifts the
  // paint block without putting anything on air.
  stage.dataset.ready = '';

  for (const node of textTargets) {
    const value = read(view, node.dataset.bind);
    const next = value === null || value === undefined ? '' : String(value);

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
    const shown = setImage(node, url);
    // The slot collapses rather than reserving space - an empty 74px hole where
    // a crest was not uploaded pulls the whole identity bar off centre.
    const slot = node.parentElement;
    if (slot && slot !== stage) slot.hidden = !shown;
  }

  for (const half of ['left', 'right']) {
    const indices = sideSlots(state, half);
    const colour = state[half].colour;
    cards[half].forEach((card, seat) => {
      const slot = state.slots[indices[seat]] ?? {};
      card.querySelector('.card-seat').textContent = String(indices[seat] + 1);
      renderCard(card, slot, state.style, colour);
    });
  }

  applyTimer(state.timer);
  applyAnim(state.anim);

  // Layout has to have settled before anything can be measured.
  requestAnimationFrame(refit);
}

// ----------------------------------------------------------------- timer ---

/**
 * The clock, driven by one CSS transition rather than a frame loop.
 *
 * The server owns where the clock is; this works out where the bar should be
 * *now* and how long it has to reach the end, then hands both to the compositor
 * and stops thinking about it. Eighty-five seconds of requestAnimationFrame to
 * move a bar is eighty-five seconds of main thread nobody needs, and it would
 * be competing with ten portraits fading in.
 *
 * A page that joins halfway through is the normal case, not an edge one - so
 * the bar is always snapped to the current position first and only then given
 * the remaining time to travel.
 */
let timerSignature = null;

function applyTimer(timer) {
  // Compared as a whole, so a roster event twenty times a second cannot restart
  // an animation that is already running correctly.
  const signature = `${timer.running}|${timer.startedAt}|${timer.durationMs}|${timer.filled}`;
  if (signature === timerSignature) return;
  timerSignature = signature;

  const to = (value, ms) => {
    timerBar.style.setProperty('--timer-ms', `${Math.max(0, Math.round(ms))}ms`);
    for (const fill of timerFills) fill.style.transform = `scaleX(${value})`;
  };

  /*
   * Snapped to the *elapsed* position, not to where a finished clock belongs.
   *
   * That distinction is the early finish: everybody locks in at forty seconds,
   * the bar is snapped to forty seconds' worth and then given half a second to
   * close the rest. Snapping to "finished" first would put it at the end before
   * the animation that is meant to take it there had started, and the fill
   * nobody sees is the one thing this was asked to do.
   */
  timerBar.classList.add('is-set');
  to(timerElapsed(timer), 0);
  void timerBar.offsetHeight; // commit, or the two states coalesce into one
  timerBar.classList.remove('is-set');

  if (timer.filled) {
    to(1, TIMER_SNAP_MS);
    return;
  }

  if (!timer.running) return;

  to(1, timerRemainingMs(timer));
}

// ------------------------------------------------------------------ fit ---

const MIN_SQUEEZE = 0.5;
const SWAP_TO_SHORT = 0.72;

/**
 * The same fitter the winner graphic uses, and the same reasoning: a team name
 * is only ever a little too long, never twice too long, so it squeezes rather
 * than changing a font size the design is built around - and past the point
 * where condensing starts looking like a fault it says the tricode instead.
 */
function fitText(node) {
  const full = node.dataset.full ?? node.textContent;
  const short = node.dataset.short ?? '';
  if (node.textContent !== full) node.textContent = full;

  node.style.transform = 'scale(1)';

  const parent = node.parentElement;
  if (!parent) return;

  const style = getComputedStyle(parent);
  const available =
    (parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) *
    (Number.parseFloat(node.dataset.fit) || 1);
  // offsetWidth, not scrollWidth: these are inline-blocks sized to their own
  // text, so their layout width *is* the width of the glyphs.
  const needed = node.offsetWidth;

  if (!(available > 0) || !needed || needed <= available) return;

  let ratio = available / needed;

  if (short && short !== full && ratio < SWAP_TO_SHORT) {
    node.textContent = short;
    const shortNeeded = node.offsetWidth;
    if (shortNeeded <= available) return;
    ratio = available / shortNeeded;
  }

  node.style.transform = `scaleX(${Math.max(MIN_SQUEEZE, ratio)})`;
}

const refit = () => fitTargets.forEach(fitText);

/*
 * Everything that can change a text measurement after the fact. `fonts.ready`
 * resolves once and only covers fonts pending at that moment - a page that
 * loaded with empty names never asked for the display weight, so it arrives
 * later and every measurement taken before it is stale.
 */
document.fonts?.ready.then(refit).catch(() => {});
document.fonts?.addEventListener?.('loadingdone', refit);

const fitObserver = new ResizeObserver(() => refit());
for (const node of fitTargets) {
  if (node.parentElement) fitObserver.observe(node.parentElement);
}

// ------------------------------------------------------------ animation ---

/**
 * Reading offsetHeight forces the pending style change to be committed. Without
 * it the browser coalesces "hidden" and "shown" into one recalculation and
 * nothing animates at all.
 */
const commit = () => void stage.offsetHeight;

function instantly(change) {
  stage.classList.add('anim-off');
  change();
  commit();
  stage.classList.remove('anim-off');
}

/**
 * The entrance stagger: identity bar, then the cards dealing outwards from the
 * middle, then the map.
 *
 * Outwards from the middle rather than left to right, because left to right
 * across eleven things reads as a wipe with extra steps where an outward deal
 * reads as two teams being introduced at once.
 */
function setEnterDelays(anim) {
  const step = anim.staggerMs;
  identSides.forEach((node) => node.style.setProperty('--enter-delay', '0ms'));
  identVs.style.setProperty('--enter-delay', `${step}ms`);
  mapCard.style.setProperty('--enter-delay', `${step}ms`);

  for (const half of ['left', 'right']) {
    cards[half].forEach((card, seat) => {
      // Seat 0 is the outermost card on each side, so distance from the map is
      // counted back from the end on the left and forwards on the right. Mirrored
      // by construction: the pair either side of the map are the same number.
      const distance = half === 'left' ? SELECT_SIDE_SIZE - seat : seat + 1;

      // `deal` runs from the map outwards; every other entrance moves the whole
      // row as one gesture and uses the stagger only to soften the edge, so it
      // counts from the outside in and both sides still land together.
      const order = anim.entrance === 'deal' ? distance : SELECT_SIDE_SIZE - distance + 1;
      card.style.setProperty('--enter-delay', `${step * (order + 1)}ms`);

      // The direction this card comes from, so one rule can mirror itself.
      // Each side arrives from its own edge, which is what makes the entrance
      // symmetrical rather than a wipe across the strip.
      card.style.setProperty('--from', half === 'left' ? '-110px' : '110px');
      card.style.setProperty('--flip', half === 'left' ? '-55deg' : '55deg');
    });
  }
}

function applyAnimConfig(anim) {
  stage.dataset.entrance = anim.entrance;
  stage.style.setProperty('--in-ms', `${anim.inMs}ms`);
  stage.style.setProperty('--out-ms', `${anim.outMs}ms`);
  stage.style.setProperty('--ease', easingCurve(anim.easing));
  // How long a card takes to commit. Tied to the entrance rather than given a
  // knob of its own: a lock-in that moved at a different speed from the graphic
  // it is part of reads as a second animation.
  stage.style.setProperty('--pick-ms', `${Math.round(anim.inMs * 0.5)}ms`);
  setEnterDelays(anim);
}

// null until the first state arrives, which is what distinguishes "the page just
// loaded" from "the operator pressed something".
let lastCue = null;
let lastVisible = null;

function applyAnim(anim) {
  applyAnimConfig(anim);

  if (lastCue === null) {
    lastCue = anim.cue;
    lastVisible = anim.visible;

    // A source starting mid-broadcast can either play the entrance or simply be
    // there. Playing it is the default because OBS commonly loads the page at
    // the moment the scene goes live.
    if (anim.visible && anim.animateOnLoad) enter();
    else instantly(() => (stage.dataset.visible = anim.visible ? 'true' : 'false'));
    return;
  }

  // Typing in the dashboard pushes state constantly, and so does every player in
  // the lobby changing their mind - so nothing here moves without one of these
  // actually changing. A card locking in is not a reason to replay the entrance.
  if (anim.cue === lastCue && anim.visible === lastVisible) return;

  lastCue = anim.cue;
  lastVisible = anim.visible;

  if (anim.visible) enter();
  else stage.dataset.visible = 'false';
}

function enter() {
  instantly(() => (stage.dataset.visible = 'false'));
  commit(); // transitions are live again, and we are still off air
  stage.dataset.visible = 'true';
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
// names paint immediately and the portraits fill in after.
const stream = new EventSource(api('/api/select/events', PAGE_BUS));

// The event's colours, on the connection this page already has. Agent select
// sits on screen for the whole draft, so following a restyle live matters here
// as much as anywhere.
const brand = watchBrand(stream, () => {
  if (latestState) render(latestState);
});

stream.addEventListener('select', (event) => {
  try {
    latestState = JSON.parse(event.data).state;
    render(latestState);
  } catch (error) {
    console.warn(`ignored a malformed select update: ${error.message}`);
  }
});

stream.addEventListener('error', () => console.warn('select stream dropped - reconnecting'));

(async () => {
  try {
    const response = await fetch('/api/valorant-assets');
    if (response.ok) {
      const data = await response.json();
      catalogue = data;
      agents = data.agents ?? [];
      mapsByName = new Map((data.maps ?? []).map((map) => [key(map.name), map]));
    }
  } catch {
    // Without the catalogue there are no portraits and no display names - the
    // strip still shows who is in the lobby, which is most of the job.
    console.warn('valorant-api catalogue unavailable - rendering without portraits');
  }
  if (latestState) render(latestState);
})();
