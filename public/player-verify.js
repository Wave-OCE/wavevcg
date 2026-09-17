/**
 * Verifying players, as one decision shared by every page that offers it.
 *
 * Three callers now - the roster editor on the Teams page, the "check them
 * all" press beside it, and the player search that replaced the Players page -
 * and the thing worth sharing is not the fetch. It is `verifyQuestion`.
 *
 * ## Why the question is shared rather than the plumbing
 *
 * A row asks one of two different things depending on its own state, and
 * getting that wrong is quietly destructive rather than merely wrong. A
 * re-check asks "is the account behind this stored PUUID still called what the
 * box says", which is only the right question while the two were last
 * confirmed to agree. Swap a player out by typing their replacement's Riot ID
 * over the old one and a re-check looks up the PREVIOUS player, reports a
 * rename that never happened, and offers a button that puts the old handle
 * back - the operator one click from undoing their own edit, with the UI
 * calling it a correction.
 *
 * That argument was written once, in the roster editor, and a second page
 * re-deriving it is exactly how two pages come to disagree about it. So it
 * lives here and both import it.
 *
 * ## Pacing
 *
 * `sweepPlayers` is deliberately one request per player with a gap between
 * them, rather than one request carrying thirty. Three reasons, in order of
 * how much they matter:
 *
 *   - A batch of thirty is thirty lookups at whatever rate the server's loop
 *     runs at. Riot's account service and HenrikDev both rate-limit, and a 429
 *     halfway through a batch is indistinguishable, to the operator, from half
 *     the roster having been deleted.
 *   - Progress. A batch answers once, at the end; a sweep can say 7 of 30
 *     while it works, which is the difference between a slow button and a
 *     button that looks broken.
 *   - A row wanting `resolve` and a row wanting `check` are different requests
 *     anyway, so a batch could never cover a mixed roster in one call.
 *
 * The server paces its own `check` loop too. That is a backstop for anything
 * that does not come through here, not a duplicate of this.
 */

import { looksLikeRiotId } from './teams.js';
import { api } from './session.js';

/**
 * Between one lookup and the next.
 *
 * A couple of hundred milliseconds: comfortably inside every published limit,
 * and thirty players still finishes in about eight seconds - a button that
 * feels slow rather than one that lies. Not a retry delay; nothing here
 * retries, because a 429 that is retried automatically is a rate limit being
 * argued with rather than respected.
 */
export const VERIFY_GAP_MS = 250;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------- what this server can do ---

/*
 * Read once, at import, and cached. A fact about the deployment rather than
 * about a tournament, so re-reading it per page would be three fetches for one
 * answer that cannot have changed between them.
 *
 * Defaults to "cannot", so a failed fetch leaves a disabled button that
 * explains itself rather than one that fails on click.
 */
let config = { can: false, source: '', henrikFallback: false };
const listeners = new Set();

const ready = fetch('/api/config')
  .then((response) => (response.ok ? response.json() : null))
  .then((payload) => {
    config = {
      can: Boolean(payload?.canVerifyPlayers),
      source: String(payload?.verifySource ?? ''),
      henrikFallback: Boolean(payload?.henrikVerifyEnabled),
    };
    for (const fn of listeners) fn(config);
    return config;
  })
  .catch(() => config);

/** Can this server look a Riot ID up at all? */
export const canVerify = () => config.can;

/** Which source would mint an id right now: 'riot', 'henrik', or ''. */
export const verifySource = () => config.source;

/** Told when the answer arrives, so a panel painted before it can repaint. */
export function onVerifyConfig(fn) {
  listeners.add(fn);
  ready.then((value) => fn(value));
  return () => listeners.delete(fn);
}

/**
 * Why the button is disabled, in the terms of whoever can fix it.
 *
 * Two different problems wear the same greyed-out button: a machine with no
 * key at all, and a machine whose only key is behind a switch an administrator
 * turned off. Naming the wrong one sends an operator to the wrong panel.
 */
export const verifyOffReason = () =>
  'This server cannot look a Riot ID up. Set RIOT_ACCOUNT_KEY in its environment - a personal key is ' +
  'enough, account-v1 needs no production approval - or have an administrator switch the HenrikDev ' +
  'fallback on under Admin > Server settings. Rosters still save either way.';

// ------------------------------------------------------------ the request ---

/** One call to the route. Throws with the server's hint attached. */
export async function verifyPlayers(body) {
  const response = await fetch(api('/api/players/verify'), {
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

// ------------------------------------------------------------ the question ---

/**
 * What this row should ask, or 'none' if it should ask nothing.
 *
 * `check` turns on having been CONFIRMED - a stored id and a stamp saying it
 * was last agreed with the Riot ID beside it - and not merely on having an id.
 * Editing the Riot ID clears that stamp, which is what makes an edited row
 * resolve instead of re-checking the player who used to be in it. See the
 * header.
 */
export function verifyQuestion(player) {
  if (!looksLikeRiotId(player?.riotId ?? '')) return 'none';
  return player?.puuid && player?.puuidCheckedAt ? 'check' : 'resolve';
}

/** One row's outcome, in the shape both callers paint from. */
const outcome = (player, question, verdict, extra = {}) => ({ player, question, verdict, ...extra });

/**
 * Ask about a list of players, in order, with a gap between lookups.
 *
 * Writes NOTHING. Every caller of this holds a draft that the operator saves,
 * and a sweep that wrote would mean a press labelled "check" rewriting a roster
 * - which is the same trap the per-row button avoids by handing back drift
 * instead of applying it.
 *
 * Verdicts:
 *   resolved   an identity was minted. `identity` carries it.
 *   ok         the stored identity still answers to that Riot ID.
 *   renamed    it answers to a different one. `current` carries it.
 *   unknown    nobody could say. `reason` says why.
 *   failed     the request itself did not complete. `reason` says why.
 *   skipped    the row has no usable Riot ID, so there was nothing to ask.
 *
 * A failure does not stop the sweep: one player whose lookup times out must
 * not silently hide the twenty-nine after them.
 */
export async function sweepPlayers(players, { onProgress } = {}) {
  const rows = Array.isArray(players) ? players : [];
  const results = [];
  let sent = 0;

  const asked = rows.filter((player) => verifyQuestion(player) !== 'none').length;

  for (const player of rows) {
    const question = verifyQuestion(player);
    if (question === 'none') {
      results.push(outcome(player, question, 'skipped', { reason: 'No Riot ID to look up.' }));
      continue;
    }

    // Between lookups, never before the first: a gap ahead of the only request
    // a one-player sweep makes is a quarter second of nothing.
    if (sent) await pause(VERIFY_GAP_MS);
    sent += 1;
    onProgress?.({ done: sent - 1, total: asked, player });

    try {
      if (question === 'resolve') {
        const { identity } = await verifyPlayers({ action: 'resolve', riotId: player.riotId });
        results.push(outcome(player, question, 'resolved', { identity }));
      } else {
        const { results: found } = await verifyPlayers({
          action: 'check',
          players: [{ riotId: player.riotId, puuid: player.puuid, puuidSource: player.puuidSource }],
        });
        const one = found?.[0];
        if (one?.verdict === 'ok') results.push(outcome(player, question, 'ok'));
        else if (one?.verdict === 'renamed') results.push(outcome(player, question, 'renamed', { current: one.current }));
        else results.push(outcome(player, question, 'unknown', { reason: one?.reason ?? 'No answer.' }));
      }
    } catch (error) {
      results.push(outcome(player, question, 'failed', { reason: error.message }));
    }
  }

  onProgress?.({ done: sent, total: asked, player: null });
  return results;
}

/**
 * A one-line summary of a sweep, for a toast.
 *
 * Renames lead, because they are the only outcome with something for the
 * operator to do. "Nothing changed" is worth saying out loud rather than
 * leaving as silence - a button that says nothing on success is one nobody
 * trusts.
 */
export function sweepSummary(results) {
  const count = (verdict) => results.filter((row) => row.verdict === verdict).length;
  const renamed = count('renamed');
  const resolved = count('resolved');
  const stuck = count('unknown') + count('failed');

  const parts = [];
  if (renamed) parts.push(`${renamed} renamed - the amber buttons say to what`);
  if (resolved) parts.push(`${resolved} newly verified`);
  if (stuck) parts.push(`${stuck} could not be checked`);
  if (!parts.length) return 'Every identity still matches.';
  return `${parts.join(', ')}.`;
}
