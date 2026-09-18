/**
 * The Players page: one search across every player this tournament knows.
 *
 * ## What this replaced, and why
 *
 * It was a list of the alias library - every account the agent select feed had
 * ever reported, most of them unnamed, in the order they were seen. Two things
 * were wrong with it, and only the second is obvious in hindsight.
 *
 * It did not contain the people an operator was usually looking for. A squad
 * typed onto the Teams page an hour before doors is not in the feed's library
 * until somebody plays a game, so searching for a player by name on the page
 * called Players found nothing, while the Teams page had them all along.
 *
 * And it was the wrong question. "Show me every account, newest first" is a
 * report; "who is `sw1ft#0000` and what do we call them" is what somebody
 * actually asks, ninety seconds before a lobby, with a handle they cannot spell
 * from memory. So this is a search box, and it searches both libraries at once
 * - see players-index.js for the merge and for why there are two.
 *
 * ## Verification lives here too
 *
 * Because this is the page where you already have the Riot ID in front of you.
 * A row that belongs to a team writes its verification straight back onto that
 * team, through the ordinary /api/teams save - so a PUUID minted here is the
 * same fact, in the same place, as one minted from the roster editor. Nothing
 * about a player is stored twice.
 *
 * ## The caret rule, by structure
 *
 * The search box and the results are siblings, and only the results are ever
 * replaced. So a keystroke in the box filters the list beneath it without ever
 * touching the box itself, and the caret stays where it was - the schedule
 * page's problem, solved by the shape of the panel rather than by a modal.
 *
 * And now there is nothing else to get right: the cards hold no inputs at all,
 * so every text box on this page is either that search field or inside the Edit
 * modal, which lives on `document.body` and is never touched by a repaint. The
 * rule the old rows needed - nothing may repaint the list while an alias box is
 * focused - has no way left to be broken.
 */

import { el, field, help, title } from './fields.js';
import { askClose, modalFoot, modalOpen, modalTitle, openModal, watchChanges } from './modal.js';
import { mediaControl } from './media-field.js';
import { api } from './session.js';
import { indexPlayers, matchesPlayer, playerOrigin } from './players-index.js';
import { stripTagline } from './select-schema.js';
import {
  canVerify,
  onVerifyConfig,
  sweepPlayers,
  sweepSummary,
  verifyOffReason,
  verifyPlayers,
  verifyQuestion,
} from './player-verify.js';

const $ = (id) => document.getElementById(id);
const toast = (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: message }));

const wrap = (className, children) => {
  const node = el('div', className);
  node.append(...children.filter(Boolean));
  return node;
};

/** How many rows are painted at once. A library can be thousands; a screen cannot. */
const PAGE = 60;

let teams = [];
let aliases = [];
let needle = '';
let host = null;
let results = null;

// ------------------------------------------------------------------ data ---

async function post(route, body) {
  const response = await fetch(api(route), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    const { message, hint } = payload?.error ?? {};
    throw new Error([message ?? `HTTP ${response.status}`, hint].filter(Boolean).join(' '));
  }
  return payload;
}

async function load() {
  const [teamData, aliasData] = await Promise.all([
    fetch(api('/api/teams'))
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    fetch(api('/api/aliases'))
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);
  teams = teamData?.teams ?? [];
  aliases = aliasData?.players ?? [];
}

/**
 * Save the team a row belongs to, carrying the whole roster.
 *
 * The roster goes as it now stands in memory, which is the same shape the
 * Teams page posts. `players` is a live reference into `teams`, so the row the
 * verification just wrote into is already in it - there is no second merge to
 * get wrong on the way back.
 */
const saveTeam = (team) =>
  post('/api/teams', {
    action: 'save',
    team: { id: team.id, name: team.name, shortName: team.shortName, players: team.players ?? [] },
  }).then((payload) => {
    teams = payload.teams ?? teams;
    aliases = payload.players ?? aliases;
    // The Teams page and the scoreboard pickers read the same library.
    window.dispatchEvent(new CustomEvent('teams-changed', { detail: teams }));
  });

const saveAlias = (row, alias) =>
  post('/api/aliases', {
    action: 'save',
    player: { id: row.accountId, riotId: row.riotId, alias },
  }).then((payload) => {
    aliases = payload.players ?? aliases;
  });

// ------------------------------------------------------------------ paint ---

/**
 * One person, as a box.
 *
 * It was a two-line ROW: identity above, a name box and two buttons below. That
 * reads fine for three people and badly for forty - every row the same shape and
 * the same height, nothing for the eye to land on, and a photo with nowhere to
 * go but behind a 38px thumbnail. A box gives the portrait somewhere to be and
 * makes the list scannable by FACE, which is how somebody actually looks for a
 * player they cannot spell.
 *
 * Nothing in a box is editable. Everything that types is in the modal Edit
 * opens, which is what lets this list repaint on every keystroke in the search
 * above it - the caret rule, met by separation rather than by care. The row it
 * replaced held an input and therefore a rule that nothing may repaint the list
 * while one is focused; that rule is now structural instead of remembered.
 */
function playerCard(row, repaint) {
  const card = el('div', 'ply-card');

  // --------- the face ---------
  const photo = el('div', 'ply-card-photo');
  const shot = row.player?.photo || '';
  if (shot) {
    const img = el('img', null, { src: shot, alt: '' });
    /*
     * A URL that 404s must not paint Chrome's broken-image marker forty times.
     * Same guard as the graphics pages use, for the same reason: a photo is
     * somebody else's link and this page is where you find out it has rotted.
     */
    img.addEventListener('error', () => {
      img.remove();
      photo.classList.add('is-empty');
      photo.append(el('span', 'ply-card-initials', {}, initials(row)));
    });
    photo.append(img);
  } else {
    photo.classList.add('is-empty');
    // Initials rather than a silhouette: they say WHICH player has no photo,
    // which is the thing somebody curating a lineup wants to see at a glance.
    photo.append(el('span', 'ply-card-initials', {}, initials(row)));
  }
  card.append(photo);

  // --------- who ---------
  const body = el('div', 'ply-card-body');
  body.append(el('div', 'ply-name', {}, row.name || '(unnamed)'));
  body.append(el('div', 'ply-riot', {}, row.riotId || 'no Riot ID yet'));

  const marks = el('div', 'ply-origin');
  marks.append(el('span', 'ply-pill', {}, playerOrigin(row)));
  if (row.accountId) marks.append(el('span', 'ply-seen', { title: 'Reported by the agent select feed' }, 'linked'));
  body.append(marks);
  card.append(body);

  // --------- what you can do to them ---------
  const tools = el('div', 'ply-card-tools');
  tools.append(verifyButton(row, repaint));

  const edit = el('button', 'mini-btn', { type: 'button', title: 'Edit their name and photo.' }, 'Edit');
  edit.addEventListener('click', () => openPlayer(row, repaint));
  tools.append(edit);
  card.append(tools);

  return card;
}

/** Two letters for a box with no photo, off the on-air name and then the handle. */
function initials(row) {
  const from = row.name || stripTagline(row.riotId) || '?';
  return from.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?';
}

/**
 * Editing one person, in a modal.
 *
 * The name is written to WHICHEVER library the row came from: a row on a roster
 * writes the roster - the team save folds it through to the alias library on the
 * server, so naming somebody here is identical to naming them on the Teams page
 * - and a row with no team writes the library directly. One name, one place,
 * whichever door you came in by.
 *
 * It saves ONCE, on Save, so Cancel really does mean nothing happened. The
 * inline box this replaced committed on blur and could never promise that: the
 * photo control wrote on every keystroke of a pasted URL, so a half-typed
 * address reached the roster and the lineup graphic before the paste finished.
 */
function openPlayer(row, repaint) {
  if (modalOpen()) return;

  let dialog = null;
  const body = el('div', 'rl-modal-body');

  const name = el('input', null, {
    type: 'text',
    spellcheck: 'false',
    maxlength: 32,
    'aria-label': `Name for ${row.riotId || row.name}`,
    // What a card would say with no name, so the box shows what it replaces
    // rather than sitting there empty.
    placeholder: stripTagline(row.riotId) || 'Name',
  });
  name.value = row.player ? (row.player.displayName ?? '') : row.alias;

  /*
   * The photo is drafted, not written, and declared BEFORE the control that
   * reads it: `mediaControl` calls its getter while it builds, so a `let`
   * underneath would be a temporal-dead-zone throw on open rather than a
   * mistake anybody would see in review.
   *
   * Offered only for a row that belongs to a TEAM. A photo lives on the player
   * record and the alias library has no column for one - the same reason
   * verification is offered to one and not the other, and inventing a column
   * there would make a second store of record for one fact.
   */
  let draftPhoto = row.player?.photo ?? '';
  const photoField =
    row.player && row.team
      ? mediaControl(
          'Photo',
          () => draftPhoto,
          (value) => {
            draftPhoto = value;
          },
        )
      : null;

  const save = el('button', 'btn btn-primary', { type: 'button' }, 'Save');
  save.addEventListener('click', async () => {
    const wanted = name.value.trim();
    try {
      if (row.player && row.team) {
        row.player.displayName = wanted;
        row.player.photo = draftPhoto;
        await saveTeam(row.team);
      } else if (wanted !== row.alias) {
        await saveAlias(row, wanted);
      }
      dialog?.close();
      repaint();
    } catch (error) {
      toast(`Not saved: ${error.message}`);
    }
  });

  const cancel = el('button', 'btn btn-ghost', { type: 'button' }, 'Cancel');
  // askClose rather than close: this is a person leaving, and there may be a
  // name and a photo in here that only Save writes. See modal.js.
  cancel.addEventListener('click', () => askClose(dialog));

  /*
   * Forget is offered only for a row with no team, and that is not squeamishness.
   *
   * Deleting the alias record of somebody who is on a roster would take their
   * name off the cards and leave them on the squad - a half-state with nothing
   * to explain it, and the next team save would put the alias straight back.
   * A player leaves a squad on the Teams page; a dictionary entry is dropped
   * here.
   */
  let drop = null;
  if (!row.teams.length && row.aliasRecord?.key) {
    drop = el(
      'button',
      'btn btn-ghost rl-modal-danger',
      { type: 'button', title: 'Drop this entry from the player library.' },
      'Forget',
    );
    drop.addEventListener('click', async () => {
      try {
        const payload = await post('/api/aliases', { action: 'delete', key: row.aliasRecord.key });
        aliases = payload.players ?? aliases;
        dialog?.close();
        repaint();
      } catch (error) {
        toast(`Not removed: ${error.message}`);
      }
    });
  }

  body.append(
    modalTitle(row.name || 'Player', row.riotId || 'no Riot ID'),
    field('Name on air', name),
    help('Saving writes the roster if they are on a team, and the player library if they are not.'),
    ...(photoField
      ? [
          // No heading above it: mediaControl labels itself "Photo", and a
          // subhead saying the same word stacked two identical labels.
          photoField,
          help('Their face on the team lineup graphic. A team-wide default covers anybody without one - set that on the Teams page.'),
        ]
      : [help('A photo lives on a team roster, so add them to a team to give them one.')]),
  );

  /*
   * Both halves of the draft, because the photo is not a form control - it is
   * dropped, pasted or browsed to through mediaControl, and a guard that only
   * watched the name would let a pasted photo go without a word.
   */
  const dirty = watchChanges(() => JSON.stringify([name.value, draftPhoto]));

  dialog = openModal({ body, dirty, foot: modalFoot({ danger: drop, cancel, confirm: save }) });
}


/**
 * The lamp and the button, which is the roster editor's control with the team
 * save folded in.
 *
 * `verifyQuestion` decides what the press asks, shared with the roster editor
 * so the two cannot disagree - and disagreeing is destructive here, not merely
 * untidy. See player-verify.js.
 */
function verifyButton(row, repaint) {
  const player = row.player;
  const question = verifyQuestion(player ?? { riotId: row.riotId });

  if (!player) {
    /*
     * A row with no team has nowhere to PUT a PUUID. The alias library records
     * an account id the feed reported and has no column for a verified
     * identity, and inventing one would make a second store of record for the
     * one fact riot-account.js exists to keep in a single place. So this says
     * what it is rather than offering a button that would drop its own answer.
     */
    return el(
      'span',
      'ply-state',
      { title: 'Add this player to a team to store a verified identity for them.' },
      row.accountId ? 'linked' : '—',
    );
  }

  const state = el('span', 'roster-state');

  const render = () => {
    state.replaceChildren();
    state.className = 'roster-state';
    const verified = verifyQuestion(player) === 'check';
    if (verified) state.classList.add('is-verified');

    const button = el(
      'button',
      'mini-btn',
      {
        type: 'button',
        title: verified
          ? `Checked ${new Date(player.puuidCheckedAt).toLocaleString()} against ${player.puuidSource}. Click to check again.`
          : 'Look this Riot ID up and store the PUUID behind it.',
      },
      verified ? '✓' : 'Verify',
    );
    button.disabled = !canVerify() || question === 'none';
    if (!canVerify()) button.title = verifyOffReason();
    else if (button.disabled) button.title = 'This row has no Riot ID to look up.';

    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = '…';
      try {
        if (verifyQuestion(player) === 'check') {
          const { results: found } = await verifyPlayers({
            action: 'check',
            players: [{ riotId: player.riotId, puuid: player.puuid, puuidSource: player.puuidSource }],
          });
          const one = found?.[0];
          if (one?.verdict === 'ok') {
            player.puuidCheckedAt = Date.now();
            toast(`${player.riotId} is unchanged`);
          } else if (one?.verdict === 'renamed') {
            // Reported, never applied - a rename is a fact about a person, and
            // rewriting it silently changes what a lobby matcher looks for with
            // nobody told. The Teams page is where the amber button lives.
            toast(`${player.riotId} is now ${one.current.riotId} - apply it on the Teams page.`);
          } else {
            player.puuidCheckedAt = 0;
            toast(one?.reason ?? 'Could not check that player.');
          }
        } else {
          const { identity } = await verifyPlayers({ action: 'resolve', riotId: player.riotId });
          player.puuid = identity.puuid;
          player.puuidSource = identity.source;
          player.puuidCheckedAt = Date.now();
          if (identity.riotId) player.riotId = identity.riotId;
          toast(`Verified ${identity.riotId} (${identity.source})`);
        }
        await saveTeam(row.team);
        repaint();
      } catch (error) {
        toast(`Could not verify: ${error.message}`);
        render();
      }
    });

    state.append(button);
  };

  render();
  return state;
}

/**
 * Check everything the search is currently showing.
 *
 * Deliberately "shown" rather than "all": the list is the operator's own
 * selection, so searching a team's tricode and pressing this is how one squad
 * gets done, and clearing the box is how the lot does. A button that ignored
 * the filter would be a different, much heavier press wearing the same label.
 */
function sweepButton(rows, repaint) {
  const askable = rows.filter((row) => row.player && verifyQuestion(row.player) !== 'none');
  if (!canVerify() || askable.length < 2) return null;

  const button = el(
    'button',
    'btn btn-small btn-ghost',
    {
      type: 'button',
      title:
        'Look up every player shown, one at a time with a gap between them. Rows with no identity get one; ' +
        'rows that have one are asked whether it has been renamed. Renames are reported, never applied.',
    },
    `Check all ${askable.length} shown`,
  );

  button.addEventListener('click', async () => {
    button.disabled = true;
    const was = button.textContent;
    try {
      const outcomes = await sweepPlayers(askable.map((row) => row.player), {
        onProgress: ({ done, total }) => {
          button.textContent = done < total ? `Checking ${done + 1}/${total}…` : 'Saving…';
        },
      });

      const touched = new Set();
      outcomes.forEach((outcome, index) => {
        const row = askable[index];
        if (outcome.verdict === 'resolved' && outcome.identity) {
          outcome.player.puuid = outcome.identity.puuid;
          outcome.player.puuidSource = outcome.identity.source;
          outcome.player.puuidCheckedAt = Date.now();
          if (outcome.identity.riotId) outcome.player.riotId = outcome.identity.riotId;
          touched.add(row.team);
        } else if (outcome.verdict === 'ok') {
          outcome.player.puuidCheckedAt = Date.now();
          touched.add(row.team);
        } else if (outcome.verdict === 'unknown' || outcome.verdict === 'failed') {
          outcome.player.puuidCheckedAt = 0;
          touched.add(row.team);
        }
      });

      // One save per TEAM rather than per player: thirty players across four
      // teams is four writes, and each carries that team's whole roster anyway.
      for (const team of touched) if (team) await saveTeam(team);
      repaint();
      toast(sweepSummary(outcomes));
    } catch (error) {
      toast(`Could not check: ${error.message}`);
    } finally {
      button.disabled = false;
      button.textContent = was;
    }
  });

  return button;
}

function paintResults() {
  if (!results) return;
  const rows = indexPlayers({ teams, aliases }).filter((row) => matchesPlayer(row, needle));
  const shown = rows.slice(0, PAGE);

  results.replaceChildren(
    ...[
      el(
        'div',
        'ply-count',
        {},
        rows.length === 1 ? '1 player' : `${rows.length} players${rows.length > PAGE ? ` - showing the first ${PAGE}` : ''}`,
      ),
      shown.length
        ? wrap('ply-grid', shown.map((row) => playerCard(row, repaint)))
        : el(
            'p',
            'empty',
            {},
            needle
              ? 'Nobody matches that.'
              : 'No players yet. Add a squad on the Teams page, or run a lobby with the agent select webhook pointed here.',
          ),
      sweepButton(shown, repaint),
    ].filter(Boolean),
  );
}

/** A full repaint of the results only - never of the search box above them. */
function repaint() {
  paintResults();
}

function build() {
  host = $('tou-players-search');
  if (!host) return;

  const search = el('input', null, {
    type: 'search',
    spellcheck: 'false',
    id: 'ply-search',
    placeholder: 'Name, Riot ID, team or account id',
    'aria-label': 'Search players',
  });
  search.value = needle;
  /*
   * Only the results below are replaced, so this box is never taken out from
   * under the caret. That is the whole reason it is built here, once, instead
   * of inside the function that paints the list.
   */
  search.addEventListener('input', () => {
    needle = search.value;
    paintResults();
  });

  results = el('div', 'ply-results');

  host.replaceChildren(
    title('Players'),
    help(
      'Everybody on a team roster and everybody the agent select feed has reported, in one list. The name here ' +
        'is what goes on air - saving it writes the roster if they are on a team, and the player library if they ' +
        'are not. Verifying stores the PUUID behind a Riot ID so a rename can be spotted later; it is never ' +
        'required, and a player without one works fine.',
    ),
    field('Search', search),
    results,
  );

  paintResults();
}

// ---------------------------------------------------------------- wiring ---

async function refresh() {
  await load();
  build();
}

refresh();

// The library is edited on the Teams page, and a team saved there has to show
// up here without a reload.
window.addEventListener('teams-changed', (event) => {
  teams = event.detail ?? teams;
  if (host) paintResults();
});

window.addEventListener('tournament-changed', refresh);

/*
 * Refetched on open as well, because there is no stream for either library and
 * the agent select feed adds players without this page asking. Walking here
 * after a lobby to name whoever just turned up is the ordinary path.
 */
window.addEventListener('app-tab', (event) => {
  if (event.detail === 'tournament') refresh();
});

onVerifyConfig(() => {
  if (host) paintResults();
});
