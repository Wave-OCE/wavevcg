/**
 * The Map veto graphics tab: load a veto onto the board, and walk it out.
 *
 * Two controls that no other graphic here has, and both come from the same
 * fact - this graphic is a SNAPSHOT of something two people with no account are
 * driving on their phones:
 *
 *   LOAD copies the veto onto the board. Nothing keeps it in step afterwards,
 *   deliberately, so a captain's mis-tap cannot reach a stream. The panel says
 *   when the veto has moved past what is loaded and Load is one press away.
 *
 *   REVEAL says how much of the board is on screen, so an operator walks it out
 *   one ban at a time while a caster talks over it. It is NOT the cue: the cue
 *   replays the entrance and moves only on Show, while revealing the fourth ban
 *   animates the fourth row and leaves the three above it alone.
 */

import { el, field, grid, help, makeFields, subhead, title } from './fields.js';
import { mediaControl } from './media-field.js';
import { onState } from './live.js';
import { DEFAULT_BRAND, brandOf } from './brand.js';
import { api, outputUrl, targetKey } from './session.js';
import { makeTakeBar } from './take-bar.js';
import { VETO_BOARD_LAYOUTS, boardIsStale, revealedCount } from './veto-board-schema.js';
import { vetoComplete } from './veto-schema.js';

const $ = (id) => document.getElementById(id);
const toast = (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: message }));

const els = {
  tab: $('tab-vetoBoard'),
  status: $('v-status'),
  air: $('v-air'),
  airLabel: $('v-air-label'),
  show: $('v-show'),
  hide: $('v-hide'),
  none: $('v-none'),
  next: $('v-next'),
  all: $('v-all'),
  revealNote: $('v-reveal-note'),
  reset: $('v-reset'),
  obsUrl: $('v-obs-url'),
  open: $('v-open'),
  preview: $('v-preview'),
  load: $('ved-load'),
  reveal: $('ved-reveal'),
  style: $('ved-style'),
};

if (els.tab) {
  let state = null;
  let vetoDoc = { pool: [], vetoes: [] };
  let chosen = '';

  // ------------------------------------------------------------ plumbing ---

  async function post(body) {
    els.status.textContent = 'Saving…';
    try {
      const response = await fetch(api('/api/veto-board', 'preview'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
      state = payload.state;
      els.status.textContent = 'Saved';
      paint();
      return payload;
    } catch (error) {
      els.status.textContent = 'Not saved';
      toast(error.message);
      throw error;
    }
  }

  /*
   * Writes go to PREVIEW, like every other graphic here - the asymmetry in
   * busFor means an unqualified write would stage anyway, but saying so is what
   * stops a later reader assuming this tab is the exception.
   */
  const save = (patch) => post({ state: { ...state, ...patch } });

  // ---------------------------------------------------------------- paint ---

  /** Which veto is loaded, and whether it has moved since. */
  function loadPanel() {
    const host = els.load;
    const live = vetoDoc.vetoes.find((entry) => entry.id === (chosen || state?.vetoId)) ?? null;
    const stale = state && live ? boardIsStale(state, live) : false;

    const pick = el('select', null, { 'aria-label': 'Which veto' });
    pick.append(el('option', null, { value: '' }, vetoDoc.vetoes.length ? '- pick a veto -' : '- no vetoes yet -'));
    for (const entry of vetoDoc.vetoes) {
      const label = entry.name || `${entry.a.name || 'Team A'} vs ${entry.b.name || 'Team B'}`;
      const where = vetoComplete(entry) ? 'finished' : `step ${entry.steps.filter((s) => s.map).length + 1}/${entry.steps.length}`;
      pick.append(
        el(
          'option',
          null,
          { value: entry.id, selected: entry.id === (chosen || state?.vetoId) ? 'selected' : null },
          `${label} - ${where}`,
        ),
      );
    }
    pick.addEventListener('change', () => {
      chosen = pick.value;
      paint();
    });

    const load = el('button', 'btn btn-primary', { type: 'button' }, state?.vetoId ? 'Load again' : 'Load onto the board');
    load.disabled = !(chosen || state?.vetoId);
    load.addEventListener('click', () =>
      post({ action: 'load', id: chosen || state.vetoId })
        .then(() => toast('Board loaded onto preview. Take it when you are ready.'))
        .catch(() => {}),
    );

    host.replaceChildren(
      title('The board'),
      help(
        'A copy of the veto, taken when you press Load. Nothing keeps it in step afterwards, on purpose: a veto ' +
          'is driven by two people holding links, and a live view would put a mis-tap on air. Press Load again ' +
          'whenever they move.',
      ),
      grid(null, [field('Veto', pick)]),
      /*
       * The staleness note. Compared on the answered MAPS rather than on the
       * whole record, so renaming a veto or fixing a tricode does not light it -
       * a badge that cries wolf is one nobody reads.
       */
      ...(stale
        ? [el('p', 'field-help is-warn', {}, 'That veto has moved since this board was loaded. Press Load again to catch up.')]
        : []),
      load,
    );
  }

  /*
   * The colour controls need binding - a blank accent's swatch has to follow
   * the tournament - and this tab had no makeFields at all. `set` writes into
   * the live state and this saves the one key, which is what every other
   * control here already does by hand.
   */
  const styleFields = makeFields(
    () => state ?? {},
    () => save({ accent: state?.accent ?? '', highlight: state?.highlight ?? '', banColour: state?.banColour ?? '' }),
  );

  let brand = { ...DEFAULT_BRAND };
  onState('brand', (next) => {
    brand = brandOf(next);
    // Sync, not rebuild: this panel carries no text input today, but a bound
    // swatch moving on its own is the behaviour every other tab here has.
    styleFields.syncFields();
  });

  function stylePanel() {
    const host = els.style;

    const layout = el('select', null, { 'aria-label': 'Layout' });
    for (const entry of VETO_BOARD_LAYOUTS) {
      layout.append(el('option', null, { value: entry.key, selected: entry.key === state.layout ? 'selected' : null }, entry.label));
    }
    layout.addEventListener('change', () => save({ layout: layout.value }));

    const sides = el('input', null, { type: 'checkbox' });
    sides.checked = state.showSides !== false;
    sides.addEventListener('change', () => save({ showSides: sides.checked }));
    const sidesLine = el('label', 'checkline');
    sidesLine.append(sides, el('span', null, {}, 'Show who starts on which side'));

    const art = el('input', null, { type: 'checkbox' });
    art.checked = state.showTeamArt !== false;
    art.addEventListener('change', () => save({ showTeamArt: art.checked }));
    const artLine = el('label', 'checkline');
    artLine.append(art, el('span', null, {}, 'Show each team mark behind their boxes'));

    host.replaceChildren(
      title('Look'),
      grid(null, [field('Layout', layout)]),
      help(VETO_BOARD_LAYOUTS.find((entry) => entry.key === state.layout)?.help ?? ''),
      sidesLine,
      artLine,
      help(
        'Their logo behind every box they banned or picked, large and faint - or their tricode when they have no ' +
          'logo. It is there to make WHO did what readable at a glance on a stream, which the words alone are too ' +
          'small to do. A revealed map paints over it.',
      ),
      subhead('Colours'),
      help(
        'Accent and highlight follow the tournament unless you set one here - Reset to default puts either back. ' +
          'The ban colour belongs to this graphic alone: a ban reads red by a convention older than any one event, ' +
          'and tying it to an event trim would announce bans in whatever colour that happens to be.',
      ),
      grid(2, [
        styleFields.brandField('Accent', 'accent', { inherited: () => brand.accent }),
        styleFields.brandField('Highlight', 'highlight', { inherited: () => brand.highlight }),
      ]),
      help('Accent is the trim - the VS divider and the logo bar. Highlight is a map that went through.'),
      grid(2, [styleFields.colourField('Ban colour', 'banColour')]),
      help('The ring and the strike through a map that is gone.'),
      subhead('Event logo'),
      help('Sits along the bottom of the lower third and under the full-screen board. Drop a file, paste one, or give it a URL.'),
      mediaControl(
        'Event logo',
        () => state.eventLogo,
        (value) => save({ eventLogo: value }),
      ),
    );
  }

  /**
   * One row per step, each with its own switch.
   *
   * A list rather than a Next button, because a veto read out over comms
   * arrives in whatever order people speak - and a board that could only reveal
   * the next one would force an operator to show three steps to get to the
   * fourth. Next is still on the cue bar, because walking forwards is what
   * happens most of the time.
   *
   * Every row is shown whether or not the veto has answered it: the GRAPHIC
   * shows all its boxes too, and a card that hid the unanswered ones would not
   * be a picture of what is on screen.
   */
  function revealPanel() {
    const rows = state.rows ?? [];
    const flags = state.revealed ?? [];

    els.reveal.replaceChildren(
      title('Reveal'),
      help(
        'The board shows every box from the moment it is up - who is banning, who is picking - and these put the ' +
          'MAP in one. Nothing here changes the veto itself; it only decides what an audience can see.',
      ),
      ...(rows.length
        ? rows.map((row, index) => {
            const line = el('div', `veto-reveal-row${flags[index] ? ' is-on' : ''}`);
            const who = row.kind === 'decider' ? 'Decider' : `${row.byShort || row.by || '?'} ${row.kind}s`;

            const box = el('input', null, { type: 'checkbox', 'aria-label': `Reveal step ${index + 1}` });
            box.checked = flags[index] === true;
            box.disabled = !row.map;
            box.addEventListener('change', () => {
              post({ action: 'reveal', at: index, on: box.checked }).catch(() => {});
            });

            line.append(
              box,
              el('span', 'veto-reveal-step', {}, String(index + 1)),
              el('span', 'veto-reveal-who', {}, who),
              /*
               * A step the veto has not answered cannot be revealed - there is
               * nothing to put in the box. Saying so beats a switch that can be
               * flicked and does nothing.
               */
              el('span', 'veto-reveal-map', {}, row.map || 'not banned yet'),
            );
            return line;
          })
        : [el('p', 'empty', {}, 'Load a veto onto the board and its steps appear here.')]),
    );
  }

  function paint() {
    if (!state) return;

    const rows = state.rows ?? [];
    const shown = revealedCount(state);
    els.revealNote.textContent = rows.length ? `${shown} of ${rows.length} revealed` : 'nothing loaded yet';
    // Next reveals the first step that is still hidden AND has a map to show.
    const nextAt = rows.findIndex((row, index) => row.map && !(state.revealed ?? [])[index]);
    els.next.disabled = nextAt === -1;
    els.all.disabled = !rows.length || shown >= rows.filter((row) => row.map).length;
    els.none.disabled = shown <= 0;

    els.air.classList.toggle('is-live', Boolean(state.anim?.visible));
    els.airLabel.textContent = state.anim?.visible ? 'On preview' : 'Hidden';

    loadPanel();
    revealPanel();
    stylePanel();
  }

  // -------------------------------------------------------------- transport ---

  /*
   * Show BUMPS THE CUE and the reveal does not, which is the whole distinction
   * this graphic turns on. Show is "the board arrives"; Reveal next is "one more
   * step of a board that is already there".
   */
  els.show.addEventListener('click', () =>
    save({ anim: { ...state.anim, visible: true, cue: ((state.anim?.cue ?? 0) + 1) % 1_000_000 } }),
  );
  els.hide.addEventListener('click', () => save({ anim: { ...state.anim, visible: false } }));

  els.next.addEventListener('click', () => {
    // The first step still hidden that has something to show. Computed here
    // rather than on the server so the button and its disabled state agree.
    const at = (state.rows ?? []).findIndex((row, index) => row.map && !(state.revealed ?? [])[index]);
    if (at !== -1) post({ action: 'reveal', at, on: true }).catch(() => {});
  });
  els.all.addEventListener('click', () => post({ action: 'reveal', all: true }).catch(() => {}));
  els.none.addEventListener('click', () => post({ action: 'reveal', all: false }).catch(() => {}));

  els.reset.addEventListener('click', () => {
    if (!window.confirm('Reset the veto board? The loaded veto, the logo and the layout all go.')) return;
    post({ reset: true });
  });

  // ---------------------------------------------------------------- wiring ---

  makeTakeBar({
    graphic: 'vetoBoard',
    prefix: 'v',
    programChannel: 'vetoBoard',
    previewChannel: 'vetoBoardPreview',
    describe: (value) => (value.anim?.visible ? `On air - ${value.reveal ?? 0} of ${(value.rows ?? []).length}` : 'Off air'),
    isLive: (value) => Boolean(value.anim?.visible),
    toast,
  });

  onState('vetoBoardPreview', (next) => {
    state = next;
    paint();
  });

  async function refresh() {
    const [boardData, vetoData] = await Promise.all([
      fetch(api('/api/veto-board', 'preview'))
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch(api('/api/veto'))
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);
    if (boardData?.state) state = boardData.state;
    vetoDoc = vetoData?.veto ?? { pool: [], vetoes: [] };
    paint();
  }

  refresh();
  window.addEventListener('tournament-changed', refresh);

  // The veto list moves without this page asking - two captains are answering
  // it - so arriving at the tab is the moment to re-read.
  window.addEventListener('app-tab', (event) => {
    if (event.detail === 'vetoBoard') refresh();
  });

  // The OBS URL carries the key, like every other output.
  /*
   * The preview iframe is NOT loaded here.
   *
   * It carries `data-src` and dashboard.js loads it when its tab is first
   * opened, which is the rule every other graphic follows and the reason is
   * written up in CLAUDE.md: a browser allows six HTTP/1.1 connections per
   * origin and a server-sent event stream holds one open for as long as the
   * page lives. The dashboard's own stream plus one per live preview is the
   * whole budget - setting `src` at module load meant three more streams opened
   * before anybody had looked at these tabs, and with the three Match previews
   * that is seven. The seventh request does not fail; it queues for ever, and
   * under that the renderer eventually dies with "Target crashed".
   */
  const paintUrl = async () => {
    // Async, because the key belongs to the tournament and is fetched. Writing
    // it synchronously printed "[object Promise]" into the OBS URL box - which
    // copies just as happily as a real one.
    const url = outputUrl('/veto-board.html', await targetKey());
    els.obsUrl.textContent = url;
    els.open.href = url;
  };
  void paintUrl();
  window.addEventListener('account-changed', () => void paintUrl());
}
