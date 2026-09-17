/**
 * The seam between the schedule and the desk, as two presses.
 *
 * `Load onto graphics` puts the chosen fixture's two teams on all three
 * PREVIEWS, its played maps on the winner graphic, and its current map on the
 * Global tab. `Report from scoreboard` reads the two round counts off the
 * preview scoreboard and files them on the fixture as one named map row. Between
 * them they are the reason a Bo3's map-score boxes stop being typed by hand.
 *
 * ## Why it is on Match setup
 *
 * Because that is what this page is for: it answers "who is in this match",
 * where the lookup tab answers "what happened in that game". Both presses
 * happen at the ends of a map - load before it starts, report when it ends -
 * which is the same rhythm the lobby board below already has.
 *
 * ## Nothing here reaches air
 *
 * `load` writes preview and only preview, so the three take bars light and the
 * operator cuts when they mean to. That is not a courtesy - it is the point of
 * the whole preview/program split, and "put the next match up" is the most
 * next-thing on the desk.
 *
 * ## The caret rule, obeyed by shape
 *
 * There is no text input in this panel at all. Two selects (a select carries no
 * caret), a derived summary line and two buttons - so the whole thing may be
 * rebuilt whenever the schedule moves, exactly like the Schedule sub-page's
 * fixture list. Anything typed here later has to bring a draft with it.
 *
 * ## No stream
 *
 * Same call `schedule-dashboard.js` makes, for its reason: six connections per
 * origin is a cap this page has already hit once, and a schedule changes when
 * somebody presses something. It refetches on open, after a report, and when
 * the tournament changes.
 */

import { el, field } from './fields.js';
import { api } from './session.js';
import {
  fixtureLabel,
  fixtureScore,
  fixtureStatus,
  mapsNeeded,
  nextMapIndex,
  slotFilled,
} from './schedule-schema.js';

const $ = (id) => document.getElementById(id);
const toast = (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: message }));

const els = {
  panel: $('fixture-panel'),
  pill: $('fixture-state'),
  body: $('fixture-body'),
};

if (els.panel && els.body) {
  /** The document as the server last answered it. Never edited here. */
  let doc = { version: 1, stages: [], fixtures: [] };
  /** Which stage is picked, and which fixture inside it. Both ids, or ''. */
  let stageId = '';
  let fixtureId = '';
  /** Which map row a report would go to. -1 means "wherever it belongs". */
  let mapIndex = -1;
  let busy = false;

  const stageOf = (id) => doc.stages.find((entry) => entry.id === id) ?? null;
  const fixturesIn = (id) => doc.fixtures.filter((fixture) => fixture.stageId === id);
  const current = () => doc.fixtures.find((fixture) => fixture.id === fixtureId) ?? null;

  function setPill(text, tone) {
    els.pill.textContent = text;
    // `pill ok` / `pill warn` - the tone is a second class, not a modifier name.
    // Same shape as the lobby panel below it, so the two read as one page.
    els.pill.className = `pill${tone ? ` ${tone}` : ''}`;
    els.pill.hidden = !text;
  }

  // -------------------------------------------------------------- the wire ---

  async function send(body) {
    const response = await fetch(api('/api/fixture'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      const { message, hint } = payload?.error ?? {};
      throw new Error([message ?? `Request failed (HTTP ${response.status}).`, hint].filter(Boolean).join(' '));
    }
    return payload;
  }

  async function refresh() {
    try {
      const response = await fetch(api('/api/schedule'));
      // A 403 is the ordinary answer for somebody with no tournament open yet,
      // so the panel stays hidden rather than reporting a failure at them.
      if (!response.ok) {
        els.panel.hidden = true;
        return;
      }
      doc = (await response.json()).schedule;
      els.panel.hidden = false;
      settle();
      paint();
    } catch {
      /* A schedule that will not load leaves the panel exactly as it was. */
    }
  }

  /** Keep the three choices pointing at things that still exist. */
  function settle() {
    if (!stageOf(stageId)) stageId = doc.stages[0]?.id ?? '';
    if (!fixturesIn(stageId).some((fixture) => fixture.id === fixtureId)) {
      fixtureId = fixturesIn(stageId)[0]?.id ?? '';
    }
    const fixture = current();
    if (!fixture || mapIndex >= fixture.bestOf) mapIndex = -1;
  }

  // ------------------------------------------------------------- the presses ---

  async function press(work, done) {
    if (busy) return;
    busy = true;
    paint();
    try {
      done(await work());
    } catch (error) {
      toast(error.message);
      setPill('That did not work', 'warn');
    } finally {
      busy = false;
      paint();
    }
  }

  const load = () =>
    press(
      () => send({ action: 'load', id: fixtureId }),
      (result) => {
        /*
         * Said out loud when nothing moved, because "it worked and changed
         * nothing" and "it did not work" look identical from a button that only
         * ever goes quiet. Pressing Load twice is the ordinary way to reach it.
         */
        if (!result.pushed.length) {
          setPill('Already loaded', 'ok');
          toast(`${result.label} is already on the previews.`);
          return;
        }
        setPill('Staged', 'ok');
        toast(
          `${result.label} staged on ${result.pushed.length} graphic${result.pushed.length === 1 ? '' : 's'}${
            result.map ? `, map set to ${result.map}` : ''
          }. Send to program when you are ready.`,
        );
      },
    );

  const report = () =>
    press(
      () => send({ action: 'report', id: fixtureId, ...(mapIndex === -1 ? {} : { index: mapIndex }) }),
      (result) => {
        doc = result.schedule;
        // Back to "wherever it belongs", so the next report lands on the next
        // map rather than overwriting the one just filed.
        mapIndex = -1;
        settle();
        setPill('Result filed', 'ok');
        // Naming the next press, because this one deliberately does not make it:
        // reporting writes the schedule and nothing else, so the winner graphic
        // still shows the series as it was when it was last loaded.
        toast(
          `Map ${result.index + 1} recorded as ${result.map.name} ${result.map.left}-${result.map.right}. ` +
            'Press Load to put it on the winner graphic.',
        );
      },
    );

  // --------------------------------------------------------------- the paint ---

  function stagePicker() {
    const select = el('select', null, { id: 'fixture-stage' });
    if (!doc.stages.length) select.append(el('option', null, { value: '' }, 'No stages yet'));
    for (const stage of doc.stages) select.append(el('option', null, { value: stage.id }, stage.name));
    select.value = stageId;
    select.disabled = !doc.stages.length || busy;
    select.addEventListener('change', () => {
      stageId = select.value;
      fixtureId = '';
      mapIndex = -1;
      settle();
      paint();
    });
    return field('Stage', select);
  }

  function fixturePicker() {
    const select = el('select', null, { id: 'fixture-pick' });
    const rows = fixturesIn(stageId);
    if (!rows.length) select.append(el('option', null, { value: '' }, 'No fixtures in this stage'));
    for (const fixture of rows) {
      const score = fixtureScore(fixture);
      const status = fixtureStatus(fixture);
      // The score only where there is one, so a fixture nobody has played does
      // not read as 0-0 - which is a result, not an absence.
      const tail = status === 'scheduled' ? '' : ` (${score.left}-${score.right})`;
      select.append(el('option', null, { value: fixture.id }, `${fixtureLabel(fixture)}${tail}`));
    }
    select.value = fixtureId;
    select.disabled = !rows.length || busy;
    select.addEventListener('change', () => {
      fixtureId = select.value;
      mapIndex = -1;
      paint();
    });
    return field('Fixture', select);
  }

  function mapPicker(fixture) {
    const select = el('select', null, { id: 'fixture-map' });
    const next = fixture ? nextMapIndex(fixture) : -1;
    select.append(
      el('option', null, { value: '' }, next === -1 ? 'Every map is played' : `Next up - map ${next + 1}`),
    );
    for (let i = 0; i < (fixture?.bestOf ?? 0); i += 1) {
      const row = fixture.maps?.[i];
      const played = row && (row.award || row.left || row.right);
      select.append(
        el(
          'option',
          null,
          { value: String(i) },
          `Map ${i + 1}${row?.name ? ` - ${row.name}` : ''}${played ? ` (${row.left}-${row.right})` : ''}`,
        ),
      );
    }
    select.value = mapIndex === -1 ? '' : String(mapIndex);
    select.disabled = !fixture || busy;
    select.addEventListener('change', () => {
      mapIndex = select.value === '' ? -1 : Number.parseInt(select.value, 10);
      paint();
    });
    return field('Report into', select);
  }

  /** What this fixture is, in one line. Derived, like everything else here. */
  function summary(fixture) {
    if (!fixture) return el('p', 'field-help fixture-summary', {}, 'Pick a fixture to stage it on the graphics.');
    const score = fixtureScore(fixture);
    const stage = stageOf(fixture.stageId);
    const bits = [
      `Best of ${fixture.bestOf}`,
      `first to ${mapsNeeded(fixture.bestOf)}`,
      `series ${score.left}-${score.right}`,
    ];
    if (stage) bits.unshift(stage.name);
    // Both sides named rather than counted, so an operator about to put this on
    // air can see WHO it is without opening the Schedule page.
    const missing = ['left', 'right'].filter((half) => !slotFilled(fixture[half]));
    if (missing.length) bits.push(`${missing.length === 2 ? 'neither side is' : 'one side is not'} filled in yet`);
    return el('p', 'field-help fixture-summary', {}, bits.join(' - '));
  }

  function paint() {
    const fixture = current();
    const rows = [];

    const picks = el('div', 'field-grid cols-2');
    picks.append(stagePicker(), fixturePicker());
    rows.push(picks, summary(fixture));

    const loadButton = el('button', 'btn btn-primary', { type: 'button', id: 'fixture-load' }, 'Load onto graphics');
    loadButton.disabled = !fixture || busy;
    loadButton.title = 'Both teams onto all three previews, the series onto the winner graphic, the map onto Global';
    loadButton.addEventListener('click', load);
    const loadRow = el('div', 'watch-actions');
    loadRow.append(loadButton);
    rows.push(loadRow);

    const reportButton = el(
      'button',
      'btn btn-ghost',
      { type: 'button', id: 'fixture-report' },
      'Report from scoreboard',
    );
    reportButton.disabled = !fixture || busy;
    reportButton.title = "The preview scoreboard's two round counts, filed on this fixture as one map";
    reportButton.addEventListener('click', report);
    const reportRow = el('div', 'watch-actions');
    reportRow.append(mapPicker(fixture), reportButton);
    rows.push(reportRow);

    rows.push(
      el(
        'p',
        'field-help',
        {},
        'Load stages - nothing reaches air until you send it to program, and the three take bars will say so. ' +
          'Report reads the PREVIEW scoreboard, which is the board you have been building during the map, and ' +
          'takes the map name from it - so set the map before you report. It writes the schedule only; press ' +
          'Load again to carry the new series score onto the winner graphic.',
      ),
    );

    els.body.replaceChildren(...rows);
  }

  refresh();
  // Built at page load, which on a fresh server happens while there is nothing
  // to read - so without this it would fetch once, get a 403 and never try
  // again. Same reason schedule-dashboard.js listens for it.
  window.addEventListener('tournament-changed', refresh);
  /*
   * And again whenever this page is opened.
   *
   * There is no schedule stream, so the copy held here goes stale the moment
   * somebody adds a fixture on the Schedule sub-page - and walking from there
   * to here to load it is the ordinary path, not an edge case. The alternative
   * is a picker that does not list the fixture the operator just made.
   */
  window.addEventListener('app-tab', (event) => {
    if (event.detail === 'setup') refresh();
  });
}
