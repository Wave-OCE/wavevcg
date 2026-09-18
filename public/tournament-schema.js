/**
 * A tournament, as a record.
 *
 * Shared by Node and the browser like every other *-schema.js here: the server
 * sanitises against this list, the Settings panel renders from it, and adding a
 * field is one entry rather than three edits that drift apart.
 *
 * ## What a tournament is at this stage
 *
 * A name, some dates, a logo, and a list of who may work on it. It owns no
 * graphics yet and no key resolves to it - that is a later stage, and keeping
 * them apart is what makes this one safe to deploy on a show day.
 *
 * ## The id is a UUID, and that is a decision rather than a habit
 *
 * It becomes a path segment on disk, it goes into URLs, and it stays in
 * somebody's bookmarks and OBS configuration for as long as the tournament runs. So:
 *
 *   - Not a name slug. `teamSlug` plus a `-2` suffix is the team library's
 *     whole namespace and it works there because a library is one operator's.
 *     Two tournaments will both run "Champions", on the same server, in the same
 *     year - and a slug that collides silently renames somebody's tournament.
 *   - Not a name at all, because renaming a tournament must not move it. An
 *     operator fixing a typo in "Champioship" should not break every URL.
 *   - It must pass SAFE_ID in sessions.js, because it will be joined into a
 *     path. randomUUID does; almost anything a person types does not.
 *
 * The name is free to change, and does. The id never does.
 */

import { DEFAULT_BRAND, brandHex } from './brand.js';

/** The longest a name may be. Long enough for "Touch Grass Invitational 2026". */
const NAME_MAX = 64;
const URL_MAX = 500;

/** What a member may do with this tournament. Mirrors GRANTS in auth.js. */
export const TOURNAMENT_ROLES = ['owner', 'editor', 'viewer'];

const text = (value, fallback = '', max = NAME_MAX) =>
  typeof value === 'string'
    ? value.slice(0, max).replace(/[\x00-\x1f]/g, '').trim()
    : fallback;

/**
 * A calendar date, or blank.
 *
 * `YYYY-MM-DD` and nothing else - the value an `<input type="date">` produces,
 * stored as it is typed. Deliberately not a timestamp: a tournament starts on a
 * date, not at an instant, and turning "the 4th" into an epoch would silently
 * pick a timezone and then show the operator the 3rd somewhere else.
 *
 * Blank is a real answer. A tournament with no end date yet is the normal state of
 * every tournament that has not finished.
 */
const date = (value, fallback = '') => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return fallback;
  // Rejects 2026-02-31 and 2026-13-01, which match the shape above but are not
  // dates. Date.parse on the bare form is UTC, so this never shifts a day.
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed.toISOString().slice(0, 10) === raw ? raw : fallback;
};

/**
 * An image URL, or blank.
 *
 * The same rule the graphics use: http(s), or a path starting with `/` so an
 * uploaded `/media/<hash>` keeps working. Anything else is discarded rather
 * than stored, because a value that cannot render is worse than no value - it
 * looks like a save that worked.
 */
const imageUrl = (value, fallback = '') => {
  const raw = text(value, '', URL_MAX);
  if (!raw) return '';
  return /^(?:https?:\/\/\S+|\/[\w./-]*)$/i.test(raw) ? raw : fallback;
};

/**
 * The fields an operator edits on the Settings sub-page.
 *
 * `type` picks the control the panel builds. Adding a field here makes it
 * appear in the panel, be sanitised on the server, and reach anything that
 * reads the record - which is the whole reason this file exists rather than
 * three hand-written inputs.
 */
export const TOURNAMENT_FIELDS = [
  {
    key: 'name',
    type: 'text',
    label: 'Tournament name',
    placeholder: 'Touch Grass Invitational',
    max: NAME_MAX,
    help: 'What this tournament is called. It names the workspace everywhere, and it can be changed at any time without moving anything.',
  },
  {
    key: 'startsAt',
    type: 'date',
    label: 'Starts',
    help: 'The first day of competition. Blank is fine.',
  },
  {
    key: 'endsAt',
    type: 'date',
    label: 'Ends',
    help: 'The last day. Blank while the tournament is still running, which is most of the time.',
  },
  {
    key: 'logo',
    type: 'image',
    label: 'Tournament logo',
    max: URL_MAX,
    help: 'Drop a file, paste one, or give a URL. Used as the default tournament logo on the graphics.',
  },
  /*
   * The event's two colours. See public/brand.js for what they mean and why
   * there are two of them rather than one.
   *
   * Blank is a real answer and means "use the house default", which is why
   * these carry no `default` of their own - the chain is graphic override ->
   * this -> DEFAULT_BRAND, and writing a default in here would make the middle
   * link indistinguishable from the last one.
   *
   * The help text says the quiet part out loud: this is the one setting in the
   * program that reaches air with no take. It is the right behaviour - an
   * operator changing the event's colour means "restyle the show" - but an
   * operator who types it during a live match should not be surprised.
   */
  {
    key: 'accent',
    type: 'hex',
    label: 'Event accent',
    group: 'Look',
    help:
      'The trim: thin rules, eyebrows and edges across every graphic. Each graphic can override it and ' +
      'Reset to default puts it back to this. CHANGES AIR IMMEDIATELY - there is no take on a colour.',
  },
  {
    key: 'highlight',
    type: 'hex',
    label: 'Event highlight',
    group: 'Look',
    help:
      'What WON, what is live, what went through - the winner\'s slot, the advancing team, a picked map. ' +
      'Separate from the accent on purpose, so the team that just advanced does not wear the same colour as ' +
      'the border around them. Graphics that draw no such distinction ignore it.',
  },
];

export const TOURNAMENT_KEYS = TOURNAMENT_FIELDS.map((field) => field.key);

/*
 * Blank passes through as blank, which is what makes "inherit" expressible.
 * `brandHex` is shared with every graphic that reads one of these, so the
 * tournament and the thing inheriting from it cannot disagree about what counts
 * as a colour.
 */
const hex = (value, fallback = '') => brandHex(value, fallback);

const SANITISERS = { text, date, image: imageUrl, hex };

/**
 * Clean the operator-editable half of a tournament record.
 *
 * Only the fields above. Everything else on the record - the id, who made it,
 * when, the membership list - is the server's and is never taken from a
 * request body, which is why this function cannot be handed a whole record and
 * asked to return one.
 */
export function sanitiseTournamentFields(input, fallback = null) {
  const source = input && typeof input === 'object' ? input : {};
  const base = fallback && typeof fallback === 'object' ? fallback : {};
  const out = {};
  for (const field of TOURNAMENT_FIELDS) {
    const clean = SANITISERS[field.type] ?? text;
    const previous = base[field.key] ?? '';
    // An absent key preserves; a present one is cleaned. That is what lets the
    // panel send only what it changed.
    out[field.key] = field.key in source ? clean(source[field.key], previous, field.max) : previous;
  }
  return out;
}

/** A brand new tournament, before anything has been typed into it. */
export const emptyTournament = () => Object.fromEntries(TOURNAMENT_KEYS.map((key) => [key, '']));

/**
 * How a tournament should be listed when it has no name yet.
 *
 * An unnamed tournament still has to be pickable out of a list, and "" is not. The
 * team library drops a nameless team for exactly this reason; a tournament cannot
 * be dropped, because somebody just made it and is about to name it.
 */
export const tournamentLabel = (tournament) => (tournament?.name || 'Untitled tournament');

/**
 * Is this tournament over?
 *
 * Only ever true when somebody has archived it. The end DATE deliberately does
 * not archive anything: a final that runs a day late must not have its
 * workspace go read-only underneath the operator, and a date nobody updated is
 * not evidence that a tournament finished.
 */
export const isArchived = (tournament) => Boolean(tournament?.archivedAt);

// ------------------------------------------------------------ productions ---

/**
 * A PRODUCTION is one desk: one set of graphics, one OBS configuration, one
 * stream deck. A tournament owns as many as it needs.
 *
 * ## The noun, and the collision it has to avoid
 *
 * It is a "production", never a "bus". `bus` is already the most load-bearing
 * word in this codebase - it is the preview/program PAIR that every graphic
 * exists as, `?bus=preview` is written into OBS URLs that predate this, and
 * `BUS_KINDS` is what decides whether a take bumps the cue counter. Reusing it
 * for a workspace would make "which bus" two different questions with the same
 * spelling, in the one place where being wrong is loud on air. Same rule, and
 * the same reason, as "the noun is tournament, never event".
 *
 * ## Why a tournament owns several
 *
 * Because a tournament runs more than one match at a time. Two concurrent
 * matches are two streams, which means two sets of browser sources - and the
 * graphic STATE is a store, so one set cannot serve both. Nothing about a
 * pointer fixes it; the desk itself has to be duplicated.
 *
 * What is NOT duplicated is the competition. Teams, aliases, the schedule and
 * the style presets stay on the tournament and are shared by every production
 * of it, because a team library per court is two libraries to keep in step and
 * a rename that reached one court and not the other.
 */
export const PRODUCTION_FIELDS = [
  {
    key: 'name',
    type: 'text',
    max: 60,
    label: 'Name',
    placeholder: 'Main stage',
    help: 'What this desk is called. Court 2, Alpha stream, whatever the crew says out loud.',
  },
];

export const PRODUCTION_KEYS = PRODUCTION_FIELDS.map((field) => field.key);

export function sanitiseProductionFields(input, fallback = null) {
  const source = input ?? {};
  const base = fallback ?? { name: '' };
  const out = {};
  for (const field of PRODUCTION_FIELDS) {
    out[field.key] = field.key in source ? text(source[field.key], base[field.key] ?? '', field.max) : (base[field.key] ?? '');
  }
  return out;
}

/** Pickable out of a list even before anybody has named it. */
export const productionLabel = (production) => production?.name || 'Untitled production';

/**
 * What the first production of a tournament is called.
 *
 * Named rather than left blank because migration day creates one of these for
 * every existing tournament, and a list of six "Untitled production" rows is
 * worse than no list at all.
 */
export const FIRST_PRODUCTION_NAME = 'Main';
