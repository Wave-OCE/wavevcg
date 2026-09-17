/**
 * Data providers + normalisation.
 *
 * Three pathways return the same normalised shape so the UI has one renderer:
 *
 *   henrik   - HenrikDev unofficial VALORANT API (default; custom games included)
 *   riot     - official Riot Games API (account-v1, val-match-v1, val-content-v1)
 *   tracker  - Tracker Network (tracker.gg)
 *
 * Normalised match summary:
 *   { id, queue, startedAt, map, score, won }
 *
 * Normalised match detail:
 *   { provider, matchId, map, mode, startedAt, durationMs, isRanked, isCompleted,
 *     season, teams[], players[], rounds[], raw }
 */

import { extractEmbeddedJson } from './browser.js';

export class ProviderError extends Error {
  constructor(status, message, hint = '') {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

// =========================================================== riot games ===

const RIOT_CONTENT_TTL_MS = 6 * 60 * 60 * 1000;
const riotContentCache = new Map();

function riotHint(status) {
  if (status === 401 || status === 403) {
    return (
      'Riot rejected the key. Either RIOT_API_KEY is missing/expired, or the key lacks ' +
      'access to val-match-v1 - the VALORANT match endpoints need an approved production key.'
    );
  }
  if (status === 404) return 'Not found. Check the Riot ID spelling/tagline and the routing region.';
  if (status === 429) return 'Rate limited by Riot. Wait a few seconds and retry.';
  if (status >= 500) return "Riot's API returned a server error - retry shortly.";
  return '';
}

export function makeRiotClient(apiKey) {
  return async function riotGet(host, endpoint, searchParams) {
    if (!apiKey) {
      throw new ProviderError(
        500,
        'No Riot API key configured.',
        'Set RIOT_API_KEY in .env, then restart the server.',
      );
    }

    const url = new URL(`https://${host}.api.riotgames.com${endpoint}`);
    for (const [key, value] of Object.entries(searchParams ?? {})) url.searchParams.set(key, value);

    let response;
    try {
      response = await fetch(url, {
        headers: {
          'X-Riot-Token': apiKey,
          Accept: 'application/json',
          'User-Agent': 'val-broadcast-tool/1.0',
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      const reason = error.name === 'TimeoutError' ? 'the request timed out' : error.message;
      throw new ProviderError(502, `Could not reach the Riot API: ${reason}`, 'Check network/proxy access.');
    }

    const body = await response.text();

    if (!response.ok) {
      let message = `Riot API returned HTTP ${response.status}.`;
      try {
        const parsed = JSON.parse(body);
        if (parsed?.status?.message) message = `Riot API ${response.status}: ${parsed.status.message}`;
      } catch {
        /* non-JSON error body */
      }
      throw new ProviderError(response.status, message, riotHint(response.status));
    }

    try {
      return JSON.parse(body);
    } catch {
      throw new ProviderError(502, 'Riot API returned a response that was not valid JSON.');
    }
  };
}

/** VAL-CONTENT-V1 lookup tables (agents, maps, ranks), cached per region. */
async function riotContent(riotGet, region) {
  const cached = riotContentCache.get(region);
  if (cached && Date.now() - cached.at < RIOT_CONTENT_TTL_MS) return cached.data;

  const raw = await riotGet(region, '/val/content/v1/contents', { locale: 'en-US' });
  const data = {
    characters: raw.characters ?? [],
    maps: raw.maps ?? [],
    competitiveTiers: raw.competitiveTiers ?? [],
  };
  riotContentCache.set(region, { at: Date.now(), data });
  return data;
}

/** Content is a nicety, never a hard dependency - IDs are shown if it fails. */
async function riotContentSafe(riotGet, region) {
  try {
    return await riotContent(riotGet, region);
  } catch {
    return { characters: [], maps: [], competitiveTiers: [] };
  }
}

const normId = (value) => String(value ?? '').replace(/-/g, '').toUpperCase();

const MAP_FALLBACK = {
  ascent: 'Ascent',
  duality: 'Bind',
  bonsai: 'Split',
  triad: 'Haven',
  port: 'Icebox',
  foxtrot: 'Breeze',
  canyon: 'Fracture',
  pitt: 'Pearl',
  jam: 'Lotus',
  juliett: 'Sunset',
  infinity: 'Abyss',
  range: 'The Range',
};

const QUEUE_NAMES = {
  competitive: 'Competitive',
  unrated: 'Unrated',
  swiftplay: 'Swiftplay',
  spikerush: 'Spike Rush',
  deathmatch: 'Deathmatch',
  ggteam: 'Escalation',
  hurm: 'Team Deathmatch',
  onefa: 'Replication',
  premier: 'Premier',
  newmap: 'New Map',
  snowball: 'Snowball Fight',
  '': 'Custom',
};

const titleCase = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());

function riotQueueName(queueId) {
  const key = String(queueId ?? '').toLowerCase();
  return QUEUE_NAMES[key] ?? (key ? titleCase(key) : 'Custom');
}

function riotMapName(content, mapId) {
  const assetPath = String(mapId ?? '');
  const hit = content.maps.find((m) => (m.assetPath ?? '').toLowerCase() === assetPath.toLowerCase());
  if (hit?.name) return hit.name;

  const codename = assetPath.split('/').filter(Boolean).pop()?.toLowerCase() ?? '';
  return MAP_FALLBACK[codename] ?? (codename ? titleCase(codename) : 'Unknown map');
}

function riotAgentName(content, characterId) {
  const target = normId(characterId);
  const hit = content.characters.find((c) => normId(c.id) === target);
  return hit?.name ?? (characterId ? `${String(characterId).slice(0, 8)}...` : null);
}

function riotRankName(content, tier) {
  if (!tier) return 'Unranked';
  const tiers = content.competitiveTiers.at(-1)?.tiers ?? [];
  const hit = tiers.find((t) => t.tier === tier);
  return hit?.tierName ? titleCase(hit.tierName) : `Tier ${tier}`;
}

/** A trade only counts if the avenging kill lands promptly - the usual cutoff. */
const TRADE_WINDOW_MS = 3000;

/**
 * First bloods and KAST, derived from the round-by-round kill timeline.
 *
 * Neither is pre-aggregated by Riot or HenrikDev, but the broadcast graphic
 * offers both as stat rows, so they are reconstructed from the same event list:
 *
 *   first blood - whoever landed the earliest kill of a round
 *   KAST        - share of rounds where a player got a Kill, an Assist,
 *                 Survived, or was Traded (their killer died within 3s)
 *
 * @param {Iterable<{round: unknown, at: number, killer: string, victim?: string, assistants?: string[]}>} events
 * @param {{playerIds?: string[], rounds?: number}} context
 * @returns {Map<string, {firstKills: number, kast: number|null}>} keyed by whatever id the caller used
 */
export function combatTally(events, { playerIds = [], rounds = 0 } = {}) {
  const byRound = new Map();
  for (const event of events) {
    if (!Number.isFinite(event?.at)) continue;
    const round = String(event.round ?? '');
    if (!byRound.has(round)) byRound.set(round, []);
    byRound.get(round).push(event);
  }

  const firstKills = new Map();
  const kastRounds = new Map();
  const bump = (map, id) => id && map.set(id, (map.get(id) ?? 0) + 1);

  for (const list of byRound.values()) {
    list.sort((a, b) => a.at - b.at);
    bump(firstKills, list[0]?.killer);

    const credited = new Set();
    const diedAt = new Map();

    for (const event of list) {
      if (event.killer) credited.add(event.killer);
      for (const assistant of event.assistants ?? []) credited.add(assistant);
      // One death per player per round, but guard against duplicate events.
      if (event.victim && !diedAt.has(event.victim)) diedAt.set(event.victim, event.at);
    }

    // Survived.
    for (const id of playerIds) if (!diedAt.has(id)) credited.add(id);

    // Traded: the player who killed you died soon after you did.
    for (const [victim, at] of diedAt) {
      const killer = list.find((event) => event.victim === victim)?.killer;
      const avengedAt = killer === undefined ? undefined : diedAt.get(killer);
      if (avengedAt !== undefined && avengedAt > at && avengedAt - at <= TRADE_WINDOW_MS) credited.add(victim);
    }

    for (const id of credited) bump(kastRounds, id);
  }

  // A round with no kills at all (spike defused untouched) still counts as
  // KAST for everyone, and would otherwise be missing from byRound entirely.
  const silentRounds = Math.max(0, rounds - byRound.size);

  const tally = new Map();
  for (const id of playerIds) {
    tally.set(id, {
      firstKills: firstKills.get(id) ?? 0,
      kast: rounds ? Math.round((((kastRounds.get(id) ?? 0) + silentRounds) / rounds) * 100) : null,
    });
  }
  return tally;
}

/** Riot: kills hang off each round's per-player stats, timed from round start. */
function riotCombat(match) {
  const events = [];
  for (const [index, round] of (match.roundResults ?? []).entries()) {
    for (const entry of round.playerStats ?? []) {
      for (const kill of entry.kills ?? []) {
        events.push({
          round: round.roundNum ?? index,
          at: kill.timeSinceRoundStartMillis ?? Number.POSITIVE_INFINITY,
          killer: kill.killer ?? entry.puuid,
          victim: kill.victim ?? null,
          assistants: (kill.assistants ?? []).map((assist) => assist?.assistant ?? assist).filter(Boolean),
        });
      }
    }
  }

  return combatTally(events, {
    playerIds: (match.players ?? []).map((player) => player.puuid).filter(Boolean),
    rounds: (match.roundResults ?? []).length,
  });
}

/** Per-player damage/headshot totals, summed across rounds (Riot does not pre-aggregate). */
function riotDamageTotals(match) {
  const totals = new Map();
  for (const round of match.roundResults ?? []) {
    for (const entry of round.playerStats ?? []) {
      const current = totals.get(entry.puuid) ?? { damage: 0, head: 0, body: 0, leg: 0 };
      for (const hit of entry.damage ?? []) {
        current.damage += hit.damage ?? 0;
        current.head += hit.headshots ?? 0;
        current.body += hit.bodyshots ?? 0;
        current.leg += hit.legshots ?? 0;
      }
      totals.set(entry.puuid, current);
    }
  }
  return totals;
}

export async function riotMatchList(riotGet, { puuid, region }) {
  const data = await riotGet(region, `/val/match/v1/matchlists/by-puuid/${encodeURIComponent(puuid)}`);
  return {
    provider: 'riot',
    matches: (data.history ?? []).map((entry) => ({
      id: entry.matchId,
      queue: riotQueueName(entry.queueId),
      startedAt: entry.gameStartTimeMillis ?? null,
      map: null,
      score: null,
      won: null,
    })),
  };
}

export async function riotMatchDetail(riotGet, { matchId, region }) {
  const [match, content] = await Promise.all([
    riotGet(region, `/val/match/v1/matches/${encodeURIComponent(matchId)}`),
    riotContentSafe(riotGet, region),
  ]);

  const info = match.matchInfo ?? {};
  const totals = riotDamageTotals(match);
  const combat = riotCombat(match);

  const players = (match.players ?? []).map((player) => {
    const stats = player.stats ?? {};
    const played = stats.roundsPlayed || 0;
    const damage = totals.get(player.puuid) ?? { damage: 0, head: 0, body: 0, leg: 0 };
    const shots = damage.head + damage.body + damage.leg;

    return {
      id: player.puuid,
      name: player.gameName ?? 'Unknown',
      tag: player.tagLine ?? null,
      teamId: player.teamId ?? null,
      agent: riotAgentName(content, player.characterId),
      rank: riotRankName(content, player.competitiveTier),
      kills: stats.kills ?? 0,
      deaths: stats.deaths ?? 0,
      assists: stats.assists ?? 0,
      score: stats.score ?? 0,
      roundsPlayed: played,
      acs: played ? Math.round((stats.score ?? 0) / played) : null,
      adr: played ? Math.round(damage.damage / played) : null,
      hsPct: shots ? Math.round((damage.head / shots) * 100) : null,
      firstKills: combat.get(player.puuid)?.firstKills ?? 0,
      kast: combat.get(player.puuid)?.kast ?? null,
    };
  });

  return {
    provider: 'riot',
    matchId: info.matchId ?? matchId,
    map: riotMapName(content, info.mapId),
    mode: riotQueueName(info.queueId),
    startedAt: info.gameStartMillis ?? null,
    durationMs: info.gameLengthMillis ?? null,
    isRanked: info.isRanked ?? null,
    isCompleted: info.isCompleted ?? null,
    season: info.seasonId ?? null,
    teams: (match.teams ?? []).map((team) => ({
      id: team.teamId,
      won: team.won ?? null,
      roundsWon: team.roundsWon ?? 0,
      roundsPlayed: team.roundsPlayed ?? 0,
    })),
    players,
    rounds: (match.roundResults ?? []).map((round) => ({
      num: (round.roundNum ?? 0) + 1,
      winningTeam: round.winningTeam ?? null,
      result: round.roundResult ?? null,
    })),
    raw: match,
  };
}

// ======================================================== tracker.gg ======

/**
 * tracker.gg - driven from the user-facing website. No API key of any kind.
 *
 * Two measured facts shaped this:
 *   - The site is behind Cloudflare; a plain request gets 403 with
 *     `cf-mitigated: challenge`, and headers alone never clear it.
 *   - The match list is fetched by XHR after render, so a static snapshot of
 *     the HTML (curl, FlareSolverr) does not contain it.
 *
 * So a real browser drives the page, and rather than scraping the rendered DOM
 * we intercept the JSON the page fetches for itself. That is the site's own
 * structured payload - the same shape the normalisers below already target -
 * and it survives visual redesigns that would break CSS selectors.
 *
 * Falls back to JSON embedded in the served HTML if no XHR is seen.
 *
 * Pages used:
 *   list   https://tracker.gg/valorant/profile/riot/{handle}/matches
 *   detail https://tracker.gg/valorant/match/{matchId}
 */

const TRACKER_LIST_TTL_MS = 5 * 60 * 1000;
const trackerListCache = new Map();

export const TRACKER_MATCH_TYPES = [
  'custom',
  'competitive',
  'unrated',
  'swiftplay',
  'spikerush',
  'deathmatch',
  'team-deathmatch',
  'escalation',
  'replication',
  'premier',
];

const BROWSER_HINT =
  'The tracker.gg source drives a real browser. Enable it with TRACKER_ENABLED=true in .env, ' +
  'and make sure Playwright is installed: npm install playwright && npx playwright install chromium.';

/**
 * The site's own match endpoints, whichever version it happens to call.
 * Covers the history (.../matches), the customs tab (.../customs) and a single
 * match (.../match/{id}).
 */
export const TRACKER_XHR_PATTERN = /\/valorant\/(?:standard\/)?(?:match(?:es)?|customs?)\b/i;

const TRACKER_BASE = 'https://tracker.gg';

/**
 * The website's own backend, which the site itself calls. Not the public
 * developer API - this needs no key, only the browser's Cloudflare clearance.
 */
const TRACKER_API_BASE = 'https://api.tracker.gg/api/v2/valorant/standard';

/** Overridable so the pathway can be tested against a local mock site. */
const trackerBase = (config) => String(config.baseUrl ?? TRACKER_BASE).replace(/\/$/, '');
const trackerApiBase = (config) => String(config.apiBaseUrl ?? TRACKER_API_BASE).replace(/\/$/, '');

/**
 * Walk a decoded page payload looking for tracker's match array.
 *
 * The site carries matches as objects with `segments` (per-player stat blocks)
 * and an `attributes.id`. Rather than pinning to one page shape - which changes
 * whenever the frontend is redeployed - find the first array whose items look
 * like that. Exported so the probe script can reuse the same detection.
 */
export function findMatchesArray(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;

  if (Array.isArray(node)) {
    const looksLikeMatches =
      node.length > 0 &&
      node.every(
        (item) =>
          item &&
          typeof item === 'object' &&
          (Array.isArray(item.segments) || item.attributes?.id !== undefined || item.metadata?.matchId !== undefined),
      );
    if (looksLikeMatches) return node;

    for (const item of node) {
      const found = findMatchesArray(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (Array.isArray(node.matches)) {
    const found = findMatchesArray(node.matches, depth + 1);
    if (found) return found;
  }

  for (const value of Object.values(node)) {
    const found = findMatchesArray(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Drive a tracker.gg page and return every match array it yields - first from
 * the XHR the page makes for itself, then from JSON embedded in the HTML.
 */
/**
 * Accept any JSON the site fetches from itself.
 *
 * On a dedicated match page there is no need to guess which endpoint holds the
 * scoreboard - everything the page fetches from its own domain is a candidate,
 * and findMatchesArray sorts out which payloads actually contain matches. That
 * survives tracker renaming or versioning the endpoint, which a hardcoded path
 * pattern does not.
 */
export function trackerSameSite(config) {
  let host;
  try {
    host = new URL(trackerBase(config)).hostname;
  } catch {
    return (candidate) => TRACKER_XHR_PATTERN.test(candidate);
  }

  const root = host.split('.').slice(-2).join('.');
  return (candidate) => {
    try {
      const target = new URL(candidate).hostname;
      return target === host || target === root || target.endsWith(`.${root}`);
    } catch {
      return false;
    }
  };
}

export async function trackerPage(browser, url, options = {}) {
  if (!browser) {
    throw new ProviderError(503, 'The tracker.gg source is not enabled.', BROWSER_HINT);
  }

  const { wanted, ...captureOptions } = options;
  const predicate = wanted ?? ((candidate) => TRACKER_XHR_PATTERN.test(candidate));

  let result;
  try {
    result = await browser.capture(url, predicate, captureOptions);
  } catch (error) {
    throw new ProviderError(502, `Browser failed on ${url}: ${error.message}`, error.hint ?? BROWSER_HINT);
  }

  const html = result.html ?? '';

  if (result.status === 404) {
    throw new ProviderError(404, 'tracker.gg has no page for that Riot ID.', 'Check the spelling and tagline.');
  }
  // A challenge that the browser could not clear leaves the interstitial in
  // place. The browser reports this directly; the HTML check is a fallback for
  // drivers that do not.
  const stuckOnChallenge =
    result.challenge?.cleared === false ||
    (result.status !== 200 && /<title>\s*Just a moment/i.test(html));

  if (stuckOnChallenge) {
    throw new ProviderError(
      403,
      'Cloudflare challenged the browser and it was not cleared.',
      'The saved browser profile was discarded and the visit retried, and it still did not clear. ' +
        'Run "npm run tracker:reset", then "npm run tracker:login" to solve it once in a visible window. ' +
        'TRACKER_BROWSER_CHANNEL=auto (real Chrome) passes far more reliably than msedge.',
    );
  }

  const arrays = [];
  let emptyList = false;
  let privateProfile = false;

  for (const capture of result.captured ?? []) {
    const matches = findMatchesArray(capture.body);
    if (matches) {
      arrays.push({ matches, via: `XHR ${new URL(capture.url).pathname}` });
      continue;
    }
    if (isPrivate(capture.body)) privateProfile = true;
    else if (TRACKER_XHR_PATTERN.test(capture.url) && isEmptyMatchList(capture.body)) emptyList = true;
  }

  if (!privateProfile && isPrivate(null, html)) privateProfile = true;
  for (const blob of extractEmbeddedJson(html)) {
    const matches = findMatchesArray(blob);
    if (matches) arrays.push({ matches, via: 'embedded JSON' });
  }

  return {
    arrays,
    emptyList,
    privateProfile,
    html,
    status: result.status ?? null,
    capturedCount: (result.captured ?? []).length,
    url,
  };
}

/**
 * Did the site answer with a match list that happens to be empty?
 *
 * This has to be told apart from "no list arrived at all", because the two look
 * identical to findMatchesArray - it only recognises a non-empty array - and
 * they mean opposite things. An account with no games of this type is a normal,
 * quiet answer; nothing arriving means the page never served its data, which
 * measured against tracker.gg is usually throttling. Reporting the first as an
 * error puts a permanent red row in the watch for a player who simply has not
 * played a custom yet.
 *
 * Deliberately narrow: only the site's own match payload shapes count, since
 * plenty of unrelated endpoints on the page answer with an empty `data` array.
 */
export function isEmptyMatchList(body) {
  const data = body?.data;
  if (Array.isArray(data?.matches)) return data.matches.length === 0;
  if (Array.isArray(data)) return data.length === 0;
  return false;
}

/**
 * Can this player's matches be read at all?
 *
 * Two different switches produce the same dead end, and neither resolves on its
 * own the way throttling or an unplayed mode does:
 *
 *   the tracker.gg profile is private   - a Tracker Network account setting
 *   the player's matches are private    - a VALORANT in-game setting, which
 *                                         tracker reports as "X's matches are
 *                                         private. Check in-game settings to
 *                                         change this."
 *
 * Both mean the account is a dead slot until its owner changes something, so
 * the watch drops it and the burst promotes another account in its place.
 *
 * The site's own API error is the first signal; page text is the fallback, and
 * it is matched tightly on purpose. "Privacy Policy" sits in the footer of every
 * page on the site, and Stripe injects an iframe named
 * __privateStripeMetricsController into the same document - measured, both are
 * present on a perfectly readable profile, so a loose match on the word alone
 * would report every throttled lookup as private.
 */
export function isPrivate(body, html = '') {
  for (const error of body?.errors ?? []) {
    if (/private/i.test(`${error?.code ?? ''} ${error?.message ?? ''}`)) return true;
  }

  return (
    /\b(?:profile|matches)\b[^<>]{0,40}\b(?:is|are) private\b/i.test(String(html)) ||
    /\bprivate\b[^<>]{0,20}\b(?:profile|matches)\b/i.test(String(html)) ||
    /check in-game settings/i.test(String(html))
  );
}


/** Match mode as tracker labels it, tolerant of casing and separators. */
const modeKey = (value) => String(value ?? '').toLowerCase().replace(/[\s_-]/g, '');

function matchesOfType(matches, type) {
  if (!type || type === 'all') return matches;
  const wanted = modeKey(type);

  const filtered = matches.filter((match) => {
    const candidates = [match.metadata?.modeName, match.metadata?.modeKey, match.attributes?.modeKey];
    return candidates.some((candidate) => candidate && modeKey(candidate) === wanted);
  });

  // If the page carried no recognisable mode labels, filtering would silently
  // hide everything - better to hand back what we found.
  const labelled = matches.some((m) => m.metadata?.modeName || m.metadata?.modeKey || m.attributes?.modeKey);
  return labelled ? filtered : matches;
}

/**
 * Custom games live on their own tab, not the general match history.
 * /matches never lists them, so asking for customs has to go to /customs.
 */
export const trackerProfilePath = (handle, type) =>
  `/valorant/profile/riot/${encodeURIComponent(handle)}/${modeKey(type) === 'custom' ? 'customs' : 'matches'}`;

async function trackerMatchesRaw(config, handle, type) {
  const onCustomsTab = modeKey(type) === 'custom';
  const url = `${trackerBase(config)}${trackerProfilePath(handle, type)}`;
  const page = await trackerPage(config.browser, url);

  // Several XHRs can carry matches; take the richest one.
  const best = page.arrays.sort((a, b) => b.matches.length - a.matches.length)[0];

  // Everything on the customs tab is already a custom game, and tracker labels
  // those by the underlying mode ("Standard", "Competitive"), so filtering by
  // mode here would throw the whole list away.
  if (best) return onCustomsTab ? best.matches : matchesOfType(best.matches, type);

  // The site answered, this account just has nothing of that kind. Not an error.
  if (page.emptyList) return [];

  // Private is permanent until its owner changes it, so it gets a status of its
  // own: the watch drops the account instead of retrying it every round.
  if (page.privateProfile) {
    throw new ProviderError(
      403,
      'That player\'s matches are private.',
      'Either the tracker.gg profile is hidden, or match history is set to private in VALORANT itself ' +
        '(Settings > General > Privacy). Nothing can read it until they change that, so this account is ' +
        'skipped and another one is tried instead.',
    );
  }

  // Nothing on the page. Ask the site's own API why, because the page itself
  // will not say: when tracker is rate-limiting, it serves a perfectly normal
  // profile shell and simply never fetches the data, which is indistinguishable
  // from a redesign or a dead account until something asks the API directly.
  // One extra request, only on a path that has already failed.
  const refusal = await trackerRefusal(config, handle);
  if (refusal) throw refusal;

  throw new ProviderError(
    502,
    `The ${onCustomsTab ? 'customs' : 'matches'} page loaded, but no match data could be found.`,
    `HTTP ${page.status ?? '?'}, ${page.html.length} bytes, ${page.capturedCount} matching XHR response(s), ` +
      'none containing a match array and none saying the list is empty. Measured against tracker.gg, the ' +
      'usual cause is throttling: over its limit the site serves a normal-looking page with the match ' +
      'request simply missing, and only time fixes it. Run "npm run tracker:probe <Name#TAG>" to see every ' +
      'request the page made and what it returned.',
  );
}

/**
 * Why did the page come back empty? Returns a ProviderError when the API gives
 * a reason worth repeating, or null to leave the generic message in place.
 *
 * Warden is tracker's own rate limiter. It answers 429 with a captcha demand,
 * and no amount of waiting inside one request clears it - a human has to solve
 * it once, which is exactly what "npm run tracker:login" is for.
 */
async function trackerRefusal(config, handle) {
  if (!config.browser) return null;

  let response;
  try {
    response = await config.browser.fetchJson(
      `${trackerBase(config)}/valorant`,
      `${trackerApiBase(config)}/matches/riot/${encodeURIComponent(handle)}?platform=pc`,
    );
  } catch {
    return null;
  }

  const error = response.body?.errors?.[0];
  const captcha = response.status === 429 || /warden|captcha/i.test(`${error?.code ?? ''} ${error?.message ?? ''}`);

  if (!captcha) return null;

  return new ProviderError(
    429,
    'tracker.gg is rate limiting this machine and wants a captcha solved.',
    `Its own API answered ${response.status} ${error?.code ?? ''}: ${error?.message ?? 'too many requests'}. ` +
      'Nothing will read until it is cleared: run "npm run tracker:login" and solve it once in the window that ' +
      'opens, or leave the site alone for a while. Measured, tracker tolerates about one lookup a minute.',
  );
}

/** Tracker stats are { key: { value, displayValue } }. Pull the first key that exists. */
function statValue(stats, ...keys) {
  for (const key of keys) {
    const value = stats?.[key]?.value;
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function trackerPlayerSegments(match) {
  return (match.segments ?? []).filter((segment) => {
    const type = String(segment.type ?? '').toLowerCase();
    return type === 'overview' || type === 'player' || type === 'player-summary';
  });
}

function trackerSummary(match) {
  const attributes = match.attributes ?? {};
  const metadata = match.metadata ?? {};
  const timestamp = pickFirst(metadata.timestamp, attributes.timestamp);

  const roundsWon = statValue(match.stats, 'roundsWon');
  const roundsLost = statValue(match.stats, 'roundsLost');

  return {
    id: pickFirst(attributes.id, metadata.matchId, match.id),
    queue: pickFirst(metadata.modeName, attributes.modeKey, metadata.modeKey) ?? 'Unknown',
    startedAt: timestamp ? new Date(timestamp).getTime() : null,
    map: pickFirst(metadata.mapName, attributes.mapKey, metadata.mapKey),
    score: roundsWon !== null && roundsLost !== null ? `${roundsWon} - ${roundsLost}` : null,
    won: metadata.result ? String(metadata.result).toLowerCase() === 'victory' : null,
  };
}

export async function trackerMatchList(config, { handle, type }) {
  const matches = await trackerMatchesRaw(config, handle, type);
  trackerListCache.set(`${handle}::${type}`, { at: Date.now(), matches });

  return {
    provider: 'tracker',
    matches: matches.map(trackerSummary),
  };
}

const matchIdOf = (entry) => pickFirst(entry.attributes?.id, entry.metadata?.matchId, entry.id);

/**
 * Normalise a payload into a list of match entries.
 *
 * The list endpoints return an array of matches, but the single-match endpoint
 * returns one object under `data` - which findMatchesArray, looking for arrays,
 * will never find.
 */
function matchEntriesFrom(body) {
  const array = findMatchesArray(body);
  if (array) return array;

  const single = body?.data ?? body;
  const looksLikeMatch =
    single &&
    typeof single === 'object' &&
    (Array.isArray(single.segments) || single.attributes?.id || single.metadata?.matchId);

  return looksLikeMatch ? [single] : [];
}

/**
 * Pick the fullest payload for a match out of everything the page fetched.
 *
 * A match page fires several match-shaped XHRs and only one of them carries the
 * whole scoreboard - the rest describe the searched player alone. Taking the
 * first array that happened to mention the id therefore yields a one-player
 * match, so score every candidate by how many players it actually describes.
 * A correct id still outranks a fuller payload: more players in a *different*
 * match is the wrong answer, not a better one.
 */
function bestMatchEntry(arrays, matchId) {
  const candidates = [];
  for (const { matches: found } of arrays) {
    for (const entry of found) {
      candidates.push({
        entry,
        idMatches: String(matchIdOf(entry)) === String(matchId) ? 1 : 0,
        players: trackerPlayerSegments(entry).length,
      });
    }
  }

  candidates.sort((a, b) => b.idMatches - a.idMatches || b.players - a.players);
  return candidates[0]?.entry ?? null;
}

/**
 * Why a match id came back with nothing, in the operator's terms.
 *
 * The two cases want opposite advice and neither is an error to fix. Reached by
 * a Riot ID, the id came off a list this tool showed, so a miss means the list
 * has gone stale. Reached by id alone - the match-id hook - nothing has claimed
 * the match exists yet, and the likeliest reason is that it finished seconds
 * ago: tracker indexes a game some time after the client knows about it, so the
 * answer is to press the button again rather than to change anything.
 */
const notFoundHint = (handle) =>
  handle
    ? 'Re-run the search to refresh the list - match ids expire from tracker over time.'
    : 'tracker.gg has probably not indexed it yet. Wait a few seconds and press the button again.';

export async function trackerMatchDetail(config, { matchId, handle, type }) {
  const cacheKey = `${handle}::${type}`;
  const cached = trackerListCache.get(cacheKey);

  let match = null;

  // Ask the site's own backend for the match outright. On the profile page the
  // scoreboard only appears after an interaction, and the match page does not
  // reliably serve it either - but this endpoint returns it directly. Called
  // from inside a tracker.gg page so it carries the Cloudflare clearance; no
  // API key is involved.
  let apiDeniedIt = false;

  if (config.browser) {
    try {
      const response = await config.browser.fetchJson(
        // Any page on the domain will do as the origin for the call, so use a
        // light one rather than paying to render the match page itself.
        `${trackerBase(config)}/valorant`,
        `${trackerApiBase(config)}/matches/${encodeURIComponent(matchId)}`,
      );
      if (response.status === 200) {
        match = bestMatchEntry([{ matches: matchEntriesFrom(response.body) }], matchId);
      }
      // The API is authoritative about existence, but only when it answers in
      // its own error shape - a bare 404 just means the URL was wrong, and
      // scraping is still worth a try.
      apiDeniedIt = response.status === 404 && Array.isArray(response.body?.errors);
    } catch {
      // Fall through to the page-scraping route below.
    }
  }

  if (apiDeniedIt && !match) {
    throw new ProviderError(404, 'tracker.gg has no record of that match.', notFoundHint(handle));
  }

  // Fallback: drive the match page and take whatever it fetches for itself.
  if (!match || trackerPlayerSegments(match).length < 2) {
    try {
      const page = await trackerPage(
        config.browser,
        `${trackerBase(config)}/valorant/match/${encodeURIComponent(matchId)}`,
        {
          wanted: trackerSameSite(config),
          // The scoreboard is not always the first payload to land, and capture
          // stops waiting once one arrives - so leave the window open longer.
          settleMs: 6_000,
        },
      );
      const fromPage = bestMatchEntry(page.arrays, matchId);
      if (fromPage && trackerPlayerSegments(fromPage).length > trackerPlayerSegments(match ?? {}).length) {
        match = fromPage;
      }
    } catch {
      // Fall through to the cached list entry below.
    }
  }

  // The list entry is a fallback and a tie-breaker, never an upgrade: only
  // consult it when the match page gave us nothing or gave us a lone player.
  // Skipped entirely without a handle - this is the one step that needs a
  // profile to read, and a lookup driven by the match-id hook has none.
  if (handle && (!match || trackerPlayerSegments(match).length < 2)) {
    try {
      let matches = cached && Date.now() - cached.at < TRACKER_LIST_TTL_MS ? cached.matches : null;
      if (!matches) matches = await trackerMatchesRaw(config, handle, type);

      const fromList = matches.find((entry) => String(matchIdOf(entry)) === String(matchId)) ?? null;
      if (fromList && trackerPlayerSegments(fromList).length > trackerPlayerSegments(match ?? {}).length) {
        match = fromList;
      }
    } catch (error) {
      // Keep whatever the match page gave us rather than losing it entirely.
      if (!match) throw error;
    }
  }

  if (!match) {
    throw new ProviderError(404, 'That match could not be found on tracker.gg.', notFoundHint(handle));
  }

  const summary = trackerSummary(match);
  const segments = trackerPlayerSegments(match);

  const players = segments.map((segment) => {
    const stats = segment.stats ?? {};
    const metadata = segment.metadata ?? {};
    const rawHandle = String(pickFirst(metadata.platformUserHandle, segment.attributes?.platformUserIdentifier) ?? '');
    const [name, tag] = rawHandle.includes('#') ? rawHandle.split('#') : [rawHandle || 'Unknown', null];

    const kills = statValue(stats, 'kills') ?? 0;
    const deaths = statValue(stats, 'deaths') ?? 0;
    const roundsPlayed = statValue(stats, 'roundsPlayed', 'roundsCounted');
    const score = statValue(stats, 'score') ?? 0;
    const acs = statValue(stats, 'scorePerRound', 'averageCombatScore');

    return {
      id: pickFirst(segment.attributes?.platformUserIdentifier, rawHandle),
      name,
      tag,
      teamId: pickFirst(metadata.teamId, segment.attributes?.teamId),
      agent: pickFirst(metadata.agentName, metadata.agentKey, segment.attributes?.agentKey),
      rank: pickFirst(metadata.rankName, metadata.tierName),
      kills,
      deaths,
      assists: statValue(stats, 'assists') ?? 0,
      score,
      roundsPlayed: roundsPlayed ?? 0,
      acs: acs !== null ? Math.round(acs) : roundsPlayed ? Math.round(score / roundsPlayed) : null,
      adr: (() => {
        const perRound = statValue(stats, 'damagePerRound');
        if (perRound !== null) return Math.round(perRound);
        const total = statValue(stats, 'damage', 'damageDealt');
        return total !== null && roundsPlayed ? Math.round(total / roundsPlayed) : null;
      })(),
      hsPct: (() => {
        const pct = statValue(stats, 'headshotsPercentage', 'headshotPercentage');
        return pct !== null ? Math.round(pct) : null;
      })(),
      // tracker pre-aggregates both of these, under either name depending on
      // the payload - no round timeline needed here.
      firstKills: statValue(stats, 'firstBloods', 'firstKills') ?? 0,
      kast: (() => {
        const kast = statValue(stats, 'kast', 'kastPercentage', 'kAST');
        return kast === null ? null : Math.round(kast);
      })(),
    };
  });

  // Rebuild team totals from whatever tracker exposed.
  const teamIds = [...new Set(players.map((p) => p.teamId).filter(Boolean))];
  const teams = teamIds.map((id) => {
    const teamSegment = (match.segments ?? []).find(
      (segment) => String(segment.type ?? '').toLowerCase().includes('team') && String(segment.attributes?.teamId) === String(id),
    );
    return {
      id,
      won: statValue(teamSegment?.stats, 'hasWon') === 1 ? true : null,
      roundsWon: statValue(teamSegment?.stats, 'roundsWon') ?? 0,
      roundsPlayed: statValue(teamSegment?.stats, 'roundsPlayed') ?? 0,
    };
  });

  return {
    provider: 'tracker',
    matchId: summary.id,
    map: summary.map,
    mode: summary.queue,
    startedAt: summary.startedAt,
    durationMs: statValue(match.stats, 'duration'),
    isRanked: null,
    isCompleted: null,
    season: pickFirst(match.metadata?.seasonName, match.attributes?.seasonId),
    teams,
    players,
    rounds: [],
    raw: match,
  };
}

// ========================================================== henrikdev ======

/**
 * HenrikDev API - https://api.henrikdev.xyz  (free key via their Discord).
 *
 * Endpoints and field names below are taken from their published OpenAPI spec
 * (https://api.henrikdev.xyz/openapi.json, v4.6.0), not from guesswork:
 *
 *   GET /valorant/v1/account/{name}/{tag}
 *       -> data { puuid, region, name, tag, account_level }
 *   GET /valorant/v4/matches/{affinity}/{platform}/{name}/{tag}?mode=&size=
 *       -> data[] of full match objects
 *   GET /valorant/v4/match/{affinity}/{match_id}
 *       -> data, one full match object
 *
 * A match object is { metadata, players, teams, rounds, kills, coaches, observers }.
 * Unlike Riot's API this needs no production key, and it returns custom games.
 */

export const HENRIK_AFFINITIES = ['ap', 'br', 'eu', 'kr', 'latam', 'na'];
export const HENRIK_PLATFORMS = ['pc', 'console'];
export const HENRIK_MODES = [
  'custom',
  'competitive',
  'unrated',
  'swiftplay',
  'spikerush',
  'deathmatch',
  'teamdeathmatch',
  'escalation',
  'replication',
  'snowball',
  'premier',
  'newmap',
];

const HENRIK_LIST_SIZE = 10;

async function henrikFetch(apiKey, endpoint, searchParams) {
  if (!apiKey) {
    throw new ProviderError(
      500,
      'No HenrikDev API key configured.',
      'Set HENRIK_API_KEY in .env, then restart. Free keys come from the HenrikDev Discord (https://discord.gg/henrikdev).',
    );
  }

  const url = new URL(`https://api.henrikdev.xyz${endpoint}`);
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }

  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? 'the request timed out' : error.message;
    throw new ProviderError(502, `Could not reach the HenrikDev API: ${reason}`, 'Check network/proxy access.');
  }

  const body = await response.text();

  if (!response.ok) {
    let message = `HenrikDev API returned HTTP ${response.status}.`;
    try {
      const parsed = JSON.parse(body);
      if (parsed?.errors?.[0]?.message) message = `HenrikDev: ${parsed.errors[0].message}`;
    } catch {
      /* non-JSON error body */
    }

    const hints = {
      401: 'HENRIK_API_KEY is missing or invalid. Request one from the HenrikDev Discord.',
      403: 'Your key does not have access to this endpoint.',
      404: 'No such player or match. Check the Riot ID, region and match type.',
      429: 'Rate limited. The free tier allows roughly 30 requests per minute.',
    };
    throw new ProviderError(response.status, message, hints[response.status] ?? '');
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new ProviderError(502, 'HenrikDev API returned a response that was not valid JSON.');
  }
}

export async function henrikAccount(apiKey, { gameName, tagLine }) {
  const payload = await henrikFetch(
    apiKey,
    `/valorant/v1/account/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
  );
  const data = payload?.data ?? {};

  return {
    gameName: data.name ?? gameName,
    tagLine: data.tag ?? tagLine,
    puuid: data.puuid ?? null,
    // The account response carries the player's affinity, so the UI can
    // preselect the right region instead of making the operator guess.
    region: data.region ?? null,
    accountLevel: data.account_level ?? null,
    handle: `${data.name ?? gameName}#${data.tag ?? tagLine}`,
  };
}

/**
 * The same lookup, backwards: a PUUID in, the name it answers to today out.
 *
 * This is what makes a stored identity worth storing. A Riot ID is a label a
 * player can change; the PUUID underneath it does not move, so asking "what is
 * this account called now" is the only way to notice a rename - and noticing
 * one before a show is the difference between a correct lower third and a
 * caster reading a name nobody uses any more.
 *
 * It takes the CANONICAL uuid, and only that. Henrik answers 400 "Invalid
 * UUID/PUUID" for the 78-character ciphertext riot/account/v1 hands out, which
 * is why riot-account.js routes this call on the stored puuidSource rather than
 * trying both. See the finding at the top of that file.
 */
export async function henrikAccountByPuuid(apiKey, { puuid }) {
  const payload = await henrikFetch(apiKey, `/valorant/v1/by-puuid/account/${encodeURIComponent(puuid)}`);
  const data = payload?.data ?? {};

  return {
    gameName: data.name ?? '',
    tagLine: data.tag ?? '',
    puuid: data.puuid ?? puuid,
    region: data.region ?? null,
    accountLevel: data.account_level ?? null,
    handle: data.name && data.tag ? `${data.name}#${data.tag}` : '',
  };
}

const henrikTimestamp = (value) => {
  if (!value) return null;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * First bloods and KAST, keyed by puuid.
 *
 * v4 exposes a flat `kills` timeline; older shapes nest the same events under
 * each round's per-player stats. Both are read, because neither the graphic nor
 * the tracker fallback can rely on which shape a given payload arrived in.
 */
function henrikCombat(match) {
  const events = [];
  const seen = new Set();

  // A puuid can appear as an object, a *_puuid field, or a bare string.
  const id = (value) => (typeof value === 'string' ? value : (value?.puuid ?? null));

  const push = (kill, roundHint) => {
    const killer = id(kill?.killer) ?? kill?.killer_puuid ?? null;
    const at = kill?.time_in_round_in_ms ?? kill?.kill_time_in_round;
    if (!killer || !Number.isFinite(at)) return;

    const victim = id(kill?.victim) ?? kill?.victim_puuid ?? null;
    const round = kill.round ?? roundHint;

    // The two shapes can both be present; do not count a kill twice.
    const fingerprint = `${round}|${at}|${killer}|${victim}`;
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);

    events.push({
      round,
      at,
      killer,
      victim,
      assistants: (kill.assistants ?? []).map(id).filter(Boolean),
    });
  };

  for (const kill of match.kills ?? []) push(kill, null);

  for (const [index, round] of (match.rounds ?? []).entries()) {
    for (const entry of round.stats ?? round.player_stats ?? []) {
      for (const kill of entry.kill_events ?? entry.kills ?? []) push(kill, index);
    }
  }

  return combatTally(events, {
    playerIds: (match.players ?? []).map((player) => player.puuid).filter(Boolean),
    rounds: henrikRoundsPlayed(match, (match.teams ?? [])[0]),
  });
}

/** Rounds actually played - the rounds array is authoritative, team totals are the fallback. */
function henrikRoundsPlayed(match, team) {
  if (Array.isArray(match.rounds) && match.rounds.length) return match.rounds.length;
  const rounds = team?.rounds ?? {};
  return (rounds.won ?? 0) + (rounds.lost ?? 0);
}

function henrikSummary(match, puuid) {
  const metadata = match.metadata ?? {};
  const teams = match.teams ?? [];

  // "won" is relative to the player being looked up.
  const self = (match.players ?? []).find((p) => p.puuid && puuid && p.puuid === puuid);
  const selfTeam = teams.find((t) => String(t.team_id) === String(self?.team_id));

  const scores = teams
    .map((team) => team.rounds?.won ?? 0)
    .slice(0, 2);

  return {
    id: metadata.match_id ?? null,
    queue: metadata.queue?.name ?? metadata.queue?.mode_type ?? metadata.queue?.id ?? 'Unknown',
    startedAt: henrikTimestamp(metadata.started_at),
    map: metadata.map?.name ?? null,
    score: scores.length === 2 ? `${scores[0]} - ${scores[1]}` : null,
    won: selfTeam ? (selfTeam.won ?? null) : null,
  };
}

function henrikDetail(match) {
  const metadata = match.metadata ?? {};
  const teams = match.teams ?? [];
  const combat = henrikCombat(match);

  const normalisedTeams = teams.map((team) => ({
    id: team.team_id ?? null,
    won: team.won ?? null,
    roundsWon: team.rounds?.won ?? 0,
    roundsPlayed: (team.rounds?.won ?? 0) + (team.rounds?.lost ?? 0),
  }));

  const players = (match.players ?? []).map((player) => {
    const stats = player.stats ?? {};
    const team = teams.find((t) => String(t.team_id) === String(player.team_id));
    const played = henrikRoundsPlayed(match, team);

    const shots = (stats.headshots ?? 0) + (stats.bodyshots ?? 0) + (stats.legshots ?? 0);
    const damage = stats.damage?.dealt ?? 0;

    return {
      id: player.puuid ?? `${player.name}#${player.tag}`,
      name: player.name ?? 'Unknown',
      tag: player.tag ?? null,
      teamId: player.team_id ?? null,
      agent: player.agent?.name ?? null,
      rank: player.tier?.name ?? 'Unranked',
      kills: stats.kills ?? 0,
      deaths: stats.deaths ?? 0,
      assists: stats.assists ?? 0,
      score: stats.score ?? 0,
      roundsPlayed: played,
      acs: played ? Math.round((stats.score ?? 0) / played) : null,
      adr: played ? Math.round(damage / played) : null,
      hsPct: shots ? Math.round(((stats.headshots ?? 0) / shots) * 100) : null,
      firstKills: combat.get(player.puuid)?.firstKills ?? 0,
      kast: combat.get(player.puuid)?.kast ?? null,
    };
  });

  const rounds = (match.rounds ?? []).map((round, index) => ({
    num: typeof round.id === 'number' ? round.id + 1 : index + 1,
    winningTeam: round.winning_team ?? null,
    result: round.result ?? null,
  }));

  return {
    provider: 'henrik',
    matchId: metadata.match_id ?? null,
    map: metadata.map?.name ?? null,
    mode: metadata.queue?.name ?? metadata.queue?.mode_type ?? null,
    startedAt: henrikTimestamp(metadata.started_at),
    durationMs: metadata.game_length_in_ms ?? null,
    isRanked: metadata.queue?.id ? metadata.queue.id === 'competitive' : null,
    isCompleted: metadata.is_completed ?? null,
    season: metadata.season?.short ?? metadata.season?.id ?? null,
    teams: normalisedTeams,
    players,
    rounds,
    raw: match,
  };
}

export async function henrikMatchList(apiKey, { gameName, tagLine, affinity, platform, mode, puuid }) {
  const payload = await henrikFetch(
    apiKey,
    `/valorant/v4/matches/${encodeURIComponent(affinity)}/${encodeURIComponent(platform)}/` +
      `${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
    { mode: mode === 'all' ? undefined : mode, size: HENRIK_LIST_SIZE },
  );

  return {
    provider: 'henrik',
    matches: (payload?.data ?? []).map((match) => henrikSummary(match, puuid)),
  };
}

export async function henrikMatchDetail(apiKey, { matchId, affinity }) {
  const payload = await henrikFetch(
    apiKey,
    `/valorant/v4/match/${encodeURIComponent(affinity)}/${encodeURIComponent(matchId)}`,
  );

  if (!payload?.data) {
    throw new ProviderError(404, 'HenrikDev returned no data for that match.', 'Re-run the search to refresh the list.');
  }
  return henrikDetail(payload.data);
}
