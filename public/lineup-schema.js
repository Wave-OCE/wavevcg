/**
 * The team lineup graphic: a squad, full screen.
 *
 * A fifth graphic, and the first one whose whole content is a COPY of a team -
 * pressing Load copies the org and its roster in, the same way the veto board
 * copies a veto and a fixture copies its teams. Nothing dereferences a `teamId`
 * at paint time, which is the one failure this codebase has actually shipped.
 *
 * ---------------------------------------------------------------------------
 * The format is a picker, not a fixed design
 * ---------------------------------------------------------------------------
 *
 * Because a show that has no photographs yet still needs a lineup. A portrait
 * shoot happens once, usually late, and often for four of the five - so a
 * graphic that can only be the photo version is one that cannot go on air until
 * everything has arrived. `names` is not a fallback for a broken state; it is a
 * design somebody may prefer.
 *
 * `photos` is what the reference board does; `names` is the one to use before a
 * portrait shoot.
 *
 * ---------------------------------------------------------------------------
 * A RIOT ID NEVER REACHES THIS GRAPHIC
 * ---------------------------------------------------------------------------
 *
 * There was a third format, `detailed`, which printed each player's Riot ID
 * under their name - and the `names` layout printed one too. Both are gone, and
 * the field went with them rather than merely being left unpainted.
 *
 * A Riot ID is not broadcast information. It is the handle somebody is added by
 * and messaged on, it is half of what an impersonator needs, and a full-screen
 * lineup is the single easiest frame in a broadcast to pause and read. Nothing
 * on air is improved by it.
 *
 * Deleting the FIELD rather than the paint is the point. A value that is merely
 * not rendered is still copied out of the roster on Load, written to
 * `lineup.json`, pushed over SSE to every browser source on every keystroke,
 * and sitting in the state any future contributor renders "just to see". Not
 * carrying it is the only version of this that cannot come back.
 */

import { ROSTER_LIMIT } from './teams.js';

export const LINEUP_FORMATS = [
  {
    key: 'photos',
    label: 'Photos and names',
    help: 'A row of portraits with a name under each. Anybody without a photo of their own wears the team default.',
  },
  {
    key: 'names',
    label: 'Names only',
    help: 'No portraits at all - large names in a column beside the crest. The one to use before a photo shoot.',
  },
];

/**
 * Formats this graphic used to have.
 *
 * `detailed` was photos plus each player's Riot ID. Remapped rather than left
 * to the unknown-value fallback, because that fallback returns the PREVIOUS
 * value - which on a saved state is `detailed` itself, so the graphic would
 * have kept a format it no longer has a design for.
 */
const RETIRED_FORMATS = { detailed: 'photos' };

export const LINEUP_FORMAT_KEYS = LINEUP_FORMATS.map((entry) => entry.key);

/** Five is a lineup. The cap matches the roster's so a squad cannot outgrow it. */
export const LINEUP_SLOTS = 5;

const text = (value, max) =>
  typeof value === 'string' ? value.slice(0, max).replace(/[\x00-\x1f\x7f]/g, '').trim() : '';

const whole = (value, min, max, fallback = min) => {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
};

/*
 * A name and a face. NOT a Riot ID - see the header, and do not add one back.
 * `sanitiseLineup` runs every seat through this, so a state saved when the
 * field existed loses it the first time it is read.
 */
const seat = (input) => {
  const source = input && typeof input === 'object' ? input : {};
  return {
    name: text(source.name, 32),
    photo: text(source.photo, 500),
  };
};

export const DEFAULT_LINEUP = {
  version: 1,
  format: 'photos',
  teamId: '',
  teamName: '',
  shortName: '',
  logo: '',
  colour: '',
  // The team's stand-in portrait, copied across with the rest - so a seat with
  // no photo of its own still paints something rather than a hole.
  defaultPhoto: '',
  heading: '',
  players: [],
  eventLogo: '',
  anim: { visible: false, cue: 0 },
};

/** A format this build still has a design for, or null. */
const formatOf = (value) => {
  const wanted = RETIRED_FORMATS[value] ?? value;
  return LINEUP_FORMAT_KEYS.includes(wanted) ? wanted : null;
};

export function sanitiseLineup(input, fallback = DEFAULT_LINEUP) {
  const source = input && typeof input === 'object' ? input : {};
  const base = fallback ?? DEFAULT_LINEUP;

  return {
    version: 1,
    format: formatOf(source.format) ?? formatOf(base.format) ?? 'photos',
    teamId: text(source.teamId ?? base.teamId, 64),
    teamName: text(source.teamName ?? base.teamName, 32),
    shortName: text(source.shortName ?? base.shortName, 8),
    logo: text(source.logo ?? base.logo, 500),
    colour: text(source.colour ?? base.colour, 24),
    defaultPhoto: text(source.defaultPhoto ?? base.defaultPhoto, 500),
    /*
     * A line above the team name - "STARTING LINEUP", "THE ROSTER", whatever
     * the show calls it. Its own field rather than baked into the design,
     * because it is the one piece of copy that differs between a league and a
     * one-off and nobody should need a code change for it.
     */
    heading: text(source.heading ?? base.heading, 40),
    players: (Array.isArray(source.players) ? source.players : (base.players ?? []))
      .slice(0, ROSTER_LIMIT)
      .map(seat),
    eventLogo: text(source.eventLogo ?? base.eventLogo, 500),
    anim: {
      visible: typeof source.anim?.visible === 'boolean' ? source.anim.visible : (base.anim?.visible ?? false),
      cue: whole(source.anim?.cue ?? base.anim?.cue, 0, 1_000_000, 0),
    },
  };
}

/**
 * A team record -> the lineup that shows it.
 *
 * Here rather than in the server for the reason `SHARED_FIELDS` lives in
 * global-schema.js: the source of a value owns the mapping. The dashboard, the
 * route and the output page would otherwise each grow their own idea of what a
 * lineup is made of.
 *
 * The roster is trimmed to LINEUP_SLOTS at the point of COPY rather than at
 * paint time. A squad of ten is an ordinary state - five starters and subs -
 * and the graphic is designed for five, so the decision about which five is one
 * the operator makes by ordering the roster, not one the page makes silently
 * while it draws.
 */
export function lineupFromTeam(team, { slots = LINEUP_SLOTS } = {}) {
  if (!team) return null;
  return {
    teamId: String(team.id ?? ''),
    teamName: String(team.name ?? ''),
    shortName: String(team.shortName ?? ''),
    logo: String(team.logo ?? ''),
    colour: String(team.colour ?? ''),
    defaultPhoto: String(team.playerPhoto ?? ''),
    // No riotId in the copy, deliberately - see the header. The roster has one
    // and this graphic must not.
    players: (team.players ?? []).slice(0, slots).map((player) =>
      seat({ name: player.displayName, photo: player.photo }),
    ),
  };
}

/** The portrait a seat actually paints: their own, then the team's, then none. */
export const seatPhoto = (player, defaultPhoto) => String(player?.photo || defaultPhoto || '');

/**
 * Has the team moved since this lineup was loaded?
 *
 * Compared on what the graphic SHOWS - the names, the photos, the crest - so
 * renaming a region or fixing a colour does not light a badge that then gets
 * ignored. Same rule the veto board's staleness note follows.
 */
export function lineupIsStale(state, team) {
  if (!state?.teamId || !team || state.teamId !== team.id) return false;
  const shown = JSON.stringify({
    name: state.teamName,
    logo: state.logo,
    players: (state.players ?? []).map((p) => [p.name, p.photo]),
  });
  /*
   * Both sides drop the Riot ID together, and that pairing is load-bearing
   * rather than tidy: the graphic no longer carries one, so comparing it
   * against a roster that does would make EVERY loaded lineup read as stale,
   * for ever, with a badge nobody could clear.
   */
  const live = JSON.stringify({
    name: team.name ?? '',
    logo: team.logo ?? '',
    players: (team.players ?? []).slice(0, LINEUP_SLOTS).map((p) => [p.displayName ?? '', p.photo ?? '']),
  });
  return shown !== live;
}
