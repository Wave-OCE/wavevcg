/**
 * The Map veto sub-page: the pool, the vetoes, and the links.
 *
 * On the Tournament page rather than under Graphics, and beside the schedule
 * rather than on Match setup, because that is what a veto IS - a thing the
 * competition does, days before anybody opens OBS. The graphic that shows one
 * is a separate object with its own tab; this is where the veto happens.
 *
 * ## The links are treated as credentials, on screen as well as on the wire
 *
 * They are shown one at a time behind a Copy button rather than printed in
 * full, and that is not decoration. This panel is open on a laptop at a desk
 * that is very often being screen-shared or filmed, and a link in plain text is
 * one frame away from being everybody's. Copy puts it on the clipboard without
 * ever painting it.
 *
 * ## The caret rule, by separation
 *
 * The page has one text input - the veto's name, in the modal. Everything on
 * the panel itself is buttons, checkboxes and derived text, so it repaints
 * freely whenever the document moves.
 */

import { el, field, help, subhead, title } from './fields.js';
import { api } from './session.js';
import { modalFoot, modalOpen, modalTitle, openModal } from './modal.js';
import {
  SIDE_RULES,
  VETO_FORMATS,
  currentStep,
  playedMaps,
  turnOf,
  vetoComplete,
} from './veto-schema.js';

const $ = (id) => document.getElementById(id);
const toast = (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: message }));

const wrap = (className, children) => {
  const node = el('div', className);
  node.append(...children.filter(Boolean));
  return node;
};

let doc = { pool: [], vetoes: [] };
let tokens = null;
let catalogue = [];
let fixtures = [];
let host = null;

// -------------------------------------------------------------------- data ---

async function send(body) {
  const response = await fetch(api('/api/veto'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    const { message, hint } = payload?.error ?? {};
    throw new Error([message ?? `HTTP ${response.status}`, hint].filter(Boolean).join(' '));
  }
  if (payload.veto) doc = payload.veto;
  return payload;
}

async function load() {
  const [vetoData, assets, scheduleData] = await Promise.all([
    fetch(api('/api/veto'))
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    fetch('/api/valorant-assets')
      .then((r) => (r.ok ? r.json() : { maps: [] }))
      .catch(() => ({ maps: [] })),
    fetch(api('/api/schedule'))
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);

  doc = vetoData?.veto ?? { pool: [], vetoes: [] };
  // null when the reader is a viewer - they see the board and get no links.
  tokens = vetoData?.tokens ?? null;
  catalogue = (assets?.maps ?? []).map((map) => map.name).filter(Boolean);
  fixtures = scheduleData?.schedule?.fixtures ?? [];
}

/**
 * Do it, then re-read.
 *
 * The re-read is not belt and braces: the LINKS come from the GET and a write
 * response carries only the document, so a veto created through here would sit
 * with no Copy buttons until something else refreshed the panel - which looks
 * exactly like the links having failed to mint. One extra request on a press
 * nobody makes twice a minute.
 */
const act = (body, after) =>
  send(body)
    .then(async (payload) => {
      after?.(payload);
      await load();
      paint();
    })
    .catch((error) => toast(error.message));

// ------------------------------------------------------------------- paint ---

/**
 * The pool, as a tick list.
 *
 * Seeded from the live catalogue rather than a written table, for the reason
 * `maps.js` states: a written list cannot be absent but goes stale, and the
 * competitive pool changes every act. A map already in the pool that the
 * catalogue no longer knows is still shown, so a rotation does not silently
 * drop it from a tournament halfway through.
 */
function poolEditor(mayEdit) {
  const known = [...new Set([...catalogue, ...doc.pool])].sort();
  const grid = el('div', 'veto-pool');

  for (const map of known) {
    const label = el('label', 'veto-pool-map');
    const box = el('input', null, { type: 'checkbox' });
    box.checked = doc.pool.includes(map);
    box.disabled = !mayEdit;
    /*
     * No repaint. The checkbox is already showing the new state - it is what
     * the operator just clicked - so rebuilding the panel underneath would
     * replace the very control under the pointer, which on a seven-map pool is
     * seven chances to tick the wrong box. Only the cards below depend on the
     * pool, and they only change when a veto is MADE.
     */
    box.addEventListener('change', () => {
      const next = box.checked ? [...doc.pool, map] : doc.pool.filter((entry) => entry !== map);
      send({ action: 'pool.save', pool: next }).catch((error) => {
        box.checked = !box.checked;
        toast(error.message);
      });
    });
    label.append(box, el('span', null, {}, map));
    grid.append(label);
  }

  return grid;
}

/** What a veto is doing right now, in one line. */
function statusLine(veto) {
  if (vetoComplete(veto)) {
    return `Finished - ${playedMaps(veto).map((entry) => entry.name).join(', ')}`;
  }
  const step = currentStep(veto);
  const turn = turnOf(veto);
  const who = turn === 'a' ? veto.a.name || 'Team A' : turn === 'b' ? veto.b.name || 'Team B' : 'the referee';
  const verb = step.kind === 'ban' ? 'to ban' : step.kind === 'pick' ? 'to pick' : 'to confirm the decider';
  const done = veto.steps.filter((entry) => entry.map).length;
  return `Step ${done + 1} of ${veto.steps.length} - ${who} ${verb}`;
}

/**
 * The three links.
 *
 * Copy rather than display, and the URL is composed here from the page's own
 * origin - the server hands over the token alone, deliberately, so that the
 * address an operator sends to a captain can never be influenced by a Host
 * header somebody else supplied.
 */
function linkRow(veto) {
  if (!tokens?.[veto.id]) return null;
  const row = el('div', 'veto-links');

  const labels = { a: veto.a.shortName || veto.a.name || 'Team A', b: veto.b.shortName || veto.b.name || 'Team B', referee: 'Referee' };

  for (const role of ['a', 'b', 'referee']) {
    const url = `${location.origin}/veto.html?session=${encodeURIComponent(new URLSearchParams(location.search).get('session') ?? '')}&k=${encodeURIComponent(tokens[veto.id][role] ?? '')}`;
    const button = el('button', 'mini-btn', { type: 'button', title: 'Copy this link. It is never shown on screen.' }, `Copy ${labels[role]} link`);
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        toast(`${labels[role]} link copied - it lets them ban without an account.`);
      } catch {
        // Clipboard access can be refused, and a link nobody can copy is worse
        // than one shown once on purpose.
        window.prompt('Copy this link:', url);
      }
    });
    row.append(button);
  }

  const rotate = el('button', 'mini-btn', { type: 'button', title: 'Mint new links. The old ones stop working immediately.' }, 'New links');
  rotate.addEventListener('click', () => {
    if (!window.confirm('Make new links for this veto?\n\nThe ones you have already sent stop working.')) return;
    act({ action: 'rotate', id: veto.id }, () => toast('New links minted - the old ones are dead.'));
  });
  row.append(rotate);

  return row;
}

/** The board, read-only: this panel watches a veto, it does not play one. */
function board(veto) {
  const list = el('div', 'veto-board');
  veto.steps.forEach((step) => {
    const row = el('div', `veto-board-step${step.kind === 'ban' ? ' is-ban' : ''}${step.map ? ' is-done' : ''}`);
    const who = step.kind === 'decider' ? 'Decider' : `${(step.who === 'a' ? veto.a : veto.b).shortName || (step.who === 'a' ? 'A' : 'B')} ${step.kind}s`;
    row.append(el('span', 'veto-board-kind', {}, who));
    row.append(el('span', 'veto-board-map', {}, step.map || '—'));
    if (step.side) {
      const sideTeam = (step.sideBy === 'a' ? veto.a : veto.b).shortName || step.sideBy.toUpperCase();
      row.append(el('span', 'veto-board-side', {}, `${sideTeam} ${step.side}`));
    }
    list.append(row);
  });
  return list;
}

function vetoCard(veto, mayEdit) {
  const card = el('div', 'veto-card');

  const head = el('div', 'veto-card-head');
  head.append(
    el('div', 'veto-card-name', {}, veto.name || `${veto.a.name || 'Team A'} vs ${veto.b.name || 'Team B'}`),
    el('div', 'veto-card-meta', {}, `${veto.format.toUpperCase()}${veto.fixtureId ? ' - from the schedule' : ''}`),
  );
  card.append(head);
  card.append(el('div', 'veto-card-status', {}, statusLine(veto)));
  card.append(board(veto));

  if (!mayEdit) return card;

  card.append(linkRow(veto));

  const tools = el('div', 'veto-card-tools');

  /*
   * Filing the maps onto the fixture, and it is a PRESS rather than something
   * that happens when the veto finishes. The schedule is the competition record
   * that every desk shares, and a veto can be driven by somebody holding a link
   * who has no account here at all - so a token must never write the draw.
   */
  if (veto.fixtureId && playedMaps(veto).length) {
    const fixture = fixtures.find((entry) => entry.id === veto.fixtureId);
    const file = el(
      'button',
      'mini-btn',
      { type: 'button', title: fixture ? 'Write these map names onto that fixture. Scores already filed are kept.' : 'That fixture is gone.' },
      `File ${playedMaps(veto).length} maps on the fixture`,
    );
    file.disabled = !fixture;
    file.addEventListener('click', () => act({ action: 'file', id: veto.id }, () => toast('Maps filed on the fixture.')));
    tools.append(file);
  }

  const edit = el('button', 'mini-btn', { type: 'button' }, 'Edit');
  edit.addEventListener('click', () => openVeto(veto));
  tools.append(edit);

  const reset = el('button', 'mini-btn', { type: 'button', title: 'Empty every step and start again. The links keep working.' }, 'Reset');
  reset.addEventListener('click', () => {
    if (!window.confirm(`Start "${veto.name || 'this veto'}" again?\n\nEvery ban and pick is cleared. The links you have sent keep working.`)) return;
    act({ action: 'reset', id: veto.id }, () => toast('Veto reset.'));
  });
  tools.append(reset);

  card.append(tools);
  return card;
}

/** Making or editing one, in a dialog. The only text input on this page. */
function openVeto(existing) {
  if (modalOpen()) return;

  let dialog = null;
  const body = el('div', 'rl-modal-body');
  const editing = Boolean(existing);

  const name = el('input', null, { type: 'text', maxlength: 80, 'aria-label': 'Veto name' });
  name.value = existing?.name ?? '';

  const format = el('select', null, { 'aria-label': 'Series length' });
  for (const entry of VETO_FORMATS) {
    format.append(el('option', null, { value: entry.key, selected: entry.key === (existing?.format ?? 'bo3') ? 'selected' : null }, entry.label));
  }

  const rule = el('select', null, { 'aria-label': 'Who chooses side' });
  for (const entry of SIDE_RULES) {
    rule.append(el('option', null, { value: entry.key, selected: entry.key === (existing?.sideRule ?? 'opponent') ? 'selected' : null }, entry.label));
  }

  const decider = el('select', null, { 'aria-label': 'Decider side' });
  decider.append(el('option', null, { value: 'a', selected: (existing?.deciderSideBy ?? 'a') === 'a' ? 'selected' : null }, 'Team A chooses'));
  decider.append(el('option', null, { value: 'b', selected: existing?.deciderSideBy === 'b' ? 'selected' : null }, 'Team B chooses'));

  /*
   * From a fixture, and only when making a new one.
   *
   * Changing an existing veto's fixture would leave its steps attached to a
   * match they were not played for, which is the one thing a veto record must
   * never be able to say.
   */
  const fromFixture = el('select', null, { 'aria-label': 'From a fixture' });
  if (!editing) {
    fromFixture.append(el('option', null, { value: '' }, '- standalone, type the teams below -'));
    for (const fixture of fixtures) {
      fromFixture.append(
        el(
          'option',
          null,
          { value: fixture.id },
          `${fixture.left?.name || 'TBD'} vs ${fixture.right?.name || 'TBD'}`,
        ),
      );
    }
  }

  const teamA = el('input', null, { type: 'text', maxlength: 32, 'aria-label': 'Team A name', placeholder: 'Team A' });
  const teamB = el('input', null, { type: 'text', maxlength: 32, 'aria-label': 'Team B name', placeholder: 'Team B' });
  teamA.value = existing?.a?.name ?? '';
  teamB.value = existing?.b?.name ?? '';

  const save = el('button', 'btn btn-primary', { type: 'button' }, editing ? 'Save' : 'Create veto');
  save.addEventListener('click', () => {
    const payload = {
      name: name.value.trim(),
      format: format.value,
      sideRule: rule.value,
      deciderSideBy: decider.value,
      a: { ...(existing?.a ?? {}), name: teamA.value.trim() },
      b: { ...(existing?.b ?? {}), name: teamB.value.trim() },
    };
    const body_ = editing
      ? { action: 'save', veto: { ...existing, ...payload } }
      : { action: 'create', fixtureId: fromFixture.value || '', veto: fromFixture.value ? { name: payload.name, sideRule: payload.sideRule, deciderSideBy: payload.deciderSideBy } : payload };
    act(body_, () => {
      dialog?.close();
      toast(editing ? 'Saved.' : 'Veto made - copy a link to each team.');
    });
  });

  const cancel = el('button', 'btn btn-ghost', { type: 'button' }, 'Cancel');
  cancel.addEventListener('click', () => dialog?.close());

  const drop = editing ? el('button', 'btn btn-ghost rl-modal-danger', { type: 'button' }, 'Remove veto') : null;
  drop?.addEventListener('click', () => {
    if (!window.confirm(`Remove "${existing.name || 'this veto'}"?`)) return;
    act({ action: 'remove', id: existing.id }, () => dialog?.close());
  });

  body.append(
    modalTitle(editing ? 'Edit veto' : 'New veto', editing ? existing.name : null),
    ...(editing ? [] : [field('From a fixture', fromFixture), help('Brings both teams and the series length across. Leave it standalone for a showmatch or a scrim.')]),
    field('Name', name),
    field('Series', format),
    field('Team A', teamA),
    field('Team B', teamB),
    subhead('Sides'),
    field('On a picked map', rule),
    field('On the decider', decider),
  );

  dialog = openModal({ body, foot: modalFoot({ danger: drop, cancel, confirm: save }) });
}

function paint() {
  if (!host) return;
  // Links are handed only to an editor, so their presence IS the permission -
  // one fact from the server rather than a second copy of the level check.
  const mayEdit = tokens !== null;

  const add = el('button', 'btn btn-primary', { type: 'button' }, 'New veto');
  add.addEventListener('click', () => openVeto(null));

  host.replaceChildren(
    title('Map veto'),
    help(
      'Run the bans and picks, and hand each team a link so they can do it themselves. The order is the standard ' +
        'one for the series length and is not editable - a Bo3 is ban, ban, pick, pick, ban, ban, and whatever is ' +
        'left is the decider. Nothing here goes on air by itself; the veto graphic is what shows it.',
    ),
    subhead('Map pool'),
    help('The maps in play this season. Every veto is created from this list and keeps its own copy, so a map rotating out does not rewrite a veto already played.'),
    poolEditor(mayEdit),
    subhead('Vetoes'),
    ...(doc.vetoes.length
      ? doc.vetoes.map((veto) => vetoCard(veto, mayEdit))
      : [el('p', 'empty', {}, doc.pool.length ? 'No vetoes yet.' : 'Tick the maps in play above, then make a veto.')]),
    ...(mayEdit ? [wrap('team-form-actions', [add])] : []),
  );
}

// ----------------------------------------------------------------- wiring ---

async function refresh() {
  host = $('veto-body');
  if (!host) return;
  await load();
  paint();
}

refresh();

window.addEventListener('tournament-changed', refresh);

/*
 * Refetched on open, because a veto moves without this page asking: two
 * captains are answering it on their phones. There is no stream for it - see
 * veto-public.js on why the public side polls rather than streaming - so
 * arriving at the panel is the moment to re-read.
 */
window.addEventListener('app-tab', (event) => {
  if (event.detail === 'tournament') refresh();
});
