/**
 * The Bracket graphics tab: pick a stage, load it, walk it out.
 *
 * `load` runs the SAME `bracketLayout` the Schedule sub-page draws from, on the
 * server, and stores its output - so the graphic holds a drawing rather than a
 * competition and the two cannot disagree about geometry.
 *
 * Three controls that follow from what a bracket is:
 *
 *   REVEAL counts ROUNDS. A round at a time is how a caster walks a sheet out;
 *   revealing one match of a quarter-final while its neighbour stays blank is
 *   not a thing anybody asks for.
 *
 *   FLOW animates the edges somebody actually progressed along. Off is a real
 *   choice - a static sheet under a talking head is often what is wanted.
 *
 *   The WINNER PANEL is the end of the sheet, and every field in it is copy
 *   somebody writes. It falls back to whoever won the last match, so a show
 *   that types nothing still gets the right team.
 */

import { el, field, grid, help, makeFields, setSaveStatus, subhead, title } from './fields.js';
import { confirmDanger } from './modal.js';
import { mediaControl } from './media-field.js';
import { onState } from './live.js';
import { DEFAULT_BRAND, brandOf } from './brand.js';
import { api, outputUrl, targetKey } from './session.js';
import { REVERT_NOTE, makeTakeBar } from './take-bar.js';
import {
  BRACKET_SCALE_MAX,
  BRACKET_SCALE_MIN,
  BRACKET_SCALE_STEP,
  bracketChampion,
  bracketFromStage,
  bracketIsStale,
} from './bracket-graphic-schema.js';
import { bracketLayout, fixtureScore, fixtureWinner } from './schedule-schema.js';

const $ = (id) => document.getElementById(id);

/*
 * The event's colours, so a blank field can SHOW what it inherits.
 *
 * The VALUE is module-level and the LISTENER is not, and that split is the
 * whole of a bug that shipped. `fields` is created inside `if (els.tab)`, so a
 * subscription registered out here called a name that does not exist in this
 * scope - every brand frame threw `fields is not defined`, `live.js` caught it
 * and reported it with console.warn, and nothing else happened. The bracket's
 * two swatches simply stopped following the event: change the tournament accent
 * and the OUTPUT page repainted (bracket.js subscribes separately and was fine)
 * while the operator's own picker kept showing the old colour. The desk
 * disagreeing with air, silently, on the one graphic whose comment already
 * warns that its two colours are easy to get the wrong way round.
 *
 * It never threw on a plain load, which is why no suite caught it: the brand store
 * is silent when nothing moved, so the only frame that reaches this is the one
 * an operator provokes by restyling the show mid-season.
 */
let brand = { ...DEFAULT_BRAND };

const toast = (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: message }));

const els = {
  tab: $('tab-bracket'),
  status: $('b-status'),
  air: $('b-air'),
  airLabel: $('b-air-label'),
  show: $('b-show'),
  hide: $('b-hide'),
  none: $('b-none'),
  back: $('b-back'),
  next: $('b-next'),
  all: $('b-all'),
  note: $('b-reveal-note'),
  reset: $('b-reset'),
  obsUrl: $('b-obs-url'),
  open: $('b-open'),
  preview: $('b-preview'),
  stage: $('bed-stage'),
  colours: $('bed-colours'),
  style: $('bed-style'),
};

if (els.tab) {
  let state = null;
  let schedule = { stages: [], fixtures: [] };
  let chosen = '';

  async function post(body) {
    setSaveStatus(els.status, 'saving', 'Saving...');
    try {
      const response = await fetch(api('/api/bracket', 'preview'), {
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

  /*
   * The shared field builders, pointed at the live state.
   *
   * `makeFields` writes through `writePath` into whatever the getter returns
   * and then calls back - so a colour picker mutates `state` in place and the
   * callback posts it. Using the shared builder rather than hand-rolling an
   * `<input type=color>` is the standing rule about schema-driven controls, and
   * it is what gets the bound-and-resynced behaviour for free.
   */
  const fields = makeFields(
    () => state,
    () => save({}),
  );

  /*
   * SYNC, never rebuild. The style panel is painted once and never again - the
   * caret rule - and a brandField's swatch is bound, so `syncFields` moves it
   * without replacing the box somebody may be typing into. A repaint here would
   * undo the very property this panel is built once to protect.
   *
   * Registered HERE, next to what it calls, which is what the lineup, the
   * head-to-head and the veto board already do. The two dashboards that
   * subscribe at module scope can only do so because their `fields` is at
   * module scope too.
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
  const freshDrawing = (stageId) => {
    const stage = schedule.stages?.find((entry) => entry.id === stageId);
    if (!stage) return null;
    return bracketFromStage({
      layout: bracketLayout(schedule, stageId),
      stage,
      score: fixtureScore,
      winnerOf: fixtureWinner,
    });
  };

  function stagePanel() {
    const wanted = chosen || state.stageId;
    const stale = bracketIsStale(state, freshDrawing(wanted));

    const pick = el('select', null, { 'aria-label': 'Which stage' });
    const bracketStages = (schedule.stages ?? []).filter((stage) => stage.kind === 'bracket');
    pick.append(el('option', null, { value: '' }, bracketStages.length ? '- pick a stage -' : '- no bracket stages yet -'));
    for (const stage of bracketStages) {
      const count = (schedule.fixtures ?? []).filter((fixture) => fixture.stageId === stage.id).length;
      pick.append(
        el('option', null, { value: stage.id, selected: stage.id === wanted ? 'selected' : null }, `${stage.name} (${count})`),
      );
    }
    pick.addEventListener('change', () => {
      chosen = pick.value;
      paint();
    });

    const load = el('button', 'btn btn-primary', { type: 'button' }, state.stageId ? 'Load again' : 'Load onto the graphic');
    load.disabled = !wanted;
    load.addEventListener('click', () =>
      post({ action: 'load', id: wanted })
        .then(() => toast('Bracket loaded onto preview. Reveal the rounds when you are ready.'))
        .catch(() => {}),
    );

    const champion = bracketChampion(state);

    els.stage.replaceChildren(
      title('The draw'),
      help(
        'A copy of the bracket, taken when you press Load - the same drawing the Schedule page shows. Nothing ' +
          'keeps it in step afterwards, on purpose: this is the graphic most likely to be up while somebody is ' +
          'filing results behind it.',
      ),
      grid(null, [field('Stage', pick)]),
      ...(stale
        ? [el('p', 'field-help is-warn', {}, 'The draw has moved since this was loaded. Press Load again to catch up.')]
        : []),
      load,
      ...(state.nodes?.length
        ? [
            el(
              'p',
              'field-help',
              {},
              `${state.nodes.length} matches across ${state.columns} round${state.columns === 1 ? '' : 's'}` +
                (champion ? ` - ${champion.shortName || champion.name} have won it.` : '.'),
            ),
          ]
        : []),
    );
  }

  /**
   * The two colours, and nothing else.
   *
   * ACCENT is the highlight - the slot of whoever went through, the flow along
   * the edges, the eyebrow. TRIM is the frame, which today is the winner
   * panel's corner marks. Two fields rather than one because they mean
   * different things: one says "this team won" and the other is the show's
   * furniture, and a single colour for both makes the winner's slot the same
   * colour as a decoration.
   *
   * Built once, like the style card, because both hold inputs.
   */
  function coloursPanel() {
    els.colours.replaceChildren(
      title('Colours'),
      help(
        'Both follow the tournament unless you set one here. Reset to default on a control puts it back to the ' +
          'event\'s colour - set once on the Tournament page and shared by every graphic.',
      ),
      /*
       * The KEYS here disagree with the words, and the words are the ones an
       * operator reads. `accent` in this graphic's state is the HIGHLIGHT and
       * `trim` is the accent - see the schema. So the event's HIGHLIGHT is what
       * the left control inherits and the event's ACCENT is what the right one
       * does, which is why the two `which` arguments look swapped and are not.
       */
      grid(2, [
        fields.brandField('Highlight', 'accent', { inherited: () => brand.highlight }),
        fields.brandField('Trim', 'trim', { inherited: () => brand.accent }),
      ]),
      help(
        'Highlight marks the team that went through, and runs along the bracket as the flow. Trim is the frame - ' +
          'the corner marks on the winner panel. Leave either blank and it follows the tournament.',
      ),
    );
  }

  function stylePanel() {
    const heading = el('input', null, { type: 'text', maxlength: 40, 'aria-label': 'Heading', placeholder: 'Playoffs' });
    heading.value = state.heading ?? '';

    const panel = state.winner ?? {};
    const inputs = {
      wHeading: el('input', null, { type: 'text', maxlength: 24, 'aria-label': 'Winner heading', placeholder: '1ST PLACE' }),
      wLabel: el('input', null, { type: 'text', maxlength: 24, 'aria-label': 'Winner label', placeholder: 'falls back to the winning team' }),
      wFooter: el('input', null, { type: 'text', maxlength: 24, 'aria-label': 'Winner footer', placeholder: 'WINNER' }),
    };
    inputs.wHeading.value = panel.heading ?? '';
    inputs.wLabel.value = panel.label ?? '';
    inputs.wFooter.value = panel.footer ?? '';

    // On blur rather than per keystroke: each of these writes through the
    // server and repaints a graphic that may be on preview beside you.
    const commit = () => {
      const next = {
        heading: heading.value,
        winner: {
          ...panel,
          heading: inputs.wHeading.value,
          label: inputs.wLabel.value,
          footer: inputs.wFooter.value,
        },
      };
      if (JSON.stringify({ h: state.heading, w: state.winner }) !== JSON.stringify({ h: next.heading, w: next.winner })) {
        save(next);
      }
    };
    for (const input of [heading, ...Object.values(inputs)]) {
      input.addEventListener('change', commit);
      input.addEventListener('blur', commit);
    }

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
      toggle('Animate the flow along the bracket', () => state.flow !== false, (on) => save({ flow: on })),
      help('Only the edges somebody actually came along move. An edge into an undecided match is drawn and stays still.'),
      toggle('Show map scores', () => state.showScores !== false, (on) => save({ showScores: on })),

      /*
       * Size, and it is two controls rather than one because they answer two
       * different questions.
       *
       * The switch is "should the sheet use the room it has" - a four-team draw
       * is 524 pixels of ink in the 1408 the frame gives it, and left alone it
       * reads as a graphic built for a different show. The slider is "and how
       * much bigger than that do I want it", which is a judgement about a
       * camera, a venue screen and how far back the audience is sitting, and
       * nothing here can make it from a column count.
       */
      subhead('Size'),
      toggle('Fit the sheet to the frame', () => state.autoSize !== false, (on) => save({ autoSize: on })),
      help(
        'A small draw is drawn larger so it reads from across a room, up to about double. A draw that already ' +
          'fills the frame is left alone. Turning the winner panel on re-fits it, because the panel takes the room.',
      ),
      fields.rangeField('Adjustment', 'drawScale', {
        min: BRACKET_SCALE_MIN,
        max: BRACKET_SCALE_MAX,
        step: BRACKET_SCALE_STEP,
        // A percentage, because 100% reads as "the size it was" far more
        // directly than 1.00 does - and this slider has a default worth getting
        // back to rather than a taste to be dialled in.
        readout: (value) => `${Math.round(value * 100)}%`,
      }),
      help(
        'Your own adjustment, on top of the fit above. Switch the fit off and this is the size on its own, ' +
          'at 100% exactly the size every bracket was drawn at before.',
      ),

      subhead('The winner panel'),
      toggle('Show it', () => Boolean(state.winner?.show), (on) => save({ winner: { ...state.winner, show: on } })),
      grid(2, [field('Heading', inputs.wHeading), field('Label', inputs.wLabel)]),
      grid(null, [field('Top and bottom', inputs.wFooter)]),
      help('Leave the label blank and it names whoever won the last match. The image does the same with their crest.'),
      mediaControl(
        'Winner image',
        () => state.winner?.image ?? '',
        (value) => save({ winner: { ...state.winner, image: value } }),
      ),

      subhead('Event logo'),
      mediaControl(
        'Event logo',
        () => state.eventLogo,
        (value) => save({ eventLogo: value }),
      ),
    );
  }

  /*
   * The style panel holds every text input on this tab, so it is built ONCE and
   * never repainted - the caret rule. The stage panel has none and repaints on
   * every push.
   */
  let styleBuilt = false;

  function paint() {
    if (!state) return;

    const shown = state.reveal ?? 0;
    const total = state.columns ?? 0;
    els.note.textContent = total ? `${shown} of ${total} rounds shown` : 'nothing loaded yet';
    els.next.disabled = shown >= total;
    els.back.disabled = shown <= 0;
    els.all.disabled = !total || shown >= total;
    els.none.disabled = shown <= 0;

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
  els.next.addEventListener('click', () => post({ action: 'reveal' }));
  els.back.addEventListener('click', () => post({ action: 'reveal', to: (state.reveal ?? 0) - 1 }));
  els.all.addEventListener('click', () => post({ action: 'reveal', to: state.columns ?? 0 }));
  els.none.addEventListener('click', () => post({ action: 'reveal', to: 0 }));
  els.reset.addEventListener('click', async () => {
    const ok = await confirmDanger({
      title: 'Reset the bracket graphic?',
      lines: [
        'The loaded draw, the winner panel, the event logo and the look all go. The DRAW itself is safe - this ' +
          'graphic holds a copy of it, and Load puts it back.',
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
    graphic: 'bracket',
    prefix: 'b',
    programChannel: 'bracket',
    previewChannel: 'bracketPreview',
    describe: (value) =>
      value.anim?.visible ? `On air - ${value.reveal ?? 0} of ${value.columns ?? 0} rounds` : 'Off air',
    isLive: (value) => Boolean(value.anim?.visible),
    toast,
  });

  onState('bracketPreview', (next) => {
    state = next;
    paint();
  });

  async function refresh() {
    const [mine, sched] = await Promise.all([
      fetch(api('/api/bracket', 'preview')).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(api('/api/schedule')).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (mine?.state) state = mine.state;
    schedule = sched?.schedule ?? { stages: [], fixtures: [] };
    styleBuilt = false;
    paint();
  }

  refresh();
  window.addEventListener('tournament-changed', refresh);
  // The draw moves on the Schedule page, which is where somebody files a
  // result. Arriving here is the moment to re-read it.
  window.addEventListener('app-tab', (event) => {
    if (event.detail === 'bracket') refresh();
  });

  /*
   * The preview iframe is NOT loaded here - it carries `data-src` and
   * dashboard.js loads it on first open. Six HTTP/1.1 connections per origin,
   * one SSE stream each: an eager preview spends one of them before anybody has
   * looked at the tab, and the seventh request does not fail, it queues for
   * ever. See CLAUDE.md.
   */
  const paintUrl = async () => {
    const url = outputUrl('/bracket.html', await targetKey());
    els.obsUrl.textContent = url;
    els.open.href = url;
  };
  void paintUrl();
  window.addEventListener('account-changed', () => void paintUrl());
}
