/**
 * The Head to head tab: two teams, or one fixture.
 *
 * Two ways to fill it and both are ordinary. A FIXTURE brings both halves
 * across as the schedule records them, which is the path for anything drawn;
 * picking sides by hand is the showmatch that is in no schedule. The fixture
 * path takes the fixture's own COPIES rather than re-resolving through the
 * library - see headToHeadFromFixture for why that is the right way round.
 */

import { el, field, grid, help, subhead, title } from './fields.js';
import { mediaControl } from './media-field.js';
import { onState } from './live.js';
import { api, outputUrl, targetKey } from './session.js';
import { makeTakeBar } from './take-bar.js';

const $ = (id) => document.getElementById(id);
const toast = (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: message }));

const els = {
  tab: $('tab-headToHead'),
  status: $('h-status'),
  air: $('h-air'),
  airLabel: $('h-air-label'),
  show: $('h-show'),
  hide: $('h-hide'),
  swap: $('h-swap'),
  reset: $('h-reset'),
  obsUrl: $('h-obs-url'),
  open: $('h-open'),
  preview: $('h-preview'),
  teams: $('hed-teams'),
  style: $('hed-style'),
};

if (els.tab) {
  let state = null;
  let library = [];
  let fixtures = [];

  async function post(body) {
    els.status.textContent = 'Saving…';
    try {
      const response = await fetch(api('/api/headtohead', 'preview'), {
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

  function sidePicker(which) {
    const half = state[which] ?? {};
    const pick = el('select', null, { 'aria-label': `${which} team` });
    pick.append(el('option', null, { value: '' }, '- pick a team -'));
    for (const team of library) {
      pick.append(el('option', null, { value: team.id, selected: team.id === half.teamId ? 'selected' : null }, team.name));
    }
    pick.addEventListener('change', () => {
      if (!pick.value) return;
      post({ action: 'side', side: which, id: pick.value }).catch(() => {});
    });
    return pick;
  }

  function teamsPanel() {
    const fixture = el('select', null, { 'aria-label': 'From a fixture' });
    fixture.append(el('option', null, { value: '' }, fixtures.length ? '- or take both from a fixture -' : '- no fixtures yet -'));
    for (const entry of fixtures) {
      fixture.append(
        el('option', null, { value: entry.id }, `${entry.left?.name || 'TBD'} vs ${entry.right?.name || 'TBD'}`),
      );
    }
    fixture.addEventListener('change', () => {
      if (!fixture.value) return;
      post({ action: 'fixture', id: fixture.value })
        .then(() => toast('Both teams taken from that fixture.'))
        .catch(() => {});
    });

    /*
     * Which backdrop each side will actually paint, said out loud.
     *
     * The rule - the team's own key art, then the show's - is invisible until
     * it surprises somebody, and the surprise is always the same: an org whose
     * banner was never set wearing the house image and the operator assuming
     * the graphic is broken.
     */
    const backdrop = (which) => {
      const half = state[which] ?? {};
      if (half.banner) return `${half.teamName || which}: their own backdrop`;
      if (state.styleBackdrop) return `${half.teamName || which}: the house backdrop`;
      return `${half.teamName || which}: no backdrop - set one on the team, or below`;
    };

    els.teams.replaceChildren(
      title('The teams'),
      help('Each side keeps a copy of the org - its name, crest, colour and backdrop - so editing a team later never changes a graphic already on air.'),
      grid(2, [field('Left', sidePicker('left')), field('Right', sidePicker('right'))]),
      grid(null, [field('From a fixture', fixture)]),
      subhead('Backdrops'),
      el('p', 'field-help', {}, backdrop('left')),
      el('p', 'field-help', {}, backdrop('right')),
    );
  }

  function stylePanel() {
    const divider = el('input', null, { type: 'text', maxlength: 16, 'aria-label': 'Divider', placeholder: 'VS' });
    divider.value = state.divider ?? '';
    const heading = el('input', null, { type: 'text', maxlength: 40, 'aria-label': 'Heading', placeholder: 'Grand final' });
    heading.value = state.heading ?? '';

    const commit = () => {
      const patch = {};
      if ((state.divider ?? '') !== divider.value) patch.divider = divider.value;
      if ((state.heading ?? '') !== heading.value) patch.heading = heading.value;
      if (Object.keys(patch).length) save(patch);
    };
    for (const input of [divider, heading]) {
      input.addEventListener('change', commit);
      input.addEventListener('blur', commit);
    }

    const tint = el('input', null, { type: 'checkbox' });
    tint.checked = state.tint === true;
    tint.addEventListener('change', () => save({ tint: tint.checked }));
    const tintLine = el('label', 'checkline');
    tintLine.append(tint, el('span', null, {}, 'Tint each half with the org colour'));

    els.style.replaceChildren(
      title('Look'),
      grid(2, [field('Divider', divider), field('Heading', heading)]),
      help('The divider is the word between them - a grand final is not the same word as a group stage.'),
      tintLine,
      help('Off by default: a team with no colour of its own would wear the fallback red, which here reads as a SIDE rather than as a brand.'),
      subhead('House backdrop'),
      help('Used behind any team that has no backdrop of its own. Set a team\'s own on the Teams page.'),
      mediaControl(
        'House backdrop',
        () => state.styleBackdrop,
        (value) => save({ styleBackdrop: value }),
      ),
      subhead('Event logo'),
      mediaControl(
        'Event logo',
        () => state.eventLogo,
        (value) => save({ eventLogo: value }),
      ),
    );
  }

  // The style panel holds this tab's only text inputs, so it is built once and
  // never repainted - the caret rule. The teams panel has none and repaints.
  let styleBuilt = false;

  function paint() {
    if (!state) return;
    els.air.classList.toggle('is-live', Boolean(state.anim?.visible));
    els.airLabel.textContent = state.anim?.visible ? 'On preview' : 'Hidden';
    els.swap.disabled = !(state.left?.teamName || state.right?.teamName);
    teamsPanel();
    if (!styleBuilt) {
      stylePanel();
      styleBuilt = true;
    }
  }

  els.show.addEventListener('click', () =>
    save({ anim: { ...state.anim, visible: true, cue: ((state.anim?.cue ?? 0) + 1) % 1_000_000 } }),
  );
  els.hide.addEventListener('click', () => save({ anim: { ...state.anim, visible: false } }));
  els.swap.addEventListener('click', () => save({ left: state.right, right: state.left }));
  els.reset.addEventListener('click', () => {
    if (!window.confirm('Reset the head-to-head? Both teams, the backdrop and the logo all go.')) return;
    post({ reset: true }).then(() => {
      styleBuilt = false;
      paint();
    });
  });

  makeTakeBar({
    graphic: 'headToHead',
    prefix: 'h',
    programChannel: 'headToHead',
    previewChannel: 'headToHeadPreview',
    describe: (value) =>
      value.anim?.visible
        ? `On air - ${value.left?.shortName || value.left?.teamName || '?'} v ${value.right?.shortName || value.right?.teamName || '?'}`
        : 'Off air',
    isLive: (value) => Boolean(value.anim?.visible),
    toast,
  });

  onState('headToHeadPreview', (next) => {
    state = next;
    paint();
  });

  async function refresh() {
    const [mine, teams, schedule] = await Promise.all([
      fetch(api('/api/headtohead', 'preview')).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(api('/api/teams')).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(api('/api/schedule')).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (mine?.state) state = mine.state;
    library = teams?.teams ?? [];
    fixtures = schedule?.schedule?.fixtures ?? [];
    styleBuilt = false;
    paint();
  }

  refresh();
  window.addEventListener('tournament-changed', refresh);
  window.addEventListener('teams-changed', (event) => {
    library = event.detail ?? library;
    if (state) teamsPanel();
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
    const url = outputUrl('/headtohead.html', await targetKey());
    els.obsUrl.textContent = url;
    els.open.href = url;
  };
  void paintUrl();
  window.addEventListener('account-changed', () => void paintUrl());
}
