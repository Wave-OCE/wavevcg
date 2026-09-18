/**
 * The team library - orgs an operator works with, saved once and reused.
 *
 * A team is a small record rather than a free-text name because the same org
 * turns up on the scoreboard, on the winner graphic and on whatever comes next,
 * and retyping a name and re-pasting a logo URL for each of them is exactly the
 * kind of thing that goes wrong ninety seconds before a show.
 *
 * Picking a team *copies* its fields into the graphic rather than storing a
 * pointer to it. Same reasoning as presets: the graphic on air is the truth, so
 * editing the library later cannot silently rewrite something already live, and
 * the output pages never need the library at all. `teamId` is kept alongside
 * purely so the dashboard can show which entry a side came from.
 *
 * Dependency-free and DOM-free so Node and the browser can both import it.
 */

/**
 * Broadcast regions, roughly the VCT ones plus the catch-alls a local event
 * actually needs. Free text would be a typo waiting to happen on a lower third,
 * but an unknown value is still preserved on the way in rather than blanked -
 * an operator running a region this list has never heard of should not lose it.
 */
export const TEAM_REGIONS = [
  'Americas',
  'EMEA',
  'Pacific',
  'China',
  'NA',
  'LATAM',
  'BR',
  'EU',
  'KR',
  'JP',
  'SEA',
  'OCE',
  'SA',
  'MENA',
];

/**
 * type: text   - plain string, `max` characters
 *       image  - a logo: an uploaded /logos/... path or a pasted http(s) URL
 *       choice - one of `options`, but unknown values are kept
 *       hex    - a colour
 */
export const TEAM_FIELDS = [
  { key: 'name', type: 'text', max: 32, label: 'Team name', placeholder: 'Sentinels' },
  // What the scoreboard header and the score line use when the full name will
  // not fit. Blank falls back to the full name rather than to an abbreviation
  // this file invented.
  { key: 'shortName', type: 'text', max: 8, label: 'Short name / tricode', placeholder: 'SEN' },
  { key: 'region', type: 'choice', options: TEAM_REGIONS, max: 24, label: 'Region', placeholder: 'Americas' },
  { key: 'logo', type: 'image', max: 500, label: 'Logo' },
  /*
   * The backdrop behind this team on the head-to-head graphic.
   *
   * On the TEAM rather than only on the graphic because an org's key art is a
   * property of the org - it should follow them into every matchup without
   * being re-picked - and the graphic keeps a style image of its own for the
   * teams that have none. Team first, style second.
   *
   * Safe to add here because `applyTeam` writes only keys the target side
   * actually HAS: the scoreboard, winner and select sides have no `banner`, so
   * this reaches the one graphic that can show it and no others.
   */
  { key: 'banner', type: 'image', max: 500, label: 'Backdrop' },
  /*
   * A stand-in portrait for anybody on this roster who has none of their own.
   *
   * The lineup graphic is five faces in a row and one empty slot is the thing
   * an audience looks at - so a team-wide fallback is what stops a sub whose
   * photo never arrived from being a hole in the middle of the graphic.
   */
  { key: 'playerPhoto', type: 'image', max: 500, label: 'Default player photo' },
  // Used for the accent bar behind the winning team, so a graphic can carry the
  // org's colour without the operator restyling the whole look per match.
  // Blank on purpose: a team with no colour of its own wears the colour of the
  // side it is playing. See teamColour below.
  { key: 'colour', type: 'hex', label: 'Team colour', default: '' },
];

export const TEAM_KEYS = TEAM_FIELDS.map((field) => field.key);

export const EMPTY_TEAM = Object.fromEntries(
  TEAM_FIELDS.map((field) => [field.key, field.default ?? '']),
);

/** The last resort when a team has no colour and is on no side. Riot red. */
export const FALLBACK_COLOUR = '#ff4655';

/**
 * What gets copied onto a graphic when a team is picked. Never the id.
 *
 * Built from TEAM_FIELDS rather than written out, because the three pickers used
 * to keep their own lists of keys and had already drifted apart - a field added
 * to the library would appear in its editor, save to disk, and then silently
 * never reach any graphic. One list, derived from the schema, is the only shape
 * of this that cannot rot.
 */
export const teamContent = (team) =>
  Object.fromEntries(
    TEAM_FIELDS.map((entry) => {
      const value = team?.[entry.key];
      // Empty counts as absent for a field with a default: a team saved with no
      // colour should arrive on the graphic wearing the fallback, not black.
      const blank = value === undefined || value === null || value === '';
      return [entry.key, blank ? (entry.default ?? '') : value];
    }),
  );

/**
 * Copy a library entry onto one side of a graphic.
 *
 * The three graphics genuinely have different shapes - the winner side carries a
 * region, the select side does not, and the scoreboard calls its name field
 * `teamName` - so this writes only the fields the target actually has. That way
 * adding a field to the library reaches every graphic that can show it, and the
 * ones that cannot are skipped rather than growing a key nothing renders.
 *
 * @param {object} side    the graphic's side object, mutated in place
 * @param {object} team    the library entry
 * @param {object} [rename] library key -> the name this graphic uses for it
 */
export function applyTeam(side, team, rename = {}) {
  for (const [key, value] of Object.entries(teamContent(team))) {
    const target = rename[key] ?? key;
    if (target in side) side[target] = value;
  }
  return side;
}

/*
 * The two sides of a VALORANT map, and what they are worth in colour.
 *
 * These hexes are the ones the built-in "Attack / Defence" preset already uses,
 * adopted rather than invented so the two cannot disagree. They are a working
 * pair, not sourced from Riot's own brand material - if the real values turn up
 * later this is the only place they change.
 */
export const VALORANT_SIDE_COLOURS = { attack: '#a32833', defence: '#14526b' };

export const SIDE_CHOICES = [
  { key: '', label: 'Not set' },
  { key: 'attack', label: 'Attack' },
  { key: 'defence', label: 'Defence' },
];

export const SIDE_KEYS = SIDE_CHOICES.map((entry) => entry.key);

/**
 * What colour a team wears.
 *
 * A blank team colour is not a missing value - it means "whichever side they are
 * on", which is how a team that has no brand colour, or a scrim team nobody has
 * set up, still comes out looking deliberate. Expressed as an absence rather
 * than a magic string so the ordinary colour control can express it by being
 * switched off, and so nothing downstream has to know the sentinel.
 *
 * `force` is the global switch: on, every team wears its side's colour whatever
 * it has saved, which is what a broadcast wanting plain attack/defence reads.
 */
export function teamColour(colour, side, { force = false, fallback = FALLBACK_COLOUR } = {}) {
  const own = String(colour ?? '').trim();
  const bySide = VALORANT_SIDE_COLOURS[String(side ?? '').trim()] ?? '';
  if (force) return bySide || own || fallback;
  return own || bySide || fallback;
}

/** Tricode if there is one, full name otherwise - never an empty label. */
export const teamLabel = (team) => (team?.shortName || team?.name || '').trim();

// ------------------------------------------------------------- the roster ---

/**
 * A player on a team.
 *
 * Deliberately NOT part of TEAM_FIELDS, and that separation is the whole point:
 * `teamContent()` copies every TEAM_FIELD onto a graphic when a team is picked,
 * and a roster is not a thing a scoreboard has a slot for. Putting players in
 * that list would have shipped ten player records into three graphic states on
 * every pick, where nothing reads them and the sanitisers would have to grow a
 * case each.
 *
 * So a team record carries `players` beside its fields, cleaned by
 * `sanitiseRoster` below rather than by `sanitiseTeamFields`.
 *
 * There IS an image field now, and the note that used to sit here said why
 * there was not: every portrait in the first three output pages is an AGENT
 * portrait from the catalogue, so "players have images" was new broadcast
 * design work rather than a storage change, and it stayed out until somebody
 * designed where it goes. The team lineup graphic is where it goes.
 *
 * It is edited on the PLAYERS page rather than in the roster editor, and that
 * is deliberate. A photo is set once a season; the roster editor is the thing
 * an operator opens ninety seconds before a match to fix a Riot ID, and ten
 * upload controls in it would bury the two fields that are actually urgent.
 */
export const PLAYER_FIELDS = [
  {
    key: 'displayName',
    type: 'text',
    max: 32,
    label: 'Name',
    placeholder: 'TenZ',
    help:
      'What a caster calls them, and what goes on air. Saving the team files this as their ' +
      'ALIAS, so the agent select strip and an imported scoreboard use it too - there is no ' +
      'second place to type it.',
  },
  {
    key: 'riotId',
    type: 'riotId',
    max: 64,
    label: 'Riot ID',
    placeholder: 'TenZ#SEN',
    help: 'GameName#Tag. Used to recognise them in a lobby, and to resolve their PUUID.',
  },
  {
    key: 'photo',
    type: 'image',
    max: 500,
    label: 'Photo',
    help: 'Their face, for the lineup graphic. A team-wide default covers anybody without one.',
  },
];

/**
 * The player fields that are TYPED, which is not all of them.
 *
 * The roster editor builds a text input per entry, and an image field rendered
 * that way would be a bare URL box - the one shape the standing rule about
 * asset fields forbids. So the editor iterates this and the photo is edited
 * with a real media control on the Players page.
 */
export const PLAYER_TEXT_FIELDS = PLAYER_FIELDS.filter((field) => field.type !== 'image');

export const PLAYER_KEYS = PLAYER_FIELDS.map((field) => field.key);

/** Five starters and room for subs. A squad, not a season's worth of signings. */
export const ROSTER_LIMIT = 10;

/**
 * Is this the shape of a Riot ID?
 *
 * Deliberately loose. A Riot ID is `GameName#Tag` and the game name accepts a
 * wide range of unicode - accents, CJK, and characters this file has no business
 * having an opinion about - so the only thing checked is that there is exactly
 * one `#` with something on each side. Anything stricter would refuse real
 * players, and the failure would be a name nobody could save ninety seconds
 * before a show.
 *
 * Whether the account EXISTS is a different question, answered by a lookup
 * rather than a regexp, and a blank is always allowed: a player whose Riot ID
 * nobody has yet is an ordinary state.
 */
export const looksLikeRiotId = (value) => /^[^#\s][^#]*#[^#\s]+$/.test(String(value ?? '').trim());

const playerText = (value, max) =>
  typeof value === 'string' ? value.slice(0, max).replace(/[\x00-\x1f]/g, '').trim() : '';

/**
 * What an image field is allowed to be: an http(s) URL, or a path on this
 * server.
 *
 * Here rather than in graphics.js because it is needed on BOTH sides of the
 * line now - a team's logo is sanitised on the server and a player's photo is
 * sanitised by the same function that runs in the browser. It used to live only
 * in graphics.js, with the result that a team logo was validated and a player
 * photo was any string at all: two fields holding the same kind of value,
 * cleaned by different rules, one of which was "anything".
 *
 * Relative paths stay allowed so an operator can drop a file into ./public, and
 * an upload is `/media/<hash>` which passes the same way. A `data:` URI does
 * NOT pass, deliberately: these end up in graphic state that is written to
 * disk, pushed over SSE to every dashboard and every output page, and a few
 * hundred kilobytes of base64 per logo would be carried on every keystroke.
 */
export const imageValue = (value, fallback = '') => {
  const candidate = String(value ?? '').trim();
  if (!candidate) return fallback;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href.slice(0, 500) : fallback;
  } catch {
    return /^\/[\w./-]{0,200}$/.test(candidate) ? candidate : fallback;
  }
};

/**
 * Clean one player.
 *
 * The three PUUID fields are carried but never typed: they are written by the
 * verification step and read by it, and an operator editing them by hand would
 * be asserting an identity they cannot check. They survive a save rather than
 * being dropped, which is what stops an ordinary name edit throwing away a
 * verification somebody already did.
 */
export function sanitisePlayer(input) {
  const source = input ?? {};
  const out = {};
  for (const field of PLAYER_FIELDS) {
    // An image is checked, not merely trimmed - the same rule a team logo goes
    // through. See imageValue.
    out[field.key] =
      field.type === 'image' ? imageValue(source[field.key], '') : playerText(source[field.key], field.max);
  }

  return {
    ...out,
    puuid: playerText(source.puuid, 128),
    // Which key minted it. Henrik's and Riot's may not be the same value, and a
    // stored identity with no provenance is one nobody can check later.
    puuidSource: ['riot', 'henrik'].includes(source.puuidSource) ? source.puuidSource : '',
    puuidCheckedAt: Number.isFinite(source.puuidCheckedAt) ? source.puuidCheckedAt : 0,
  };
}

/**
 * Clean a whole roster.
 *
 * A player with neither a name nor a Riot ID is not a player - it is an empty
 * row somebody left behind, and keeping it would put a blank line in every
 * picker. Same rule the team library applies to a nameless team.
 */
export function sanitiseRoster(input) {
  const rows = Array.isArray(input) ? input : [];
  return rows
    .map(sanitisePlayer)
    .filter((player) => player.displayName || player.riotId)
    .slice(0, ROSTER_LIMIT);
}

/** An empty row for the editor to fill in. */
export const emptyPlayer = () => sanitisePlayer({});

/**
 * `Team Liquid` -> `team-liquid`, so ids stay readable in the saved file and a
 * hand-edited teams.json is still something a person can follow.
 */
export const teamSlug = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'team';
