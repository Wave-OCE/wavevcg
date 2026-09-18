/**
 * Team lineup - output renderer.
 *
 * Point an OBS browser source at /lineup.html (1920x1080, transparent) and
 * leave it. State arrives over SSE like every other output here.
 *
 * The rules these pages live by, applied again:
 *
 *   NEVER RECREATE an element that is already on screen. Seats are built for
 *   the count they need and afterwards only their text, classes and image URLs
 *   change, so a name correction does not restart five entrance transitions.
 *
 *   NEVER WRITE MARKUP. Everything goes in through textContent.
 *
 *   LAYOUT MUST NOT MOVE when data changes. A seat is a fixed width and the row
 *   is centred, so five portraits are the same size as three - a lineup that
 *   resized itself as a squad filled in would be exactly the failure this rule
 *   exists to prevent.
 */

import { LINEUP_FORMAT_KEYS, seatPhoto } from './lineup-schema.js';
import { api, PAGE_BUS } from './session.js';

const STAGE_W = 1920;
const STAGE_H = 1080;

const stage = document.getElementById('stage');
const lineup = document.getElementById('lineup');
const row = document.getElementById('row');
const names = document.getElementById('names');
const crest = document.getElementById('crest');
const crestImg = document.getElementById('crest-img');
const teamName = document.getElementById('team-name');
const eyebrow = document.getElementById('eyebrow');
const eventLogo = document.getElementById('event-logo');
const eventLogoImg = document.getElementById('event-logo-img');

for (const img of document.querySelectorAll('img')) guard(img);

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


/**
 * One seat with a portrait.
 *
 * The image AND the stand-in both exist from the start and are only ever
 * hidden. The first version set `photo.textContent` to the tricode when there
 * was no portrait, which tears the <img> out of the DOM - so the next update
 * that did have one had to put it back, and every seat that went from no photo
 * to a photo rebuilt itself mid-shot. Two elements and a `hidden` each.
 */
function photoSeat() {
  const seat = el('div', 'seat');
  const photo = el('div', 'seat-photo');
  photo.append(el('img', null, { alt: '' }), el('span', 'seat-stand'));
  const plate = el('div', 'seat-plate');
  plate.append(el('div', 'seat-name'), el('div', 'seat-riot'));
  seat.append(photo, plate);
  return seat;
}

function nameSeat() {
  const seat = el('div', 'seat');
  seat.append(el('div', 'seat-name'), el('div', 'seat-riot'));
  return seat;
}

/**
 * Keep a container's child count in step without rebuilding what is there.
 *
 * The while loops rather than replaceChildren: replacing would restart every
 * transition, so a sixth player arriving would flash the five already up.
 */
function fit(host, count, make) {
  while (host.children.length < count) host.append(make());
  while (host.children.length > count) host.lastElementChild.remove();
}

/*
 * Cards arrive from the OUTSIDE IN, which is the house motion. The delay is set
 * per seat from the count rather than written as five CSS rules, so a three-man
 * lineup is still symmetrical.
 */
function stagger(host) {
  const seats = [...host.children];
  const middle = (seats.length - 1) / 2;
  seats.forEach((seat, index) => {
    const fromEdge = middle - Math.abs(index - middle);
    seat.style.transitionDelay = `${Math.round(fromEdge * 70)}ms`;
  });
}

function render(state) {
  if (!state) return;

  const format = LINEUP_FORMAT_KEYS.includes(state.format) ? state.format : 'photos';
  const withPhotos = format !== 'names';
  const withRiot = format === 'detailed';

  teamName.textContent = (state.teamName || '').toUpperCase();
  eyebrow.textContent = (state.heading || '').toUpperCase();
  eyebrow.hidden = !state.heading;

  const logo = state.eventLogo || '';
  eventLogo.hidden = !logo;
  if (logo && eventLogoImg.getAttribute('src') !== logo) eventLogoImg.setAttribute('src', logo);

  row.hidden = !withPhotos;
  names.hidden = withPhotos;
  crest.hidden = withPhotos || !state.logo;
  if (state.logo && crestImg.getAttribute('src') !== state.logo) crestImg.setAttribute('src', state.logo);

  const players = state.players ?? [];

  if (withPhotos) {
    fit(row, players.length, photoSeat);
    players.forEach((player, index) => {
      const seat = row.children[index];
      const photo = seat.querySelector('.seat-photo');
      const img = photo.querySelector('img');
      const stand = photo.querySelector('.seat-stand');
      const src = seatPhoto(player, state.defaultPhoto);

      photo.classList.toggle('is-empty', !src);
      // Hidden here only when there is nothing to show at all; `guard` owns the
      // other direction, so an image that 404s stays hidden instead of painting
      // a broken marker over a portrait slot.
      if (!src) img.hidden = true;
      if (src && img.getAttribute('src') !== src) img.setAttribute('src', src);
      // The tricode stands in when there is neither a photo of their own nor a
      // team default, so the seat still says who it is rather than being a grey
      // rectangle.
      stand.hidden = Boolean(src);
      stand.textContent = (state.shortName || '').toUpperCase();

      seat.querySelector('.seat-name').textContent = (player.name || '').toUpperCase();
      const riot = seat.querySelector('.seat-riot');
      riot.textContent = withRiot ? player.riotId || '' : '';
      riot.hidden = !withRiot || !player.riotId;
    });
    stagger(row);
  } else {
    fit(names, players.length, nameSeat);
    players.forEach((player, index) => {
      const seat = names.children[index];
      seat.querySelector('.seat-name').textContent = (player.name || '').toUpperCase();
      seat.querySelector('.seat-riot').textContent = player.riotId || '';
    });
    stagger(names);
  }

  lineup.classList.toggle('is-on', Boolean(state.anim?.visible));
}

/*
 * The cue: replay the entrance.
 *
 * Moved only by a transport press, so an operator fixing a name does not make
 * five portraits fly on again mid-shot. The class is dropped and re-added
 * around a forced reflow, which is what makes it two state changes in one frame
 * rather than none.
 */
let lastCue = null;

function apply(state) {
  const cue = state?.anim?.cue ?? 0;
  if (lastCue !== null && cue !== lastCue && state?.anim?.visible) {
    lineup.classList.remove('is-on');
    void lineup.offsetWidth;
  }
  lastCue = cue;
  render(state);
}

function fitStage() {
  stage.style.transform = `scale(${Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H)})`;
}

window.addEventListener('resize', fitStage);
fitStage();

const stream = new EventSource(api('/api/lineup/events', PAGE_BUS));

stream.addEventListener('lineup', (event) => {
  try {
    apply(JSON.parse(event.data).state);
  } catch (error) {
    console.warn(`ignored a malformed lineup update: ${error.message}`);
  }
});

stream.addEventListener('error', () => console.warn('lineup stream dropped - reconnecting'));
