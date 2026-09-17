/**
 * The map veto, for a team captain or a referee holding a link.
 *
 * The only page in this program served to somebody with no account, other than
 * the login itself - and unlike the login it is not a door to anything. The
 * token in the URL opens one veto and one seat in it; there is nothing else to
 * reach from here, which is what makes handing the link to a visiting team a
 * reasonable thing to do.
 *
 * ## It asks the server what it may do
 *
 * `yours` and `turn` come back from `publicView`, and the buttons follow them
 * rather than working it out locally. That is not laziness about duplicating a
 * rule - it is that two captains have this page open at the same moment, and
 * whose turn it is changes underneath them without anything they did. A page
 * deciding for itself would let the impatient one ban on the other's step and
 * find out from a 409.
 *
 * The server refuses that anyway (`answer` in veto.js checks the turn, and the
 * map still being available, against the document as it now stands). This is
 * the courtesy on top; the fence is there.
 *
 * ## Polling, not a stream
 *
 * Two seconds. `/api/events` is behind the account gate and adding an SSE
 * channel outside it would be a second unauthenticated long-lived connection to
 * reason about, for a page that is open for four minutes and changes seven
 * times. The cost of being wrong about polling is a captain waiting two seconds;
 * the cost of being wrong about an unauthenticated stream is not.
 */

import { sideChooser } from './veto-schema.js';

const page = document.getElementById('veto-page');
const params = new URLSearchParams(location.search);
const SESSION = params.get('session') ?? '';
const TOKEN = params.get('k') ?? '';

const POLL_MS = 2000;

let veto = null;
let busy = false;

const el = (tag, className, attrs = {}, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs)) if (value !== null) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
};

const api = (suffix = '') =>
  `/api/veto/public?session=${encodeURIComponent(SESSION)}&k=${encodeURIComponent(TOKEN)}${suffix}`;

async function read() {
  const response = await fetch(api());
  if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.error?.message ?? 'That link is not valid.');
  return (await response.json()).veto;
}

async function send(body) {
  busy = true;
  paint();
  try {
    const response = await fetch(api(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message ?? 'That did not go through.');
    veto = payload.veto;
  } catch (error) {
    // Shown in place rather than as a toast: this page has no toast host, and
    // a captain who has just pressed a map needs the reason where they are
    // looking. The most common one by far is "somebody else took that map".
    note = error.message;
  } finally {
    busy = false;
    paint();
  }
}

let note = '';

const seatName = (which) => {
  if (!veto) return '';
  const team = which === 'a' ? veto.a : veto.b;
  return team?.name || (which === 'a' ? 'Team A' : 'Team B');
};

/** What the banner says, which is the only thing most visits are here to read. */
function turnLine() {
  if (veto.complete) return { text: 'The veto is finished.', yours: false };

  const step = veto.step;
  const verb = step.kind === 'ban' ? 'ban a map' : step.kind === 'pick' ? 'pick a map' : 'confirm the decider';

  if (step.kind === 'decider') {
    return veto.you === 'referee'
      ? { text: `Only one map is left - confirm it.`, yours: true }
      : { text: 'One map is left. The referee confirms it.', yours: false };
  }
  if (veto.you === 'referee') {
    return { text: `${seatName(veto.turn)} to ${verb}. You can enter it for them.`, yours: true };
  }
  return veto.turn === veto.you
    ? { text: `Your turn - ${verb}.`, yours: true }
    : { text: `Waiting for ${seatName(veto.turn)} to ${verb}.`, yours: false };
}

/**
 * A map that is picked but has no side yet, and is YOURS to answer.
 *
 * Its own question because it is a different one, asked of a different team at
 * a different moment: the ordinary rule gives the side to whoever did NOT pick
 * the map, so it cannot ride along with the pick.
 */
function pendingSide() {
  if (!veto) return null;
  for (let at = 0; at < veto.steps.length; at += 1) {
    const step = veto.steps[at];
    if (step.kind === 'ban' || !step.map || step.side) continue;
    const chooser = sideChooser(step, veto);
    if (veto.you === 'referee' || chooser === veto.you) return { at, step, chooser };
  }
  return null;
}

function paint() {
  if (!veto) return;

  const { text, yours } = turnLine();
  const children = [];

  const head = el('div', 'veto-head');
  head.append(
    el('div', 'veto-teams', {}, `${seatName('a')}  vs  ${seatName('b')}`),
    el('div', 'field-help', {}, veto.format.toUpperCase()),
  );
  children.push(head);
  if (veto.name) children.push(el('p', 'field-help', {}, veto.name));

  children.push(el('div', `veto-turn${yours && !busy ? ' is-yours' : ''}`, {}, busy ? 'Sending…' : text));

  // --- the choice, when there is one to make ---
  const side = pendingSide();
  if (side) {
    children.push(
      el('div', 'subhead', {}, `Which side on ${side.step.map}?`),
      (() => {
        const row = el('div', 'veto-sides');
        for (const choice of ['attack', 'defence']) {
          const button = el('button', 'btn', { type: 'button' }, choice === 'attack' ? 'Attack' : 'Defence');
          button.disabled = busy;
          button.addEventListener('click', () => send({ action: 'side', at: side.at, side: choice }));
          row.append(button);
        }
        return row;
      })(),
    );
  } else if (!veto.complete && (veto.you === 'referee' || veto.turn === veto.you || veto.step?.kind === 'decider')) {
    const step = veto.step;
    const mine = veto.you === 'referee' || veto.turn === veto.you;

    if (step.kind === 'decider') {
      if (veto.you === 'referee') {
        const button = el('button', 'btn btn-primary', { type: 'button' }, `Confirm ${veto.remaining[0] ?? 'the last map'}`);
        button.disabled = busy;
        button.addEventListener('click', () => send({ action: 'answer' }));
        children.push(button);
      }
    } else if (mine) {
      const grid = el('div', 'veto-maps');
      for (const map of veto.remaining) {
        const button = el('button', 'veto-map', { type: 'button' }, map);
        button.disabled = busy;
        button.addEventListener('click', () => {
          const verb = step.kind === 'ban' ? 'Ban' : 'Pick';
          // A confirm, because this is irreversible from here - only the
          // referee can reset a veto - and a phone in a pocket presses things.
          if (!window.confirm(`${verb} ${map}?`)) return;
          send({ action: 'answer', map });
        });
        grid.append(button);
      }
      children.push(grid);
    }
  }

  if (note) children.push(el('p', 'veto-note', {}, note));

  // --- what has happened so far ---
  children.push(el('div', 'subhead', {}, 'So far'));
  const steps = el('div', 'veto-steps');
  veto.steps.forEach((step, at) => {
    const row = el(
      'div',
      `veto-step${step.kind === 'ban' ? ' is-ban' : ''}${veto.step?.at === at ? ' is-now' : ''}`,
    );
    const who = step.kind === 'decider' ? 'Decider' : `${seatName(step.who)} ${step.kind}s`;
    row.append(el('span', 'veto-step-kind', {}, who));
    row.append(el('span', 'veto-step-map', {}, step.map || '—'));
    if (step.side) row.append(el('span', 'veto-step-side', {}, `${seatName(step.sideBy)} on ${step.side}`));
    steps.append(row);
  });
  children.push(steps);

  children.push(
    el(
      'p',
      'veto-note',
      {},
      veto.you === 'referee'
        ? 'You are the referee: you can enter a ban or a pick for either team, which is what this link is for when somebody cannot open theirs.'
        : 'Keep this link to yourself - anybody who has it can ban for your team.',
    ),
  );

  page.replaceChildren(...children);
}

async function tick() {
  if (busy) return;
  try {
    const next = await read();
    // Compared before repainting, because this runs every two seconds and
    // replacing the page under a thumb that is reaching for a map is how
    // somebody bans the wrong one.
    if (JSON.stringify(next) === JSON.stringify(veto)) return;
    veto = next;
    note = '';
    paint();
  } catch {
    /* A blip between polls is not worth shouting about; the next one retries. */
  }
}

(async () => {
  if (!SESSION || !TOKEN) {
    page.replaceChildren(el('p', 'field-help', {}, 'That link is incomplete. Ask whoever sent it for the whole address.'));
    return;
  }
  try {
    veto = await read();
    paint();
    setInterval(tick, POLL_MS);
  } catch (error) {
    page.replaceChildren(el('p', 'field-help', {}, error.message));
  }
})();
