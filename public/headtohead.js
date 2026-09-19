/**
 * Head to head - output renderer.
 *
 * Point an OBS browser source at /headtohead.html (1920x1080, transparent).
 * State arrives over SSE like every other output here.
 *
 * The markup is a fixed skeleton and nothing in it is ever created or removed -
 * only text, image URLs and classes change. That is the rule the other output
 * pages follow and it matters here for a small reason: this graphic is usually
 * corrected rather than rebuilt (a tricode, a crest that loaded late), and a
 * repaint that swapped elements would flash a logo that is already on screen.
 */

import { backdropFor } from './headtohead-schema.js';
import { api, PAGE_BUS } from './session.js';
import { pick } from './brand.js';
import { watchBrand } from './brand-stream.js';

const STAGE_W = 1920;
const STAGE_H = 1080;

const stage = document.getElementById('stage');
const root = document.getElementById('h2h');
const divider = document.getElementById('divider');
const heading = document.getElementById('heading');
const eventLogo = document.getElementById('event-logo');
const eventLogoImg = document.getElementById('event-logo-img');

for (const img of document.querySelectorAll('img')) guard(img);

const halves = {
  left: {
    back: document.getElementById('left-back'),
    tint: document.getElementById('left-tint'),
    logo: document.getElementById('left-logo'),
    name: document.getElementById('left-name'),
  },
  right: {
    back: document.getElementById('right-back'),
    tint: document.getElementById('right-tint'),
    logo: document.getElementById('right-logo'),
    name: document.getElementById('right-name'),
  },
};

/*
 * An image that fails to load must be INVISIBLE, not a broken-image marker.
 *
 * A logo URL that 404s - a media file deleted, a CDN that moved, a typo in a
 * pasted address - otherwise paints Chrome's broken-image icon and a border on
 * a live broadcast. Nothing about the state says anything is wrong, because
 * nothing is wrong with the state: the string is a perfectly good URL that
 * happens not to answer.
 *
 * So every <img> on this page hides itself on error and un-hides when a src
 * that actually loads arrives. The graphic then degrades to "no logo", which is
 * a look somebody chose rather than a fault on screen.
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

/** Only write a src when it actually changed, or the image reloads and flashes. */
const setSrc = (node, value) => {
  if (value) {
    if (node.getAttribute('src') !== value) node.setAttribute('src', value);
    // Not un-hidden here: `load` does that, so an image that never answers stays
    // hidden rather than flashing a broken marker while it tries.
  } else {
    node.hidden = true;
    node.removeAttribute('src');
  }
};

function paintHalf(which, half, state) {
  const els = halves[which];
  els.name.textContent = (half.teamName || '').toUpperCase();

  setSrc(els.back, backdropFor(half, state.styleBackdrop));
  setSrc(els.logo, half.logo || '');

  /*
   * The tint is off unless the operator asks for it AND the team has a colour
   * of its own. `teamColour` would hand back the fallback red for a team with
   * none, which on a head-to-head reads as a SIDE rather than as a brand - so
   * the raw value is what decides, not the resolved one.
   */
  const wanted = Boolean(state.tint && half.colour);
  els.tint.hidden = !wanted;
  // The raw value, not teamColour() - that resolves a blank to the fallback
  // red, and the whole point of the guard above is that a team with no colour
  // must not be tinted at all.
  if (wanted) els.tint.style.setProperty('--team', half.colour);
}

function render(state) {
  if (!state) return;

  /*
   * The trim: the VS divider and the two rules either side of it.
   *
   * On the stage rather than the document, so nothing outside this graphic is
   * restyled. `--plate` is deliberately left alone - it is the fill behind a
   * team's name, and painting a surface with the trim colour would make the two
   * halves read as one block instead of two.
   */
  stage.style.setProperty('--vs', pick(state.accent, brand(), 'accent'));
  /*
   * The two size handles. On `#stage` beside the colour rather than on a
   * transform here, so the stylesheet decides WHAT each one multiplies - the
   * plate's height and the crest's box both follow the type, and neither of
   * those facts belongs in a renderer.
   *
   * Never a transform on `#stage` itself: `fitStage` owns that one and
   * rewrites it on every resize.
   */
  stage.style.setProperty('--text-scale', String(state.textScale ?? 1));
  stage.style.setProperty('--logo-scale', String(state.logoScale ?? 1));

  paintHalf('left', state.left ?? {}, state);
  paintHalf('right', state.right ?? {}, state);

  divider.textContent = state.divider || 'VS';
  heading.textContent = (state.heading || '').toUpperCase();
  heading.hidden = !state.heading;

  const logo = state.eventLogo || '';
  eventLogo.hidden = !logo;
  if (logo) setSrc(eventLogoImg, logo);

  root.classList.toggle('is-on', Boolean(state.anim?.visible));
}

/*
 * The cue: replay the entrance, and only on a transport press. Fixing a tricode
 * must not make both halves slide in again while they are on screen.
 */
let lastCue = null;

/*
 * The last matchup drawn, kept so a colour change can redraw it. The stream
 * only pushes when the MATCHUP moves, and a head-to-head sitting on air makes
 * no such push.
 */
let latestState = null;

function apply(state) {
  latestState = state;
  const cue = state?.anim?.cue ?? 0;
  if (lastCue !== null && cue !== lastCue && state?.anim?.visible) {
    root.classList.remove('is-on');
    void root.offsetWidth;
  }
  lastCue = cue;
  render(state);
}

function fitStage() {
  stage.style.transform = `scale(${Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H)})`;
}

window.addEventListener('resize', fitStage);
fitStage();

const stream = new EventSource(api('/api/headtohead/events', PAGE_BUS));

// The event's colours, on the connection this page already has.
const brand = watchBrand(stream, () => {
  if (latestState) apply(latestState);
});

stream.addEventListener('headToHead', (event) => {
  try {
    apply(JSON.parse(event.data).state);
  } catch (error) {
    console.warn(`ignored a malformed head-to-head update: ${error.message}`);
  }
});

stream.addEventListener('error', () => console.warn('head-to-head stream dropped - reconnecting'));
