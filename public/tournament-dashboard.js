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

import { el, grid, help, makeFields, title } from './fields.js';
import { mediaControl } from './media-field.js';
import { TOURNAMENT_FIELDS, tournamentLabel } from './tournament-schema.js';
import { account, refreshAccount } from './session.js';

const $ = (id) => document.getElementById(id);
const toast = (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: message }));

const els = {
  tab: document.querySelector('.rail-item[data-tab="tournament"]'),
  pick: $('tou-select'),
  fresh: $('tou-new'),
  archive: $('tou-archive'),
  state: $('tou-state'),
  note: $('tou-note'),
  settings: $('tou-settings'),
  fields: $('tou-fields'),
  saved: $('tou-saved'),
  access: $('tou-access'),
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

  function paint() {
    // shell.js hides a sub-tab whose panel is hidden, so hiding these is also
    // what removes the strip - there is no second thing to keep in step.
    els.settings.hidden = !current;
    els.access.hidden = !current;
    els.fresh.hidden = !mayCreate;

    // Archiving is the owner's, and it is the only control here that says what
    // it will do rather than what the state is - "Archive" / "Reopen".
    els.archive.hidden = !current || !isOwner();
    els.archive.textContent = current?.archivedAt ? 'Reopen' : 'Archive';

    paintPicker();
    if (current) {
      buildSettings();
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
