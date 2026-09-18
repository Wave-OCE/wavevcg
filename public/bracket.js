/**
 * Bracket - output renderer.
 *
 * Point an OBS browser source at /bracket.html (1920x1080, transparent). State
 * arrives over SSE like every other output here.
 *
 * ## Arithmetic, never measurement
 *
 * The state carries columns and rows; this multiplies by the four constants
 * below and positions everything absolutely. That is the same rule the Schedule
 * sub-page follows and the reason is the same one written up there: anything
 * that measured itself would have to be on screen to do it, and this page is
 * routinely rendered by OBS while nothing is visible.
 *
 * It also means NOTHING REFLOWS when a result lands. A node is at a fixed left
 * and top from the moment the draw loads; revealing a round changes opacity and
 * a transform, and a score changing rewrites text inside a box that does not
 * move. That is the rule these pages exist to keep.
 *
 * ## The three rules every output page here follows
 *
 *   Never recreate an element that is already on screen - revealing round three
 *   must not restart round one's transition.
 *   Never write markup; everything goes in through textContent.
 *   Layout must not move when data changes.
 */

import { bracketChampion } from './bracket-graphic-schema.js';
import { api, PAGE_BUS } from './session.js';

const STAGE_W = 1920;
const STAGE_H = 1080;

/*
 * The only four numbers that turn abstract units into pixels.
 *
 * A node is two 36px slots and a 2px gap, so 74 high; ROW_H leaves 18px of air
 * between neighbours. COL_W is the node width plus the gap the elbows run
 * through.
 */
const NODE_W = 224;
const NODE_H = 74;
const COL_W = 300;
const ROW_H = 92;

const stage = document.getElementById('stage');
const board = document.getElementById('board');
const draw = document.getElementById('draw');
const links = document.getElementById('links');
const nodes = document.getElementById('nodes');
const stageName = document.getElementById('stage-name');
const eyebrow = document.getElementById('eyebrow');
const eventLogo = document.getElementById('event-logo');
const eventLogoImg = document.getElementById('event-logo-img');
const winner = document.getElementById('winner');
const winnerTop = document.getElementById('winner-top');
const winnerBottom = document.getElementById('winner-bottom');
const winnerHeading = document.getElementById('winner-heading');
const winnerLabel = document.getElementById('winner-label');
const winnerImage = document.getElementById('winner-image');

/*
 * An image that fails to load must be INVISIBLE, not a broken-image marker. A
 * crest URL that 404s otherwise paints Chrome's broken icon on a live
 * broadcast, and nothing about the state says anything is wrong - because
 * nothing is: the string is a good URL that happens not to answer.
 */
function guard(node_) {
  node_.addEventListener('error', () => {
    node_.hidden = true;
  });
  node_.addEventListener('load', () => {
    node_.hidden = false;
  });
  return node_;
}
guard(winnerImage);
guard(eventLogoImg);

const svgEl = (tag) => document.createElementNS('http://www.w3.org/2000/svg', tag);

function el(tag, className, attrs = {}) {
  const node_ = document.createElement(tag);
  if (className) node_.className = className;
  for (const [key, value] of Object.entries(attrs)) node_.setAttribute(key, value);
  if (tag === 'img') guard(node_);
  return node_;
}

const atX = (column) => column * COL_W;
const atY = (row) => row * ROW_H;

/** One match: two slots, each a crest, a name and a score. */
function makeNode() {
  const node_ = el('div', 'node');
  for (const side of ['left', 'right']) {
    const slot = el('div', `slot is-${side}`);
    slot.append(el('img', 'slot-logo', { alt: '' }), el('span', 'slot-name'), el('span', 'slot-score'));
    node_.append(slot);
  }
  return node_;
}

function paintNode(node_, data, state) {
  node_.style.left = `${atX(data.column)}px`;
  node_.style.top = `${atY(data.row)}px`;

  ['left', 'right'].forEach((side, index) => {
    const slot = node_.children[index];
    const seat = data[side] ?? {};
    const logo = slot.querySelector('.slot-logo');
    if (seat.logo) {
      if (logo.getAttribute('src') !== seat.logo) logo.setAttribute('src', seat.logo);
    } else {
      logo.hidden = true;
      logo.removeAttribute('src');
    }
    // The tricode, then the full name - a 224px slot is not where a long org
    // name belongs, and a bracket is read from across a room.
    slot.querySelector('.slot-name').textContent = (seat.shortName || seat.name || '').toUpperCase();
    const score = slot.querySelector('.slot-score');
    score.textContent = String(seat.score ?? 0);
    score.hidden = !state.showScores;
    slot.classList.toggle('is-won', data.winner === side);
  });

  // Reveal is by COLUMN: a round at a time is how a caster walks a bracket out.
  node_.classList.toggle('is-shown', data.column < state.reveal);
}

/**
 * The elbows.
 *
 * `M x1 y1 H mid V y2 H x2` - out of the source, across to the midpoint, down
 * or up, then into the target. The same shape the Schedule page draws, for the
 * same reason: a straight line between two matches crosses everything between
 * them, and a curve reads as decorative on a sheet that is meant to be read.
 */
function paintLinks(state) {
  const wanted = state.links ?? [];
  /*
   * TWO paths per link: the elbow, and the highlight that travels along it.
   *
   * One path cannot be both. `stroke-dasharray` on the line itself does not add
   * a moving highlight, it replaces the line with a repeating gap - the first
   * version did exactly that and the bracket had no connectors at all, just a
   * short dash drifting where each one should have been.
   */
  const need = wanted.length * 2;
  while (links.children.length < need) links.append(svgEl('path'));
  while (links.children.length > need) links.lastElementChild.remove();

  wanted.forEach((link, index) => {
    const line = links.children[index * 2];
    const flow = links.children[index * 2 + 1];
    const x1 = atX(link.fromColumn) + NODE_W;
    const y1 = atY(link.fromRow) + NODE_H / 2;
    const x2 = atX(link.toColumn);
    const y2 = atY(link.toRow) + NODE_H / 2;
    const mid = x1 + (x2 - x1) / 2;
    const d = `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`;

    line.setAttribute('d', d);
    line.setAttribute('class', `link${link.take === 'loser' ? ' is-loser' : ''}${link.live ? ' is-live' : ''}`);
    flow.setAttribute('d', d);
    flow.setAttribute('class', `flow${link.live ? ' is-live' : ''}`);

    /*
     * A link belongs to the round it ARRIVES at, so it appears with the match
     * it feeds rather than hanging off the previous round pointing at nothing.
     */
    const on = link.toColumn < state.reveal;
    line.style.opacity = on ? '' : '0';
    flow.style.opacity = on ? '' : '0';
  });

  const width = (state.columns || 0) * COL_W;
  const height = (state.rows || 0) * ROW_H;
  links.setAttribute('width', String(width));
  links.setAttribute('height', String(height));
  links.setAttribute('viewBox', `0 0 ${width} ${height}`);
}

/*
 * Centre the drawing in the space it actually has.
 *
 * ARITHMETIC, not measurement - the draw's size is `columns` and `rows` times
 * the constants above, and the space is the frame minus the winner panel when
 * that is showing. Asking the DOM would mean measuring a page OBS renders while
 * nothing is on screen, which is the trap this whole family of pages avoids.
 *
 * Without it a three-round bracket sits in the top-left corner of a 1920x1080
 * frame with half the width empty beside it, which reads as a graphic that
 * failed to finish loading rather than as a design.
 */
function placeDraw(state) {
  const drawW = Math.max(0, (state.columns || 0) * COL_W - (COL_W - NODE_W));
  const drawH = Math.max(0, (state.rows || 0) * ROW_H - (ROW_H - NODE_H));

  // Left edge, top band, bottom band, and what the winner panel takes.
  const LEFT = 72;
  const TOP = 168;
  const BOTTOM = 120;
  /*
   * The panel's width comes from the STYLESHEET, via the custom property it
   * declares. One number in one place: hard-coding it here is how the draw
   * comes to be centred against a panel that is no longer that wide, and the
   * only symptom is a bracket sitting slightly off to one side.
   */
  const panelW = Number.parseFloat(getComputedStyle(winner).getPropertyValue('--panel-w')) || 320;
  const PANEL = state.winner?.show ? panelW + 72 + 48 : 72;

  const availW = STAGE_W - LEFT - PANEL;
  const availH = STAGE_H - TOP - BOTTOM;

  draw.style.left = `${Math.round(LEFT + Math.max(0, (availW - drawW) / 2))}px`;
  draw.style.top = `${Math.round(TOP + Math.max(0, (availH - drawH) / 2))}px`;
}

function paintWinner(state) {
  const panel = state.winner ?? {};
  winner.classList.toggle('is-shown', Boolean(panel.show));
  winnerTop.textContent = (panel.footer || '').toUpperCase();
  winnerBottom.textContent = (panel.footer || '').toUpperCase();
  winnerHeading.textContent = (panel.heading || '').toUpperCase();

  /*
   * The label and the image fall back to whoever actually won the last match,
   * so a show that types nothing still gets the right team - and anything the
   * operator DID type wins, because a grand final sometimes wants "CHAMPIONS"
   * rather than a tricode.
   */
  const champion = bracketChampion(state);
  winnerLabel.textContent = (panel.label || champion?.shortName || champion?.name || '').toUpperCase();

  const art = panel.image || champion?.logo || '';
  // The slot collapses when there is nothing in it, so the heading and the
  // label sit together rather than either side of a gap.
  document.getElementById('winner-art').hidden = !art;
  if (art) {
    if (winnerImage.getAttribute('src') !== art) winnerImage.setAttribute('src', art);
  } else {
    winnerImage.hidden = true;
    winnerImage.removeAttribute('src');
  }
}

function render(state) {
  if (!state) return;

  /*
   * The two colours the operator owns, as custom properties on the board.
   *
   * Set rather than removed when blank: `setProperty(name, '')` clears the
   * declaration, so the stylesheet's own value comes back and "unset" is a real
   * state rather than a black graphic. That is why the schema keeps blank as
   * blank instead of defaulting it to a hex.
   */
  board.style.setProperty('--accent', state.accent || '');
  board.style.setProperty('--slot-won', state.accent || '');
  board.style.setProperty('--flow', state.accent || '');
  board.style.setProperty('--trim', state.trim || '');

  stageName.textContent = (state.stageName || '').toUpperCase();
  eyebrow.textContent = (state.heading || '').toUpperCase();
  eyebrow.hidden = !state.heading;

  const logo = state.eventLogo || '';
  eventLogo.hidden = !logo;
  if (logo && eventLogoImg.getAttribute('src') !== logo) eventLogoImg.setAttribute('src', logo);

  const wanted = state.nodes ?? [];
  while (nodes.children.length < wanted.length) nodes.append(makeNode());
  while (nodes.children.length > wanted.length) nodes.lastElementChild.remove();
  wanted.forEach((data, index) => paintNode(nodes.children[index], data, state));

  paintLinks(state);
  placeDraw(state);
  paintWinner(state);

  board.classList.toggle('is-flowing', state.flow !== false);
  board.classList.toggle('is-on', Boolean(state.anim?.visible));
}

/*
 * The cue: replay the entrance, and only on a transport press. Revealing a
 * round, or a score landing behind the scenes, must not fly the whole sheet on
 * again - which is the failure the counter was invented to prevent.
 */
let lastCue = null;

function apply(state) {
  const cue = state?.anim?.cue ?? 0;
  if (lastCue !== null && cue !== lastCue && state?.anim?.visible) {
    board.classList.remove('is-on');
    void board.offsetWidth;
  }
  lastCue = cue;
  render(state);
}

function fitStage() {
  stage.style.transform = `scale(${Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H)})`;
}

window.addEventListener('resize', fitStage);
fitStage();

const stream = new EventSource(api('/api/bracket/events', PAGE_BUS));

stream.addEventListener('bracket', (event) => {
  try {
    apply(JSON.parse(event.data).state);
  } catch (error) {
    console.warn(`ignored a malformed bracket update: ${error.message}`);
  }
});

stream.addEventListener('error', () => console.warn('bracket stream dropped - reconnecting'));
