/**
 * The Tournament page.
 *
 * Settings is what the competition IS; Access is who may work on it. Both are
 * built from the schema rather than hand-written - a field added to
 * tournament-schema.js appears here, is sanitised on the server, and reaches
 * anything that reads the record, which is the whole reason that file exists.
 *
 * ## It opens no stream, and that is deliberate
 *
 * Every other dashboard rides the one multiplexed /api/events - six connections
 * per origin is a cap this page has already hit once, and a seventh EventSource
 * for a panel somebody opens twice a season would be a poor trade. A tournament
 * changes when somebody presses something here, so a refetch after a write is
 * the whole of what it needs.
 *
 * The cost is honest and worth writing down: two owners editing one tournament
 * will not see each other's changes until one of them reloads. That is the same
 * trade the team and player libraries already make, and it is the thing to
 * revisit first if tournaments turn out to be edited by more than one person at
 * a time.
 *
 * ## Nothing here is per-session
 *
 * A tournament belongs to no production, so this page ignores `?session=`
 * entirely and talks to /api/tournaments with the login cookie alone. That is
 * why it uses plain fetch rather than session.js's api() - adding a session
 * parameter would imply a relationship that does not exist.
 */

import { el, field, grid, help, makeFields, subhead, title } from './fields.js';
import { modalFoot, modalOpen, modalTitle, openModal } from './modal.js';
import { mediaControl } from './media-field.js';
import { TOURNAMENT_FIELDS, tournamentLabel } from './tournament-schema.js';
import { account, refreshAccount, switchDesk } from './session.js';

const $ = (id) => document.getElementById(id);
const toast = (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: message }));

const els = {
  tab: document.querySelector('.rail-item[data-tab="tournament"]'),
  pick: $('tou-select'),
  fresh: $('tou-new'),
  archive: $('tou-archive'),
  schedule: $('tou-schedule'),
  export: $('tou-export'),
  delete: $('tou-delete'),
  state: $('tou-state'),
  note: $('tou-note'),
  settings: $('tou-settings'),
  fields: $('tou-fields'),
  desks: $('tou-desks'),
  saved: $('tou-saved'),
  access: $('tou-access'),
  teams: $('tou-teams'),
  players: $('tou-players'),
  members: $('tou-members'),
  add: $('tou-add'),
  addWho: $('tou-add-who'),
  addLevel: $('tou-add-level'),
  addGo: $('tou-add-go'),
};

// The page is not in this build of the dashboard - nothing to wire.
if (els.pick) {
  let me = null;
  /** Every tournament this account can see. */
  let all = [];
  /** The one on screen, as a separate object because the fields write into it. */
  let current = null;
  let mayCreate = false;
  /** Other accounts, for the Add row. Fetched only by somebody who can use it. */
  let people = [];

  /** Which tournament to open on load, remembered for this browser only. */
  const LAST_KEY = 'vct.tournament.last';

  const remember = (id) => {
    try {
      if (id) localStorage.setItem(LAST_KEY, id);
      else localStorage.removeItem(LAST_KEY);
    } catch {
      // A browser with storage denied still gets a working page, just a
      // forgetful one - the same call the rail's collapse makes.
    }
  };

  const remembered = () => {
    try {
      return localStorage.getItem(LAST_KEY) ?? '';
    } catch {
      return '';
    }
  };

  /** Every write on this page is the same shape, so it is written once. */
  async function send(body) {
    const response = await fetch('/api/tournaments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      throw new Error(payload?.error?.message ?? `Request failed (HTTP ${response.status}).`);
    }
    return payload;
  }

  const levelOf = (tournament) =>
    tournament?.members?.find((member) => member.id === me?.user?.id)?.level ?? null;

  const isOwner = () => levelOf(current) === 'owner';
  const mayEdit = () => ['owner', 'editor'].includes(levelOf(current)) && !current?.archivedAt;

  // ------------------------------------------------------------- settings ---

  const SAVE_DEBOUNCE_MS = 250;
  let saveTimer = null;
  let saveGeneration = 0;

  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
  }

  async function save() {
    saveTimer = null;
    if (!current) return;
    const generation = (saveGeneration += 1);
    const id = current.id;

    try {
      const payload = await send({ action: 'update', id, fields: current });
      // A reply for a tournament the operator has since switched away from must
      // not paint over the one they are now looking at.
      if (generation !== saveGeneration || current?.id !== id) return;
      current = payload.tournament;
      all = all.map((entry) => (entry.id === id ? { ...payload.tournament, level: entry.level } : entry));
      paintPicker();
      els.saved.textContent = 'Saved.';
    } catch (error) {
      els.saved.textContent = '';
      toast(`Tournament not saved: ${error.message}`);
    }
  }

  const fields = makeFields(() => current, queueSave);

  function buildSettings() {
    if (!current) return;

    const controls = TOURNAMENT_FIELDS.map((entry) => {
      if (entry.type === 'image') {
        return mediaControl(
          entry.label,
          () => current[entry.key],
          (value) => {
            current[entry.key] = value;
            queueSave();
          },
          { placeholder: 'https://... or drop a file here' },
        );
      }
      if (entry.type === 'date') return fields.dateField(entry.label, entry.key);
      return fields.textField(entry.label, entry.key, {
        placeholder: entry.placeholder ?? '',
        maxlength: entry.max ?? 120,
      });
    });

    /*
     * The dates side by side and everything else full width. Two calendar boxes
     * in one row reads as a range, which is what it is; a name or a logo in half
     * a column just wastes the other half.
     */
    const dates = TOURNAMENT_FIELDS.map((entry, i) => [entry, controls[i]]).filter(([entry]) => entry.type === 'date');
    const rest = TOURNAMENT_FIELDS.map((entry, i) => [entry, controls[i]]).filter(([entry]) => entry.type !== 'date');

    els.fields.replaceChildren(
      ...rest.flatMap(([entry, control]) => [control, entry.help ? help(entry.help) : null]).filter(Boolean),
      grid(2, dates.map(([, control]) => control)),
    );

    // Read-only means read-only, said rather than merely enforced. The server
    // refuses the write either way; a disabled box is how somebody finds out
    // before they have typed a paragraph into it.
    const locked = !mayEdit();
    for (const input of els.fields.querySelectorAll('input, select, textarea, button')) {
      input.disabled = locked;
    }
    els.saved.textContent = locked
      ? current.archivedAt
        ? 'Archived. Reopen it to change these.'
        : 'You have view-only access to this tournament.'
      : '';
  }

  /**
   * The desks, listed and managed.
   *
   * No text input anywhere in here - naming a desk happens in a dialog rather
   * than in an inline box, so this block is free to repaint on every change.
   * The caret rule, obeyed by not having the problem.
   */
  function buildDesks() {
    if (!current) return;
    const owner = isOwner();
    const rows = current.productions ?? [];

    els.desks.replaceChildren(
      ...rows.map((desk) => {
        const row = el('div', 'desk-row');
        row.append(
          el('span', 'desk-name', {}, desk.name || 'Untitled production'),
          el(
            'span',
            'desk-note',
            { title: desk.hasControlKey ? 'A stream deck can drive this desk.' : '' },
            desk.hasControlKey ? 'OBS + stream deck' : 'OBS',
          ),
        );

        const open = el('button', 'mini-btn', { type: 'button', title: 'Point this dashboard at that desk' }, 'Open');
        open.addEventListener('click', () => switchDesk(desk.id));
        row.append(open);

        if (mayEdit()) {
          const manage = el('button', 'mini-btn', { type: 'button' }, 'Manage');
          // `owner && rows.length > 1` is the whole rule for offering Remove,
          // and it is decided here rather than in the dialog so the dialog does
          // not have to know how many desks there are.
          manage.addEventListener('click', () => openDesk(desk, owner && rows.length > 1));
          row.append(manage);
        }

        return row;
      }),
      ...(owner ? [addDeskRow()] : []),
    );
  }

  /**
   * A desk, in a dialog.
   *
   * All three of these were `window.prompt()`, and the removal one is why they
   * stopped being. A prompt cannot say what it is about to take in a way
   * anybody reads - the consequence had to be crammed into the message string
   * above the box, which is exactly where a person about to type a name to
   * confirm something is not looking. It also cannot mark the difference
   * between the box you type a NEW name into and the box you type an EXISTING
   * name into to destroy it, which were two visually identical prompts one
   * button apart.
   *
   * The typed-back name stays. A confirm dialog is answered "yes" by reflex and
   * a name is not, and this takes a whole set of graphics with it.
   */
  function openDesk(desk, mayRemove) {
    if (modalOpen()) return;

    let dialog = null;
    const body = el('div', 'rl-modal-body');

    const name = el('input', null, { type: 'text', maxlength: 60, 'aria-label': 'Production name' });
    name.value = desk.name ?? '';

    const save = el('button', 'btn btn-primary', { type: 'button' }, 'Save');
    save.addEventListener('click', async () => {
      const wanted = name.value.trim();
      if (!wanted || wanted === desk.name) {
        dialog?.close();
        return;
      }
      try {
        const payload = await send({
          action: 'production.update',
          id: current.id,
          productionId: desk.id,
          fields: { name: wanted },
        });
        current = payload.tournament;
        await refreshAccount();
        dialog?.close();
        paint();
      } catch (error) {
        toast(error.message);
      }
    });

    const cancel = el('button', 'btn btn-ghost', { type: 'button' }, 'Cancel');
    cancel.addEventListener('click', () => dialog?.close());

    let drop = null;
    if (mayRemove) {
      const typed = el('input', null, { type: 'text', placeholder: desk.name, 'aria-label': 'Type the name to confirm' });
      drop = el('button', 'btn btn-ghost rl-modal-danger', { type: 'button' }, 'Remove this production');
      drop.disabled = true;
      // The button turns on only when the name matches, so the confirmation is
      // visible BEFORE the click rather than being a second dialog after it.
      typed.addEventListener('input', () => {
        drop.disabled = typed.value.trim() !== desk.name;
      });
      drop.addEventListener('click', async () => {
        try {
          const payload = await send({
            action: 'production.remove',
            id: current.id,
            productionId: desk.id,
            confirm: typed.value.trim(),
          });
          current = payload.tournament;
          await refreshAccount();
          dialog?.close();
          paint();
          toast(`Removed "${desk.name}"`);
        } catch (error) {
          toast(error.message);
        }
      });

      body.append(
        subhead('Remove'),
        help(
          'Its graphics, its OBS URLs and its stream deck key all go, and that cannot be undone. The teams, the ' +
            'schedule and the player names stay - they belong to the tournament, not to this desk.',
        ),
        field('Type the name to confirm', typed),
      );
    }

    body.prepend(
      modalTitle(desk.name || 'Untitled production', desk.hasControlKey ? 'OBS + stream deck' : 'OBS'),
      field('Name', name),
    );

    dialog = openModal({ body, foot: modalFoot({ danger: drop, cancel, confirm: save }) });
  }

  function addDeskRow() {
    const add = el('button', 'btn btn-small', { type: 'button' }, 'Add production');
    add.addEventListener('click', () => {
      if (modalOpen()) return;

      let dialog = null;
      const body = el('div', 'rl-modal-body');
      const name = el('input', null, { type: 'text', maxlength: 60, 'aria-label': 'Production name' });
      name.value = 'Court 2';

      const make = el('button', 'btn btn-primary', { type: 'button' }, 'Add production');
      make.addEventListener('click', async () => {
        const wanted = name.value.trim();
        if (!wanted) return;
        try {
          const payload = await send({ action: 'production.create', id: current.id, name: wanted });
          current = payload.tournament;
          // The topbar's production selector lives in account.js and is built
          // from the cached account, which knows nothing about this yet.
          await refreshAccount();
          dialog?.close();
          paint();
          toast(`Added "${wanted}" - it has its own OBS URLs`);
        } catch (error) {
          toast(error.message);
        }
      });

      const cancel = el('button', 'btn btn-ghost', { type: 'button' }, 'Cancel');
      cancel.addEventListener('click', () => dialog?.close());

      body.append(
        modalTitle('Add a production'),
        help(
          'A second desk: its own graphics, its own OBS URLs and its own stream deck key. The teams, the schedule ' +
            'and the player names are shared with the rest of the tournament.',
        ),
        field('Name', name),
      );

      dialog = openModal({ body, foot: modalFoot({ cancel, confirm: make }) });
    });
    return add;
  }

  // --------------------------------------------------------------- access ---

  function buildAccess() {
    if (!current) return;
    const owner = isOwner();

    els.members.replaceChildren(
      ...current.members.map((member) => {
        const row = el('div', 'access-row');
        row.append(
          el('span', 'access-name', {}, member.username + (member.id === me?.user?.id ? ' (you)' : '')),
        );

        for (const level of ['owner', 'editor', 'viewer']) {
          const button = el(
            'button',
            `btn btn-small${member.level === level ? ' is-active' : ''}`,
            { type: 'button' },
            level[0].toUpperCase() + level.slice(1),
          );
          button.disabled = !owner || member.level === level;
          button.addEventListener('click', () => setMember(member, level));
          row.append(button);
        }

        const remove = el('button', 'btn btn-small btn-danger', { type: 'button' }, 'Remove');
        remove.disabled = !owner;
        remove.addEventListener('click', () => setMember(member, ''));
        row.append(remove);

        return row;
      }),
    );

    els.add.hidden = !owner;
    if (owner) paintAddList();
  }

  function paintAddList() {
    const already = new Set(current.members.map((member) => member.id));
    const free = people.filter((person) => !already.has(person.id));
    els.addWho.replaceChildren(
      ...free.map((person) => el('option', null, { value: person.id }, person.username)),
    );
    els.addGo.disabled = free.length === 0;
    els.addWho.disabled = free.length === 0;

    /*
     * Two different empties, said differently.
     *
     * This used to say "everybody is already on this" whenever the list came
     * out short, which is true when there are other accounts and they are all
     * members - and an affirmative lie when there are no other accounts at all,
     * or when the page simply has a stale copy. An owner reading it would stop
     * looking for the person they were trying to add.
     */
    if (!free.length) {
      els.addWho.replaceChildren(
        el(
          'option',
          null,
          {},
          people.length ? 'everybody is already on this' : 'no other accounts yet',
        ),
      );
    }
  }

  async function setMember(member, level) {
    /*
     * Only warned about on the way DOWN, and only for yourself. Handing
     * somebody else a level is undoable in one click by whoever did it; taking
     * your own last powers away is the one move on this panel that can leave an
     * operator unable to put it back.
     */
    if (member.id === me?.user?.id && member.level === 'owner' && level !== 'owner') {
      const gone = level ? `become ${level} on` : 'leave';
      if (!window.confirm(`${gone === 'leave' ? 'Leave' : 'Step down on'} "${tournamentLabel(current)}"?\n\nAnother owner would have to add you back.`)) {
        return;
      }
    }

    try {
      const payload = await send({ action: 'member', id: current.id, userId: member.id, level });
      current = payload.tournament;
      // Leaving removes it from the list this account can see at all.
      if (!levelOf(current)) {
        await load(null);
        toast(`You are no longer on "${tournamentLabel(payload.tournament)}"`);
        return;
      }
      all = all.map((entry) => (entry.id === current.id ? { ...current, level: levelOf(current) } : entry));
      buildAccess();
      buildSettings();
    } catch (error) {
      toast(error.message);
    }
  }

  // ---------------------------------------------------------------- chrome ---

  function paintPicker() {
    els.pick.replaceChildren(
      ...all.map((entry) =>
        el(
          'option',
          null,
          { value: entry.id, selected: entry.id === current?.id ? 'selected' : null },
          `${tournamentLabel(entry)}${entry.archivedAt ? ' - archived' : ''}`,
        ),
      ),
    );
    els.pick.hidden = all.length === 0;
    els.pick.parentElement.hidden = all.length === 0;

    els.state.hidden = !current?.archivedAt;
    if (current?.archivedAt) els.state.textContent = 'Archived';

    els.note.textContent = all.length
      ? ''
      : mayCreate
        ? 'No tournaments yet. Make one to get started.'
        : 'You are not on any tournament yet. Whoever runs one can add you to it.';
  }

  /** Which tournament the sub-pages last painted for, so the event fires on a CHANGE. */
  let announced = null;

  function paint() {
    /*
     * Tell the sub-pages built by other modules which tournament this is.
     *
     * schedule-dashboard.js reads a tournament-scoped route and is built at
     * page load, which on a fresh install happens while there is nothing to
     * read - so without this it would fetch once, get a 403, and never try
     * again. The operator would create their first tournament and find an empty
     * Schedule tab with nothing saying why.
     *
     * On a CHANGE rather than on every paint, because paint runs on every
     * keystroke in Settings and a refetch per keystroke is a different bug.
     */
    if (current?.id !== announced) {
      announced = current?.id ?? null;
      window.dispatchEvent(new CustomEvent('tournament-changed', { detail: current }));
    }

    // shell.js hides a sub-tab whose panel is hidden, so hiding these is also
    // what removes the strip - there is no second thing to keep in step.
    els.settings.hidden = !current;
    els.access.hidden = !current;
    /*
     * The two libraries, which belong to the tournament and are therefore
     * meaningless without one. shell.js hides a sub-tab whose panel is hidden,
     * so this is also what takes their buttons off the strip - there is no
     * second thing to keep in step.
     */
    els.teams.hidden = !current;
    els.players.hidden = !current;
    els.schedule.hidden = !current;
    els.fresh.hidden = !mayCreate;

    // Archiving is the owner's, and it is the only control here that says what
    // it will do rather than what the state is - "Archive" / "Reopen".
    els.archive.hidden = !current || !isOwner();
    els.archive.textContent = current?.archivedAt ? 'Reopen' : 'Archive';

    /*
     * Export is for anybody who may edit - it reads what they can already see,
     * and an editor wanting a copy of the team library before a season ends is
     * an ordinary thing to want.
     *
     * Delete is owner-only AND archived-only, which is the archive/delete split
     * made visible rather than merely enforced: the irreversible button is not
     * on the page until the reversible step has been taken.
     */
    /*
     * NOT mayEdit(), which is false on an archived tournament - that would hide
     * Export at the exact moment it matters, since the only way to reach Delete
     * is to archive first. Exporting reads what the caller can already see, so
     * it is a level question and not an archived one.
     */
    els.export.hidden = !current || !['owner', 'editor'].includes(levelOf(current));
    els.delete.hidden = !current || !isOwner() || !current.archivedAt;

    paintPicker();
    if (current) {
      buildSettings();
      buildDesks();
      buildAccess();
    }
  }

  /**
   * Fetch everything and show one.
   *
   * `wanted` picks which: an id, or null for "whatever makes sense" - the one
   * this browser was last on, else the newest. A remembered id that has since
   * been archived, deleted, or had this account removed from it simply does not
   * match, and the fallback takes over.
   */
  async function load(wanted) {
    try {
      const response = await fetch('/api/tournaments');
      if (!response.ok) return;
      const payload = await response.json();
      all = payload.tournaments ?? [];
      mayCreate = payload.mayCreate === true;

      const pick = wanted ?? current?.id ?? remembered();
      current = all.find((entry) => entry.id === pick) ?? all[0] ?? null;
      remember(current?.id);

      /*
       * The rail item appears for somebody who has a tournament or could make
       * one, and stays hidden otherwise. An operator who will never touch this
       * page should not be given a button that leads to an explanation of why
       * it is empty - the same call account.js makes about the Admin tab.
       */
      if (els.tab) els.tab.hidden = !all.length && !mayCreate;

      if (mayCreate) await loadPeople();
      paint();
    } catch {
      // A failed fetch leaves the page as it was rather than blanking it. There
      // is nothing here an operator needs mid-map, so a quiet stale panel beats
      // an empty one.
    }
  }

  /**
   * Other accounts, for the Add row.
   *
   * /api/account/me already lists who this person may share a session with,
   * which is every enabled account - so there is no second route to add and no
   * account list shipped to somebody who cannot use it.
   */
  async function loadPeople() {
    /*
     * Refetched, not read from the copy taken at boot.
     *
     * account() caches, so an account an administrator made AFTER this page
     * loaded never appeared in the picker - and because the empty list read as
     * "everybody is already on this", the page affirmatively told an owner
     * there was nobody left to add. Refetching costs one request on a panel
     * somebody opens twice a season.
     */
    me = (await refreshAccount()) ?? me;
    people = (me?.grantable ?? []).map((entry) => ({ id: entry.id, username: entry.username }));
  }

  // ---------------------------------------------------------------- wiring ---

  els.pick.addEventListener('change', () => {
    current = all.find((entry) => entry.id === els.pick.value) ?? null;
    remember(current?.id);
    paint();
  });

  els.fresh.addEventListener('click', async () => {
    const name = window.prompt('Name the tournament');
    // Cancel is null and must not create anything; an empty string is somebody
    // pressing OK on an empty box, which is a tournament they will name later.
    if (name === null) return;
    try {
      const payload = await send({ action: 'create', name });
      await load(payload.tournament.id);
      toast(`Created "${tournamentLabel(payload.tournament)}"`);
    } catch (error) {
      toast(error.message);
    }
  });

  els.archive.addEventListener('click', async () => {
    if (!current) return;
    const reopening = Boolean(current.archivedAt);
    if (
      !reopening &&
      !window.confirm(
        `Archive "${tournamentLabel(current)}"?\n\nIts settings stop being editable. Nothing is deleted, and it can be reopened at any time.`,
      )
    ) {
      return;
    }
    try {
      const payload = await send({ action: 'archive', id: current.id, archived: !reopening });
      current = payload.tournament;
      all = all.map((entry) => (entry.id === current.id ? { ...current, level: levelOf(current) } : entry));
      paint();
      toast(`"${tournamentLabel(current)}" ${reopening ? 'reopened' : 'archived'}`);
    } catch (error) {
      toast(error.message);
    }
  });

  /*
   * Write the whole tournament out as one file.
   *
   * Deliberately its own button next to Delete rather than something tucked
   * inside Settings: it is the answer to "can I get this back", and the answer
   * has to be beside the question. An owner who is about to delete a season
   * should not have to go looking for it.
   *
   * Not downloadLibraryFile, which builds the { kind, exported, entries } shape
   * the teams and aliases files use. This is a whole workspace rather than one
   * library, and giving it that envelope would make it look importable by the
   * library reader, which would take the first list it recognised and silently
   * drop the rest.
   */
  els.export.addEventListener('click', async () => {
    if (!current) return;
    try {
      const { export: bundle } = await send({ action: 'export', id: current.id });
      const stamp = new Date(bundle.exportedAt).toISOString().slice(0, 10);
      const slug = (bundle.name || 'tournament').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `riotline-tournament-${slug || 'untitled'}-${stamp}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(
        `Exported ${bundle.teams.length} team${bundle.teams.length === 1 ? '' : 's'} and ` +
          `${bundle.aliases.length} alias${bundle.aliases.length === 1 ? '' : 'es'}`,
      );
    } catch (error) {
      toast(error.message);
    }
  });

  /*
   * The one control here with no undo.
   *
   * Two gates, and they guard different mistakes. The button only exists on an
   * archived tournament, which is what stops a live competition going in a
   * mis-click - archiving is reversible, so reaching this at all takes a second
   * deliberate visit. Then the name has to be typed: a confirm dialog is
   * answered "yes" by reflex, and a name is not.
   *
   * A prompt rather than a confirm for exactly that reason. The server checks
   * the typed name again and is what actually enforces it - this one is here so
   * the refusal happens before the request rather than after.
   */
  els.delete.addEventListener('click', async () => {
    if (!current) return;
    const label = tournamentLabel(current);
    const typed = window.prompt(
      `Delete "${label}" for good?\n\n` +
        'This removes the tournament AND its whole workspace - every team, alias, preset and graphic. ' +
        'It cannot be undone, and Export is the only copy you will have.\n\n' +
        `Type the name to confirm:`,
    );
    if (typed === null) return;

    try {
      const payload = await send({ action: 'delete', id: current.id, confirm: typed });
      all = payload.tournaments.map((entry) => ({ ...entry, level: levelOf(entry) }));
      // Whatever is left, or nothing. paint() handles an empty list already -
      // it is the state a fresh install is in.
      current = all[0] ?? null;
      paint();
      toast(`Deleted "${label}"`);
    } catch (error) {
      toast(error.message);
    }
  });

  els.addGo.addEventListener('click', async () => {
    const userId = els.addWho.value;
    if (!userId) return;
    try {
      const payload = await send({
        action: 'member',
        id: current.id,
        userId,
        level: els.addLevel.value,
      });
      current = payload.tournament;
      all = all.map((entry) => (entry.id === current.id ? { ...current, level: levelOf(current) } : entry));
      buildAccess();
    } catch (error) {
      toast(error.message);
    }
  });

  window.addEventListener('app-tab', (event) => {
    if (event.detail === 'tournament' && me) void load(current?.id ?? null);
  });

  account().then(async (data) => {
    if (!data) return;
    me = data;
    await load(null);
  });
}
