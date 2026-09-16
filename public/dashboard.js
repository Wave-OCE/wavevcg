/**
 * Graphics dashboard - edits the broadcast scoreboard.
 *
 * The editors write into a local copy of the graphic state and POST it to the
 * server (debounced). The server pushes it back out over SSE, which is what
 * both the preview iframe and any OBS browser source are listening to - so the
 * preview is not a re-implementation of the graphic, it *is* the graphic.
 *
 * Slot 1 of each roster is the MVP panel. Choosing an MVP moves that player to
 * slot 1 rather than setting a flag, so the state can never say one thing and
 * the layout show another.
 */

import { onLookupMatch } from './store.js';
import { onState } from './live.js';
import { aliasForPlayer } from './select-schema.js';
import { applyTeam } from './teams.js';
import { STATS, STAT_FIELDS, STAT_SLOTS, resultText, statDef } from './stats.js';
import { ANIM_FIELDS, ANIM_GROUPS, ANIM_TIER_COUNT, inDurationMs } from './animation.js';
import { el, field, grid, help, makeFields, subhead, title } from './fields.js';
import { api, outputUrl, pageUrl, targetKey } from './session.js';
import { makeTakeBar } from './take-bar.js';

/*
 * Which bus this dashboard edits.
 *
 * Preview. Everything typed, imported, swapped or cued here stages, and reaches
 * an audience only when Send to program is pressed - see take-bar.js. The one
 * exception is not here but in the server: the game client's roster and scene
 * feeds write both buses, because an operator taking once per lock-in is not a
 * workflow anybody wants.
 */
const EDIT_BUS = 'preview';
import {
  FONT_CHOICES,
  PRESET_FIELDS,
  PRESET_GROUPS,
  PRESET_KEYS,
  decodePreset,
  encodePreset,
} from './preset-schema.js';

const SIDES = ['left', 'right'];
const SLOTS = 5;
// Slots 1 and 2 also appear on the roster rows; slot 3 is MVP-panel only.
const ROW_STAT_SLOTS = 2;
const SAVE_DEBOUNCE_MS = 180;

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------- elements ---

const els = {
  tabs: [...document.querySelectorAll('.tab')],
  panels: {
    lookup: $('tab-lookup'),
    setup: $('tab-setup'),
    graphic: $('tab-graphic'),
    winner: $('tab-winner'),
    select: $('tab-select'),
    // No preview and no stream of its own - see index.html.
    global: $('tab-global'),
    account: $('tab-account'),
    admin: $('tab-admin'),
  },
  importBtn: $('g-import'),
  importHint: $('g-import-hint'),
  swapBtn: $('g-swap'),
  namesBtn: $('g-names'),
  sortBtn: $('g-sort'),
  resetBtn: $('g-reset'),
  status: $('g-status'),
  obsUrl: $('g-obs-url'),
  openLink: $('g-open'),
  checker: $('g-checker'),
  frame: $('preview-frame'),
  preview: $('preview'),
  showBtn: $('g-show'),
  hideBtn: $('g-hide'),
  replayBtn: $('g-replay'),
  air: $('g-air'),
  airLabel: $('g-air-label'),
  cueHint: $('g-cue-hint'),
  editors: {
    match: $('ed-match'),
    left: $('ed-left'),
    right: $('ed-right'),
    anim: $('ed-anim'),
    style: $('ed-style'),
  },
};

// ----------------------------------------------------------------- tabs ---

/**
 * Load a preview only once its tab has been opened.
 *
 * Each preview is the real output page, and each output page holds a live event
 * stream open for as long as it exists. A browser allows six connections to an
 * origin, so three previews loading up front spend three of them permanently on
 * graphics nobody is looking at - and the request that then cannot get through
 * is the POST that saves what you are typing.
 *
 * The src stays put once set: reloading it on every tab change would restart the
 * animation an operator is trying to judge.
 */
function loadPreview(panel) {
  for (const frame of panel?.querySelectorAll('iframe[data-src]') ?? []) {
    // Through pageUrl, so a preview of somebody else's production shows theirs.
    // An output page reads its target out of its own URL and has no other way
    // to learn it - there is no cross-document call anywhere in this dashboard.
    // The dashboard previews the staged copy. The OBS URL beside them carries
    // no bus and therefore keeps showing air, which is the whole arrangement.
    frame.src = pageUrl(frame.dataset.src, 'preview');
    delete frame.dataset.src;
  }
}

function showTab(name) {
  for (const tab of els.tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  for (const [key, panel] of Object.entries(els.panels)) panel.hidden = key !== name;
  loadPreview(els.panels[name]);
  // The topbar's routing selects belong to the lookup flow only. A body class
  // rather than [hidden] so app.js's own show/hide logic is not fought over.
  document.body.classList.toggle('tab-graphic', name !== 'lookup');
  if (name === 'graphic') fitPreview();
  // The winner dashboard is a separate module with its own preview to scale, and
  // an iframe measured while its panel is hidden measures zero.
  window.dispatchEvent(new CustomEvent('app-tab', { detail: name }));
}

for (const tab of els.tabs) tab.addEventListener('click', () => showTab(tab.dataset.tab));

// -------------------------------------------------------------- helpers ---

const toast = (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: message }));

// --------------------------------------------------------------- saving ---

let state = null;
let catalogue = { agents: [], maps: [] };
let teamLibrary = [];

/*
 * Every player the agent select feed has ever seen, with whatever the operator
 * chose to call them. Held here so an imported scoreboard can put the same names
 * on air as the agent select strip did - typing a caster-friendly name twice a
 * series is the thing this removes.
 */
let aliasLibrary = [];
let saveTimer = null;
let saveGeneration = 0;
let saveInFlight = false;

function setStatus(kind, label) {
  els.status.className = `save-status ${kind}`.trim();
  els.status.textContent = label;
}

function queueSave() {
  setStatus('saving', 'Saving...');
  // Any edit can drift the styling away from the preset it came from, and any
  // timing edit changes what the cue bar reports, so both are refreshed here
  // rather than at each of the thirty-odd controls.
  markModified();
  syncCueUi();
  syncResultUi();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
}

/** For cues, where a debounce would mean the graphic moves late on air. */
function saveNow() {
  clearTimeout(saveTimer);
  setStatus('saving', 'Saving...');
  return save();
}

async function save() {
  const generation = ++saveGeneration;
  saveInFlight = true;
  try {
    const response = await fetch(api('/api/graphic', EDIT_BUS), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);

    // Adopt the sanitised copy so the dashboard and the graphic can never
    // disagree - but only if nothing has been typed since this save started.
    if (generation === saveGeneration) state = payload.state;
    setStatus('', 'Saved');
  } catch (error) {
    setStatus('failed', 'Not saved');
    toast(`Graphic not saved: ${error.message}`);
  } finally {
    // Only the newest save reopens the dashboard to incoming state: an older
    // one finishing late must not let a remote update land on top of edits a
    // newer save is still carrying.
    if (generation === saveGeneration) saveInFlight = false;
  }
}

// -------------------------------------------------------- field builders ---

// Shared with the winner dashboard. The state is passed as a getter because it
// is replaced wholesale after every save - a captured reference would leave
// controls writing into a discarded copy.
const {
  textField,
  urlField,
  numberField,
  choiceField,
  selectField,
  colourField,
  checkField,
  rangeField,
  optionalColourField,
  syncFields,
} = makeFields(() => state, queueSave);

// ------------------------------------------------------- editor: match ---

/**
 * One stat row: which stat it shows, and an optional label override. Changing
 * the stat rebuilds this panel so the label placeholder tracks the new choice,
 * and rebuilds the rosters so their stat headings follow.
 */
function statRowField(slot) {
  const select = el('select');
  for (const stat of STATS) select.append(el('option', null, { value: stat.key }, stat.label));
  select.value = state.statRows[slot];

  select.addEventListener('change', () => {
    state.statRows[slot] = select.value;
    queueSave();
    buildMatchEditor();
    for (const side of SIDES) buildSideEditor(side);
  });

  const label = el('input', null, {
    type: 'text',
    maxlength: 16,
    // Blank shows the stat's own name, so most operators never touch this.
    placeholder: statDef(state.statRows[slot]).label,
  });
  label.value = state.labels[`stat${slot + 1}`] ?? '';
  label.addEventListener('input', () => {
    state.labels[`stat${slot + 1}`] = label.value;
    queueSave();
  });

  const where = slot < ROW_STAT_SLOTS ? 'MVP panel + roster rows' : 'MVP panel only';
  return grid(2, [field(`Row ${slot + 1} - ${where}`, select), field('Label override', label)]);
}

function buildMatchEditor() {
  const host = els.editors.match;
  const mapNames = catalogue.maps.map((map) => map.name);

  host.replaceChildren(
    title('Match'),
    grid(2, [
      selectField('Map', 'map', mapNames),
      textField('Match ID', 'matchId', { placeholder: 'optional' }),
    ]),
    grid(null, [
      urlField('Map image override', 'mapImage', { placeholder: 'https://... (blank = official splash)' }),
      urlField('Centre logo URL', 'eventLogo', { placeholder: 'https://... event or league logo' }),
    ]),
    subhead('Stat rows'),
    ...Array.from({ length: STAT_SLOTS }, (_, slot) => statRowField(slot)),
    subhead('MVP banner'),
    grid(2, [textField('Banner text', 'labels.mvp', { maxlength: 16 })]),

    subhead('Result wording'),
    grid(3, [
      textField('Won', 'labels.win', { maxlength: 16, placeholder: 'WIN' }),
      textField('Lost', 'labels.loss', { maxlength: 16, placeholder: 'LOSS' }),
      textField('Drawn', 'labels.draw', { maxlength: 16, placeholder: 'DRAW' }),
    ]),
    help(
      'Which side gets which is worked out from the two round counts, so there is nothing to keep in step - only ' +
        'the words are yours. A board still on 0 - 0 prints nothing at all rather than calling it a draw.',
    ),
  );
}

// -------------------------------------------------------- editor: sides ---

function movePlayer(side, from, to) {
  const roster = state[side].players;
  if (to < 0 || to >= roster.length) return;
  const [moved] = roster.splice(from, 1);
  roster.splice(to, 0, moved);
  queueSave();
  buildSideEditor(side);
}

/**
 * The player name, and the promise that comes with typing in it.
 *
 * A name written here is the operator's, so the row stops answering to the alias
 * library: saving or deleting an alias re-resolves every row that still carries
 * an identity, and without this that correction would be silently undone the
 * next time somebody edited the library. The cost is that the row no longer
 * follows later alias changes either - re-import to get the link back.
 */
function nameField(side, index, path) {
  const wrap = textField('Player name', `${path}.name`, { maxlength: 40 });
  wrap.querySelector('input').addEventListener('input', () => {
    const player = state[side].players[index];
    if (!player.playerId && !player.riotId) return;
    player.playerId = '';
    player.riotId = '';
  });
  return wrap;
}

function playerRow(side, index) {
  const path = `${side}.players.${index}`;
  const isMvp = index === 0;
  const agentNames = catalogue.agents.map((agent) => agent.name);

  const row = el('div', `player-row${isMvp ? ' is-mvp' : ''}`);

  const head = el('div', 'player-row-head');
  head.append(el('span', 'slot-tag', {}, isMvp ? 'Slot 1 - MVP panel' : `Slot ${index + 1}`));

  const tools = el('div', 'row-tools');
  if (!isMvp) {
    const mvpBtn = el('button', 'mini-btn', { type: 'button', title: 'Show this player in the MVP panel' }, 'Make MVP');
    mvpBtn.addEventListener('click', () => movePlayer(side, index, 0));
    tools.append(mvpBtn);
  }

  const up = el('button', 'mini-btn', { type: 'button', title: 'Move up' }, '▲');
  up.disabled = index === 0;
  up.addEventListener('click', () => movePlayer(side, index, index - 1));

  const down = el('button', 'mini-btn', { type: 'button', title: 'Move down' }, '▼');
  down.disabled = index === SLOTS - 1;
  down.addEventListener('click', () => movePlayer(side, index, index + 1));

  tools.append(up, down);
  head.append(tools);

  row.append(
    head,
    grid(2, [
      nameField(side, index, path),
      textField('Tag', `${path}.tag`, { placeholder: 'optional', maxlength: 16 }),
    ]),
    grid(null, [selectField('Agent', `${path}.agent`, agentNames)]),
    // Every stat is editable regardless of which rows are on air, so switching
    // a row to KAST mid-broadcast does not mean typing ten new numbers.
    grid(4, STAT_FIELDS.map((stat) => numberField(stat.label, `${path}.${stat.key}`, { max: stat.max }))),
  );
  return row;
}

/**
 * Fills a side's name and logo from the team library.
 *
 * The fields are copied rather than referenced, so this is a shortcut for typing
 * rather than a link - the operator is free to edit the name afterwards, and
 * renaming the team later cannot rewrite a scoreboard that is already on air.
 */
/**
 * What the graphic will print on this side, shown rather than typed.
 *
 * Read-only on purpose: it comes from the two round counts, so there is nothing
 * here to edit. Shown at all because an operator who has just lost a text box
 * needs to see where its contents went - and because 0 - 0 printing nothing is
 * worth being able to see before it is on air.
 */
const resultBoxes = { left: null, right: null };

function resultLine(side) {
  const box = el('div', 'result-readout');
  resultBoxes[side] = box;
  paintResult(side);
  return field('Result', box);
}

function paintResult(side) {
  const box = resultBoxes[side];
  if (!box || !state) return;
  const value = resultText(state, side);
  box.textContent = value || 'nothing yet - both sides are on 0';
  box.classList.toggle('is-empty', !value);
}

/*
 * Both sides, because one round count decides both of them - typing into the
 * left team's score has to move the right team's word too, and neither box is
 * wired to the other.
 */
function syncResultUi() {
  paintResult('left');
  paintResult('right');
}

function teamPicker(side) {
  const select = el('select');
  select.append(el('option', null, { value: '' }, teamLibrary.length ? '- pick a team -' : '- no saved teams -'));
  for (const team of teamLibrary) {
    select.append(el('option', null, { value: team.id }, team.region ? `${team.name} (${team.region})` : team.name));
  }
  select.value = state[side].teamId ?? '';
  select.disabled = !teamLibrary.length;

  select.addEventListener('change', () => {
    const team = teamLibrary.find((entry) => entry.id === select.value);
    if (!team) {
      state[side].teamId = '';
      queueSave();
      return;
    }
    // Only the fields this graphic has: the header takes the full name, and
    // the tricode is the winner graphic's problem rather than this one's.
    applyTeam(state[side], team, { name: 'teamName' });
    state[side].teamId = team.id;
    queueSave();
    buildSideEditor(side);
    toast(`Filled the ${side} side from "${team.name}"`);
  });

  return field('From the team library', select);
}

function buildSideEditor(side) {
  const host = els.editors[side];
  const swatchColour = state.preset[side === 'left' ? 'leftBg' : 'rightBg'];
  const swatch = el('span', 'side-swatch');
  swatch.style.background = swatchColour;

  const heading = title(side === 'left' ? 'Left side' : 'Right side');
  heading.prepend(swatch);

  host.replaceChildren(
    heading,
    grid(null, [teamPicker(side)]),
    grid(2, [
      textField('Team name', `${side}.teamName`, { placeholder: side === 'left' ? 'ATK' : 'DEF', maxlength: 24 }),
      numberField('Rounds won', `${side}.roundsWon`, { max: 99 }),
    ]),
    resultLine(side),
    grid(null, [urlField('Team logo URL', `${side}.logo`, { placeholder: 'https://...' })]),
    subhead(`Roster - rows show ${state.statRows.slice(0, ROW_STAT_SLOTS).map((key) => statDef(key).label).join(' + ')}`),
    ...Array.from({ length: SLOTS }, (_, index) => playerRow(side, index)),
  );
}

// ---------------------------------------------------- editor: animation ---

/** One editor control per schema field, chosen by its declared type. */
function animField(field) {
  const path = `anim.${field.key}`;
  switch (field.type) {
    case 'choice':
      return choiceField(field.label, path, field.options);
    case 'bool':
      return checkField(field.label, path);
    default:
      return numberField(field.label, path, { min: field.min, max: field.max });
  }
}

function buildAnimEditor() {
  const host = els.editors.anim;
  const groups = [];

  for (const group of ANIM_GROUPS) {
    const fields = ANIM_FIELDS.filter((entry) => entry.group === group);
    const columns = fields.every((entry) => entry.type === 'bool') ? null : 2;
    groups.push(subhead(group), grid(columns, fields.map(animField)));
  }

  host.replaceChildren(
    title('Animation'),
    el(
      'p',
      'field-help',
      {},
      `The scoreboard reveals in ${ANIM_TIER_COUNT} tiers - headers, MVP panels, map and team art, then one per ` +
        'roster row. Both sides of a tier move together; each tier waits one stagger step. Use Show, Hide and ' +
        'Replay above the preview to try it.',
    ),
    ...groups,
  );
}

// ----------------------------------------------------------------- cueing ---

// Matches the wrap in graphics.js: the output page only compares cues for
// inequality, so wrapping is safe and keeps the number a sane length.
const CUE_WRAP = 1_000_000;

/**
 * Show, Hide and Replay all bump the cue. That counter is the only thing that
 * distinguishes "the operator asked for this" from the constant stream of state
 * pushes that ordinary typing produces, and it is what lets Replay re-run the
 * entry while the graphic is already up.
 */
function cue(kind) {
  state.anim.visible = kind !== 'hide';
  state.anim.cue = ((state.anim.cue ?? 0) + 1) % CUE_WRAP;
  syncCueUi();
  return saveNow();
}

/** Reflects visibility and reports what the current timings add up to. */
function syncCueUi() {
  const anim = state?.anim;
  if (!anim) return;

  const visible = Boolean(anim.visible);
  els.air.classList.toggle('is-live', visible);
  /*
   * "Preview", not "On air". This lamp reads the bus this dashboard EDITS, and
   * since the split that is the staged copy - so the old wording would have sat
   * a few pixels above a second lamp that means the opposite, both lit red. The
   * one thing an operator must never have to work out is which of two identical
   * indicators is the one an audience can see.
   */
  els.airLabel.textContent = visible ? 'Preview up' : 'Preview hidden';
  // Doubles as the state readout: whichever button is available is the one that
  // would change something.
  els.showBtn.disabled = visible;
  els.hideBtn.disabled = !visible;
  // Explains an empty preview rather than leaving it looking broken.
  els.frame.classList.toggle('is-hidden', !visible);

  const outTotal = anim.outDurationMs + (ANIM_TIER_COUNT - 1) * anim.staggerMs;
  // Keeps the "Hidden" note off the screen until the exit has actually played.
  els.frame.style.setProperty('--hide-note-delay', `${outTotal + 120}ms`);

  const summary = [`in ${inDurationMs(anim, ANIM_TIER_COUNT)} ms`, `out ${outTotal} ms`];
  if (anim.holdMs) summary.push(`auto-hide ${(anim.holdMs / 1000).toFixed(1).replace(/\.0$/, '')}s after entry`);
  els.cueHint.textContent = summary.join('  ·  ');
}

els.showBtn.addEventListener('click', () => cue('show'));
els.hideBtn.addEventListener('click', () => cue('hide'));
els.replayBtn.addEventListener('click', () => cue('replay'));

/**
 * What another operator changed, arriving live.
 *
 * Visibility is taken from the stream unconditionally: auto-hide happens on the
 * server, so the graphic can come down without this dashboard having asked, and
 * being wrong about what is on air is the one error that shows.
 *
 * The rest of the state is somebody else's editing, and is adopted only while
 * this dashboard has nothing of its own outstanding. Between the debounce and
 * the POST, `state` here is ahead of the server - taking the server's copy in
 * that window would undo what was just typed. `syncFields` additionally skips
 * whatever holds focus, so a field being typed in is never rewritten under the
 * caret.
 *
 * ponytail: only controls built by makeFields re-read themselves. The panels
 * assembled by hand here - roster rows, stat pickers, the preset list - still
 * need a reload to show a remote structural change; wire them through
 * makeFields (or give them their own bind) if that starts to bite.
 */
onState('graphicPreview', (next) => {
  if (!state || !next) return;

  if (next.anim) {
    state.anim.visible = next.anim.visible;
    state.anim.cue = next.anim.cue;
  }
  syncCueUi();

  if (saveTimer || saveInFlight) return;
  state = next;
  syncFields();
  markModified();
});

// -------------------------------------------------------- editor: style ---

// -------------------------------------------------------------- presets ---

let presetLibrary = [];

const activePreset = () => presetLibrary.find((entry) => entry.id === state.presetId) ?? null;

/**
 * Has the operator changed anything since applying the preset? Compared field
 * by field against the saved copy so the badge cannot claim "unchanged" while
 * the graphic on air says otherwise.
 */
const isModified = () => {
  const entry = activePreset();
  if (!entry) return true;
  return PRESET_KEYS.some((key) => entry.preset[key] !== state.preset[key]);
};

/** Called on every edit - the badge tracks changes, not just preset applies. */
function markModified() {
  const badge = els.editors.style.querySelector('.preset-state');
  if (!badge) return;

  const edited = isModified();
  badge.textContent = edited ? 'edited' : 'matches preset';
  badge.classList.toggle('is-edited', edited);
}

async function presetAction(body) {
  const response = await fetch(api('/api/presets'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);

  presetLibrary = payload.presets;

  // Applying and saving both rewrite the live styling, so pull it back in.
  const graphic = await fetch(api('/api/graphic', EDIT_BUS)).then((r) => r.json());
  state = graphic.state;
  buildAll();
  setStatus('', 'Saved');
  return payload;
}

function presetBar() {
  const select = el('select', 'preset-select');
  for (const entry of presetLibrary) {
    select.append(el('option', null, { value: entry.id }, entry.builtIn ? `${entry.name} (built-in)` : entry.name));
  }
  if (!activePreset()) select.append(el('option', null, { value: '' }, 'Custom'));
  select.value = state.presetId ?? '';

  select.addEventListener('change', async () => {
    try {
      await presetAction({ action: 'apply', id: select.value });
      toast(`Applied "${presetLibrary.find((e) => e.id === select.value)?.name ?? select.value}"`);
    } catch (error) {
      toast(`Could not apply that preset: ${error.message}`);
    }
  });

  const button = (label, hint, onClick) => {
    const node = el('button', 'mini-btn', { type: 'button', title: hint }, label);
    node.addEventListener('click', onClick);
    return node;
  };

  const entry = activePreset();
  const tools = el('div', 'preset-tools');

  tools.append(
    button('Save as…', 'Save the current styling as a new preset', async () => {
      const name = window.prompt('Name this preset:', entry ? `${entry.name} copy` : 'My preset');
      if (name === null) return;
      try {
        await presetAction({ action: 'save', name, preset: state.preset });
        toast(`Saved "${name}"`);
      } catch (error) {
        toast(`Could not save: ${error.message}`);
      }
    }),
  );

  // Built-ins are read-only on purpose: there is always a known-good look to
  // fall back to. "Save as..." covers making an edited copy.
  const update = button('Update', 'Overwrite this preset with the current styling', async () => {
    try {
      await presetAction({ action: 'save', id: entry.id, name: entry.name, preset: state.preset });
      toast(`Updated "${entry.name}"`);
    } catch (error) {
      toast(`Could not update: ${error.message}`);
    }
  });
  update.disabled = !entry || entry.builtIn;

  const remove = button('Delete', 'Delete this preset', async () => {
    if (!window.confirm(`Delete the preset "${entry.name}"? The graphic keeps its current look.`)) return;
    try {
      await presetAction({ action: 'delete', id: entry.id });
      toast(`Deleted "${entry.name}"`);
    } catch (error) {
      toast(`Could not delete: ${error.message}`);
    }
  });
  remove.disabled = !entry || entry.builtIn;

  tools.append(update, remove);

  tools.append(
    button('Copy code', 'Copy a share code for this look', async () => {
      const code = encodePreset(entry?.name ?? 'Custom', state.preset);
      try {
        await navigator.clipboard.writeText(code);
        toast('Preset code copied - paste it to another operator');
      } catch {
        window.prompt('Copy this preset code:', code);
      }
    }),
    button('Paste code', 'Load a look from a share code', async () => {
      const code = window.prompt('Paste a preset code:');
      if (!code) return;

      const decoded = decodePreset(code);
      if (!decoded) {
        toast('That does not look like a preset code.');
        return;
      }
      try {
        await presetAction({ action: 'save', name: decoded.name, preset: decoded.preset });
        toast(`Loaded "${decoded.name}"`);
      } catch (error) {
        toast(`Could not load that code: ${error.message}`);
      }
    }),
  );

  const head = el('div', 'preset-head');
  head.append(el('span', null, {}, 'Preset'), el('span', 'preset-state'));

  const bar = el('div', 'preset-bar');
  bar.append(head, select, tools);
  return bar;
}

/** One editor control per schema field, chosen by its declared type. */
function presetField(field) {
  const path = `preset.${field.key}`;
  switch (field.type) {
    case 'font':
      return selectField(field.label, path, FONT_CHOICES, { allowUnknown: false });
    case 'ratio':
      return rangeField(field.label, path);
    case 'bool':
      return checkField(field.label, path);
    case 'hexOff':
      return optionalColourField(field.label, path);
    default:
      return colourField(field.label, path);
  }
}

function buildStyleEditor() {
  const host = els.editors.style;
  const groups = [];

  for (const group of PRESET_GROUPS) {
    const fields = PRESET_FIELDS.filter((field) => field.group === group);
    // Toggles read better stacked; colours pair up two to a row.
    const columns = fields.every((field) => field.type === 'bool') ? null : 2;
    groups.push(subhead(group), grid(columns, fields.map(presetField)));
  }

  host.replaceChildren(title('Style'), presetBar(), ...groups);
  // The bar is rebuilt on every apply, so seed the badge rather than leaving it
  // blank until the operator's first edit.
  markModified();

  // The side headings carry a swatch of the background colour they control.
  for (const input of host.querySelectorAll('input[type="color"]')) {
    input.addEventListener('input', () => {
      for (const side of SIDES) {
        const swatch = els.editors[side].querySelector('.side-swatch');
        if (swatch) swatch.style.background = state.preset[side === 'left' ? 'leftBg' : 'rightBg'];
      }
    });
  }
}

function buildAll() {
  buildMatchEditor();
  for (const side of SIDES) buildSideEditor(side);
  buildAnimEditor();
  buildStyleEditor();
  syncCueUi();
}

// -------------------------------------------------------------- actions ---

els.swapBtn.addEventListener('click', () => {
  // Colours stay put: they describe the left and right halves of the design,
  // not the teams. Only the content moves.
  [state.left, state.right] = [state.right, state.left];
  queueSave();
  for (const side of SIDES) buildSideEditor(side);
  toast('Sides swapped');
});

/*
 * The identity fields, and only those.
 *
 * Names and logos are typed once at the top of a series and left alone, but a
 * match import re-assigns the rosters and scores Blue-left / Red-right on every
 * map (see teamRank), and which org is Blue flips between maps. So roughly every
 * other map the typed name ends up sitting over the other team's roster.
 *
 * Swap sides moves both halves at once, which keeps them mismatched - that is
 * why this is a separate button rather than the same one.
 */
const IDENTITY_KEYS = ['teamName', 'logo', 'teamId'];

els.namesBtn.addEventListener('click', () => {
  for (const key of IDENTITY_KEYS) {
    const held = state.left[key];
    state.left[key] = state.right[key];
    state.right[key] = held;
  }
  queueSave();
  for (const side of SIDES) buildSideEditor(side);
  toast('Names swapped - rosters and scores stayed put');
});

els.sortBtn.addEventListener('click', () => {
  for (const side of SIDES) {
    state[side].players.sort((a, b) => (b.acs ?? 0) - (a.acs ?? 0) || (b.kills ?? 0) - (a.kills ?? 0));
  }
  queueSave();
  for (const side of SIDES) buildSideEditor(side);
  toast('Rosters sorted by ACS - top player is now the MVP');
});

els.resetBtn.addEventListener('click', async () => {
  if (!window.confirm('Reset the graphic to defaults? Every field will be cleared.')) return;

  const response = await fetch(api('/api/graphic', EDIT_BUS), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reset: true }),
  });
  const payload = await response.json();
  state = payload.state;
  buildAll();
  setStatus('', 'Saved');
  toast('Graphic reset');
});

els.checker.addEventListener('change', () => {
  els.frame.classList.toggle('checker', els.checker.checked);
});

// -------------------------------------------------------------- preview ---

function fitPreview() {
  const width = els.frame.clientWidth;
  if (width) els.preview.style.transform = `scale(${width / 1920})`;
}

new ResizeObserver(fitPreview).observe(els.frame);
window.addEventListener('resize', fitPreview);

// --------------------------------------------------------------- import ---

const emptyPlayer = () => ({
  name: '',
  tag: '',
  agent: '',
  playerId: '',
  riotId: '',
  ...Object.fromEntries(STAT_FIELDS.map((stat) => [stat.key, 0])),
});

/**
 * A normalised player from any of the three sources. Missing stats become 0
 * rather than being dropped - the field still has to exist so the operator can
 * type it in if the source did not report it.
 */
/*
 * A UUID and nothing else is allowed into playerId.
 *
 * The three sources disagree about what `id` is: Riot and HenrikDev give a
 * puuid, but tracker.gg has none and puts the Riot ID string there instead, and
 * Henrik falls back to "name#tag" when a puuid is missing. Writing either of
 * those into a field meant to hold a puuid would create a key that can never
 * match an alias record - so the Riot ID is kept separately and matched on its
 * own terms.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const mapPlayer = (player) => ({
  name: player.name ?? '',
  tag: player.tag ?? '',
  agent: player.agent ?? '',
  playerId: UUID.test(String(player.id ?? '')) ? String(player.id) : '',
  riotId: player.tag ? `${player.name ?? ''}#${player.tag}` : String(player.name ?? ''),
  kills: player.kills ?? 0,
  deaths: player.deaths ?? 0,
  assists: player.assists ?? 0,
  acs: player.acs ?? player.score ?? 0,
  adr: player.adr ?? 0,
  firstKills: player.firstKills ?? 0,
  hsPct: player.hsPct ?? 0,
  kast: player.kast ?? 0,
});

/** Blue before Red - that is the order the graphic's left/right halves assume. */
const teamRank = (id) => ['blue', 'red'].indexOf(String(id).toLowerCase()) + 1 || 9;

function groupByTeam(players) {
  const groups = new Map();
  for (const player of players) {
    const id = String(player.teamId ?? 'Players');
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(player);
  }
  return groups;
}

/**
 * Normalised match detail -> graphic state.
 *
 * Team names and logos are deliberately preserved: those are the org names the
 * operator typed, and no data source knows them. Everything a source *does*
 * know - scores, rosters, agents, map - is overwritten.
 */
function importMatch(match) {
  const players = match.players ?? [];
  if (!players.length) {
    toast('That match returned no per-player stats - nothing to import.');
    return false;
  }

  const groups = groupByTeam(players);
  let rosters;

  if (groups.size === 2) {
    rosters = [...groups.entries()].sort((a, b) => teamRank(a[0]) - teamRank(b[0]));
  } else {
    // Deathmatch, or a source that did not report teams. Split the leaderboard
    // so the operator has something to edit rather than an empty graphic.
    const ranked = [...players].sort((a, b) => (b.acs ?? 0) - (a.acs ?? 0));
    rosters = [
      [null, ranked.slice(0, SLOTS)],
      [null, ranked.slice(SLOTS, SLOTS * 2)],
    ];
    toast(`Match has ${groups.size} team(s) - split the leaderboard in half, check the rosters.`);
  }

  SIDES.forEach((side, position) => {
    const [teamId, roster] = rosters[position] ?? [null, []];
    const team = (match.teams ?? []).find((entry) => String(entry.id) === String(teamId));

    const ranked = [...roster].sort((a, b) => (b.acs ?? 0) - (a.acs ?? 0)).slice(0, SLOTS);

    state[side] = {
      ...state[side],
      roundsWon: team?.roundsWon ?? 0,
      players: Array.from({ length: SLOTS }, (_, index) => {
        if (!ranked[index]) return emptyPlayer();
        const row = mapPlayer(ranked[index]);
        // Resolved here rather than at render, exactly as agent select does it:
        // the output page holds one event stream and no alias channel, and the
        // name that gets saved should be the name that goes to air.
        return { ...row, name: aliasForPlayer(aliasLibrary, row) || row.name };
      }),
    };
  });

  if (match.map) state.map = match.map;
  state.matchId = match.matchId ?? '';

  queueSave();
  buildMatchEditor();
  for (const side of SIDES) buildSideEditor(side);
  return true;
}

let pendingImport = null;

onLookupMatch(({ match }) => {
  pendingImport = match;
  els.importBtn.disabled = !match;
  els.importHint.hidden = Boolean(match);
});

els.importBtn.addEventListener('click', () => {
  if (!pendingImport) return;
  if (importMatch(pendingImport)) toast('Match imported into the graphic');
});

// ----------------------------------------------------------------- start ---

async function start() {
  // The URL an operator copies into OBS. It has to carry a session key: a
  // browser source has no login, and without one it would reach a 401 and show
  // nothing at all. Filled in asynchronously because the key comes from the
  // account, so the markup holds a placeholder until this resolves.
  void targetKey().then((key) => {
    const url = outputUrl('/post-match.html', key);
    // textContent stays whole - the copy button reads it, and the box is
    // narrowed with an ellipsis in CSS rather than by shortening the string.
    els.obsUrl.textContent = url;
    els.obsUrl.title = url;
    els.openLink.href = url;
  });

  const [graphic, assetData, presetData, teamData, aliasData] = await Promise.all([
    fetch(api('/api/graphic', EDIT_BUS)).then((r) => r.json()),
    fetch('/api/valorant-assets')
      .then((r) => (r.ok ? r.json() : { agents: [], maps: [] }))
      .catch(() => ({ agents: [], maps: [] })),
    fetch(api('/api/presets'))
      .then((r) => r.json())
      .catch(() => ({ presets: [] })),
    fetch(api('/api/teams'))
      .then((r) => r.json())
      .catch(() => ({ teams: [] })),
    // A plain GET, deliberately not a second event stream: six connections per
    // origin is the cap that deadlocked the dashboard once already.
    fetch(api('/api/aliases'))
      .then((r) => (r.ok ? r.json() : { players: [] }))
      .catch(() => ({ players: [] })),
  ]);

  state = graphic.state;
  catalogue = assetData;
  presetLibrary = presetData.presets ?? [];
  teamLibrary = teamData.teams ?? [];
  aliasLibrary = aliasData.players ?? [];

  // Same reason as the team library below: aliases are curated on the agent
  // select tab, so a name saved there has to be available here without a reload.
  window.addEventListener('app-tab', (event) => {
    if (event.detail !== 'graphic') return;
    fetch(api('/api/aliases'))
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) aliasLibrary = data.players ?? []; })
      .catch(() => {});
  });

  // The library is edited on the winner tab; the pickers here have to follow it
  // without a reload, or a team saved on one tab is invisible on the other.
  window.addEventListener('teams-changed', (event) => {
    teamLibrary = event.detail ?? [];
    if (state) for (const side of SIDES) buildSideEditor(side);
  });

  if (!catalogue.agents.length) {
    toast('Agent and map lists unavailable - type names by hand, art will be missing.');
  }

  buildAll();
  setStatus('', 'Saved');
  fitPreview();
}

start().catch((error) => {
  els.editors.match.replaceChildren(el('p', 'empty', {}, `Could not load the graphic: ${error.message}`));
});

// ------------------------------------------------------------- the take ---

makeTakeBar({
  graphic: 'graphics',
  prefix: 'g',
  programChannel: 'graphic',
  previewChannel: 'graphicPreview',
  isLive: (state) => Boolean(state.anim?.visible),
  describe: (state) => (state.anim?.visible ? 'ON AIR' : 'Off air'),
  toast,
});
