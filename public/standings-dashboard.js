/**
 * The Standings graphics tab: pick a stage, load its tables, walk the pools.
 *
 * `load` runs the SAME `stageTables` the Schedule sub-page draws its tables
 * from, on the server, and stores its output - so the graphic holds a TABLE
 * rather than a competition, and the desk and the air cannot disagree about who
 * is second.
 *
 * Three controls that follow from what a table is:
 *
 *   LAYOUT is all the pools at once or one at a time. Both are real answers: a
 *   four-pool group stage fits at two-by-two and reads fine, while a caster
 *   walking the groups out one at a time wants one table filling the frame.
 *
 *   THE GROUP is an INDEX, not a filter, so Next and Back walk the pools - and
 *   it is not the cue. Stepping to Group C animates Group C in and leaves the
 *   board it sits on where it is.
 *
 *   QUALIFY marks how many PLACES go through, and it is counted in ranks rather
 *   than rows. With 1, 2, 2, 4 and a cut of two, three teams are marked -
 *   because the table shares a rank on purpose and a graphic must not invent an
 *   order the table refuses to have.
 */

import { el, field, grid, help, makeFields, setSaveStatus, subhead, title } from './fields.js';
import { confirmDanger } from './modal.js';
import { mediaControl } from './media-field.js';
import { onState } from './live.js';
import { DEFAULT_BRAND, brandOf } from './brand.js';
import { api, outputUrl, targetKey } from './session.js';
import { REVERT_NOTE, makeTakeBar } from './take-bar.js';
import {
  STANDINGS_LAYOUTS,
  STANDINGS_ROW_LIMIT,
  STANDINGS_SCALE_MAX,
  STANDINGS_SCALE_MIN,
  STANDINGS_SCALE_STEP,
  standingsFromStage,
  standingsIsStale,
} from './standings-schema.js';
import { stageHasTable, stageTables } from './schedule-schema.js';

const $ = (id) => document.getElementById(id);

/*
 * The event's colours, so a blank field can SHOW what it inherits.
 *
 * The VALUE is module-level and the LISTENER is not, which is the shape the
 * bracket's own bug taught: `fields` is built inside `if (els.tab)`, so a
 * subscription registered out here would call a name that does not exist in
 * this scope, throw on every brand frame, and be swallowed into a console line.
 * Register the listener beside what it calls.
 */
let brand = { ...DEFAULT_BRAND };

const toast = (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: message }));

const els = {
  tab: $('tab-standings'),
  status: $('st-status'),
  air: $('st-air'),
  airLabel: $('st-air-label'),
  show: $('st-show'),
  hide: $('st-hide'),
  first: $('st-first'),
  back: $('st-back'),
  next: $('st-next'),
  note: $('st-group-note'),
  reset: $('st-reset'),
  obsUrl: $('st-obs-url'),
  open: $('st-open'),
  preview: $('st-preview'),
  stage: $('sted-stage'),
  colours: $('sted-colours'),
  style: $('sted-style'),
};

if (els.tab) {
  let state = null;
  let schedule = { stages: [], fixtures: [] };
  let chosen = '';

  async function post(body) {
    setSaveStatus(els.status, 'saving', 'Saving...');
    try {
      const response = await fetch(api('/api/standings', 'preview'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error([payload?.error?.message, payload?.error?.hint].filter(Boolean).join(' '));
      state = payload.state;
      setSaveStatus(els.status, '', 'Saved');
      paint();
      return payload;
    } catch (error) {
      setSaveStatus(els.status, 'failed', 'Not saved');
      toast(error.message);
      throw error;
    }
  }

  const save = (patch) => post({ state: { ...state, ...patch } });

  const fields = makeFields(
    () => state,
    () => save({}),
  );

  /*
   * SYNC, never rebuild. The style panel is painted once and never again - the
   * caret rule - and a bound swatch or slider is moved by `syncFields` without
   * replacing the control somebody may be dragging. A repaint here would undo
   * the very property this panel is built once to protect.
   */
  onState('brand', (next) => {
    brand = brandOf(next);
    fields.syncFields();
  });

  /**
   * What the stage would draw as RIGHT NOW, for the staleness note.
   *
   * Computed in the browser from the same pure function the server used, which
   * is the point of that function being pure: comparing "what is loaded" with
   * "what the schedule says now" costs no round trip and cannot disagree with
   * what Load would produce.
   */
  const freshTables = (stageId) => {
    const stage = schedule.stages?.find((entry) => entry.id === stageId);
    if (!stage || !stageHasTable(stage)) return null;
    return standingsFromStage({ tables: stageTables(schedule, stage), stage });
  };

  function stagePanel() {
    const wanted = chosen || state.stageId;
    const stale = standingsIsStale(state, freshTables(wanted));

    const pick = el('select', null, { 'aria-label': 'Which stage' });
    /*
     * GROUPS AND ROUND ROBINS ONLY, which is `stageHasTable` rather than a
     * kind comparison written out again here. A bracket has no standings -
     * nobody is ranked in a knockout, they are eliminated - and although
     * `standings` would happily count its fixtures and answer with a table,
     * that table means nothing. The server refuses it too; this is the
     * courtesy, not the rule.
     */
    const tableStages = (schedule.stages ?? []).filter(stageHasTable);
    pick.append(
      el('option', null, { value: '' }, tableStages.length ? '- pick a stage -' : '- no group or league stages yet -'),
    );
    for (const stage of tableStages) {
      const count = (schedule.fixtures ?? []).filter((fixture) => fixture.stageId === stage.id).length;
      pick.append(
        el('option', null, { value: stage.id, selected: stage.id === wanted ? 'selected' : null }, `${stage.name} (${count})`),
      );
    }
    pick.addEventListener('change', () => {
      chosen = pick.value;
      paint();
    });

    const load = el(
      'button',
      'btn btn-primary',
      { type: 'button' },
      state.stageId ? 'Load again' : 'Load onto the graphic',
    );
    load.disabled = !wanted;
    load.addEventListener('click', () =>
      post({ action: 'load', id: wanted })
        .then(() => toast('Standings loaded onto preview.'))
        .catch(() => {}),
    );

    const groups = state.groups ?? [];
    const teams = groups.reduce((sum, entry) => sum + (entry.rows?.length ?? 0), 0);

    els.stage.replaceChildren(
      title('The table'),
      help(
        'A copy of the standings, taken when you press Load - the same table the Schedule page shows. Nothing ' +
          'keeps it in step afterwards, on purpose: this is a graphic that goes up while somebody is filing ' +
          'results behind it.',
      ),
      grid(null, [field('Stage', pick)]),
      ...(stale
        ? [el('p', 'field-help is-warn', {}, 'The table has moved since this was loaded. Press Load again to catch up.')]
        : []),
      load,
      ...(teams
        ? [
            el(
              'p',
              'field-help',
              {},
              `${teams} team${teams === 1 ? '' : 's'} across ${groups.length} ` +
                `${groups.length === 1 ? 'table' : 'tables'}.`,
            ),
          ]
        : []),
      help(
        'Teams on equal wins share a rank - 1, 2, 2, 4 - because a real rulebook breaks that tie head to head. ' +
          'The graphic shows what the table says and puts nobody in an order the table does not have.',
      ),
    );
  }

  /**
   * The two colours, and nothing else.
   *
   * ACCENT is the trim - the rule under the column heads, the eyebrow, the
   * furniture. HIGHLIGHT is what went through. Unlike the bracket, whose two
   * fields are named the other way round from what they mean, these two say
   * what they are, so each inherits the event field of the same name.
   */
  function coloursPanel() {
    els.colours.replaceChildren(
      title('Colours'),
      help(
        'Both follow the tournament unless you set one here. Reset to default on a control puts it back to the ' +
          "event's colour - set once on the Tournament page and shared by every graphic.",
      ),
      grid(2, [
        fields.brandField('Accent', 'accent', { inherited: () => brand.accent }),
        fields.brandField('Highlight', 'highlight', { inherited: () => brand.highlight }),
      ]),
      help(
        'Accent is the frame - the rule under the column heads and the line above the stage name. Highlight marks ' +
          'the places that go through, and is drawn only when there is a cut set below.',
      ),
    );
  }

  function stylePanel() {
    const heading = el('input', null, { type: 'text', maxlength: 40, 'aria-label': 'Heading', placeholder: 'Group stage' });
    heading.value = state.heading ?? '';

    // On blur rather than per keystroke: this writes through the server and
    // repaints a graphic that may be on preview beside you.
    const commit = () => {
      if ((state.heading ?? '') !== heading.value) save({ heading: heading.value });
    };
    heading.addEventListener('change', commit);
    heading.addEventListener('blur', commit);

    const toggle = (label, get, set) => {
      const box = el('input', null, { type: 'checkbox' });
      box.checked = get();
      box.addEventListener('change', () => set(box.checked));
      const line = el('label', 'checkline');
      line.append(box, el('span', null, {}, label));
      return line;
    };

    els.style.replaceChildren(
      title('Look'),
      grid(null, [field('Heading', heading)]),
      help('The small line above the stage name.'),

      subhead('Layout'),
      fields.choiceField('Which tables', 'layout', STANDINGS_LAYOUTS),
      help(
        'One at a time gives a single table the whole frame and puts Back and Next on the transport above. Every ' +
          'group at once arranges them in whichever grid leaves the tables biggest - four pools go two by two.',
      ),

      subhead('Columns'),
      toggle('Show crests', () => state.showLogos !== false, (on) => save({ showLogos: on })),
      toggle('Show the win-loss record', () => state.showRecord !== false, (on) => save({ showRecord: on })),
      toggle('Show maps won and lost', () => state.showMaps !== false, (on) => save({ showMaps: on })),
      toggle('Show the round difference', () => state.showRounds === true, (on) => save({ showRounds: on })),
      help(
        'There is no "played" column and there cannot be one: a VALORANT match has no draw and an unfinished one ' +
          'counts for neither side, so played is always wins plus losses.',
      ),

      subhead('Qualification'),
      fields.numberField('Places through', 'qualify', { min: 0, max: STANDINGS_ROW_LIMIT }),
      help(
        'Marks the top places in the highlight colour, in every table. Zero draws nothing, which is the right ' +
          'answer for a league table mid-season. It counts PLACES, not rows - so if two teams are tied for ' +
          'second and two go through, both are marked, because the table cannot separate them and this must not ' +
          'pretend it can.',
      ),

      /*
       * Size, and it is two controls rather than one because they answer two
       * different questions. The switch is "should the board use the room it
       * has"; the slider is "and how much bigger than that do I want it", which
       * is a judgement about a camera and a venue screen that nothing here can
       * make from a row count.
       */
      subhead('Size'),
      toggle('Fit the tables to the frame', () => state.autoSize !== false, (on) => save({ autoSize: on })),
      help(
        'One table is drawn larger so it reads from across a room; sixteen pools are drawn smaller so they fit ' +
          'the frame at all. Unlike the bracket, this one is allowed to shrink - it has never been on air at a ' +
          'fixed size, so there is nothing to preserve.',
      ),
      fields.rangeField('Adjustment', 'boardScale', {
        min: STANDINGS_SCALE_MIN,
        max: STANDINGS_SCALE_MAX,
        step: STANDINGS_SCALE_STEP,
        readout: (value) => `${Math.round(value * 100)}%`,
      }),
      help('Your own adjustment, on top of the fit above. Switch the fit off and this is the size on its own.'),

      subhead('Event logo'),
      mediaControl(
        'Event logo',
        () => state.eventLogo,
        (value) => save({ eventLogo: value }),
      ),
    );
  }

  /*
   * The style panel holds the only text input on this tab, so it is built ONCE
   * and never repainted - the caret rule. It also holds the size slider, which
   * needs the same protection for a different reason: a save fires on every
   * frame of a drag, and a rebuilt panel would replace the handle under the
   * cursor. The stage panel has neither and repaints on every push.
   */
  let styleBuilt = false;

  function paint() {
    if (!state) return;

    const groups = state.groups ?? [];
    const one = state.layout === 'one';
    const at = Math.min(state.group ?? 0, Math.max(0, groups.length - 1));

    els.note.textContent = !groups.length
      ? 'nothing loaded yet'
      : one
        ? `showing ${groups[at]?.name || 'the table'} - ${at + 1} of ${groups.length}`
        : `showing all ${groups.length} ${groups.length === 1 ? 'table' : 'tables'}`;

    // Dead unless there is somewhere to step TO. A button that does nothing is
    // a button that teaches nothing.
    els.next.disabled = !one || at >= groups.length - 1;
    els.back.disabled = !one || at <= 0;
    els.first.disabled = !one || at <= 0;

    els.air.classList.toggle('is-live', Boolean(state.anim?.visible));
    els.airLabel.textContent = state.anim?.visible ? 'On preview' : 'Hidden';

    stagePanel();
    if (!styleBuilt) {
      stylePanel();
      coloursPanel();
      styleBuilt = true;
    }
  }

  els.show.addEventListener('click', () =>
    save({ anim: { ...state.anim, visible: true, cue: ((state.anim?.cue ?? 0) + 1) % 1_000_000 } }),
  );
  els.hide.addEventListener('click', () => save({ anim: { ...state.anim, visible: false } }));
  els.next.addEventListener('click', () => post({ action: 'group' }));
  els.back.addEventListener('click', () => post({ action: 'group', to: (state.group ?? 0) - 1 }));
  els.first.addEventListener('click', () => post({ action: 'group', to: 0 }));
  els.reset.addEventListener('click', async () => {
    const ok = await confirmDanger({
      title: 'Reset the standings graphic?',
      lines: [
        'The loaded tables, the columns, the qualification cut, the event logo and the look all go. The ' +
          'COMPETITION is safe - this graphic holds a copy of the table, and Load puts it back.',
        REVERT_NOTE,
      ],
      confirm: 'Reset it',
    });
    if (!ok) return;
    post({ reset: true }).then(() => {
      styleBuilt = false;
      paint();
    });
  });

  makeTakeBar({
    graphic: 'standings',
    prefix: 'st',
    programChannel: 'standings',
    previewChannel: 'standingsPreview',
    describe: (value) => {
      if (!value.anim?.visible) return 'Off air';
      const groups = value.groups ?? [];
      if (value.layout !== 'one') return `On air - all ${groups.length} tables`;
      const at = Math.min(value.group ?? 0, Math.max(0, groups.length - 1));
      return `On air - ${groups[at]?.name || 'the table'}`;
    },
    isLive: (value) => Boolean(value.anim?.visible),
    toast,
  });

  onState('standingsPreview', (next) => {
    state = next;
    paint();
  });

  async function refresh() {
    const [mine, sched] = await Promise.all([
      fetch(api('/api/standings', 'preview')).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(api('/api/schedule')).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (mine?.state) state = mine.state;
    schedule = sched?.schedule ?? { stages: [], fixtures: [] };
    styleBuilt = false;
    paint();
  }

  refresh();
  window.addEventListener('tournament-changed', refresh);
  // The table moves on the Schedule page, which is where somebody files a
  // result. Arriving here is the moment to re-read it.
  window.addEventListener('app-tab', (event) => {
    if (event.detail === 'standings') refresh();
  });

  /*
   * The preview iframe is NOT loaded here - it carries `data-src` and
   * dashboard.js loads it on first open. Six HTTP/1.1 connections per origin,
   * one SSE stream each: an eager preview spends one of them before anybody has
   * looked at the tab, and the seventh request does not fail, it queues for
   * ever. See CLAUDE.md.
   */
  const paintUrl = async () => {
    const url = outputUrl('/standings.html', await targetKey());
    els.obsUrl.textContent = url;
    els.open.href = url;
  };
  void paintUrl();
  window.addEventListener('account-changed', () => void paintUrl());
}
