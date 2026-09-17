/**
 * The Schedule sub-page: stages, the fixtures inside them, and the table that
 * falls out of the results.
 *
 * ## The caret rule, and how this page obeys it
 *
 * `winner-dashboard.js`'s roster editor records the rule: rebuilding a block
 * replaces the input being typed into, and the caret goes with it. The shape
 * that follows here is deliberate and worth stating, because it is what keeps
 * the rest of the page free to repaint:
 *
 *   the fixture LIST has no text inputs at all. It is rows of read-only
 *   summaries and buttons, so it may be rebuilt on every change.
 *
 *   the RESULT EDITOR has all of them, holds a draft, writes into that draft
 *   on every keystroke and repaints nothing. One fixture is open at a time.
 *
 * A derived view - the table, the round headings - may repaint on every
 * keystroke precisely because it contains no inputs.
 *
 * ## It works out the table itself
 *
 * `/api/schedule` answers with the document verbatim: no standings, no resolved
 * slots, no bracket columns. All three are pure functions of what is already in
 * the payload, and a second implementation on the server is one refactor from
 * disagreeing with this one - which would show as a table on the desk that does
 * not match the one in the editor, with nothing failing.
 *
 * ## No stream
 *
 * Like `tournament-dashboard.js`, and for its reason: six connections per
 * origin is a cap this page has already hit once. A schedule changes when
 * somebody presses something here, so a refetch after a write is the whole of
 * what it needs. The cost is honest - two people editing one schedule will not
 * see each other until one reloads.
 */

import { el, grid, help, title } from './fields.js';
import { api } from './session.js';
import { EMPTY_TEAM, TEAM_KEYS, teamLabel } from './teams.js';
import {
  BEST_OF_CHOICES,
  BRACKET_HALVES,
  STAGE_KINDS,
  emptyMapRow,
  fixtureLabel,
  fixtureScore,
  fixtureStatus,
  fixtureWinner,
  mapsNeeded,
  slotLabel,
  stageHasTable,
  standings,
} from './schedule-schema.js';

const $ = (id) => document.getElementById(id);
const toast = (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: message }));

const host = $('sch-body');

if (host) {
  /** The document as the server last answered it. Never edited in place. */
  let doc = { version: 1, stages: [], fixtures: [] };
  /** The team library, for the pickers. Kept in step by the same event the graphics use. */
  let library = [];
  /** Which stage is on screen. A slug, or '' for none. */
  let openStage = '';
  /** Which fixture's result is open, or ''. One at a time - see the caret note. */
  let openFixture = '';
  /** The result being edited. A copy, so cancelling costs nothing. */
  let draft = null;
  let loaded = false;

  // ------------------------------------------------------------- the wire ---

  async function send(body) {
    const response = await fetch(api('/api/schedule'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      const { message, hint } = payload?.error ?? {};
      throw new Error([message ?? `Request failed (HTTP ${response.status}).`, hint].filter(Boolean).join(' '));
    }
    doc = payload.schedule;
    return payload;
  }

  const act = async (body, after) => {
    try {
      await send(body);
      after?.();
      paint();
    } catch (error) {
      toast(error.message);
    }
  };

  async function refresh() {
    try {
      const response = await fetch(api('/api/schedule'));
      if (!response.ok) return;
      doc = (await response.json()).schedule;
      loaded = true;
      if (!openStage) openStage = doc.stages[0]?.id ?? '';
      paint();
    } catch {
      /* A schedule that will not load leaves the panel as it was. */
    }
  }

  // ------------------------------------------------------------ the stages ---

  const stageOf = (id) => doc.stages.find((entry) => entry.id === id) ?? null;
  const fixturesIn = (id) => doc.fixtures.filter((fixture) => fixture.stageId === id);

  function stageStrip() {
    const row = el('div', 'sch-stages');

    for (const stage of doc.stages) {
      const pill = el(
        'button',
        `sch-stage${stage.id === openStage ? ' is-open' : ''}`,
        { type: 'button' },
        `${stage.name} (${fixturesIn(stage.id).length})`,
      );
      pill.addEventListener('click', () => {
        openStage = stage.id;
        openFixture = '';
        draft = null;
        paint();
      });
      row.append(pill);
    }

    const add = el('button', 'btn btn-small', { type: 'button' }, 'Add stage');
    add.addEventListener('click', () => {
      const name = window.prompt('What is this stage called?\n\ne.g. Group A, Playoffs, Grand Final');
      if (!name?.trim()) return;
      act({ action: 'stage.save', stage: { name: name.trim(), kind: 'bracket', bestOf: 3 } }, () => {
        openStage = doc.stages.find((entry) => entry.name === name.trim())?.id ?? openStage;
      });
    });
    row.append(add);

    return row;
  }

  function stageSettings(stage) {
    const card = el('div', 'sch-stage-settings');

    const kind = el('select', null, { 'aria-label': 'Stage kind' });
    for (const entry of STAGE_KINDS) {
      kind.append(el('option', null, { value: entry.key, selected: entry.key === stage.kind ? 'selected' : null }, entry.label));
    }
    kind.addEventListener('change', () => act({ action: 'stage.save', stage: { ...stage, kind: kind.value } }));

    const best = el('select', null, { 'aria-label': 'Default series length' });
    for (const value of BEST_OF_CHOICES) {
      best.append(el('option', null, { value: String(value), selected: value === stage.bestOf ? 'selected' : null }, `Best of ${value}`));
    }
    best.addEventListener('change', () =>
      act({ action: 'stage.save', stage: { ...stage, bestOf: Number(best.value) } }),
    );

    const gen = el('button', 'btn btn-small', { type: 'button' }, 'Generate fixtures');
    gen.addEventListener('click', () => generate(stage));

    const drop = el('button', 'btn btn-small btn-ghost', { type: 'button' }, 'Remove stage');
    drop.addEventListener('click', () => {
      const holding = fixturesIn(stage.id).length;
      if (holding) {
        // The server refuses this too. Saying so here means the operator finds
        // out before a round trip, and finds out what to do about it.
        toast(`"${stage.name}" still holds ${holding} fixture${holding === 1 ? '' : 's'}. Remove them first.`);
        return;
      }
      if (!window.confirm(`Remove "${stage.name}"?`)) return;
      act({ action: 'stage.remove', id: stage.id }, () => {
        openStage = doc.stages[0]?.id ?? '';
      });
    });

    card.append(
      el('span', 'sch-label', {}, 'Kind'),
      kind,
      el('span', 'sch-label', {}, 'Series'),
      best,
      gen,
      drop,
    );
    return card;
  }

  /**
   * Lay a stage out from the team library in one press.
   *
   * It ADDS. A button that silently discarded a half-recorded group would be
   * the worst kind of convenience, so an operator who wants a clean slate
   * removes the fixtures and sees how many they are removing. The server
   * enforces the same thing.
   */
  function generate(stage) {
    if (library.length < 2) {
      toast('Add at least two teams to the library first.');
      return;
    }
    const existing = fixturesIn(stage.id).length;
    const note = existing ? `\n\nThis ADDS to the ${existing} already here - it does not replace them.` : '';
    const picked = window.prompt(
      `Which teams are in "${stage.name}"?\n\nComma-separated, from the library:\n${library.map(teamLabel).join(', ')}${note}`,
      library.map(teamLabel).join(', '),
    );
    if (picked === null) return;

    const wanted = picked
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean)
      .map((name) => library.find((team) => teamLabel(team).toLowerCase() === name || team.name.toLowerCase() === name))
      .filter(Boolean);

    if (wanted.length < 2) {
      toast('Could not match at least two teams to the library.');
      return;
    }
    act({ action: 'generate', stageId: stage.id, teams: wanted.map(asSlot) });
  }

  /** A library team as a fixture slot: the fields copied, never the id resolved later. */
  const asSlot = (team) => {
    const slot = { teamId: team.id };
    for (const key of TEAM_KEYS) slot[key] = team[key] ?? EMPTY_TEAM[key];
    return slot;
  };

  // ----------------------------------------------------------- the fixtures ---

  const STATUS_LABEL = { scheduled: 'Scheduled', live: 'In progress', done: 'Final', void: 'Void' };

  function fixtureList(stage) {
    const rows = fixturesIn(stage.id);
    const list = el('div', 'sch-fixtures');

    if (!rows.length) {
      list.append(el('p', 'field-help', {}, 'No fixtures in this stage yet. Generate them, or add one below.'));
    }

    let lastRound = null;
    for (const fixture of rows) {
      if (fixture.round !== lastRound) {
        lastRound = fixture.round;
        list.append(el('h3', 'sch-round', {}, roundName(stage, fixture)));
      }
      list.append(fixtureRow(fixture));
      if (fixture.id === openFixture && draft) list.append(resultEditor(fixture));
    }

    const add = el('button', 'btn btn-small', { type: 'button' }, 'Add fixture');
    add.addEventListener('click', () =>
      act({
        action: 'fixture.save',
        fixture: { stageId: stage.id, bestOf: stage.bestOf, round: (rows.at(-1)?.round ?? 0) || 1 },
      }),
    );
    list.append(add);

    return list;
  }

  /** `Round 2`, or `Lower round 2` where a stage uses both halves of a bracket. */
  function roundName(stage, fixture) {
    if (stageHasTable(stage)) return `Round ${fixture.round}`;
    const halves = new Set(fixturesIn(stage.id).map((entry) => entry.bracket));
    if (fixture.bracket === 'final') return 'Grand final';
    if (halves.size > 1) return `${fixture.bracket === 'lower' ? 'Lower' : 'Upper'} round ${fixture.round}`;
    return `Round ${fixture.round}`;
  }

  /**
   * One fixture, as a read-only row.
   *
   * No text input anywhere in here, which is what lets the whole list rebuild
   * whenever anything changes. Everything editable lives in the result editor
   * below, or behind a select - a select does not carry a caret.
   */
  function fixtureRow(fixture) {
    const status = fixtureStatus(fixture);
    const score = fixtureScore(fixture);
    const won = fixtureWinner(fixture);
    const row = el('div', `sch-fixture is-${status}${fixture.id === openFixture ? ' is-open' : ''}`);

    row.append(
      side(fixture, 'left', won === 'left'),
      el('span', 'sch-score', {}, status === 'scheduled' ? 'v' : `${score.left} - ${score.right}`),
      side(fixture, 'right', won === 'right'),
      el('span', `sch-status is-${status}`, {}, STATUS_LABEL[status]),
    );

    const open = el(
      'button',
      'mini-btn',
      { type: 'button', title: `Best of ${fixture.bestOf} - needs ${mapsNeeded(fixture.bestOf)} maps` },
      fixture.id === openFixture ? 'Close' : 'Result',
    );
    open.addEventListener('click', () => {
      if (fixture.id === openFixture) {
        openFixture = '';
        draft = null;
      } else {
        openFixture = fixture.id;
        draft = {
          bestOf: fixture.bestOf,
          winner: fixture.winner,
          maps: Array.from({ length: fixture.bestOf }, (_, i) => ({ ...emptyMapRow(), ...(fixture.maps[i] ?? {}) })),
        };
      }
      paint();
    });

    const drop = el('button', 'btn btn-small btn-ghost', { type: 'button', title: 'Remove this fixture' }, '×');
    drop.addEventListener('click', () => {
      if (!window.confirm(`Remove "${fixtureLabel(fixture)}"?`)) return;
      act({ action: 'fixture.remove', id: fixture.id }, () => {
        if (openFixture === fixture.id) {
          openFixture = '';
          draft = null;
        }
      });
    });

    row.append(open, drop);
    return row;
  }

  /**
   * One side of a fixture: who is in it, or where they come from.
   *
   * A select rather than a text box, for two reasons. A fixture's team is a
   * COPY of a library entry and typing a name would make a team the library
   * does not have; and a select carries no caret, so this row stays free to
   * repaint.
   */
  function side(fixture, which, winner) {
    const slot = fixture[which];
    const wrap = el('span', `sch-side${winner ? ' is-winner' : ''}`);

    const pick = el('select', null, { 'aria-label': `${which} team` });
    pick.append(el('option', null, { value: '' }, slot.source ? `← ${sourceLabel(slot.source)}` : '- nobody yet -'));
    for (const team of library) {
      // The full name, not teamLabel() - that prefers the tricode, which is
      // right on a graphic at 1920x1080 and useless in a list where "ALP" and
      // "ALT" are the whole of what an operator has to tell apart.
      pick.append(
        el('option', null, { value: team.id, selected: team.id === slot.teamId ? 'selected' : null }, team.name || teamLabel(team)),
      );
    }
    // A team already copied in that is no longer in the library still has to
    // show, or the row would silently read as empty.
    if (slot.teamId && !library.some((team) => team.id === slot.teamId)) {
      pick.append(el('option', null, { value: slot.teamId, selected: 'selected' }, `${slot.name} (not in the library)`));
    }

    pick.addEventListener('change', () => {
      const team = library.find((entry) => entry.id === pick.value);
      act({
        action: 'fixture.save',
        // Picking a team by hand is what PINS a slot, so the edge is cleared
        // explicitly - the sanitiser deliberately arbitrates neither.
        fixture: { ...fixture, [which]: team ? { ...asSlot(team), source: null } : { ...slot, ...EMPTY_TEAM, teamId: '' } },
      });
    });

    wrap.append(pick);
    return wrap;
  }

  const sourceLabel = (source) => {
    const from = doc.fixtures.find((entry) => entry.id === source.fixtureId);
    return from ? `${source.take === 'loser' ? 'Loser' : 'Winner'} of ${fixtureLabel(from)}` : 'a fixture that is gone';
  };

  /**
   * The result editor, and the only place on this page with a text input.
   *
   * It writes into `draft` on every keystroke and repaints NOTHING, which is
   * the caret rule. The running score beside it is its own node with its own
   * updater, so it can move without the inputs moving.
   */
  function resultEditor(fixture) {
    const card = el('div', 'sch-result');
    const tally = el('span', 'sch-result-score');

    const retally = () => {
      const score = fixtureScore({ maps: draft.maps });
      const need = mapsNeeded(draft.bestOf);
      tally.textContent = `${score.left} - ${score.right}`;
      tally.classList.toggle('is-decided', score.left >= need || score.right >= need);
    };

    for (let i = 0; i < draft.maps.length; i += 1) {
      const row = draft.maps[i];
      const line = el('div', 'sch-map');

      const name = el('input', null, { type: 'text', placeholder: `Map ${i + 1}`, maxlength: 40, 'aria-label': `Map ${i + 1} name` });
      name.value = row.name;
      name.addEventListener('input', () => {
        row.name = name.value;
      });

      const left = el('input', null, { type: 'number', min: '0', max: '99', 'aria-label': `Map ${i + 1} left score` });
      left.value = String(row.left);
      const right = el('input', null, { type: 'number', min: '0', max: '99', 'aria-label': `Map ${i + 1} right score` });
      right.value = String(row.right);
      for (const [input, key] of [[left, 'left'], [right, 'right']]) {
        input.addEventListener('input', () => {
          row[key] = Number(input.value) || 0;
          retally();
        });
      }

      /*
       * A forfeit on one map. 0-0 is the normal state of a map nobody has
       * played, so a map won by a walkover cannot be expressed as a score at
       * all - without this it would either read as unplayed or want a fake 13-0
       * that then flowed into the round differential on the table.
       */
      const award = el('select', null, { 'aria-label': `Map ${i + 1} awarded to` });
      for (const [value, label] of [['', 'By score'], ['left', 'Awarded left'], ['right', 'Awarded right']]) {
        award.append(el('option', null, { value, selected: value === row.award ? 'selected' : null }, label));
      }
      award.addEventListener('change', () => {
        row.award = award.value;
        retally();
      });

      line.append(name, left, right, award);
      card.append(line);
    }

    const result = el('select', null, { 'aria-label': 'Series result' });
    for (const [value, label] of [
      ['auto', 'From the maps'],
      ['left', 'Left wins (forfeit)'],
      ['right', 'Right wins (forfeit)'],
      ['void', 'Void - no result'],
    ]) {
      result.append(el('option', null, { value, selected: value === draft.winner ? 'selected' : null }, label));
    }
    result.addEventListener('change', () => {
      draft.winner = result.value;
    });

    const save = el('button', 'btn btn-small', { type: 'button' }, 'Save result');
    save.addEventListener('click', () =>
      act({ action: 'result', id: fixture.id, maps: draft.maps, winner: draft.winner }, () => {
        openFixture = '';
        draft = null;
        toast(`Saved ${fixtureLabel(fixture)}`);
      }),
    );

    const cancel = el('button', 'btn btn-small btn-ghost', { type: 'button' }, 'Cancel');
    cancel.addEventListener('click', () => {
      openFixture = '';
      draft = null;
      paint();
    });

    retally();
    card.append(el('div', 'sch-result-foot', {}, ''), tally, result, save, cancel);
    return card;
  }

  // ---------------------------------------------------------- the standings ---

  /**
   * The table, and the one thing it deliberately will not do.
   *
   * Teams on equal wins SHARE a rank. Real VALORANT group rulebooks tiebreak
   * head-to-head first, so ordering by map differential would be
   * authoritative-looking and wrong in exactly the situation that makes
   * somebody open the table. Every number a rulebook would use is shown, and
   * the operator reads the rulebook.
   */
  function table(stage) {
    const rows = standings(doc, stage.id);
    const box = el('div', 'sch-table-wrap');
    if (!rows.length) {
      box.append(el('p', 'field-help', {}, 'Nothing has been played in this stage yet.'));
      return box;
    }

    const head = ['#', 'Team', 'P', 'W', 'L', 'Maps', 'Rounds'];
    const grid = el('table', 'sch-table');
    const thead = el('thead');
    const hrow = el('tr');
    for (const label of head) hrow.append(el('th', null, {}, label));
    thead.append(hrow);
    grid.append(thead);

    const body = el('tbody');
    for (const row of rows) {
      const tr = el('tr', row.tied ? 'is-tied' : null);
      tr.append(
        el('td', 'sch-rank', { title: row.tied ? 'Tied on wins. This tool does not break ties - check the rulebook.' : '' }, String(row.rank)),
        el('td', null, {}, row.name),
        el('td', null, {}, String(row.played)),
        el('td', null, {}, String(row.won)),
        el('td', null, {}, String(row.lost)),
        el('td', null, {}, `${row.mapsWon}-${row.mapsLost}`),
        el('td', null, {}, `${row.roundsWon}-${row.roundsLost}`),
      );
      body.append(tr);
    }
    grid.append(body);
    box.append(grid);

    if (rows.some((row) => row.tied)) {
      box.append(
        help('Teams level on wins share a place. Ties are not broken here - map and round numbers are shown so a rulebook can be applied.'),
      );
    }
    return box;
  }

  // ---------------------------------------------------------------- paint ---

  function paint() {
    if (!loaded) {
      host.replaceChildren(el('p', 'field-help', {}, 'Loading the schedule…'));
      return;
    }

    const stage = stageOf(openStage) ?? doc.stages[0] ?? null;
    if (stage) openStage = stage.id;

    host.replaceChildren(
      ...[
        stageStrip(),
        stage ? stageSettings(stage) : null,
        stage ? fixtureList(stage) : el('p', 'field-help', {}, 'Add a stage to start building the schedule.'),
        stage && stageHasTable(stage) ? title('Standings') : null,
        stage && stageHasTable(stage) ? table(stage) : null,
        // .filter(Boolean), because replaceChildren STRINGIFIES what it is
        // handed - a conditional resolving to null appends the text "null" to
        // the page, which every DOM assertion happily passes over. It happened
        // under the roster editor and took a screenshot to see.
      ].filter(Boolean),
    );
  }

  // The team library is fetched by winner-dashboard.js and gossiped through a
  // same-page event. Listening rather than fetching keeps one owner for it.
  window.addEventListener('teams-changed', (event) => {
    library = event.detail ?? [];
    if (loaded) paint();
  });

  fetch(api('/api/teams'))
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => {
      library = payload?.teams ?? [];
      if (loaded) paint();
    })
    .catch(() => {
      /* A picker with no library still works; it just offers nobody. */
    });

  refresh();
  // The Tournament page reveals its panels once a tournament resolves, and this
  // one may have been built before there was anything to read.
  window.addEventListener('tournament-changed', refresh);
}
