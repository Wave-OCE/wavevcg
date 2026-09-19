/**
 * The Schedule sub-page: stages, the fixtures inside them, and the table that
 * falls out of the results.
 *
 * ## The caret rule, and how this page obeys it
 *
 * `winner-dashboard.js`'s roster editor records the rule: rebuilding a block
 * replaces the input being typed into, and the caret goes with it. This page
 * meets it by SEPARATION, and that is what lets everything on it repaint
 * freely:
 *
 *   the PAGE has no text input anywhere. The stage settings, the fixture list,
 *   the bracket and the table are selects, buttons and derived text, so any of
 *   them may be rebuilt on any change.
 *
 *   the MODAL has all of them. It is built once, lives on `document.body`
 *   rather than inside `host`, is never touched by `paint()`, and writes into a
 *   draft that reaches the server only on Save.
 *
 * So a repaint provoked by anything at all - a team library arriving, another
 * stage being picked - cannot replace the box somebody is typing into, because
 * the two are not in the same tree.
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

import { el, field, grid, help, title } from './fields.js';
import { api } from './session.js';
import { askClose, chooserModal, confirmDanger, modalFoot, modalOpen, modalTitle, openModal, watchChanges } from './modal.js';
import { EMPTY_TEAM, TEAM_KEYS, teamLabel } from './teams.js';
import {
  BEST_OF_CHOICES,
  MAX_GROUPS,
  BRACKET_HALVES,
  STAGE_KINDS,
  STAGE_TEMPLATES,
  emptyMapRow,
  fixtureLabel,
  fixtureScore,
  fixtureStatus,
  fixtureWinner,
  bracketLayout,
  mapsNeeded,
  slotLabel,
  stageHasGroups,
  stageHasTable,
  stageTables,
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
  /*
   * A stage's matches, in the order a person reads a draw.
   *
   * Upper bracket, then lower, then the grand final; within each, by round and
   * then by slot. The document's own order is whatever they were written in,
   * which was harmless while the only way to build a bracket was `generate`
   * laying out one round of one half - and became visibly wrong the moment a
   * template could produce all three. A grand final at the top of the list
   * under its own heading, with the first round beneath it, is a draw nobody
   * can read.
   *
   * `BRACKET_HALVES` is the order, taken from the schema rather than written
   * out here: it is already `['upper', 'lower', 'final']` because that is the
   * order they happen in, and a second copy of that fact is one edit from
   * disagreeing with the layout the graphic draws from.
   */
  const fixturesIn = (id) =>
    doc.fixtures
      .filter((fixture) => fixture.stageId === id)
      .sort(
        (a, b) =>
          BRACKET_HALVES.indexOf(a.bracket) - BRACKET_HALVES.indexOf(b.bracket) ||
          (a.round ?? 0) - (b.round ?? 0) ||
          (a.slot ?? 0) - (b.slot ?? 0),
      );

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
        paint();
      });
      row.append(pill);
    }

    /*
     * Add makes the stage and opens its editor, rather than asking for a name
     * in a prompt first.
     *
     * That prompt was the only place a stage could ever be named: there was no
     * rename anywhere in the program, so a typo made at speed on a show day was
     * permanent short of hand-editing schedule.json. Making the record and then
     * opening the real form is one fewer dialog AND the thing that fixes it,
     * because the same form renames.
     */
    const add = el('button', 'btn btn-small', { type: 'button' }, 'Add stage');
    add.addEventListener('click', () => void addStage());
    row.append(add);

    const edit = el('button', 'btn btn-small btn-ghost', { type: 'button' }, 'Edit stage');
    edit.disabled = !doc.stages.length;
    edit.addEventListener('click', () => {
      const stage = stageOf(openStage);
      if (stage) openStageEditor(stage);
    });
    row.append(edit);

    return row;
  }

  /**
   * What the open stage IS, read-only, under the strip.
   *
   * It used to be the settings themselves - a format select, a series select
   * and two buttons, each writing on change. They have moved into a modal, and
   * what is left here is a sentence.
   *
   * Two reasons, and the second is the one that matters. A stage has more to
   * say than fits on a strip - it is about to have groups and templates - and a
   * row of controls that grows with every feature is what an operator scrolls
   * past. And a form that writes on every `change` can never promise that
   * Cancel meant nothing happened, which is the promise the match editor beside
   * it already makes; two editors on one page with two different ideas of when
   * a thing is saved is worse than either one.
   *
   * No control in here, so it repaints freely - the caret rule, obeyed by not
   * having the problem, which is how the rest of this page is built.
   */
  function stageSummary(stage) {
    const card = el('div', 'sch-stage-settings');
    const kind = STAGE_KINDS.find((entry) => entry.key === stage.kind);
    const held = fixturesIn(stage.id).length;

    card.append(
      el('span', 'sch-label', {}, 'Format'),
      el('span', null, {}, kind?.label ?? stage.kind),
      el('span', 'sch-label', {}, 'Series'),
      el('span', null, {}, `Best of ${stage.bestOf}`),
      el('span', 'sch-label', {}, 'Matches'),
      el('span', null, {}, String(held)),
    );
    return card;
  }

  /**
   * WHICH WAY, before the form.
   *
   * Every way of making a stage was already in the editor and one of them was
   * four sections down: an operator who did not know the template picker was
   * there laid a sixteen-team bracket out a round at a time. Asking first makes
   * that one impossible to miss, and lets the editor open on the pane that
   * answers what they picked.
   *
   * Making the record BEFORE the form is kept from the old flow, and it is what
   * made a stage renameable at all - the name used to be set by a prompt at
   * creation and nowhere else, so a typo made at speed was permanent short of
   * hand-editing schedule.json.
   */
  async function addStage() {
    const how = await chooserModal({
      title: 'Add a stage',
      lines: ['A stage is one phase of the competition - a group stage, a playoff bracket, a final.'],
      options: [
        {
          id: 'template',
          label: 'From a template',
          help: 'Single or double elimination, or a round robin with pools. Lays the whole thing out WIRED, so every winner carries forward on its own.',
        },
        {
          id: 'manual',
          label: 'Build it by hand',
          help: 'An empty stage. Add rounds and matches yourself - for a draw no template covers.',
        },
        {
          id: 'copy',
          label: 'Copy an existing stage',
          help: doc.stages.length
            ? 'Its format, its groups and the shape of its draw, with no teams and no results. For a season that is the same shape every week.'
            : 'Nothing to copy yet.',
          disabled: doc.stages.length === 0,
        },
      ],
    });
    if (!how) return;

    if (how === 'copy') {
      const from = await chooserModal({
        title: 'Copy which stage?',
        lines: ['The new one gets its format, its groups and the shape of its draw. No teams and no results come across.'],
        options: doc.stages.map((stage) => ({
          id: stage.id,
          label: stage.name,
          help: `${fixturesIn(stage.id).length} match${fixturesIn(stage.id).length === 1 ? '' : 'es'}`,
        })),
      });
      if (!from) return;
      const source = stageOf(from);
      act({ action: 'stage.duplicate', id: from, name: `${source?.name ?? 'Stage'} copy` }, () => {
        const made = doc.stages[doc.stages.length - 1];
        if (!made) return;
        openStage = made.id;
        paint();
        openStageEditor(made);
        toast(`Copied "${source?.name ?? 'that stage'}" - no teams, no results`);
      });
      return;
    }

    act({ action: 'stage.save', stage: { name: 'New stage', kind: 'bracket', bestOf: 3 } }, () => {
      const made = doc.stages.find((entry) => entry.name === 'New stage');
      if (!made) return;
      openStage = made.id;
      paint();
      // Landing on the pane that answers what they just asked for. Opening a
      // template pick on the Stage tab would make them go looking for it again,
      // which is the thing this chooser exists to stop.
      openStageEditor(made, how === 'template' ? 'matches' : 'about');
    });
  }

  /**
   * Everything about ONE stage, in a modal.
   *
   * The same shape the match editor and the team editor use, and deliberately
   * so: one dialog per thing, built on document.body, saving ONCE so Cancel
   * really does mean nothing happened, and asking before it throws away unsaved
   * work. An operator who has learnt one of these has learnt all three.
   */
  function openStageEditor(stage, startTab = 'about') {
    if (modalOpen()) return;

    const draft = { ...stage };
    let dialog = null;
    const held = fixturesIn(stage.id).length;

    const name = el('input', null, { type: 'text', maxlength: 80, 'aria-label': 'Stage name' });
    name.value = draft.name ?? '';
    name.addEventListener('input', () => {
      draft.name = name.value;
    });

    const kind = el('select', null, { 'aria-label': 'Format' });
    for (const entry of STAGE_KINDS) {
      kind.append(el('option', null, { value: entry.key, selected: entry.key === draft.kind ? 'selected' : null }, entry.label));
    }
    const kindHelp = help('');
    const syncKind = () => {
      kindHelp.textContent = STAGE_KINDS.find((entry) => entry.key === kind.value)?.help ?? '';
    };
    kind.addEventListener('change', () => {
      draft.kind = kind.value;
      syncKind();
    });
    syncKind();

    const best = el('select', null, { 'aria-label': 'Default series length' });
    for (const value of BEST_OF_CHOICES) {
      best.append(el('option', null, { value: String(value), selected: value === draft.bestOf ? 'selected' : null }, `Best of ${value}`));
    }
    best.addEventListener('change', () => {
      draft.bestOf = Number(best.value);
    });

    const save = el('button', 'btn btn-primary', { type: 'button' }, 'Save stage');
    save.addEventListener('click', () => {
      if (!String(draft.name ?? '').trim()) {
        toast('A stage needs a name.');
        return;
      }
      act({ action: 'stage.save', stage: draft }, () => {
        toast(`Saved "${draft.name}"`);
        dialog?.close();
      });
    });

    const cancel = el('button', 'btn btn-ghost', { type: 'button' }, 'Cancel');
    cancel.addEventListener('click', () => askClose(dialog));

    /*
     * Generate SAVES first, and the button says so.
     *
     * Laying a stage out reads the stage as the SERVER has it, so generating
     * against a name or a format typed but not saved would use the old ones -
     * and the matches that came back would quietly be for the stage as it was.
     * One press that does both is the only version with no surprise in it.
     */
    /*
     * A round of empty matches, after the last one.
     *
     * The round NUMBER is the server's to work out - the next one after the
     * highest already there. An operator adding a round means "the one after
     * this", and a number they have to type is a number they can get wrong: a
     * match at round 7 of a 3-round bracket draws a column of empty space and
     * reads as a bug in the layout.
     *
     * It does NOT save the draft first, unlike Generate. Adding a round touches
     * no stage field, so there is nothing for an unsaved name or format to make
     * wrong - and quietly committing a half-typed rename because somebody
     * pressed a different button would be the surprise this avoids everywhere
     * else.
     */
    const roundCount = el('input', null, { type: 'number', min: '1', max: '64', value: '2', 'aria-label': 'Matches in the round' });

    let roundGroup = null;
    if ((stage.groups?.length ?? 0) > 0) {
      roundGroup = el('select', null, { 'aria-label': 'Group for the new round' });
      roundGroup.append(el('option', null, { value: '' }, '- not in a group -'));
      for (const group of stage.groups) roundGroup.append(el('option', null, { value: group.id }, group.name));
    }

    const addRound = el('button', 'btn btn-small', { type: 'button' }, 'Add round');
    addRound.addEventListener('click', () => {
      const count = Number.parseInt(roundCount.value, 10);
      if (!Number.isInteger(count) || count < 1) {
        toast('A round needs at least one match.');
        return;
      }
      act({ action: 'round.add', stageId: stage.id, group: roundGroup ? roundGroup.value : '', count }, () => {
        toast(`Added a round of ${count} match${count === 1 ? '' : 'es'}`);
        dialog?.close();
      });
    });

    /*
     * A WHOLE STAGE FROM A TEMPLATE, wired.
     *
     * The thing an operator actually wants at eight in the morning: "this is a
     * sixteen-team double elimination", not thirty matches added a round at a
     * time and fifty-eight edges drawn by hand. The shapes are in the schema;
     * this is the press.
     *
     * It REPLACES, so it takes the same bar as deleting the stage once there is
     * anything to lose - the exact name typed back. That bar is now a SHEET
     * this button raises rather than a box sitting in the form: a confirmation
     * belongs to the press it guards, and two typed boxes living in one body
     * was a mis-aim away from arming the wrong one. It stays in its own section
     * beside the template picker rather than moving to the footer - this is a
     * constructive press with a destructive consequence, not a Delete.
     */
    const templatePick = el('select', null, { 'aria-label': 'Template' });
    for (const entry of STAGE_TEMPLATES) {
      templatePick.append(el('option', null, { value: entry.key }, entry.label));
    }
    const templateHelp = help('');
    const templateGroups = el('input', null, { type: 'number', min: '1', max: '16', value: '1', 'aria-label': 'Groups' });
    const templateGroupsField = field('Groups', templateGroups);

    const lay = el(
      'button',
      'btn btn-small',
      { type: 'button' },
      held ? `Replace ${held} match${held === 1 ? '' : 'es'} and lay out` : 'Lay this stage out',
    );

    const syncTemplate = () => {
      const entry = STAGE_TEMPLATES.find((e) => e.key === templatePick.value);
      templateHelp.textContent = entry?.help ?? '';
      // Groups are a round-robin idea. A number box beside a bracket template
      // is a control that does nothing, on a form somebody is reading fast.
      templateGroupsField.hidden = entry?.key !== 'roundrobin';
    };
    templatePick.addEventListener('change', syncTemplate);
    syncTemplate();

    lay.addEventListener('click', async () => {
      /*
       * Teams FIRST, then the confirmation, and that order is deliberate: the
       * teams are what is being built and the typed name is the last gate in
       * front of the write. Asked the other way round, an operator confirms a
       * replacement and is then asked a question they can still back out of,
       * which makes the confirmation mean less than it says.
       */
      const teams = askForTeams(stage, templatePick.value);
      if (!teams) return;

      // An EMPTY stage has nothing to replace, so it asks nothing - the same
      // rule Delete follows two sections down.
      if (held) {
        const ok = await confirmDanger({
          title: `Replace ${held} match${held === 1 ? '' : 'es'} in "${stage.name}"?`,
          lines: [
            'Laying the stage out again builds it from scratch, so every match in it now goes - results included. ' +
              'That cannot be undone.',
            'The draw you are about to build is wired: every winner carries forward on its own.',
          ],
          typed: stage.name,
          typedLabel: 'Type the stage name to confirm',
          confirm: 'Replace and lay out',
        });
        if (!ok) return;
      }

      act(
        {
          action: 'template.apply',
          stageId: stage.id,
          template: templatePick.value,
          teams,
          groups: Number.parseInt(templateGroups.value, 10) || 1,
          // The sheet above does not let a wrong name through, so this is the
          // name. The server checks it again and is what actually enforces it.
          confirm: held ? stage.name : undefined,
        },
        () => {
          toast(`Laid "${stage.name}" out`);
          dialog?.close();
        },
      );
    });

    const gen = el('button', 'btn btn-small', { type: 'button' }, 'Save and generate matches');
    gen.addEventListener('click', () => {
      if (!String(draft.name ?? '').trim()) {
        toast('A stage needs a name.');
        return;
      }
      act({ action: 'stage.save', stage: draft }, () => {
        dialog?.close();
        generate(stageOf(draft.id) ?? draft);
      });
    });

    /*
     * Removing it, and the bar rises with what it would take.
     *
     * An EMPTY stage is one press: there is nothing to lose, and asking anyway
     * would train the answer out of somebody for the case that matters. A stage
     * holding matches wants its name typed back - the bar a production and a
     * tournament both set, because this deletes results nobody can get back.
     *
     * The typed box is a SHEET this button raises, not a section in the form.
     * It used to be the latter, which put the confirmation for a press at the
     * bottom of a scroll and the press itself in the footer - so the two halves
     * of one decision were never on screen together. The sheet is still visible
     * BEFORE the write, which was the property worth keeping: the button in it
     * stays dead until the name matches.
     */
    const drop = el(
      'button',
      'btn btn-ghost rl-modal-danger',
      { type: 'button' },
      held ? `Delete stage and ${held} match${held === 1 ? '' : 'es'}` : 'Delete stage',
    );

    drop.addEventListener('click', async () => {
      if (held) {
        const ok = await confirmDanger({
          title: `Delete "${stage.name}" and ${held} match${held === 1 ? '' : 'es'}?`,
          lines: [
            'The stage goes and every match in it goes with it, results included. It cannot be undone.',
            'Any match elsewhere that was fed by one of these keeps whoever had already reached it - the edge is ' +
              'cleared, not the team.',
          ],
          typed: stage.name,
          typedLabel: 'Type the stage name to confirm',
          confirm: 'Delete the stage',
        });
        if (!ok) return;
      }
      act({ action: 'stage.remove', id: stage.id, confirm: held ? stage.name : undefined }, () => {
        openStage = doc.stages[0]?.id ?? '';
        toast(held ? `Deleted "${stage.name}" and ${held} match${held === 1 ? '' : 'es'}` : `Deleted "${stage.name}"`);
        dialog?.close();
      });
    });

    /*
     * The groups, edited in place inside the draft.
     *
     * A list of boxes rather than a count, because a group has a NAME an
     * audience reads - "Group A" and "Alpha Pool" are both real - and a count
     * would make the page invent them. The id is minted from the first name and
     * never moves again, so renaming a group does not orphan its matches.
     *
     * Its own repainting block, and it has to be: adding a group adds a text
     * input, so rebuilding the whole dialog would take the caret out of the one
     * somebody is typing in. Only this list is replaced, and only when a group
     * is added or removed - typing a name writes straight into the draft and
     * touches no DOM at all.
     */
    const groupList = el('div', 'sch-groups');

    const paintGroups = () => {
      const rows = (draft.groups ?? []).map((group, index) => {
        const row = el('div', 'sch-group-row');
        const box = el('input', null, {
          type: 'text',
          maxlength: 60,
          'aria-label': `Group ${index + 1} name`,
          placeholder: `Group ${String.fromCharCode(65 + index)}`,
        });
        box.value = group.name ?? '';
        box.addEventListener('input', () => {
          group.name = box.value;
        });

        const inIt = fixturesIn(stage.id).filter((fixture) => (fixture.group ?? '') === group.id).length;
        const count = el('span', 'sch-label', {}, `${inIt} match${inIt === 1 ? '' : 'es'}`);

        /*
         * Generating into ONE group, which is the whole reason a stage has
         * them. Saves the stage first for the reason the stage-level button
         * does: laying out reads the stage as the SERVER has it, and a group
         * that has only been typed does not exist there yet.
         */
        /*
         * SAVES THE WHOLE DRAFT, and the title says so.
         *
         * It has to: the group may have been typed a second ago and not exist
         * on the server yet, so laying it out means saving the stage first. The
         * consequence is the part worth saying out loud - a name or a format
         * edited in this same dialog and not yet saved is committed too. An
         * operator who typed a new stage name, thought better of it, and then
         * pressed Generate on a group lower down would otherwise find the
         * rename had stuck.
         */
        const gen = el(
          'button',
          'btn btn-small',
          { type: 'button', title: 'Saves this stage, then lays this group out from the team library.' },
          'Save and generate',
        );
        gen.addEventListener('click', () => {
          if (!String(box.value ?? '').trim()) {
            toast('Name the group first.');
            return;
          }
          act({ action: 'stage.save', stage: draft }, () => {
            const saved = stageOf(draft.id);
            // Matched by POSITION, because the id of a group that has just been
            // added is minted by the server from its name - the draft's copy is
            // still blank at this point.
            const fresh = saved?.groups?.[index];
            dialog?.close();
            if (saved && fresh) generate(saved, fresh);
          });
        });

        const drop = el('button', 'btn btn-small btn-ghost', { type: 'button', title: 'Remove this group' }, '×');
        drop.addEventListener('click', () => {
          draft.groups.splice(index, 1);
          paintGroups();
        });

        row.append(box, count, gen, drop);
        return row;
      });

      const add = el('button', 'btn btn-small', { type: 'button' }, 'Add group');
      add.disabled = (draft.groups?.length ?? 0) >= MAX_GROUPS;
      add.addEventListener('click', () => {
        const next = draft.groups?.length ?? 0;
        draft.groups = [...(draft.groups ?? []), { id: '', name: `Group ${String.fromCharCode(65 + next)}` }];
        paintGroups();
        // Into the box that just appeared, so adding four groups is four
        // clicks rather than eight.
        groupList.querySelector('.sch-group-row:last-of-type input')?.focus();
      });

      groupList.replaceChildren(
        ...rows,
        ...[
          rows.length
            ? null
            : el('p', 'field-help', {}, 'No groups. Every match in this stage shares one table, which is what most stages want.'),
          add,
          // .filter(Boolean) - replaceChildren STRINGIFIES what it is handed,
          // so a conditional resolving to null paints the word "null".
        ].filter(Boolean),
      );
    };
    paintGroups();

    /*
     * THREE TABS, because this is one record with three jobs.
     *
     * What the stage IS (its name, its format, how long a series runs) is
     * something an operator sets once and comes back to rarely. Groups is a
     * list they build at the start of a season. Matches is where they live on
     * the morning of a show. In one column those were four sections deep and
     * the last of them was the one being opened for.
     *
     * Every pane is built ONCE - see modal.js. `paintGroups()` still replaces
     * the children of `groupList`, which is inside a pane rather than being
     * one, so switching tabs cannot disturb it.
     *
     * Delete stays in the FOOTER rather than becoming a fourth tab. It is not a
     * section of the form, it is an action on the record, and a tab called
     * Delete is one mis-click from a pane nobody meant to open.
     */
    const aboutPane = el('div');
    aboutPane.append(
      field('Name', name),
      help('What this phase of the competition is called. It names the strip, the bracket graphic and the table.'),
      grid(2, [field('Format', kind), field('Default series', best)]),
      kindHelp,
      help('The series length a NEW match in this stage starts at. Not a rule - a grand final in a Bo3 bracket is allowed to be a Bo5.'),
    );

    const groupPane = el('div');
    groupPane.append(
      help(
        'Split this stage into pools, each with its own table, shown together. Sixteen teams in four groups is ' +
          'four round robins of six matches instead of one of a hundred and twenty. Removing a group leaves its ' +
          'matches in the stage - they move to "Not in a group" rather than being deleted. Generating a group ' +
          'saves this whole form first, because the group has to exist before it can be laid out.',
      ),
      groupList,
    );

    const matchPane = el('div');
    matchPane.append(
      help(
        'Generate lays the stage out from the team library in one press, and ADDS to whatever is already here. ' +
          'Add round makes a round of empty matches after the last one - which is how a bracket grows past its ' +
          'first round without generating the whole thing.',
      ),
      stageRow([gen]),
      stageRow([field('Matches in the round', roundCount), ...(roundGroup ? [field('In', roundGroup)] : []), addRound]),
      el('div', 'subhead', {}, 'Lay it out from a template'),
      help(
        'The whole stage in one press, WIRED - every winner carries forward on its own, and in a double ' +
          'elimination every loser drops into the lower bracket. This REPLACES whatever is in the stage, which is ' +
          'why it asks for the name once there is anything to lose.',
      ),
      grid(2, [field('Template', templatePick), templateGroupsField]),
      templateHelp,
      stageRow([lay]),
    );

    // Snapshotted after the form is built, so nothing the form does to the
    // draft on the way up reads as the operator's work - see modal.js. It
    // watches the WHOLE draft, not the open tab: a name typed on one pane and
    // abandoned from another still has to be worth asking about.
    const dirty = watchChanges(() => JSON.stringify(draft));

    dialog = openModal({
      head: modalTitle(stage.name || 'Stage', `${held} match${held === 1 ? '' : 'es'}`),
      tabs: [
        { id: 'about', label: 'Stage', body: aboutPane },
        { id: 'groups', label: 'Groups', body: groupPane },
        { id: 'matches', label: 'Matches', body: matchPane },
      ],
      tab: startTab,
      dirty,
      foot: modalFoot({ danger: drop, cancel, confirm: save }),
      onClose: () => paint(),
    });
  }

  /** A row of buttons inside a modal, wrapping rather than overflowing it. */
  function stageRow(children) {
    const node = el('div', 'rl-modal-row');
    node.append(...children.filter(Boolean));
    return node;
  }

  /**
   * Lay a stage out from the team library in one press.
   *
   * It ADDS. A button that silently discarded a half-recorded group would be
   * the worst kind of convenience, so an operator who wants a clean slate
   * removes the fixtures and sees how many they are removing. The server
   * enforces the same thing.
   */
  /**
   * Which teams are in it, asked once.
   *
   * Shared by Generate and by the templates so the two cannot come to disagree
   * about what an operator typed - and so the list of names they are matched
   * against is the same list in both places. Returns null when the operator
   * backed out, which is different from an empty answer.
   */
  function askForTeams(stage, what) {
    if (library.length < 2) {
      toast('Add at least two teams to the library first.');
      return null;
    }
    const picked = window.prompt(
      `Which teams are in "${stage.name}"${what ? ` for a ${what} draw` : ''}?\n\n` +
        `Comma-separated, from the library:\n${library.map(teamLabel).join(', ')}\n\n` +
        'The ORDER is the seeding - the first name is seed one.',
      library.map(teamLabel).join(', '),
    );
    if (picked === null) return null;

    const wanted = picked
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean)
      .map((name) => library.find((team) => teamLabel(team).toLowerCase() === name || team.name.toLowerCase() === name))
      .filter(Boolean);

    if (wanted.length < 2) {
      toast('Could not match at least two teams to the library.');
      return null;
    }
    return wanted.map(asSlot);
  }

  /**
   * Lay a stage - or ONE GROUP of it - out from the team library.
   *
   * The group is what makes groups worth having: sixteen teams in four pools is
   * four round robins of six matches rather than one of a hundred and twenty,
   * and that only happens if generation can be pointed at a pool. Blank means
   * the stage as a whole, which is what a bracket and an unsplit round robin
   * both want.
   */
  function generate(stage, group = null) {
    if (library.length < 2) {
      toast('Add at least two teams to the library first.');
      return;
    }
    const where = group ? `${stage.name} - ${group.name}` : stage.name;
    const existing = group
      ? fixturesIn(stage.id).filter((fixture) => (fixture.group ?? '') === group.id).length
      : fixturesIn(stage.id).length;
    const note = existing ? `\n\nThis ADDS to the ${existing} already here - it does not replace them.` : '';
    const picked = window.prompt(
      `Which teams are in "${where}"?\n\nComma-separated, from the library:\n${library.map(teamLabel).join(', ')}${note}`,
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
    act({ action: 'generate', stageId: stage.id, group: group?.id ?? '', teams: wanted.map(asSlot) });
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
      list.append(el('p', 'field-help', {}, 'No matches in this stage yet. Lay it out from a template, or add one below.'));
    }

    /*
     * BY GROUP FIRST, then by round.
     *
     * A grouped stage laid out round-first interleaves every pool - "Round 1"
     * holding Crusaders v Hillside and Northwood v Ironhold with nothing to say
     * which group either is in - and an operator reading down it cannot tell
     * the draw apart at all. Two pools playing their first round is two rounds
     * one, not one round of eight.
     *
     * Ungrouped stages are a list of ONE bucket, so the loop below is the same
     * code for both - the same reason `stageTables` answers with a list of one
     * rather than making the caller branch.
     */
    for (const bucket of listBuckets(stage, rows)) {
      if (bucket.name) {
        const head = el('h3', 'sch-group-head', {}, bucket.name);
        // The loose bucket is the only one that can be emptied, because it is
        // the only one that is not somewhere a match is meant to be.
        if (!bucket.id) head.append(sweepControls(stage, bucket.rows));
        list.append(head);
      }

      /*
       * The heading changes when the HALF changes as well as the round.
       *
       * Watching the round alone put the whole of a double elimination under
       * one heading: the grand final is round 1 of the `final` half, upper
       * round 1 is round 1 too, and the first fixture through the loop won the
       * heading for all of them. Keyed on both, which is also what `roundName`
       * already reads.
       */
      let lastHead = null;
      for (const fixture of bucket.rows) {
        const head = `${fixture.bracket}/${fixture.round}`;
        if (head !== lastHead) {
          lastHead = head;
          list.append(el('h3', 'sch-round', {}, roundName(stage, fixture)));
        }
        list.append(fixtureRow(fixture));
      }
    }

    const add = el('button', 'btn btn-small', { type: 'button' }, 'Add match');
    add.addEventListener('click', () =>
      act({
        action: 'fixture.save',
        fixture: { stageId: stage.id, bestOf: stage.bestOf, round: (rows.at(-1)?.round ?? 0) || 1 },
      }),
    );
    list.append(add);

    return list;
  }

  /**
   * The fixture list's sections: one per group, or one for the whole stage.
   *
   * Mirrors `stageTables` deliberately - same order, same leftover bucket, same
   * "a list of one when there are no groups". The list and the tables under it
   * reading in different orders would be two answers to "what is in this
   * stage", and an operator checking one against the other is exactly who would
   * find that out.
   */
  function listBuckets(stage, rows) {
    const groups = stage.groups ?? [];
    if (!groups.length) return [{ id: '', name: '', rows }];

    const known = new Set(groups.map((group) => group.id));
    const buckets = groups.map((group) => ({
      id: group.id,
      name: group.name,
      rows: rows.filter((fixture) => (fixture.group ?? '') === group.id),
    }));

    // Anything whose group was removed, or which was never assigned one. It has
    // to be visible: a list that silently omitted them would read as matches
    // having been deleted.
    const loose = rows.filter((fixture) => !known.has(fixture.group ?? ''));
    if (loose.length) buckets.push({ id: '', name: 'Not in a group', rows: loose });
    return buckets;
  }

  /**
   * What to do with the matches that are in no group.
   *
   * Removing a group leaves its matches behind on purpose - they land here
   * rather than being deleted, because a match belonging to no table an
   * operator can see reads as matches having vanished from the draw. That left
   * this bucket a dead end: the only way to empty it was to delete the matches
   * one at a time.
   *
   * BOTH answers, because there are two honest ones. A pool laid out by mistake
   * wants its matches gone; a pool renamed into existence after the matches
   * were made wants them moved. Offering only Delete would make destroying
   * results the routine way to tidy up a draw.
   *
   * A select and two buttons rather than a dialog: this sits on a heading in a
   * list that repaints, so it must hold no text input - the caret rule, met by
   * shape, which is what the whole Schedule page is built on.
   */
  function sweepControls(stage, loose) {
    const wrap = el('span', 'sch-sweep');
    const groups = stage.groups ?? [];
    const count = loose.length;
    const played = loose.filter((fixture) => Boolean(fixtureWinner(fixture))).length;

    if (groups.length) {
      const into = el('select', null, { 'aria-label': 'Move these into a group' });
      into.append(el('option', null, { value: '' }, 'Move all into...'));
      for (const group of groups) into.append(el('option', null, { value: group.id }, group.name));
      into.addEventListener('change', () => {
        if (!into.value) return;
        const name = groups.find((group) => group.id === into.value)?.name ?? 'that group';
        act({ action: 'group.sweep', stageId: stage.id, group: into.value }, () => {
          toast(`Moved ${count} match${count === 1 ? '' : 'es'} into ${name}`);
        });
      });
      wrap.append(into);
    }

    const drop = el(
      'button',
      'btn btn-small btn-ghost sch-modal-drop',
      { type: 'button' },
      `Delete all ${count}`,
    );
    drop.addEventListener('click', async () => {
      /*
       * The typed name only when a RESULT would go with them - the bar rises
       * with what it would take, which is the rule the stage delete already
       * follows by asking nothing of an empty stage.
       */
      const ok = await confirmDanger({
        title: `Delete ${count} match${count === 1 ? '' : 'es'} in no group?`,
        lines: [
          played
            ? `${played} of them ${played === 1 ? 'has' : 'have'} a result filed, and deleting them throws that away. ` +
              'It cannot be undone.'
            : 'None of them has been played, so nothing filed is lost. It still cannot be undone.',
          'Any match elsewhere that was fed by one of these keeps whoever had already reached it - the edge is ' +
            'cleared, not the team.',
        ],
        ...(played ? { typed: stage.name, typedLabel: 'Type the stage name to confirm' } : {}),
        confirm: `Delete ${count === 1 ? 'it' : 'them'}`,
      });
      if (!ok) return;
      act(
        { action: 'group.sweep', stageId: stage.id, group: '', confirm: played ? stage.name : undefined },
        () => {
          toast(`Deleted ${count} match${count === 1 ? '' : 'es'}`);
        },
      );
    });
    wrap.append(drop);
    return wrap;
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

    /*
     * One button, and removal moved into the modal beside it.
     *
     * A row of small buttons next to a row that is ITSELF clickable is two ways
     * to do one thing plus a delete sitting a few pixels from both - which is
     * the shape the Admin accounts row got wrong by growing. Edit opens the
     * match; everything you can do to a match is in there.
     */
    const open = el(
      'button',
      'mini-btn',
      { type: 'button', title: `Best of ${fixture.bestOf} - needs ${mapsNeeded(fixture.bestOf)} maps` },
      'Edit',
    );
    open.addEventListener('click', () => openMatch(fixture));

    row.append(open);
    return row;
  }

  /**
   * One side of a fixture, read only.
   *
   * The row used to carry a `select` here and write on change. Everything
   * editable now lives in the modal, which is what lets this whole list - and
   * the bracket above it - repaint on any change without a thought: there is no
   * input left in either to lose a caret.
   */
  function side(fixture, which, winner) {
    const slot = fixture[which];
    const wrap = el('span', `sch-side${winner ? ' is-winner' : ''}`);
    const label = slotLabel(slot) || (slot.source ? `← ${sourceLabel(slot.source)}` : '- nobody yet -');
    wrap.append(el('span', 'sch-side-name', {}, label));
    return wrap;
  }

  const sourceLabel = (source) => {
    const from = doc.fixtures.find((entry) => entry.id === source.fixtureId);
    return from ? `${source.take === 'loser' ? 'Loser' : 'Winner'} of ${fixtureLabel(from)}` : 'a match that is gone';
  };

  // ------------------------------------------------------------- the modal ---

  /**
   * The match editor.
   *
   * ## Why it is a modal and not a card under the list
   *
   * It used to open inline, which put every input on the page underneath
   * whichever fixture was open - and once the bracket arrived that was two
   * views of the same match with a column of text boxes beneath both. A match
   * is one thing to edit and the page is where you choose which; only the
   * STAGE's own settings stay outside, because those are properties of the
   * competition rather than of any one match.
   *
   * ## It is the only place on this page with a text input, and it repaints
   * nothing
   *
   * Which is the caret rule, met the other way round from the list. The dialog
   * is built ONCE, lives on `document.body` rather than inside `host`, and is
   * never touched by `paint()` - so a repaint provoked by anything else cannot
   * replace the box being typed into. Writes go into a draft and reach the
   * server only on Save, so Cancel really does mean nothing happened.
   *
   * A native `dialog` with `showModal()`, so Escape, the backdrop and the focus
   * trap are the platform's rather than three more things to get wrong.
   */
  function openMatch(fixture) {
    // One at a time. A second dialog over the first would take the focus trap
    // with it and strand the one underneath. The rule lives in modal.js now.
    if (modalOpen()) return;

    const draft = {
      ...structuredClone(fixture),
      maps: Array.from({ length: fixture.bestOf }, (_, i) => ({ ...emptyMapRow(), ...(fixture.maps[i] ?? {}) })),
    };

    /*
     * Snapshotted once the draft is complete and before anything is drawn.
     *
     * It has to be after the map rows are padded out to `bestOf` above: those
     * rows are the form filling itself in, and taking the snapshot first would
     * make every Bo3 with two maps played read as edited the moment it opened.
     */
    const dirty = watchChanges(() => JSON.stringify(draft));

    openFixture = fixture.id;
    const form = el('div', 'sch-modal-body');

    const tally = el('span', 'sch-result-score');
    const maps = el('div', 'sch-maps');
    const retally = () => {
      const score = fixtureScore({ maps: draft.maps });
      const need = mapsNeeded(draft.bestOf);
      tally.textContent = `${score.left} - ${score.right}`;
      tally.classList.toggle('is-decided', score.left >= need || score.right >= need);
    };

    // Only the map rows are rebuilt when the series length changes - never the
    // whole dialog, which would replace the team selects mid-edit.
    const paintMaps = () => {
      maps.replaceChildren(...draft.maps.map((row, i) => mapRow(row, i, retally)));
      retally();
    };

    const heading = el('h2', 'sch-modal-title', {}, fixtureLabel(fixture));
    heading.append(el('span', 'sch-modal-sub', {}, roundName(stageOf(fixture.stageId) ?? {}, fixture)));

    form.append(
      heading,
      grid(2, [field('Left team', modalSide(draft, 'left')), field('Right team', modalSide(draft, 'right'))]),
      grid(2, [field('Series', seriesPicker(draft, paintMaps)), field('Result', resultPicker(draft))]),
      /*
       * Which group this match is in, and ONLY when the stage has any.
       *
       * A select that offers one choice is a control an operator has to read
       * and then ignore, on the dialog they open ninety seconds before a match.
       * Most stages have no groups at all, so most of the time this is not
       * there.
       */
      ...(stageHasGroups(stageOf(fixture.stageId)) ? [field('Group', groupPicker(draft))] : []),
      el('div', 'subhead', {}, 'Maps'),
      maps,
    );

    /*
     * Declared before the handlers that close over it and assigned after the
     * body is built, because openModal wants a finished body and the buttons
     * inside that body want something to close. `let` rather than threading a
     * callback through, which would be the same indirection wearing a hat.
     */
    let dialog = null;

    const save = el('button', 'btn btn-primary', { type: 'button' }, 'Save');
    save.addEventListener('click', () => {
      /*
       * ONE write, carrying the whole fixture.
       *
       * `fixture.save` replaces the record, so the draft has to be complete -
       * and going through `apply` means propagation, acyclicity and the refusal
       * to rewrite a match that has already been played all still hold. Two
       * writes (the teams, then the result) would be two validations with the
       * first already committed if the second failed.
       */
      act({ action: 'fixture.save', fixture: draft }, () => {
        toast(`Saved ${fixtureLabel(draft)}`);
        dialog?.close();
      });
    });

    const drop = el('button', 'btn btn-ghost sch-modal-drop', { type: 'button' }, 'Remove match');
    drop.addEventListener('click', () => {
      if (!window.confirm(`Remove "${fixtureLabel(fixture)}"?`)) return;
      act({ action: 'fixture.remove', id: fixture.id }, () => dialog?.close());
    });

    const cancel = el('button', 'btn btn-ghost', { type: 'button' }, 'Cancel');
    // askClose rather than close - a match editor holds both teams, the series
    // length and every map row, and none of it is written until Save.
    cancel.addEventListener('click', () => askClose(dialog));

    const foot = el('div', 'sch-modal-foot');
    foot.append(drop, el('span', 'sch-modal-spacer'), tally, cancel, save);

    paintMaps();

    /*
     * modal.js owns the scaffolding - on document.body, one teardown path for
     * Escape / backdrop / Cancel / Save alike, one dialog at a time. The class
     * is kept so this panel's own width and footer rules still find it.
     */
    dialog = openModal({
      className: 'sch-modal',
      body: form,
      dirty,
      foot,
      onClose: () => {
        openFixture = '';
        paint();
      },
    });

    paint();
  }

  /**
   * Which group of its stage this match belongs to.
   *
   * "Not in a group" is a real answer and is offered first: splitting an
   * existing pool leaves every match ungrouped until somebody assigns them, and
   * an operator part-way through that has to be able to see and keep that
   * state rather than being forced to pick one.
   */
  function groupPicker(draft) {
    const stage = stageOf(draft.stageId);
    const pick = el('select', null, { 'aria-label': 'Group' });
    pick.append(el('option', null, { value: '' }, '- not in a group -'));
    for (const group of stage?.groups ?? []) {
      pick.append(
        el('option', null, { value: group.id, selected: group.id === (draft.group ?? '') ? 'selected' : null }, group.name),
      );
    }
    pick.addEventListener('change', () => {
      draft.group = pick.value;
    });
    return pick;
  }

  /** A team picker, writing into the draft rather than to the server. */
  function modalSide(draft, which) {
    const slot = draft[which];
    const pick = el('select', null, { 'aria-label': `${which} team` });
    pick.append(el('option', null, { value: '' }, slot.source ? `← ${sourceLabel(slot.source)}` : '- nobody yet -'));
    for (const team of library) {
      // The full name, not teamLabel() - that prefers the tricode, which is
      // right on a graphic at 1920x1080 and useless where "ALP" and "ALT" are
      // the whole of what an operator has to tell apart.
      pick.append(
        el('option', null, { value: team.id, selected: team.id === slot.teamId ? 'selected' : null }, team.name || teamLabel(team)),
      );
    }
    /*
     * A team that is IN the fixture but not selectable from the library.
     *
     * Two ways to get here and both are ordinary: a fixture generated or
     * imported by name alone carries no `teamId`, and a team picked last month
     * may since have left the library. Without this the picker reads
     * "- nobody yet -" for a match that plainly has two teams in its own title,
     * and the first save silently empties it - which is the shape of bug the
     * whole copy-not-link rule exists to avoid.
     *
     * `__keep` rather than the id, because there may be no id: it means "leave
     * this slot exactly as it is", which is a third answer the other two
     * options cannot express.
     */
    const known = library.some((team) => team.id === slot.teamId);
    if (slot.name && !known) {
      pick.append(el('option', null, { value: '__keep', selected: 'selected' }, `${slot.name} (not from the library)`));
    }

    pick.addEventListener('change', () => {
      if (pick.value === '__keep') return;
      const team = library.find((entry) => entry.id === pick.value);
      // Picking a team by hand is what PINS a slot, so the edge is cleared
      // explicitly - the sanitiser deliberately arbitrates neither.
      draft[which] = team ? { ...asSlot(team), source: null } : { ...slot, ...EMPTY_TEAM, teamId: '' };
    });
    return pick;
  }

  /** The series length. Changing it adds or removes map rows there and then. */
  function seriesPicker(draft, paintMaps) {
    const pick = el('select', null, { 'aria-label': 'Series length' });
    for (const value of BEST_OF_CHOICES) {
      pick.append(
        el('option', null, { value: String(value), selected: value === draft.bestOf ? 'selected' : null }, `Best of ${value}`),
      );
    }
    pick.addEventListener('change', () => {
      const wanted = Number(pick.value);
      /*
       * Shortening a series drops rows off the end, and it says so.
       *
       * The server would slice them silently on the way in - `sanitiseFixture`
       * runs on LOAD as well as on write, so it cannot refuse - which means a
       * played map can leave a record with nothing raised. Here it is at least
       * visible, and Cancel still undoes it because nothing has been written.
       */
      const losing = draft.maps.slice(wanted).filter((row) => row.award || row.left || row.right).length;
      if (losing) toast(`That drops ${losing} recorded map${losing === 1 ? '' : 's'}. Cancel to keep them.`);
      draft.bestOf = wanted;
      draft.maps = Array.from({ length: wanted }, (_, i) => ({ ...emptyMapRow(), ...(draft.maps[i] ?? {}) }));
      paintMaps();
    });
    return pick;
  }

  /** How the series was decided, for the cases the maps cannot express. */
  function resultPicker(draft) {
    const pick = el('select', null, { 'aria-label': 'Series result' });
    for (const [value, label] of [
      ['auto', 'From the maps'],
      ['left', 'Left wins (forfeit)'],
      ['right', 'Right wins (forfeit)'],
      ['void', 'Void - no result'],
    ]) {
      pick.append(el('option', null, { value, selected: value === draft.winner ? 'selected' : null }, label));
    }
    pick.addEventListener('change', () => {
      draft.winner = pick.value;
    });
    return pick;
  }

  /** One map of the series. The only text input on this page. */
  function mapRow(row, i, retally) {
    const line = el('div', 'sch-map');

    const name = el('input', null, {
      type: 'text',
      placeholder: `Map ${i + 1}`,
      maxlength: 40,
      'aria-label': `Map ${i + 1} name`,
    });
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
     * A forfeit on one map. 0-0 is the normal state of a map nobody has played,
     * so a map won by a walkover cannot be expressed as a score at all -
     * without this it would either read as unplayed or want a fake 13-0 that
     * then flowed into the round differential on the table.
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
    return line;
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

  /*
   * The bracket, drawn.
   *
   * ## Every number comes from arithmetic
   *
   * `bracketLayout` answers in abstract units - columns and rows, both possibly
   * fractional - and the four constants below are the only pixels in it. That
   * is not tidiness: this panel lives behind a sub-tab, sub-tabs are hidden
   * with `display: none`, and `shell.js` fires no event when one opens. A
   * layout that measured itself would read zero for everything and stack the
   * whole bracket on one spot, on the first paint only, which is the kind of
   * fault that survives every DOM assertion.
   *
   * ## It repaints freely
   *
   * No text input anywhere in it - cards are buttons - so the caret rule is
   * satisfied by shape, exactly like the fixture list above it.
   */
  const CARD_W = 188;
  const CARD_H = 44;
  const COL_GAP = 46;
  const ROW_H = 56;

  const atX = (column) => column * (CARD_W + COL_GAP);
  const atY = (row) => row * ROW_H;

  function bracket(stage) {
    const layout = bracketLayout(doc, stage.id);
    if (!layout.nodes.length) {
      return el('p', 'field-help', {}, 'Nothing to draw yet - lay the stage out, or add a match.');
    }

    const width = layout.columns * (CARD_W + COL_GAP) - COL_GAP;
    const height = layout.rows * ROW_H;

    // Its own scroll container: a bracket is a diagram and may legitimately be
    // wider than the panel, which is the one thing allowed to overflow.
    const scroller = el('div', 'sch-bracket-scroll');
    const frame = el('div', 'sch-bracket');
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;

    frame.append(connectors(layout, width, height));
    for (const node of layout.nodes) frame.append(bracketCard(node));

    scroller.append(frame);
    return scroller;
  }

  /**
   * The elbows between matches, as one SVG behind the cards.
   *
   * Drawn from the same coordinates the cards use rather than from anything
   * measured, so a line cannot drift from the card it points at. An edge into
   * another band - an upper-bracket loser dropping into the lower - is drawn
   * like any other, which is the whole reason a double elimination is legible
   * at all.
   */
  function connectors(layout, width, height) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'sch-links');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    for (const link of layout.links) {
      const x1 = atX(link.from.column) + CARD_W;
      const y1 = atY(link.from.row) + CARD_H / 2;
      const x2 = atX(link.to.column);
      const y2 = atY(link.to.row) + CARD_H / 2;
      // Halfway across the gap, then vertically, then in - the square elbow a
      // bracket is always drawn with. A curve would read as a flow chart.
      const mid = x1 + Math.max(12, (x2 - x1) / 2);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`);
      // A loser's path is dashed, because "the loser of this drops to there" is
      // a different claim from "the winner advances" and a bracket that draws
      // them alike is one an operator has to trace with a finger.
      path.setAttribute('class', `sch-link is-${link.take}`);
      svg.append(path);
    }

    return svg;
  }

  /** One match in the bracket. A button, because clicking it opens its result. */
  function bracketCard(node) {
    const { fixture } = node;
    const status = fixtureStatus(fixture);
    const score = fixtureScore(fixture);
    const won = fixtureWinner(fixture);

    /*
     * The tooltip names where an unplayed side COMES from; the card does not.
     *
     * In a drawn bracket the connector is the answer to "who plays here" - that
     * is what the line is for, and it is why the list below needs the words and
     * this does not. Printing "Winner of Sentinels vs LOUD" in a 188px card
     * would ellipsis away to "Winner of Sentine..." and say less than the line
     * already does. So the card stays quiet and the hover is exact.
     */
    const describe = (which) =>
      slotLabel(fixture[which]) || (fixture[which]?.source ? sourceLabel(fixture[which].source) : 'nobody yet');
    const card = el('button', `sch-node is-${status}${fixture.id === openFixture ? ' is-open' : ''}`, {
      type: 'button',
      title: `${describe('left')} v ${describe('right')} - best of ${fixture.bestOf}`,
    });
    card.style.left = `${atX(node.column)}px`;
    card.style.top = `${atY(node.row)}px`;
    card.style.width = `${CARD_W}px`;
    card.style.height = `${CARD_H}px`;

    for (const which of ['left', 'right']) {
      const slot = fixture[which];
      const line = el('span', `sch-node-side${won === which ? ' is-won' : ''}`);
      line.append(
        // slotLabel already answers "Winner of QF1" for a slot with an edge and
        // no team yet, so an undrawn round reads as a promise rather than blank.
        el('span', 'sch-node-name', {}, slotLabel(slot) || '—'),
        el('span', 'sch-node-score', {}, status === 'scheduled' ? '' : String(score[which])),
      );
      card.append(line);
    }

    card.addEventListener('click', () => openMatch(fixture));
    return card;
  }

  /**
   * Every table this stage wants, which is one when it has no groups.
   *
   * The list comes from `stageTables` rather than from a branch here, so the
   * grouped and ungrouped cases render through the SAME code - two paths for
   * one table is how the grouped one ends up missing whatever the ungrouped one
   * gains next.
   */
  function tables(stage) {
    const box = el('div', 'sch-tables');
    for (const entry of stageTables(doc, stage)) {
      // The heading only when there is more than one thing to tell apart. A
      // lone table under the word "Standings" does not also need a subtitle.
      if (entry.name) box.append(el('div', 'subhead', {}, entry.name));
      box.append(table(stage, entry.table));
    }
    return box;
  }

  function table(stage, rows = standings(doc, stage.id)) {
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
        stage ? stageSummary(stage) : null,
        /*
         * The bracket goes ABOVE the list and the table goes below it, and the
         * asymmetry is the job rather than an oversight. A table is something
         * an operator CHECKS, so it reads last; a bracket is how they NAVIGATE
         * a knockout, and clicking a match in it opens that fixture's result
         * editor in the list - which has to be in the direction you are already
         * reading, or the thing you just opened is off the top of the screen.
         */
        stage && !stageHasTable(stage) ? title('Bracket') : null,
        stage && !stageHasTable(stage) ? bracket(stage) : null,
        stage ? fixtureList(stage) : el('p', 'field-help', {}, 'Add a stage to start building the schedule.'),
        stage && stageHasTable(stage) ? title('Standings') : null,
        stage && stageHasTable(stage) ? tables(stage) : null,
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
