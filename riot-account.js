/**
 * PUUID verification: resolving a Riot ID to a stable identity, and checking
 * later whether that identity still answers to the same name.
 *
 * Its own file and its own key, and a measurement decides the shape of both.
 *
 * ## Why a second Riot key
 *
 * RIOT_API_KEY is the MATCH key. val/match/v1 needs an approved production key
 * and answers 403 without one. riot/account/v1 does not - a development key
 * reaches it. Measured against a real development key on 2026-09-17:
 *
 *     GET /riot/account/v1/accounts/by-riot-id/RTLine/GLHF   -> 200
 *     GET /val/match/v1/matchlists/by-puuid/<that puuid>      -> 403
 *
 * One variable for both would be a trap rather than a saving, because the two
 * failures are not the same failure. riotHint in providers.js says a refusal
 * means "the key lacks access to val-match-v1 - the VALORANT match endpoints
 * need an approved production key", which sends an operator to a week-long
 * approval process. For an account key that is wrong: development keys expire
 * every 24 hours, so the overwhelmingly likely cause is a key that lapsed
 * overnight and wants pasting again. Two variables, two hints.
 *
 * RIOT_ACCOUNT_KEY falls back to RIOT_API_KEY when unset, so an install that
 * already has a production key does not need a second entry in .env to get
 * verification.
 *
 * ## The finding, and why puuidSource is load-bearing
 *
 * The plan assumed Riot and HenrikDev would hand back the same PUUID for an
 * account, making puuidSource provenance and nothing more. They do not. One
 * account, both sources, the same minute:
 *
 *     riot    Q3-G8S7FR8Pzxsq38H85i5XRZH9X7DsWPQIucyT-jvIkD8KOviY9...   78 chars
 *     henrik  01d1e35f-7e01-50f7-be31-2b1e53d708a9                      36 chars
 *
 * Riot's account-v1 returns an ENCRYPTED puuid. The canonical identity is a
 * UUID, which is what Henrik returns; what Riot hands out is a per-consumer
 * ciphertext of it. The API says so itself when fed the other form:
 *
 *     riot   <- henrik's uuid   ->  400  "Exception decrypting 01d1e35f-..."
 *     henrik <- riot's id       ->  400  "Invalid UUID/PUUID"
 *
 * "Exception decrypting" is the tell: Riot decrypts on the way IN, so the id
 * is only meaningful to the key that minted it. Repeat calls on one key are
 * stable (measured - three calls, one distinct value), but a different key is
 * a different ciphertext, and a development key is regenerated daily.
 *
 * So the two ids are not comparable, and a stored identity with no record of
 * which side minted it is one nobody can ever check again. puuidSource is
 * therefore not a label: it is the routing decision for the re-check. Compare
 * across sources and every player on the roster reads as renamed.
 *
 * ## Which one gets asked, and which one gets stored
 *
 * Riot, and Riot. This is the one place in this program where HenrikDev is NOT
 * the primary source, and the exception is deliberate: verification asks "is
 * this account real and what is it called now", which is a question about
 * Riot's own account service rather than about a match. Asking the authority
 * directly is the right shape for it, and it spends no HenrikDev budget on a
 * roster of thirty players an hour before a show.
 *
 * HenrikDev remains the fallback and is worth keeping, because what it covers
 * is real - a key that lapsed overnight, an outage, a 429 thirty seconds
 * before a show. But it is switched OFF by default (`henrikVerify` in
 * settings-schema.js) rather than engaging silently, and that is the whole
 * argument of the finding above: the two sources mint different PUUIDs, so a
 * fallback that fires by itself quietly changes which API can ever re-check
 * that player. An administrator turns it on, and the panel says what it costs.
 *
 * The cost of Riot being the store of record is stated rather than hidden: an
 * id minted from an account key is only readable while that key lives, which
 * is why checkPuuid answers `unknown` - never `renamed` - when Riot cannot
 * decrypt one. A permanent personal key is fine; a development key regenerated
 * daily would make every stored id unreadable each morning.
 *
 * ## Nothing here is ever required
 *
 * A player with no PUUID is an ordinary state and always has been - the
 * tracker.gg provider returns puuid: null by design. No key configured means
 * the button says so; it does not mean a roster cannot be saved.
 */

import { ProviderError, henrikAccount, henrikAccountByPuuid } from './providers.js';

/**
 * The HenrikDev half, as two functions rather than a key.
 *
 * Injected for the same reason `accountGet` is: it is the only way the suite
 * can assert what this file does with a 404, a 429 and a decrypt failure
 * without a live key, a network and somebody else's rate limit. A test that
 * needs a Riot key to run is a test nobody runs, and the cases worth covering
 * here are precisely the ones that are awkward to provoke on purpose.
 *
 * `null` means no key is configured, which is an ordinary state.
 */
export const henrikLookups = (apiKey) =>
  apiKey
    ? {
        account: (parts) => henrikAccount(apiKey, parts),
        accountByPuuid: (puuid) => henrikAccountByPuuid(apiKey, { puuid }),
      }
    : null;

/** Where account-v1 is served. Any of them answers for any region. */
export const ACCOUNT_ROUTING = ['americas', 'asia', 'esports', 'europe'];
export const DEFAULT_ACCOUNT_ROUTING = 'europe';

/**
 * Why Riot refused, said in terms of the ACCOUNT key rather than the match one.
 *
 * Deliberately not riotHint from providers.js. That one names val-match-v1 and
 * production approval, which is correct advice for a match lookup and actively
 * misleading here: account-v1 needs no approval, so a refusal on this path is
 * nearly always a development key that expired overnight.
 */
function accountHint(status) {
  if (status === 401 || status === 403) {
    return (
      'Riot rejected the account key. account-v1 does NOT need production approval, so this is ' +
      'almost always an expired key - development keys last 24 hours. Paste a fresh one into ' +
      'RIOT_ACCOUNT_KEY and restart.'
    );
  }
  if (status === 404) return 'No Riot account with that name and tag.';
  if (status === 429) return 'Rate limited by Riot. Wait a few seconds and retry.';
  if (status >= 500) return "Riot's account API returned a server error - retry shortly.";
  return '';
}

/**
 * A client over riot/account/v1, and nothing else.
 *
 * Separate from makeRiotClient rather than a wrapper around it: that client
 * closes over the match key, and the entire point of this file is that the two
 * keys are different. Sharing the client would have made the separation a
 * convention instead of a fact.
 */
export function makeAccountClient(apiKey) {
  return async function accountGet(routing, endpoint) {
    if (!apiKey) {
      throw new ProviderError(
        503,
        'No Riot account key configured.',
        'Set RIOT_ACCOUNT_KEY in .env (RIOT_API_KEY is used if it is absent), then restart. ' +
          'A development key is enough - account-v1 needs no production approval.',
      );
    }

    const host = ACCOUNT_ROUTING.includes(routing) ? routing : DEFAULT_ACCOUNT_ROUTING;
    let response;
    try {
      response = await fetch(`https://${host}.api.riotgames.com${endpoint}`, {
        headers: {
          'X-Riot-Token': apiKey,
          Accept: 'application/json',
          'User-Agent': 'val-broadcast-tool/1.0',
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const reason = error.name === 'TimeoutError' ? 'the request timed out' : error.message;
      throw new ProviderError(502, `Could not reach Riot's account API: ${reason}`, 'Check network/proxy access.');
    }

    const body = await response.text();
    if (!response.ok) {
      let message = `Riot's account API returned HTTP ${response.status}.`;
      try {
        const parsed = JSON.parse(body);
        if (parsed?.status?.message) message = `Riot: ${parsed.status.message}`;
      } catch {
        /* non-JSON error body */
      }
      throw new ProviderError(response.status, message, accountHint(response.status));
    }

    try {
      return JSON.parse(body);
    } catch {
      throw new ProviderError(502, "Riot's account API returned a response that was not valid JSON.");
    }
  };
}

/** TenZ#SEN -> { gameName: 'TenZ', tagLine: 'SEN' }, or null if it is not one. */
export function splitRiotId(value) {
  const text = String(value ?? '').trim();
  const at = text.indexOf('#');
  if (at < 1 || at === text.length - 1) return null;
  const gameName = text.slice(0, at).trim();
  const tagLine = text.slice(at + 1).trim();
  if (!gameName || !tagLine || tagLine.includes('#')) return null;
  return { gameName, tagLine };
}

/** How the two sides spell the same answer. */
const asIdentity = (source, gameName, tagLine, puuid) => ({
  source,
  puuid: puuid ?? '',
  gameName: gameName ?? '',
  tagLine: tagLine ?? '',
  riotId: gameName && tagLine ? `${gameName}#${tagLine}` : '',
});

/**
 * Resolve a Riot ID to an identity, for a player being created.
 *
 * Riot first - see the header. `henrik` is null unless a key is configured AND
 * an administrator has switched the fallback on, so this function never has to
 * know what a setting is: being handed one IS the permission.
 *
 * `henrikNote` is why it was not handed one, in words an operator can act on.
 * Without it the composite failure says "no HenrikDev key" to somebody who has
 * a key and a switch turned off, which sends them to the wrong panel.
 */
export async function resolveRiotId({ riotId, henrik, henrikNote, accountGet, routing }) {
  const parts = splitRiotId(riotId);
  if (!parts) {
    throw new ProviderError(400, `"${riotId}" is not a Riot ID.`, 'The shape is GameName#Tag.');
  }

  /*
   * Why each source could not answer, hint INCLUDED.
   *
   * The hint is the half that says what to do about it - "Set RIOT_ACCOUNT_KEY
   * in .env", "Request a key from the HenrikDev Discord" - and this path is
   * exactly where an operator needs it, because the composite failure is the
   * one that reads as "verification is just broken". Carrying only the message
   * left them with two restatements of "no key" and no way to learn which
   * variable either one meant.
   */
  const reasons = [];
  const why = (label, error) => reasons.push([`${label}: ${error.message}`, error.hint].filter(Boolean).join(' '));

  try {
    const data = await accountGet(
      routing,
      `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(parts.gameName)}/${encodeURIComponent(parts.tagLine)}`,
    );
    if (!data?.puuid) throw new ProviderError(502, 'Riot answered without a PUUID.');
    return { ...asIdentity('riot', data.gameName, data.tagLine, data.puuid), region: null };
  } catch (error) {
    /*
     * A 404 from the account service is an ANSWER, not an outage: Riot is the
     * authority on whether a Riot account exists, so there is nothing a second
     * source could add. Falling through would turn a clear "no such player"
     * into a vaguer composite message and spend somebody else's rate limit to
     * learn what we already knew. The same argument used to be written here
     * about Henrik, and it moved with the order rather than being dropped.
     */
    if (error instanceof ProviderError && error.status === 404) throw error;
    why('Riot', error);
  }

  if (henrik) {
    try {
      const account = await henrik.account(parts);
      if (account?.puuid) {
        return {
          ...asIdentity('henrik', account.gameName, account.tagLine, account.puuid),
          region: account.region ?? null,
        };
      }
      reasons.push('HenrikDev found the account but returned no PUUID.');
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) throw error;
      why('HenrikDev', error);
    }
  } else if (henrikNote) {
    reasons.push(henrikNote);
  }

  throw new ProviderError(502, `Could not verify ${parts.gameName}#${parts.tagLine}.`, reasons.join(' '));
}

/**
 * Ask a stored identity what it is called NOW.
 *
 * The verdict is one of:
 *
 *   ok        the name still matches what is stored
 *   renamed   the account resolved, under a different Riot ID
 *   unknown   nobody could answer - no key, an outage, or (the case that
 *             needs saying) a riot-sourced id and a key that can no longer
 *             decrypt it
 *
 * unknown and renamed are kept apart deliberately. Collapsing them would mean
 * that rotating the Riot key reports every riot-sourced player on every roster
 * as renamed on the same morning: a loud, plausible, entirely false alarm
 * whose only offered remedy would be accepting ten rewrites that change
 * nothing.
 *
 * Nothing here writes. Drift is reported and an operator applies it, because a
 * rename is a fact about a person and rewriting a Riot ID silently changes
 * what a lobby matcher looks for with nobody told.
 */
export async function checkPuuid({ puuid, puuidSource, riotId, henrik, henrikNote, accountGet, routing }) {
  const stored = String(puuid ?? '').trim();
  if (!stored) return { verdict: 'unknown', reason: 'No PUUID stored for this player yet.' };

  const wanted = String(riotId ?? '').trim().toLowerCase();

  /*
   * A successful lookup that carries no usable handle is UNKNOWN, not renamed.
   *
   * Both sources can answer 200 with a thin body - Henrik's shape is not
   * guaranteed field by field, and an outage upstream of it has been seen to
   * come back as an empty data object rather than an error. Without this guard
   * the falsy `current.riotId` fell to the else and reported a rename, which
   * put an amber button reading "-> " on the roster whose only action was to
   * blank the player's Riot ID. Worse than useless: it looks like the correct
   * handle arrived and the operator is one click from deleting the real one.
   */
  const say = (current) => {
    if (!current.riotId) {
      return { verdict: 'unknown', reason: 'That source answered without a Riot ID, so there is nothing to compare.' };
    }
    return { verdict: current.riotId.toLowerCase() === wanted ? 'ok' : 'renamed', current };
  };

  /*
   * Routed by source, which is the whole reason the field exists. Asking the
   * other side is not a fallback here - it is a guaranteed 400, and one that
   * would read to an operator as "this player does not exist".
   */
  if (puuidSource === 'henrik') {
    if (!henrik) {
      return {
        verdict: 'unknown',
        reason: `This PUUID came from HenrikDev, which is not available. ${henrikNote ?? ''}`.trim(),
      };
    }
    try {
      const account = await henrik.accountByPuuid(stored);
      return say(asIdentity('henrik', account.gameName, account.tagLine, account.puuid));
    } catch (error) {
      return { verdict: 'unknown', reason: `HenrikDev: ${error.message}` };
    }
  }

  if (puuidSource === 'riot') {
    try {
      const data = await accountGet(routing, `/riot/account/v1/accounts/by-puuid/${encodeURIComponent(stored)}`);
      return say(asIdentity('riot', data.gameName, data.tagLine, data.puuid));
    } catch (error) {
      /*
       * A 400 here is nearly always "this ciphertext was minted by a key that
       * is gone", which Riot reports as `Exception decrypting`. That is not a
       * missing player and must never be shown as one: the identity is intact,
       * it is this server that can no longer read it.
       */
      const status = error instanceof ProviderError ? error.status : 0;
      if (status === 400) {
        return {
          verdict: 'unknown',
          reason:
            'Riot could not decrypt this PUUID. It was minted by a different Riot key - account-v1 encrypts ' +
            'PUUIDs per key, so a rotated or expired key cannot read one it did not issue. Re-verify from the ' +
            'Riot ID to mint a fresh one.',
        };
      }
      return { verdict: 'unknown', reason: `Riot: ${error.message}` };
    }
  }

  return {
    verdict: 'unknown',
    reason: 'This PUUID has no recorded source, so there is no way to know which API can read it.',
  };
}
