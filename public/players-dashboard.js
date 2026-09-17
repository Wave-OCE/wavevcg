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
 * page's problem, solved by the shape of the panel rather than by a modal,
 * because here there is exactly one text input that is not inside a row.
 *
 * The alias boxes inside a row DO get replaced on a repaint, which is why they
 * commit on `change`/`blur` rather than per keystroke and why nothing repaints
 * the list while one is focused.
 */

import { el, field, help, subhead, title } from './fields.js';
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
 * One person.
 *
 * Two lines rather than one wide row, for the same reason the alias editor was
 * built that way: who they are is a handle and an account id, what you call
 * them is a box and a button, and side by side in a dashboard column those four
 * fight for width until the identity truncates - which is exactly the half that
 * has to be readable to tell two similar handles apart.
 */
function playerRow(row, repaint) {
  const node = el('div', 'ply-row');

  const who = el('div', 'ply-who');
  who.append(el('div', 'ply-name', {}, row.name || '(unnamed)'));
  who.append(el('div', 'ply-riot', {}, row.riotId || 'no Riot ID yet'));
  const origin = el('div', 'ply-origin');
  origin.append(el('span', 'ply-pill', {}, playerOrigin(row)));
  if (row.accountId) origin.append(el('span', 'ply-seen', { title: 'Reported by the agent select feed' }, 'account linked'));
  who.append(origin);

  // --------- the name that goes on air ---------
  const alias = el('input', null, {
    type: 'text',
    spellcheck: 'false',
    maxlength: 32,
    'aria-label': `Name for ${row.riotId || row.name}`,
    // What a card would say with no alias, so the box shows what it replaces
    // rather than sitting there empty.
    placeholder: stripTagline(row.riotId) || 'Name',
  });
  alias.value = row.player ? (row.player.displayName ?? '') : row.alias;

  /*
   * Committed on blur, and written to WHICHEVER library this row came from.
   *
   * A row on a roster writes the roster - the team save folds it through to the
   * alias library on the server, so naming somebody here is identical to naming
   * them on the Teams page. A row with no team writes the library directly.
   * One name, one place, whichever door you came in by.
   */
  const commit = async () => {
    const value = alias.value.trim();
    const before = row.player ? (row.player.displayName ?? '') : row.alias;
    if (before === value) return;
    try {
      if (row.player && row.team) {
        row.player.displayName = value;
        await saveTeam(row.team);
      } else {
        await saveAlias(row, value);
      }
      repaint();
    } catch (error) {
      toast(`Name not saved: ${error.message}`);
    }
  };
  alias.addEventListener('change', commit);
  alias.addEventListener('blur', commit);

  // --------- verification ---------
  const controls = el('div', 'ply-controls');
  controls.append(alias, verifyButton(row, repaint));

  /*
   * Forget is offered only for a row with no team, and that is not squeamishness.
   *
   * Deleting the alias record of somebody who is on a roster would take their
   * name off the cards and leave them on the squad - a half-state with nothing
   * to explain it, and the next team save would put the alias straight back.
   * A player leaves a squad on the Teams page; a dictionary entry is dropped
   * here.
   */
  if (!row.teams.length && row.aliasRecord?.key) {
    const forget = el('button', 'mini-btn', { type: 'button', title: 'Drop this entry from the player library.' }, 'Forget');
    forget.addEventListener('click', async () => {
      try {
        const payload = await post('/api/aliases', { action: 'delete', key: row.aliasRecord.key });
        aliases = payload.players ?? aliases;
        repaint();
      } catch (error) {
        toast(`Not removed: ${error.message}`);
      }
    });
    controls.append(forget);
  }

  node.append(who, controls);
  return node;
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
        ? wrap('ply-list', shown.map((row) => playerRow(row, repaint)))
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
