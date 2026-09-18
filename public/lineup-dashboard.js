/**
 * The Team lineup tab: pick a team, load it, choose how it looks.
 *
 * `load` copies the org and its roster in, the same way the veto board copies a
 * veto - nothing is dereferenced at paint time. Patched rather than replaced,
 * so the format, the heading and the event logo (set once, before the show)
 * survive a Load that only means "now show the other team".
 */

import { el, field, grid, help, subhead, title } from './fields.js';
import { mediaControl } from './media-field.js';
import { onState } from './live.js';
import { api, outputUrl, targetKey } from './session.js';
import { makeTakeBar } from './take-bar.js';
import { LINEUP_FORMATS, LINEUP_SLOTS, lineupIsStale } from './lineup-schema.js';

const $ = (id) => document.getElementById(id);
const toast = (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: message }));

const els = {
  tab: $('tab-lineup'),
  status: $('l-status'),
  air: $('l-air'),
  airLabel: $('l-air-label'),
  show: $('l-show'),
  hide: $('l-hide'),
  note: $('l-note'),
  reset: $('l-reset'),
  obsUrl: $('l-obs-url'),
  open: $('l-open'),
  preview: $('l-preview'),
  team: $('led-team'),
  style: $('led-style'),
};

if (els.tab) {
  let state = null;
  let library = [];
  let chosen = '';

  async function post(body) {
    els.status.textContent = 'Saving…';
    try {
      const response = await fetch(api('/api/lineup', 'preview'), {
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

  const save = (patch) => post({ state: { ...state, ...patch } });

  function teamPanel() {
    const live = library.find((entry) => entry.id === (chosen || state.teamId)) ?? null;
    const stale = lineupIsStale(state, live);

    const pick = el('select', null, { 'aria-label': 'Which team' });
    pick.append(el('option', null, { value: '' }, library.length ? '- pick a team -' : '- no teams yet -'));
    for (const team of library) {
      pick.append(
        el(
          'option',
          null,
          { value: team.id, selected: team.id === (chosen || state.teamId) ? 'selected' : null },
          `${team.name}${team.players?.length ? ` (${team.players.length})` : ' - no roster'}`,
        ),
      );
    }
    pick.addEventListener('change', () => {
      chosen = pick.value;
      paint();
    });

    const load = el('button', 'btn btn-primary', { type: 'button' }, state.teamId ? 'Load again' : 'Load onto the graphic');
    load.disabled = !(chosen || state.teamId);
    load.addEventListener('click', () =>
      post({ action: 'load', id: chosen || state.teamId })
        .then(() => toast('Lineup loaded onto preview. Take it when you are ready.'))
        .catch(() => {}),
    );

    const loaded = state.players ?? [];
    const missing = loaded.filter((player) => !player.photo && !state.defaultPhoto).length;

    els.team.replaceChildren(
      title('The team'),
      help(
        `A copy of the roster, taken when you press Load - the first ${LINEUP_SLOTS} on it, in the order they are ` +
          'listed. Reorder them on the Teams page to change which five appear.',
      ),
      grid(null, [field('Team', pick)]),
      ...(stale ? [el('p', 'field-help is-warn', {}, 'That team has changed since this was loaded. Press Load again to catch up.')] : []),
      load,
      ...(loaded.length
        ? [
            el('p', 'field-help', {}, `${loaded.length} on the graphic${missing ? ` - ${missing} with no photo` : ''}.`),
            /*
             * Named rather than counted, because the next question is always
             * "which one". A missing portrait is a hole in the middle of a
             * five-across graphic and the fix is on another page, so saying who
             * is what makes it actionable.
             */
            ...(missing
              ? [
                  help(
                    `No photo: ${loaded
                      .filter((player) => !player.photo && !state.defaultPhoto)
                      .map((player) => player.name || '(unnamed)')
                      .join(', ')}. Add one on the Players page, or set a team default on Teams.`,
                  ),
                ]
              : []),
          ]
        : []),
    );
  }

  function stylePanel() {
    const format = el('select', null, { 'aria-label': 'Format' });
    for (const entry of LINEUP_FORMATS) {
      format.append(el('option', null, { value: entry.key, selected: entry.key === state.format ? 'selected' : null }, entry.label));
    }
    format.addEventListener('change', () => save({ format: format.value }));

    const heading = el('input', null, { type: 'text', maxlength: 40, 'aria-label': 'Heading', placeholder: 'Starting lineup' });
    heading.value = state.heading ?? '';
    // On blur rather than per keystroke: this writes through the server and the
    // graphic repaints, which is not something to do eight times while
    // somebody types two words.
    const commitHeading = () => {
      if ((state.heading ?? '') !== heading.value) save({ heading: heading.value });
    };
    heading.addEventListener('change', commitHeading);
    heading.addEventListener('blur', commitHeading);

    els.style.replaceChildren(
      title('Look'),
      grid(null, [field('Format', format)]),
      help(LINEUP_FORMATS.find((entry) => entry.key === state.format)?.help ?? ''),
      grid(null, [field('Heading', heading)]),
      help('The small line above the team name - "Starting lineup", "The roster", whatever the show calls it.'),
      subhead('Event logo'),
      mediaControl(
        'Event logo',
        () => state.eventLogo,
        (value) => save({ eventLogo: value }),
      ),
    );
  }

  /*
   * The style panel holds the one text input on this tab, so it is painted ONCE
   * and never again - the caret rule. Everything that changes with the state
   * lives in the team panel, which has no input in it and repaints freely.
   */
  let styleBuilt = false;

  function paint() {
    if (!state) return;
    els.air.classList.toggle('is-live', Boolean(state.anim?.visible));
    els.airLabel.textContent = state.anim?.visible ? 'On preview' : 'Hidden';
    els.note.textContent = state.teamName ? `Showing ${state.teamName}` : 'nothing loaded yet';
    teamPanel();
    if (!styleBuilt) {
      stylePanel();
      styleBuilt = true;
    }
  }

  els.show.addEventListener('click', () =>
    save({ anim: { ...state.anim, visible: true, cue: ((state.anim?.cue ?? 0) + 1) % 1_000_000 } }),
  );
  els.hide.addEventListener('click', () => save({ anim: { ...state.anim, visible: false } }));
  els.reset.addEventListener('click', () => {
    if (!window.confirm('Reset the lineup graphic? The loaded team, the heading and the logo all go.')) return;
    post({ reset: true }).then(() => {
      styleBuilt = false;
      paint();
    });
  });

  makeTakeBar({
    graphic: 'lineup',
    prefix: 'l',
    programChannel: 'lineup',
    previewChannel: 'lineupPreview',
    describe: (value) => (value.anim?.visible ? `On air - ${value.teamName || 'no team'}` : 'Off air'),
    isLive: (value) => Boolean(value.anim?.visible),
    toast,
  });

  onState('lineupPreview', (next) => {
    state = next;
    paint();
  });

  async function refresh() {
    const [mine, teams] = await Promise.all([
      fetch(api('/api/lineup', 'preview')).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(api('/api/teams')).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (mine?.state) state = mine.state;
    library = teams?.teams ?? [];
    styleBuilt = false;
    paint();
  }

  refresh();
  window.addEventListener('tournament-changed', refresh);
  window.addEventListener('teams-changed', (event) => {
    library = event.detail ?? library;
    if (state) teamPanel();
  });

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
    const url = outputUrl('/lineup.html', await targetKey());
    els.obsUrl.textContent = url;
    els.open.href = url;
  };
  void paintUrl();
  window.addEventListener('account-changed', () => void paintUrl());
}
