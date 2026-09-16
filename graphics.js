/**
 * Broadcast graphic state - the thing the dashboard edits and the output page renders.
 *
 * The output page is meant to be an OBS browser source, which is a separate
 * browser process from the dashboard. localStorage/BroadcastChannel therefore
 * cannot reach it, so state lives here on the server: the dashboard POSTs it,
 * the output page subscribes over SSE, and it is mirrored to disk so a restart
 * mid-broadcast does not wipe the graphic.
 *
 * Shape mirrors the scoreboard layout it drives: two sides, five players each,
 * player[0] of each side being that side's MVP.
 *
 * Zero npm dependencies - Node 18+ built-ins only.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// The browser loads these same modules - one definition of what a stat is, and
// one of what a preset is.
import { STAT_FIELDS, STAT_KEYS, STAT_SLOTS } from './public/stats.js';
import { BUILT_IN_IDS, BUILT_IN_PRESETS, FONT_CHOICES, PRESET_FIELDS } from './public/preset-schema.js';
import {
  ANIM_EASING_KEYS,
  ANIM_FIELDS,
  ANIM_STYLE_KEYS,
  ANIM_TIER_COUNT,
  DEFAULT_ANIM,
  inDurationMs,
} from './public/animation.js';
import { EMPTY_TEAM, TEAM_FIELDS, TEAM_REGIONS, teamSlug } from './public/teams.js';
import { mapCodeFromUrl, mapDisplayName } from './public/maps.js';
import {
  LOBBY_SEATS,
  emptyLobby,
  lobbyProgress,
  lobbySides,
  parseTeamOrder,
  sanitiseLobbySeat,
} from './public/lobby-schema.js';
import { DEFAULT_SETTINGS, sanitiseSettings } from './public/settings-schema.js';
import {
  COLOUR_SOURCE_KEYS,
  DEFAULT_GLOBAL,
  SYNC_FIELDS,
  graphicPatch,
} from './public/global-schema.js';
import {
  DEFAULT_SELECT,
  DEFAULT_SELECT_ANIM,
  DEFAULT_SELECT_AUTO,
  DEFAULT_SELECT_STYLE,
  DEFAULT_TIMER,
  EMPTY_SLOT,
  SELECT_ANIM_FIELDS,
  SELECT_AUTO_FIELDS,
  SELECT_EASING_KEYS,
  SELECT_ENTRANCE_KEYS,
  SELECT_SIDE_FIELDS,
  SELECT_SLOTS,
  SELECT_STYLE_FIELDS,
  TIMER_DEFAULT_MS,
  aliasForPlayer,
  aliasKey,
  displayName,
  emptySlots,
  pendingLinks,
  riotIdKey,
  everyoneLocked,
  isAgentSelectScene,
} from './public/select-schema.js';
import {
  AUDIO_FIELDS,
  DEFAULT_AUDIO,
  DEFAULT_SEQ,
  DEFAULT_WINNER,
  DEFAULT_WINNER_STYLE,
  SEQ_FIELDS,
  WINNER_EASING_KEYS,
  WINNER_MAP_ROWS,
  WINNER_OPENING_KEYS,
  WINNER_STAGE_COUNT,
  WINNER_STAGES,
  isOverlayEntry,
  WINNER_SCORE_FIELDS,
  WINNER_STYLE_FIELDS,
  WINNER_TEXT_FIELDS,
  WINNER_TRANSITION_KEYS,
  resolveWinner,
  stageBands,
  stageEnterMs,
} from './public/winner-schema.js';

export { STAT_FIELDS, STAT_KEYS, STAT_SLOTS, FONT_CHOICES, BUILT_IN_PRESETS, ANIM_TIER_COUNT, inDurationMs };
export { TEAM_REGIONS, WINNER_STAGES, WINNER_STAGE_COUNT, isOverlayEntry, resolveWinner, stageBands, stageEnterMs };
export { SELECT_SLOTS, aliasForPlayer, displayName, isAgentSelectScene };
// Re-exported so the server imports the lobby's shape from the same place it
// imports everything else's, rather than reaching into public/ for some of it.
export { LOBBY_SEATS, emptyLobby, lobbyProgress, lobbySides };

export const PLAYERS_PER_SIDE = 5;

const clone = (value) => JSON.parse(JSON.stringify(value));

// ------------------------------------------------------------- defaults ---

const emptyPlayer = () => ({
  name: '',
  tag: '',
  agent: '',
  // Who this row is, as opposed to what it scored. Carried so the alias library
  // built in agent select can name the same people on the scoreboard; both are
  // blank for a row typed by hand, which is what keeps a hand-typed name from
  // being overwritten the next time an alias is saved.
  playerId: '',
  riotId: '',
  ...Object.fromEntries(STAT_FIELDS.map((stat) => [stat.key, 0])),
});

const side = (teamName, roundsWon) => ({
  teamName,
  roundsWon,
  logo: '',
  // Which library entry the name and logo were filled from. Informational only,
  // exactly like presetId: the fields above are the truth, so editing a team
  // later never rewrites a scoreboard that is already on air.
  teamId: '',
  players: Array.from({ length: PLAYERS_PER_SIDE }, emptyPlayer),
});

export const DEFAULT_STATE = {
  version: 1,
  map: 'Ascent',
  mapImage: '',
  matchId: '',
  eventLogo: '',
  // Which stat each of the three rows shows. Slots 1 and 2 appear on the roster
  // rows as well; slot 3 only has room on the MVP panel.
  statRows: ['kda', 'acs', 'firstKills'],
  // Blank means "use the stat's own name", so changing a slot relabels itself.
  // The result line is derived from the two round counts rather than typed, so
  // only the wording is an operator's business.
  labels: { mvp: 'MVP', win: 'WIN', loss: 'LOSS', draw: 'DRAW', stat1: '', stat2: '', stat3: '' },
  left: side('ATK', 13),
  right: side('DEF', 5),
  // Which saved preset the styling last came from. Purely informational - the
  // preset block below is the truth, so an edit after applying is never lost.
  presetId: BUILT_IN_PRESETS[0].id,
  preset: clone(BUILT_IN_PRESETS[0].preset),
  // Whether the scoreboard is on air, and how it gets there.
  anim: clone(DEFAULT_ANIM),
};


// ----------------------------------------------------------- sanitising ---

/**
 * Everything below arrives from the browser and is re-emitted into a rendered
 * page, so nothing is trusted. Text is length-clamped (the renderer always uses
 * textContent, so markup is inert), colours must be literal hex, and image URLs
 * are restricted to http/https - `javascript:` and `data:` are the two that
 * would otherwise turn an <img src> into an injection point.
 */

/**
 * Absent means "fall back to the default"; present-but-empty means the operator
 * cleared the field deliberately. Collapsing the two would make a blanked team
 * name spring back to its old value, which is impossible to type into.
 */
const text = (value, fallback = '', max = 120) => {
  if (value === null || value === undefined) return fallback;
  // Control characters would survive textContent and corrupt the saved JSON.
  return String(value)
    .slice(0, max)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
};

const int = (value, fallback = 0, min = -9999, max = 9999) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const bool = (value, fallback = false) => (typeof value === 'boolean' ? value : fallback);

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const colour = (value, fallback) => {
  const candidate = String(value ?? '').trim();
  return HEX.test(candidate) ? candidate.toLowerCase() : fallback;
};

const imageUrl = (value, fallback = '') => {
  const candidate = String(value ?? '').trim();
  if (!candidate) return fallback;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href.slice(0, 500) : fallback;
  } catch {
    // Relative paths stay allowed so operators can drop a logo into ./public.
    return /^\/[\w./-]{0,200}$/.test(candidate) ? candidate : fallback;
  }
};

const ratio = (value, fallback) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, Math.round(parsed * 100) / 100)) : fallback;
};

/**
 * A ratio that is allowed past 1, clamped to the field's own range.
 *
 * `ratio` caps at 1 because everything it guards is a proportion - an opacity,
 * a dim. A multiplier is not, and running one through `ratio` would silently
 * clamp every enlargement to "no change" while the slider claimed otherwise.
 * Two decimals, the same as `ratio`, because the sliders step in twentieths and
 * a float arriving as 1.0500000000000002 should not be stored that way.
 */
const scale = (value, fallback, min = 0.1, max = 4) => {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed * 100) / 100));
};

function sanitisePlayer(input, fallback) {
  const source = input ?? {};
  return {
    name: text(source.name, fallback.name, 40),
    tag: text(source.tag, fallback.tag, 16),
    agent: text(source.agent, fallback.agent, 32),
    // Same 64 as the select slot and the alias record, so an id cannot be
    // truncated into one that matches nothing on its way through here.
    playerId: text(source.playerId, fallback.playerId ?? '', 64),
    riotId: text(source.riotId, fallback.riotId ?? '', 64),
    ...Object.fromEntries(
      STAT_FIELDS.map((stat) => [stat.key, int(source[stat.key], fallback[stat.key] ?? 0, 0, stat.max)]),
    ),
  };
}

function sanitiseSide(input, fallback) {
  const source = input ?? {};
  const players = Array.isArray(source.players) ? source.players : [];

  return {
    teamName: text(source.teamName, fallback.teamName, 24),
    roundsWon: int(source.roundsWon, fallback.roundsWon, 0, 99),
    logo: imageUrl(source.logo, fallback.logo),
    teamId: text(source.teamId, fallback.teamId ?? '', 48),
    // Always exactly PLAYERS_PER_SIDE: the layout has five fixed slots and a
    // short or long array would silently break the render rather than the edit.
    players: Array.from({ length: PLAYERS_PER_SIDE }, (_, index) =>
      sanitisePlayer(players[index], fallback.players[index] ?? emptyPlayer()),
    ),
  };
}

/** Merge a caller-supplied patch onto a known-good base, field by field. */
export function sanitiseState(input, base = DEFAULT_STATE) {
  const source = input ?? {};
  const fallback = base ?? DEFAULT_STATE;
  const labels = source.labels ?? {};

  return {
    version: 1,
    map: text(source.map, fallback.map, 40),
    mapImage: imageUrl(source.mapImage, fallback.mapImage),
    matchId: text(source.matchId, fallback.matchId, 64),
    eventLogo: imageUrl(source.eventLogo, fallback.eventLogo),
    // Exactly STAT_SLOTS entries, every one a stat the renderer knows how to
    // format - an unknown key would render as a blank row on air.
    statRows: Array.from({ length: STAT_SLOTS }, (_, index) => {
      const requested = String(source.statRows?.[index] ?? '');
      return STAT_KEYS.includes(requested) ? requested : fallback.statRows[index];
    }),
    labels: {
      mvp: text(labels.mvp, fallback.labels.mvp, 16),
      win: text(labels.win, fallback.labels.win, 16),
      loss: text(labels.loss, fallback.labels.loss, 16),
      draw: text(labels.draw, fallback.labels.draw, 16),
      stat1: text(labels.stat1, fallback.labels.stat1, 16),
      stat2: text(labels.stat2, fallback.labels.stat2, 16),
      stat3: text(labels.stat3, fallback.labels.stat3, 16),
    },
    left: sanitiseSide(source.left, fallback.left),
    right: sanitiseSide(source.right, fallback.right),
    presetId: text(source.presetId, fallback.presetId, 48),
    preset: sanitisePreset(source.preset, fallback.preset),
    anim: sanitiseAnim(source.anim, fallback.anim),
  };
}

/**
 * Driven by ANIM_FIELDS, for the same reason sanitisePreset is driven by
 * PRESET_FIELDS. `visible` and `cue` are handled by hand because they are the
 * command channel rather than configuration.
 */
const CUE_WRAP = 1_000_000;

export function sanitiseAnim(input, fallback = DEFAULT_ANIM) {
  const source = input ?? {};
  const base = fallback ?? DEFAULT_ANIM;

  const clean = {
    visible: bool(source.visible, base.visible),
    // Wrapped rather than clamped: the output page only compares it for
    // inequality, so wrapping keeps working where a ceiling would silently stop
    // registering cues once it was reached.
    cue: int(source.cue, base.cue, 0, Number.MAX_SAFE_INTEGER) % CUE_WRAP,
  };

  for (const field of ANIM_FIELDS) {
    const value = source[field.key];
    const previous = base[field.key];

    switch (field.type) {
      case 'choice': {
        const allowed = field.key === 'style' ? ANIM_STYLE_KEYS : ANIM_EASING_KEYS;
        clean[field.key] = allowed.includes(String(value)) ? String(value) : previous;
        break;
      }
      case 'bool':
        clean[field.key] = bool(value, previous);
        break;
      default:
        // A zero-length transition would make "animate" a lie, so durations have
        // a floor rather than clamping to 0 - the field's own min carries it.
        clean[field.key] = int(value, previous, field.min, field.max);
    }
  }

  return clean;
}

/**
 * Driven by PRESET_FIELDS rather than a hand-written list, so a styling option
 * cannot exist in the editor but be silently dropped here on the way in.
 */
export function sanitisePreset(input, fallback = DEFAULT_STATE.preset) {
  const source = input ?? {};
  const base = fallback ?? DEFAULT_STATE.preset;
  const clean = {};

  for (const field of PRESET_FIELDS) {
    const value = source[field.key];
    const previous = base[field.key];

    switch (field.type) {
      case 'font':
        clean[field.key] = FONT_CHOICES.includes(String(value)) ? String(value) : previous;
        break;
      case 'ratio':
        clean[field.key] = ratio(value, previous);
        break;
      case 'bool':
        clean[field.key] = bool(value, previous);
        break;
      case 'hexOff':
        // Empty means "leave it transparent", which is what OBS wants.
        clean[field.key] = colour(value, '') || '';
        break;
      default:
        clean[field.key] = colour(value, previous);
    }
  }

  return clean;
}

// ------------------------------------------------------ winner sanitising ---

/**
 * The winner graphic. Same rules as the scoreboard - nothing from the browser is
 * trusted - but the shapes are its own: two teams with a series score, a fixed
 * list of map rows, a sequence position, and its own style block.
 */

/** Shared by the team library and the winner graphic's two team blocks. */
export function sanitiseTeamFields(input, fallback = EMPTY_TEAM) {
  const source = input ?? {};
  const base = fallback ?? EMPTY_TEAM;
  const clean = {};

  for (const field of TEAM_FIELDS) {
    const value = source[field.key];
    const previous = base[field.key] ?? EMPTY_TEAM[field.key];

    switch (field.type) {
      case 'image':
        clean[field.key] = imageUrl(value, previous);
        break;
      case 'hex':
        // Blank is a real answer here - it means "whichever side they are on",
        // which is why an empty string is kept rather than falling back. Only an
        // absent key takes the previous value; anything unparseable still does.
        clean[field.key] =
          typeof value === 'string' && !value.trim() ? '' : colour(value, previous);
        break;
      default:
        // Regions are a suggestion list, not a closed set: an event running a
        // region this build has never heard of should keep the name it typed.
        clean[field.key] = text(value, previous, field.max ?? 40);
    }
  }
  return clean;
}

function sanitiseWinnerTeam(input, fallback) {
  const source = input ?? {};
  return {
    // Informational only, exactly like presetId - the copied fields below are
    // the truth, so editing the library never rewrites something already on air.
    teamId: text(source.teamId, fallback.teamId, 48),
    ...sanitiseTeamFields(source, fallback),
    score: int(source.score, fallback.score, 0, 99),
  };
}

function sanitiseMapRow(input, fallback) {
  const source = input ?? {};
  return {
    name: text(source.name, fallback.name, 32),
    left: int(source.left, fallback.left, 0, 99),
    right: int(source.right, fallback.right, 0, 99),
  };
}

/**
 * Driven by SEQ_FIELDS. `active`, `stage` and `cue` are done by hand because
 * they are the command channel rather than configuration.
 */
export function sanitiseSeq(input, fallback = DEFAULT_SEQ) {
  const source = input ?? {};
  const base = fallback ?? DEFAULT_SEQ;

  const clean = {
    active: bool(source.active, base.active),
    // Clamped, not wrapped: a stage outside the list has no scene to show, so
    // an out-of-range value has to land somewhere real rather than modulo into
    // an arbitrary scene.
    stage: int(source.stage, base.stage, 0, WINNER_STAGE_COUNT - 1),
    restart: bool(source.restart, base.restart),
    music: bool(source.music, base.music),
    cue: int(source.cue, base.cue, 0, Number.MAX_SAFE_INTEGER) % CUE_WRAP,
  };

  const CHOICES = {
    opening: WINNER_OPENING_KEYS,
    transition: WINNER_TRANSITION_KEYS,
    easing: WINNER_EASING_KEYS,
  };

  for (const field of SEQ_FIELDS) {
    const value = source[field.key];
    const previous = base[field.key];

    switch (field.type) {
      case 'choice': {
        const allowed = CHOICES[field.key] ?? [];
        clean[field.key] = allowed.includes(String(value)) ? String(value) : previous;
        break;
      }
      case 'bool':
        clean[field.key] = bool(value, previous);
        break;
      default:
        clean[field.key] = int(value, previous, field.min, field.max);
    }
  }
  return clean;
}

export function sanitiseAudio(input, fallback = DEFAULT_AUDIO) {
  const source = input ?? {};
  const base = fallback ?? DEFAULT_AUDIO;

  // Same rules as any other media reference: http(s) or a path under this
  // server, never a data: or javascript: URL.
  const clean = { track: imageUrl(source.track, base.track) };

  for (const field of AUDIO_FIELDS) {
    const value = source[field.key];
    const previous = base[field.key];

    switch (field.type) {
      case 'bool':
        clean[field.key] = bool(value, previous);
        break;
      case 'ratio':
        clean[field.key] = ratio(value, previous);
        break;
      default:
        clean[field.key] = int(value, previous, field.min, field.max);
    }
  }
  return clean;
}

export function sanitiseWinnerStyle(input, fallback = DEFAULT_WINNER_STYLE) {
  const source = input ?? {};
  const base = fallback ?? DEFAULT_WINNER_STYLE;
  const clean = {};

  for (const field of WINNER_STYLE_FIELDS) {
    const value = source[field.key];
    const previous = base[field.key];

    switch (field.type) {
      case 'font':
        clean[field.key] = FONT_CHOICES.includes(String(value)) ? String(value) : previous;
        break;
      case 'choice': {
        // The field carries its own allowed values, so a new choice field needs
        // no edit here to be checked.
        const allowed = (field.options ?? []).map((option) => option.key);
        clean[field.key] = allowed.includes(String(value)) ? String(value) : previous;
        break;
      }
      case 'ratio':
        clean[field.key] = ratio(value, previous);
        break;
      // Clamped to the field's own min/max rather than a rule here, so a second
      // scale field needs no edit in this switch to be bounded correctly.
      case 'scale':
        clean[field.key] = scale(value, previous, field.min, field.max);
        break;
      case 'bool':
        clean[field.key] = bool(value, previous);
        break;
      case 'px':
        clean[field.key] = int(value, previous, field.min, field.max);
        break;
      // Same rule as every other image reference in the graphic: http(s), or a
      // path under this server. The page drops it into a CSS url(), so an
      // unchecked string here would be reaching a good deal further than a src.
      case 'media':
        clean[field.key] = imageUrl(value, previous);
        break;
      default:
        clean[field.key] = colour(value, previous);
    }
  }
  return clean;
}

export function sanitiseWinner(input, base = DEFAULT_WINNER) {
  const source = input ?? {};
  const fallback = base ?? DEFAULT_WINNER;
  const rows = Array.isArray(source.maps) ? source.maps : [];

  const clean = {
    version: 1,
    eventLogo: imageUrl(source.eventLogo, fallback.eventLogo),
    mapName: text(source.mapName, fallback.mapName, 40),
    mapImage: imageUrl(source.mapImage, fallback.mapImage),
    left: sanitiseWinnerTeam(source.left, fallback.left),
    right: sanitiseWinnerTeam(source.right, fallback.right),
    // Always exactly WINNER_MAP_ROWS, for the same reason the rosters are always
    // five: the layout has fixed slots, and a short array should break the edit
    // rather than the render.
    maps: Array.from({ length: WINNER_MAP_ROWS }, (_, index) =>
      sanitiseMapRow(rows[index], fallback.maps[index] ?? { name: '', left: 0, right: 0 }),
    ),
    winner: ['auto', 'left', 'right'].includes(String(source.winner)) ? String(source.winner) : fallback.winner,
    seq: sanitiseSeq(source.seq, fallback.seq),
    style: sanitiseWinnerStyle(source.style, fallback.style),
    audio: sanitiseAudio(source.audio, fallback.audio),
  };

  for (const field of WINNER_TEXT_FIELDS) {
    clean[field.key] = text(source[field.key], fallback[field.key], field.max);
  }
  // A state written before the series count existed has no key here, so it takes
  // the default and starts counting. That is deliberate: a stored series score
  // the map rows contradict is a wrong number on air, and the rows are the
  // record of what actually happened.
  for (const field of WINNER_SCORE_FIELDS) {
    clean[field.key] = bool(source[field.key], fallback[field.key]);
  }
  return clean;
}

// ----------------------------------------------------------- agent select ---

function sanitiseSelectSlot(input, fallback = EMPTY_SLOT) {
  const source = input ?? {};
  const base = fallback ?? EMPTY_SLOT;
  return {
    playerId: text(source.playerId, base.playerId, 64),
    riotId: text(source.riotId, base.riotId, 64),
    name: text(source.name, base.name, 32),
    // Stored exactly as the game reports it. Anything that is not a plain
    // identifier could not have come from the feed, so it is not kept.
    character: /^[\w .'/-]{0,32}$/.test(String(source.character ?? '')) ? text(source.character, base.character, 32) : base.character,
    locked: bool(source.locked, base.locked),
    teammate: bool(source.teammate, base.teammate),
  };
}

function sanitiseSelectSide(input, fallback) {
  const source = input ?? {};
  const clean = { teamId: text(source.teamId, fallback.teamId ?? '', 48) };

  for (const field of SELECT_SIDE_FIELDS) {
    const value = source[field.key];
    const previous = fallback[field.key];
    switch (field.type) {
      case 'hex':
        // Blank means "wear the side's colour", so it survives - see teamColour.
        clean[field.key] =
          field.optional && typeof value === 'string' && !value.trim() ? '' : colour(value, previous);
        break;
      case 'image':
        clean[field.key] = imageUrl(value, previous);
        break;
      case 'choice':
        clean[field.key] = (field.options ?? []).some((entry) => entry.key === value)
          ? value
          : previous;
        break;
      default:
        clean[field.key] = text(value, previous, field.max);
    }
  }
  return clean;
}

export function sanitiseSelectStyle(input, fallback = DEFAULT_SELECT_STYLE) {
  const source = input ?? {};
  const base = fallback ?? DEFAULT_SELECT_STYLE;
  const clean = {};

  for (const field of SELECT_STYLE_FIELDS) {
    const value = source[field.key];
    const previous = base[field.key];

    switch (field.type) {
      case 'font':
        clean[field.key] = FONT_CHOICES.includes(String(value)) ? String(value) : previous;
        break;
      case 'choice': {
        const allowed = (field.options ?? []).map((option) => option.key);
        clean[field.key] = allowed.includes(String(value)) ? String(value) : previous;
        break;
      }
      case 'ratio':
        clean[field.key] = ratio(value, previous);
        break;
      case 'bool':
        clean[field.key] = bool(value, previous);
        break;
      default:
        clean[field.key] = int(value, previous, field.min, field.max);
    }
  }
  return clean;
}

export function sanitiseSelectAnim(input, fallback = DEFAULT_SELECT_ANIM) {
  const source = input ?? {};
  const base = fallback ?? DEFAULT_SELECT_ANIM;

  const clean = {
    visible: bool(source.visible, base.visible),
    cue: int(source.cue, base.cue, 0, Number.MAX_SAFE_INTEGER) % CUE_WRAP,
  };

  // Each choice field validates against its own list rather than a shared one,
  // so adding another cannot silently start accepting easing names.
  const CHOICES = { easing: SELECT_EASING_KEYS, entrance: SELECT_ENTRANCE_KEYS };

  for (const field of SELECT_ANIM_FIELDS) {
    const value = source[field.key];
    const previous = base[field.key];

    switch (field.type) {
      case 'choice': {
        const allowed = CHOICES[field.key] ?? [];
        clean[field.key] = allowed.includes(String(value)) ? String(value) : previous;
        break;
      }
      case 'bool':
        clean[field.key] = bool(value, previous);
        break;
      default:
        clean[field.key] = int(value, previous, field.min, field.max);
    }
  }
  return clean;
}

export function sanitiseSelectAuto(input, fallback = DEFAULT_SELECT_AUTO) {
  const source = input ?? {};
  const base = fallback ?? DEFAULT_SELECT_AUTO;
  return Object.fromEntries(SELECT_AUTO_FIELDS.map((field) => [field.key, bool(source[field.key], base[field.key])]));
}

export function sanitiseTimer(input, fallback = DEFAULT_TIMER) {
  const source = input ?? {};
  const base = fallback ?? DEFAULT_TIMER;
  return {
    running: bool(source.running, base.running),
    // A stamp rather than a countdown, so a source that joins late arrives at
    // the right place. Not clamped to "now" - a clock that was started before
    // this page loaded is the normal case, not a suspicious one.
    startedAt: int(source.startedAt, base.startedAt, 0, Number.MAX_SAFE_INTEGER),
    durationMs: int(source.durationMs, base.durationMs, 1000, 600_000),
    filled: bool(source.filled, base.filled),
    stoppedAt: int(source.stoppedAt, base.stoppedAt, 0, Number.MAX_SAFE_INTEGER),
  };
}

export function sanitiseSelect(input, base = DEFAULT_SELECT) {
  const source = input ?? {};
  const fallback = base ?? DEFAULT_SELECT;
  const slots = Array.isArray(source.slots) ? source.slots : [];

  return {
    version: 1,
    gameId: text(source.gameId, fallback.gameId, 64),
    scene: text(source.scene, fallback.scene, 64),
    colourSource: COLOUR_SOURCE_KEYS.includes(String(source.colourSource))
      ? String(source.colourSource)
      : fallback.colourSource,
    mapName: text(source.mapName, fallback.mapName, 40),
    mapImage: imageUrl(source.mapImage, fallback.mapImage),
    eventLogo: imageUrl(source.eventLogo, fallback.eventLogo),
    swap: bool(source.swap, fallback.swap),
    left: sanitiseSelectSide(source.left, fallback.left),
    right: sanitiseSelectSide(source.right, fallback.right),
    // Always exactly SELECT_SLOTS, for the same reason the rosters are always
    // five: the feed addresses these by index, so a short array would turn a
    // late-arriving event into a crash rather than into a card.
    slots: Array.from({ length: SELECT_SLOTS }, (_, index) =>
      sanitiseSelectSlot(slots[index], fallback.slots[index] ?? EMPTY_SLOT),
    ),
    timer: sanitiseTimer(source.timer, fallback.timer),
    auto: sanitiseSelectAuto(source.auto, fallback.auto),
    anim: sanitiseSelectAnim(source.anim, fallback.anim),
    style: sanitiseSelectStyle(source.style, fallback.style),
  };
}

export const makeSelectStore = (filePath) => makeStateStore(filePath, sanitiseSelect, DEFAULT_SELECT);

/**
 * The agent-select feed.
 *
 * One event per player, arriving as the lobby picks and locks. The envelope is
 * whatever the reporting client sends; the part worth having is `eventIndex`
 * (which of the ten seats) and `data` (who is in it and what they have picked).
 *
 * `data` arrives as a JSON *string* inside the JSON envelope, which is not a
 * mistake to be corrected on the way in - it is how the client sends it, so it
 * is parsed here and an object is accepted too for anyone hand-testing the hook.
 *
 * A changed `gameId` clears the board before applying the event. That is the
 * whole of "each square should be empty at the start": a new lobby is a new
 * game id, so nobody has to remember to press anything between matches, and a
 * stale roster cannot survive into the next map.
 *
 * Pure, so the whole of it can be tested without a server or a lobby.
 *
 * @param {object} state    the current select state
 * @param {unknown} payload one event, an array of them, or {events: [...]}
 * @param {(playerId: string) => string} aliasFor  the alias library's lookup
 * @returns {{state: object, applied: number, seen: {playerId: string, riotId: string}[], reset: boolean}}
 */
export function ingestRoster(state, payload, aliasFor = () => '') {
  const events = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.events)
      ? payload.events
      : [payload];

  let next = state;
  let applied = 0;
  let reset = false;
  const seen = [];

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;

    // An envelope that says what it is has to say the right thing. One that says
    // nothing is allowed through, because hand-testing the hook with just the
    // inner object is a reasonable thing to want to do.
    const kind = String(event.event ?? event.category ?? '').trim().toLowerCase();
    if (kind && kind !== 'roster' && kind !== 'match_info') continue;

    let data = event.data ?? event;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        continue;
      }
    }
    if (!data || typeof data !== 'object') continue;

    /*
     * Rejected rather than clamped, unlike every other number in this file.
     *
     * Clamping is right when a value is meant to be in range and merely arrived
     * silly - a score of 300 is a typo for something. An index off the board is
     * not that: it is a message this does not understand, and clamping it would
     * quietly write a stranger over whoever is in the last seat.
     */
    const index = int(event.eventIndex ?? data.eventIndex ?? data.index, -1, -1, Number.MAX_SAFE_INTEGER);
    if (!(index >= 0 && index < SELECT_SLOTS)) continue;

    const gameId = text(event.gameId ?? data.gameId, '', 64);
    if (gameId && gameId !== next.gameId) {
      next = { ...next, gameId, slots: emptySlots() };
      reset = true;
    }

    const playerId = text(data.player_id ?? data.playerId, '', 64);
    const riotId = text(data.name ?? data.riotId, '', 64);

    if (playerId && riotId) seen.push({ playerId, riotId });

    const slots = [...next.slots];
    slots[index] = sanitiseSelectSlot({
      playerId,
      riotId,
      name: displayName(riotId, aliasFor(playerId, riotId)),
      character: data.character ?? '',
      locked: data.locked,
      teammate: data.teammate,
    });

    next = { ...next, slots };
    applied += 1;
  }

  /*
   * Everybody in, so the clock is over.
   *
   * Filled rather than merely stopped: the bar closes the last of the gap and
   * stays shut, which is the picture of agent select finishing early. Stopping
   * it where it stood would read as the clock breaking.
   *
   * Read off the resulting state alone - not off `applied`, and not off whether
   * the clock happened to be running. Ten locked cards under an empty bar is the
   * failure this guards, and there are ordinary ways to reach it: the scene event
   * never arrived so the clock was never started, an operator ended it by hand,
   * or the last event was a resend that changed nothing. The lock-ins are the
   * real signal that agent select is over; the clock is only an estimate of it.
   *
   * `settleSelect` keeps this idempotent - once shut it stays shut, so a feed
   * repeating itself twenty times a second cannot restart the fill.
   */
  const settled = settleSelect(state, next);
  const finished = settled !== next;
  next = settled;

  return { state: next, applied, seen, reset, finished };
}

/** Start the clock from now. Exported so the dashboard's button and the scene
    feed's automation are provably the same move. */
export const startTimer = (state, at = Date.now(), durationMs = state?.timer?.durationMs ?? TIMER_DEFAULT_MS) => ({
  ...state,
  timer: { running: true, startedAt: at, durationMs, filled: false, stoppedAt: 0 },
});

/**
 * Stop the clock where it is, or at the end.
 *
 * `filled` is what makes an early finish read as a finish rather than as the
 * bar giving up: everybody locked in, so the bar closes the last of the gap and
 * stays there. Ending it by hand mid-lobby leaves it where it stood.
 */
export const stopTimer = (state, { filled = false, at = Date.now() } = {}) => ({
  ...state,
  timer: { ...state.timer, running: false, filled, stoppedAt: at },
});

/** Everything that says where the clock is, for telling an operator's move on it
    apart from a write that left it alone. */
const TIMER_KEYS = ['running', 'startedAt', 'durationMs', 'filled', 'stoppedAt'];
const sameTimer = (a, b) => TIMER_KEYS.every((key) => a?.[key] === b?.[key]);

/**
 * Shut the clock once agent select is over, however the last card got locked.
 *
 * This belongs to the state rather than to the feed. Locking the last player by
 * hand on the dashboard finishes the lobby exactly as surely as the game client
 * saying so, and a bar that only closes for one of the two is a bar that looks
 * broken whenever the feed is not the thing driving it.
 *
 * The exception is an operator who just touched the clock: starting a fresh
 * eighty-five seconds over a board that happens to be full should run, not shut
 * itself the instant it starts. So a write that moved the timer is taken at its
 * word, and only a write that left the timer alone is allowed to finish it.
 */
export function settleSelect(previous, next, at = Date.now()) {
  if (!everyoneLocked(next) || next?.timer?.filled) return next;
  if (previous && !sameTimer(previous.timer, next.timer)) return next;
  return stopTimer(next, { filled: true, at });
}

export const clearRosterState = (state) => ({ ...state, slots: emptySlots() });

// ------------------------------------------------------------ staged lobby ---

/**
 * The Overwolf lobby feed - who is in the game and on what, held rather than shown.
 *
 * Same wire shape as /api/roster and deliberately a different store. That hook
 * writes the agent-select graphic, so every event it accepts is on air a frame
 * later; this one fills a board the operator reads, checks and stages. Pointing
 * both at one store was the tempting simplification and it is wrong in the one
 * case this exists for: an observer client's `teammate` flag is arbitrary, so
 * the first thing an operator does is swap the sides - and a swap that repainted
 * agent select mid-lobby would be a graphic moving because somebody was tidying
 * up the thing that feeds a *different* graphic.
 *
 * Two event keys, because Overwolf reports the roster and the on-screen order
 * separately and neither is sufficient: `roster` says who picked what but is
 * indexed by the client's own bookkeeping, and `ui_team_order_*` says what is
 * where on screen but names only agents. lobbySides does the join.
 *
 * Pure, like ingestRoster and ingestGame, so the whole of it tests without a
 * server or a lobby.
 *
 * @param {object} state    the current lobby state
 * @param {unknown} payload one event, an array of them, or {events: [...]}
 * @returns {{state: object, applied: number, seen: {playerId: string, riotId: string}[]}}
 */
export function ingestLobby(state, payload) {
  const events = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.events)
      ? payload.events
      : [payload];

  let next = state;
  let applied = 0;
  const seen = [];

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;

    /*
     * Shots Fired splits its config key on "." into feature / event / category,
     * so `match_info.roster.match_info` arrives as event "roster". The bare
     * inner object is accepted too, for hand-testing the hook with curl.
     */
    const kind = String(event.event ?? event.key ?? '').trim().toLowerCase();

    let data = event.data ?? event;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        /*
         * Not JSON - which is the normal path for the order events, whose
         * payload uses unquoted keys. Handed on as the original string so
         * parseTeamOrder can do what JSON.parse could not; a roster event that
         * genuinely arrived malformed falls out at the object check below.
         */
        data = event.data;
      }
    }

    if (kind === 'ui_team_order_allies' || kind === 'ui_team_order_enemies') {
      const order = parseTeamOrder(data);
      if (!order.length) continue;
      const side = kind.endsWith('allies') ? 'allies' : 'enemies';
      next = { ...next, [side]: order, updatedAt: Date.now(), count: next.count + 1 };
      applied += 1;
      continue;
    }

    // Anything that names itself and is not one of ours. An envelope that says
    // nothing still gets a look, for the same reason ingestRoster allows it.
    if (kind && kind !== 'roster' && kind !== 'match_info') continue;
    if (!data || typeof data !== 'object') continue;

    /*
     * Rejected rather than clamped, for the reason ingestRoster spells out: an
     * index off the board is a message this does not understand, and clamping
     * it would quietly write a stranger over whoever is in the last seat.
     */
    const index = int(event.eventIndex ?? data.eventIndex ?? data.index, -1, -1, Number.MAX_SAFE_INTEGER);
    if (!(index >= 0 && index < LOBBY_SEATS)) continue;

    const riotId = text(data.name ?? data.riotId, '', 64);
    const playerId = text(data.player_id ?? data.playerId, '', 64);
    if (playerId && riotId) seen.push({ playerId, riotId });

    const seats = [...next.seats];
    seats[index] = sanitiseLobbySeat(
      {
        riotId,
        playerId,
        character: data.character ?? '',
        teammate: data.teammate,
        seen: true,
      },
      next.seats[index],
    );

    next = {
      ...next,
      // Recorded, not acted on - see emptyLobby. For VALORANT this is the
      // constant 21640, so it can never mean "a new lobby started".
      gameId: text(event.gameId ?? data.gameId, next.gameId, 64),
      seats,
      updatedAt: Date.now(),
      count: next.count + 1,
    };
    applied += 1;
  }

  return { state: next, applied, seen };
}

/** Back to an empty board. The operator's button, because the feed has no
    signal that means "new lobby" - see emptyLobby. */
export const clearLobbyState = (state) => ({ ...emptyLobby(), count: state?.count ?? 0 });

/**
 * The general game feed - scenes and match facts.
 *
 * Separate from the roster hook because it is a different shape and a different
 * job: that one addresses a seat and says who is in it, this one says what the
 * game as a whole is doing. Keeping them apart means whatever is configured to
 * post them can be pointed at two URLs rather than one that has to guess.
 *
 * What it actually buys is timing. A roster event only arrives once somebody
 * picks, so without this the first sign of a new lobby is a game id changing
 * one event too late to have cleared the board tidily. A scene event says the
 * lobby exists before anybody has done anything in it.
 *
 * Pure, like ingestRoster, so all of the automation can be tested without a
 * server or a game.
 *
 * @param {object} state
 * @param {unknown} payload
 * @param {{now?: number, catalogue?: object}} options the catalogue is what
 *   turns a reported map code into the name an audience knows
 * @returns {{state: object, applied: number, entered: boolean, left: boolean}}
 */
export function ingestGame(state, payload, { now = Date.now(), catalogue = null } = {}) {
  const events = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.events)
      ? payload.events
      : [payload];

  let next = state;
  let applied = 0;
  let entered = false;
  let left = false;

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;

    const kind = String(event.event ?? '').trim().toLowerCase();
    // `data` is a bare string on these rather than a JSON envelope, which is
    // why this cannot simply reuse the roster parser.
    const value = typeof event.data === 'string' ? event.data.trim() : '';
    const gameId = text(event.gameId, '', 64);

    if (kind === 'scene') {
      if (!value) continue;

      const wasSelect = isAgentSelectScene(next.scene);
      const isSelect = isAgentSelectScene(value);
      next = { ...next, scene: text(value, '', 64) };

      // A new lobby, arriving as a scene rather than as a late roster event.
      // The game id moves with it so the first roster event is treated as a
      // continuation rather than as another reset.
      if (isSelect && (!wasSelect || (gameId && gameId !== next.gameId))) {
        entered = true;
        if (gameId) next = { ...next, gameId };
        if (next.auto.autoClear) next = clearRosterState(next);
        if (next.auto.autoTimer) next = startTimer(next, now);
        if (next.auto.autoShow) next = { ...next, anim: { ...next.anim, visible: true, cue: next.anim.cue + 1 } };
      }

      if (!isSelect && wasSelect) {
        left = true;
        // The clock is stopped but not filled: leaving agent select early is
        // not the lobby finishing, and a bar snapping full on the way out would
        // say it was.
        next = stopTimer(next);
        if (next.auto.autoHide) next = { ...next, anim: { ...next.anim, visible: false, cue: next.anim.cue + 1 } };
      }

      applied += 1;
      continue;
    }

    if (kind === 'map') {
      if (!value) continue;
      /*
       * Resolved here rather than at render, unlike the agent names.
       *
       * The map is the one field both the feed and an operator write - it is in
       * a dropdown on the dashboard and it is what the winner graphic looks its
       * splash up by - so storing the code name would mean every one of those
       * places had to know how to undo it. Resolving on the way in leaves a
       * single spelling in the state, and an unresolved one is still visible in
       * the dropdown and fixable in a click.
       */
      next = { ...next, mapName: text(mapDisplayName(catalogue, value), next.mapName, 40) };
      applied += 1;
      continue;
    }

    // Anything else is a fact this graphic has no use for. Counted as handled
    // rather than refused, so a client posting its whole feed here does not get
    // an error back for every event that is simply not ours.
  }

  return { state: next, applied, entered, left };
}

/**
 * What a match id is allowed to look like.
 *
 * Deliberately a charset rather than a UUID pattern. Every id this has been
 * shown is a UUID, but the one thing worse than accepting a shape nobody uses
 * is refusing the shape that turns up next season - and everything this guards
 * against (a whole JSON blob pasted into the box, a newline smuggled into a log
 * line, a path segment) is already gone once the charset is closed.
 */
const MATCH_ID = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * The match-id feed: one id, however the client chose to wrap it.
 *
 * The loosest of the three hooks on purpose. The other two carry structure that
 * has to survive - a seat index, a scene name - so their envelopes mean
 * something. This one carries a single string, so anything an id can be dug out
 * of is accepted: the bare string, a JSON string, `{matchId}`, `{id}`, `{data:
 * ...}` nested to any of those, an array, or `{events: [...]}` - the same three
 * envelope shapes the roster hook takes, because whatever is watching the game
 * client will already be posting one of them.
 *
 * Returns '' rather than throwing. A feed that fires on every match end will
 * eventually fire on something that has no id yet, and answering that with a
 * 400 puts a red line in somebody's client log for an event that was never
 * going to be useful. The route decides what to do about an empty answer.
 *
 * @param {unknown} payload
 * @param {number} depth  guards against a self-referential envelope
 * @returns {string} the id, or '' if there is not exactly one usable id in there
 */
export function matchIdFrom(payload, depth = 0) {
  if (depth > 6) return '';

  if (typeof payload === 'string' || typeof payload === 'number') {
    const value = String(payload).trim();
    if (MATCH_ID.test(value)) return value;

    /*
     * A string that is not an id may still contain one.
     *
     * The roster hook already receives `data` as a JSON string inside the JSON
     * envelope - that is how the game client sends it, not a mistake to be
     * corrected - so a client reusing its existing shape for this hook will do
     * the same thing here. Parsed rather than refused, for the same reason.
     */
    if (/^[[{"]/.test(value)) {
      try {
        return matchIdFrom(JSON.parse(value), depth + 1);
      } catch {
        return '';
      }
    }
    return '';
  }

  if (Array.isArray(payload)) {
    // First usable one wins. A client that batches two matches into one post is
    // reporting them in order, and the earlier is the one already finished.
    for (const entry of payload) {
      const found = matchIdFrom(entry, depth + 1);
      if (found) return found;
    }
    return '';
  }

  if (!payload || typeof payload !== 'object') return '';

  for (const key of ['matchId', 'matchID', 'match_id', 'id', 'gameId', 'data', 'events', 'match']) {
    if (!(key in payload)) continue;
    const found = matchIdFrom(payload[key], depth + 1);
    if (found) return found;
  }

  return '';
}

/**
 * Player aliases.
 *
 * The feed reports Riot IDs, which are not what anybody is called on a broadcast
 * - a player known to the audience as "Dragon" turns up as "Kuyareymark #6767".
 * This is where the mapping between the two lives.
 *
 * Keyed on the player id rather than the Riot ID, because that is the half of
 * the pair that does not change: somebody who renames themselves mid-season
 * keeps their alias without anybody noticing.
 *
 * Every player the feed reports is recorded whether or not they have an alias,
 * which is the point - an operator cannot write an alias for somebody they have
 * no record of ever having seen. The list is capped and the least recently seen
 * fall off, so a season of pick-up games does not grow it without limit.
 */
const ALIAS_LIMIT = 500;

export function makeAliasStore(filePath) {
  /** @type {{id: string, riotId: string, alias: string, seenAt: number}[]} */
  let players = [];
  let writeChain = Promise.resolve();

  function persist() {
    const snapshot = JSON.stringify(players, null, 2);
    writeChain = writeChain
      .then(() => mkdir(path.dirname(filePath), { recursive: true }))
      .then(() => writeFile(filePath, snapshot, 'utf8'))
      .catch((error) => console.warn(`  aliases not saved: ${error.message}`));
    return writeChain;
  }

  const clean = (entry) => ({
    id: text(entry?.id, '', 64),
    riotId: text(entry?.riotId, '', 64),
    alias: text(entry?.alias, '', 32),
    seenAt: int(entry?.seenAt, 0, 0, Number.MAX_SAFE_INTEGER),
    // Account ids this record has been told it is NOT. Only ever grows by an
    // operator answering the question, and it is what stops the same weak name
    // match being offered every time that player loads in.
    rejected: (Array.isArray(entry?.rejected) ? entry.rejected : [])
      .map((value) => text(value, '', 64))
      .filter(Boolean)
      .slice(0, 20),
  });

  /** Aliased first, then most recently seen - the two ways an operator looks. */
  const sorted = () =>
    [...players].sort(
      (a, b) => Number(Boolean(b.alias)) - Number(Boolean(a.alias)) || b.seenAt - a.seenAt || a.riotId.localeCompare(b.riotId),
    );

  function trim() {
    if (players.length <= ALIAS_LIMIT) return;
    // Aliased entries are somebody's work and are never the ones dropped.
    const keep = players.filter((entry) => entry.alias);
    const rest = players.filter((entry) => !entry.alias).sort((a, b) => b.seenAt - a.seenAt);
    players = [...keep, ...rest.slice(0, Math.max(0, ALIAS_LIMIT - keep.length))];
  }

  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (!Array.isArray(parsed)) return false;
        // A record needs one key or the other: an account id from the feed, or a
        // Riot ID it was written down under before the event.
        players = parsed.map(clean).filter((entry) => entry.id || entry.riotId);
        return true;
      } catch {
        return false;
      }
    },

    list() {
      return sorted().map((entry) => ({ ...entry, key: aliasKey(entry) }));
    },

    /**
     * '' when there is no alias, which `displayName` reads as "use the Riot ID".
     *
     * Takes the Riot ID as well so an alias typed in before the event - which
     * has no account id to match on yet - still reaches the card.
     */
    aliasFor(playerId, riotId = '') {
      return aliasForPlayer(players, { playerId, riotId });
    },

    /**
     * Record that these players exist, without touching anybody's alias. Called
     * on every ingest, so it must be cheap and must never overwrite operator
     * work - only the Riot ID and the timestamp move.
     */
    seen(entries, at = Date.now()) {
      let changed = false;

      for (const entry of entries ?? []) {
        const id = text(entry?.playerId ?? entry?.id, '', 64);
        if (!id) continue;
        const riotId = text(entry?.riotId, '', 64);
        const existing = players.find((player) => player.id === id);

        if (existing) {
          if (existing.riotId === riotId && at - existing.seenAt < 1000) continue;
          if (riotId) existing.riotId = riotId;
          existing.seenAt = at;
        } else {
          players.push({ id, riotId, alias: '', seenAt: at, rejected: [] });
        }
        changed = true;
      }

      if (changed) {
        trim();
        persist();
      }
      return changed;
    },

    /**
     * Set or clear one alias, on a player the feed has seen or on one it has not.
     *
     * With an account id this is the ordinary case: name somebody in the lobby.
     * With only a Riot ID it is the preparation case - writing the roster down
     * the day before, when nothing has reported an account id yet. Those records
     * match on the Riot ID until the feed turns up somebody who looks like them,
     * at which point `link` can make the match exact.
     */
    save({ id, alias = '', riotId = '' }) {
      const key = text(id, '', 64);
      const name = text(riotId, '', 64);
      if (!key && !riotIdKey(name)) {
        throw new Error('A player alias needs either a player id or a Riot ID.');
      }

      const existing = key
        ? players.find((entry) => entry.id === key)
        : players.find((entry) => !entry.id && riotIdKey(entry.riotId) === riotIdKey(name));

      if (existing) {
        existing.alias = text(alias, '', 32);
        if (name) existing.riotId = name;
      } else {
        players.push({ id: key, riotId: name, alias: text(alias, '', 32), seenAt: Date.now(), rejected: [] });
      }

      trim();
      persist();
      return this.list();
    },

    remove(key) {
      const wanted = text(key, '', 64);
      const before = players.length;
      players = players.filter((entry) => aliasKey(entry) !== wanted);
      if (players.length !== before) persist();
      return this.list();
    },

    /**
     * Say that a hand-written alias and an account the feed has seen are the
     * same person.
     *
     * The alias moves onto the account record rather than the other way round,
     * because the account id is the key that cannot go stale - the operator's
     * work survives the player renaming themselves afterwards. The hand-written
     * record is then gone: leaving it would match the same person twice.
     */
    link(key, playerId) {
      const wanted = text(key, '', 64);
      const account = text(playerId, '', 64);
      const manual = players.find((entry) => aliasKey(entry) === wanted && !entry.id);
      if (!manual || !account) throw new Error('Nothing to link.');

      const target = players.find((entry) => entry.id === account);
      if (target) {
        target.alias = manual.alias;
        if (!target.riotId) target.riotId = manual.riotId;
      } else {
        players.push({ id: account, riotId: manual.riotId, alias: manual.alias, seenAt: Date.now(), rejected: [] });
      }
      players = players.filter((entry) => entry !== manual);

      trim();
      persist();
      return this.list();
    },

    /** Say that they are different people, and stop being asked. */
    reject(key, playerId) {
      const wanted = text(key, '', 64);
      const account = text(playerId, '', 64);
      const manual = players.find((entry) => aliasKey(entry) === wanted && !entry.id);
      if (!manual || !account) throw new Error('Nothing to separate.');

      if (!manual.rejected.includes(account)) manual.rejected.push(account);
      persist();
      return this.list();
    },

    /** Hand-written aliases that now look like somebody the feed has reported. */
    pending() {
      return pendingLinks(players).map(({ manual, candidate }) => ({
        key: aliasKey(manual),
        alias: manual.alias,
        riotId: manual.riotId,
        playerId: candidate.id,
        candidateRiotId: candidate.riotId,
        candidateAlias: candidate.alias,
        seenAt: candidate.seenAt,
      }));
    },

    /**
     * Fold a library file into this one. Adds and updates; never deletes.
     *
     * Upsert rather than a whole-array swap, and that is the whole safety
     * property. A swap would mean importing a colleague's 12-player file into a
     * 300-player library deleted 288 people - and then `reresolve()` would
     * rewrite both scoreboard sides and every select slot from the survivors,
     * so every deleted name would revert to a raw Riot ID in one frame, on air.
     * The confirmation says "nothing deleted"; this is what makes that true
     * rather than a promise the caller has to keep.
     *
     * On an existing record only the alias and the Riot ID move. `seenAt` and
     * `rejected` stay with the account that earned them: `rejected` is the list
     * of "this is NOT that player" answers somebody gave at this desk, and
     * clearing it would let the by-name branch of aliasForPlayer put a name back
     * on the wrong person the next time they load in.
     *
     * @param {{id?: string, riotId?: string, alias?: string}[]} incoming
     */
    import(incoming) {
      const rows = (Array.isArray(incoming) ? incoming : []).map(clean).filter((entry) => entry.alias && aliasKey(entry));

      let added = 0;
      let updated = 0;

      /*
       * Merged into a draft, and swapped in only once the cap below has passed.
       *
       * The cap is still tested after the merge - that part is deliberate and is
       * unchanged. What was wrong is that it threw having ALREADY rewritten the
       * live array. This function does not persist on the throw path, but the
       * next roster webhook calls seen(), which does - so a rejected import
       * showed the operator a 400 that read like their own mistake and then
       * wrote the over-cap library to disk a minute later anyway, with nothing
       * connecting the two. Folding several operators' files into one library is
       * precisely the case that exceeds the cap, so this is the normal path and
       * not an edge.
       *
       * Entries are shallow-copied because the merge below writes through to
       * them. That copy is what makes the rollback free, and it carries `seenAt`
       * and `rejected` across untouched - which the docblock above promises.
       */
      const draft = players.map((entry) => ({ ...entry }));

      for (const row of rows) {
        const wanted = aliasKey(row);
        const existing = draft.find((entry) => aliasKey(entry) === wanted);

        if (!existing) {
          // seenAt 0 reads as "never seen at this desk", which is true, and
          // sorts it below anybody this operator has actually had in a lobby.
          draft.push({ ...row, seenAt: 0 });
          added += 1;
          continue;
        }

        if (existing.alias !== row.alias || (row.riotId && existing.riotId !== row.riotId)) updated += 1;
        existing.alias = row.alias;
        if (row.riotId) existing.riotId = row.riotId;
      }

      // Checked after the merge rather than before: the cap is about what the
      // library ends up holding, and an import that mostly updates adds nothing.
      const named = draft.filter((entry) => entry.alias).length;
      if (named > ALIAS_LIMIT) {
        throw new Error(`That would take the player library to ${named} names, over the ${ALIAS_LIMIT} limit.`);
      }

      players = draft;
      if (added || updated) persist();
      return { added, updated, players: this.list() };
    },

    /** Drop everyone nobody has bothered to name. */
    clearUnnamed() {
      const before = players.length;
      players = players.filter((entry) => entry.alias);
      if (players.length !== before) persist();
      return this.list();
    },

    /**
     * Let the process exit without truncating an in-flight save.
     *
     * This store had no flush and was therefore the one thing shutdown did not
     * wait for. Every other store persists the same way - fire and forget onto
     * a write chain - and the six in flushSession are awaited before the
     * process goes. Aliases were not, so a name typed a moment before a restart,
     * or a batch of players just recorded from a roster webhook, could be lost
     * with the write half done.
     */
    flush() {
      return writeChain;
    },
  };
}

// ------------------------------------------------------------ the store ---

/**
 * A piece of live state: sanitised, mirrored to disk, and pushed to every
 * subscriber. The scoreboard and the winner graphic are both one of these -
 * they differ only in shape, and the shape is the sanitiser's business.
 *
 * @param {string} filePath where to mirror state between restarts
 * @param {(input: object, base: object) => object} sanitise
 * @param {object} defaults what `reset` returns to, and the base every merge starts from
 */
export function makeStateStore(filePath, sanitise, defaults) {
  let state = clone(defaults);
  let revision = 0;
  let writeChain = Promise.resolve();

  /** @type {Set<(event: {revision: number, state: object}) => void>} */
  const listeners = new Set();

  async function load() {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      // Sanitised on the way in as well: the file is editable by hand, and a
      // half-edited one should degrade to defaults rather than break the render.
      state = sanitise(parsed, defaults);
      return true;
    } catch {
      return false;
    }
  }

  function persist() {
    const snapshot = JSON.stringify(state, null, 2);
    // Serialised: concurrent dashboard edits must not interleave partial writes.
    writeChain = writeChain
      .then(() => mkdir(path.dirname(filePath), { recursive: true }))
      .then(() => writeFile(filePath, snapshot, 'utf8'))
      .catch((error) => console.warn(`  graphic state not saved: ${error.message}`));
    return writeChain;
  }

  return {
    get state() {
      return state;
    },
    get revision() {
      return revision;
    },
    load,

    /** Replace the whole graphic. Returns the sanitised result. */
    replace(input) {
      state = sanitise(input, defaults);
      revision += 1;
      persist();
      for (const listener of listeners) listener({ revision, state });
      return state;
    },

    /** Shallow-merge a partial update onto the current state. */
    patch(input) {
      return this.replace({ ...state, ...(input ?? {}) });
    },

    reset() {
      return this.replace(defaults);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    get subscriberCount() {
      return listeners.size;
    },

    /** Let the process exit without truncating an in-flight save. */
    flush() {
      return writeChain;
    },
  };
}

/**
 * The settings that belong to the production rather than to one graphic.
 *
 * Sanitised with the same rules as everything else - the map name is text an
 * operator can type, the logo is a URL, and the colour source is a closed set.
 */
export function sanitiseGlobal(input, base = DEFAULT_GLOBAL) {
  const source = input ?? {};
  const fallback = base ?? DEFAULT_GLOBAL;
  return {
    version: 1,
    mapName: text(source.mapName, fallback.mapName, 40),
    mapImage: imageUrl(source.mapImage, fallback.mapImage),
    eventLogo: imageUrl(source.eventLogo, fallback.eventLogo),
    colourSource: COLOUR_SOURCE_KEYS.includes(String(source.colourSource))
      ? String(source.colourSource)
      : fallback.colourSource,
    ...Object.fromEntries(SYNC_FIELDS.map((field) => [field.key, bool(source[field.key], fallback[field.key])])),
  };
}

export const makeGlobalStore = (filePath) => makeStateStore(filePath, sanitiseGlobal, DEFAULT_GLOBAL);

/**
 * The administrator switches. Server-wide, so this one lives beside the media
 * store rather than inside a session bundle - see public/settings-schema.js.
 */
export const makeSettingsStore = (filePath) => makeStateStore(filePath, sanitiseSettings, DEFAULT_SETTINGS);

export { graphicPatch };

export const makeGraphicStore = (filePath) => makeStateStore(filePath, sanitiseState, DEFAULT_STATE);
export const makeWinnerStore = (filePath) => makeStateStore(filePath, sanitiseWinner, DEFAULT_WINNER);

// -------------------------------------------------------------- presets ---

/** `My Look #2` -> `my-look-2`, so ids stay readable in the saved file. */
const slug = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'preset';

/**
 * Saved looks: the built-ins from preset-schema.js plus whatever the operator
 * has saved, mirrored to disk.
 *
 * Built-ins are never written to the file and cannot be deleted or overwritten,
 * so there is always a known-good look to fall back to mid-broadcast. Saving
 * over one produces a copy instead of an error - a refusal in the middle of a
 * show is not helpful.
 *
 * @param {string} filePath where to mirror the operator's own presets
 */
export function makePresetStore(filePath) {
  /** @type {{id: string, name: string, preset: object}[]} */
  let custom = [];
  let writeChain = Promise.resolve();

  const builtIns = () => BUILT_IN_PRESETS.map((entry) => ({ ...entry, preset: clone(entry.preset), builtIn: true }));

  function persist() {
    const snapshot = JSON.stringify(custom, null, 2);
    writeChain = writeChain
      .then(() => mkdir(path.dirname(filePath), { recursive: true }))
      .then(() => writeFile(filePath, snapshot, 'utf8'))
      .catch((error) => console.warn(`  presets not saved: ${error.message}`));
    return writeChain;
  }

  function uniqueId(name, ignoreId = null) {
    const base = slug(name);
    let candidate = base;
    let counter = 2;
    const taken = (id) => BUILT_IN_IDS.has(id) || custom.some((entry) => entry.id === id && entry.id !== ignoreId);
    while (taken(candidate)) candidate = `${base}-${counter++}`;
    return candidate;
  }

  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (!Array.isArray(parsed)) return false;
        // Sanitised on the way in: the file is hand-editable, and a broken
        // entry should degrade to defaults rather than break the Style panel.
        custom = parsed
          .filter((entry) => entry && typeof entry.id === 'string' && !BUILT_IN_IDS.has(entry.id))
          .map((entry) => ({
            id: slug(entry.id),
            name: text(entry.name, entry.id, 40) || entry.id,
            preset: sanitisePreset(entry.preset),
          }));
        return true;
      } catch {
        return false;
      }
    },

    /** Built-ins first, then the operator's own. */
    list() {
      return [...builtIns(), ...custom.map((entry) => ({ ...entry, preset: clone(entry.preset), builtIn: false }))];
    },

    get(id) {
      return this.list().find((entry) => entry.id === id) ?? null;
    },

    /**
     * Create or update. Passing the id of a built-in saves a copy instead,
     * which is what "Save as" on a shipped look should do anyway.
     */
    save({ id = null, name, preset }) {
      const cleanName = text(name, '', 40) || 'Untitled preset';
      const clean = sanitisePreset(preset);
      const existing = id && !BUILT_IN_IDS.has(id) ? custom.find((entry) => entry.id === id) : null;

      if (existing) {
        existing.name = cleanName;
        existing.preset = clean;
        persist();
        return { ...existing, preset: clone(clean), builtIn: false };
      }

      const entry = { id: uniqueId(cleanName), name: cleanName, preset: clean };
      custom.push(entry);
      persist();
      return { ...entry, preset: clone(clean), builtIn: false };
    },

    remove(id) {
      if (BUILT_IN_IDS.has(id)) return false;
      const before = custom.length;
      custom = custom.filter((entry) => entry.id !== id);
      if (custom.length === before) return false;
      persist();
      return true;
    },

    flush() {
      return writeChain;
    },
  };
}

// ---------------------------------------------------------------- teams ---

/**
 * The operator's own team library, mirrored to disk.
 *
 * Unlike presets there are no built-ins: nobody's roster of orgs is guessable,
 * and a shipped list of teams would be wrong for every event that is not the one
 * it was written for.
 *
 * @param {string} filePath where to mirror the library
 */
export function makeTeamStore(filePath) {
  /** @type {{id: string, name: string}[]} */
  let teams = [];
  let writeChain = Promise.resolve();

  function persist() {
    const snapshot = JSON.stringify(teams, null, 2);
    writeChain = writeChain
      .then(() => mkdir(path.dirname(filePath), { recursive: true }))
      .then(() => writeFile(filePath, snapshot, 'utf8'))
      .catch((error) => console.warn(`  teams not saved: ${error.message}`));
    return writeChain;
  }

  function uniqueId(name, ignoreId = null) {
    const base = teamSlug(name);
    let candidate = base;
    let counter = 2;
    while (teams.some((entry) => entry.id === candidate && entry.id !== ignoreId)) candidate = `${base}-${counter++}`;
    return candidate;
  }

  const sortByName = (list) => [...list].sort((a, b) => a.name.localeCompare(b.name));

  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (!Array.isArray(parsed)) return false;
        teams = parsed
          .filter((entry) => entry && typeof entry.id === 'string')
          .map((entry) => ({ id: teamSlug(entry.id), ...sanitiseTeamFields(entry) }))
          // A team with no name cannot be picked out of a list, so it is not a
          // team - dropping it beats leaving a blank row in every dropdown.
          .filter((entry) => entry.name);
        return true;
      } catch {
        return false;
      }
    },

    list() {
      return sortByName(teams).map((entry) => ({ ...entry }));
    },

    get(id) {
      return teams.find((entry) => entry.id === id) ?? null;
    },

    /** Create or update. An unknown id creates rather than failing. */
    save({ id = null, ...fields }) {
      const existing = id ? teams.find((entry) => entry.id === id) : null;
      const clean = sanitiseTeamFields(fields, existing ?? EMPTY_TEAM);
      if (!clean.name) throw new Error('A team needs a name.');

      if (existing) {
        Object.assign(existing, clean);
        persist();
        return { ...existing };
      }

      const entry = { id: uniqueId(clean.name), ...clean };
      teams.push(entry);
      persist();
      return { ...entry };
    },

    remove(id) {
      const before = teams.length;
      teams = teams.filter((entry) => entry.id !== id);
      if (teams.length === before) return false;
      persist();
      return true;
    },

    /**
     * Fold a library file into this one. Adds and updates; never deletes.
     *
     * Upsert, not a swap, for the same reason the alias store is: importing a
     * colleague's 12-team file must not delete the 30 orgs it does not mention.
     * The dashboard says "nothing deleted" and this is what makes that true.
     *
     * Keyed on the slug rather than on the supplied id, because the id an
     * export carries came from `uniqueId` at the other desk and may be
     * `sentinels-2` there and free here. Matching on what the name slugs to is
     * what makes a re-import of the same file a no-op rather than a second copy.
     *
     * Every id written is forced to be a fixed point of `teamSlug`: `uniqueId`
     * can emit a 42-character id from a 40-character base, and `load()` re-slugs
     * to 40 with no uniqueness pass, so the pair would collide one restart later
     * and `get()` would silently return whichever came first.
     *
     * @param {{id?: string, name?: string}[]} incoming
     */
    import(incoming) {
      const rows = Array.isArray(incoming) ? incoming : [];

      let added = 0;
      let updated = 0;

      for (const row of rows) {
        const clean = sanitiseTeamFields(row, EMPTY_TEAM);
        // A team with no name cannot be picked out of a list, which is the same
        // rule load() applies to the file on disk.
        if (!clean.name) continue;

        const wanted = teamSlug(clean.name);
        const existing = teams.find((entry) => entry.id === wanted || teamSlug(entry.name) === wanted);

        if (existing) {
          const changed = TEAM_FIELDS.some((field) => existing[field.key] !== clean[field.key]);
          if (changed) {
            Object.assign(existing, clean);
            updated += 1;
          }
          continue;
        }

        teams.push({ id: teamSlug(uniqueId(clean.name)), ...clean });
        added += 1;
      }

      if (added || updated) persist();
      return { added, updated, teams: this.list() };
    },

    flush() {
      return writeChain;
    },
  };
}

// ---------------------------------------------------------------- media ---

/**
 * Uploaded logos and music, kept on disk beside the rest of the state.
 *
 * Files are named after a hash of their own bytes, which is doing three jobs:
 * the same file uploaded twice costs one copy, the name can never contain a
 * path an operator typed, and a name is stable enough to sit in a saved graphic
 * without a re-upload invalidating it.
 *
 * The declared Content-Type is ignored entirely - the format is read out of the
 * first few bytes, so a file that merely claims to be a PNG is rejected rather
 * than written and served back as one.
 */

/** Images are logos; audio is a whole music bed, so it gets its own ceiling. */
export const MEDIA_LIMITS = { image: 12 * 1024 * 1024, audio: 32 * 1024 * 1024 };

const ascii = (buffer, from, to) => buffer.toString('latin1', from, to);

const MEDIA_SIGNATURES = [
  { kind: 'image', ext: 'png', mime: 'image/png', test: (b) => b.length > 8 && ascii(b, 0, 8) === '\x89PNG\r\n\x1a\n' },
  {
    kind: 'image',
    ext: 'jpg',
    mime: 'image/jpeg',
    test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  { kind: 'image', ext: 'gif', mime: 'image/gif', test: (b) => b.length > 6 && ascii(b, 0, 4) === 'GIF8' },
  {
    kind: 'image',
    ext: 'webp',
    mime: 'image/webp',
    test: (b) => b.length > 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
  },
  {
    // Org logos are very often SVG, so refusing them would send operators off to
    // convert files mid-setup. It is served with a locked-down CSP and nosniff
    // (see server.js), which is what keeps script inside one inert.
    kind: 'image',
    ext: 'svg',
    mime: 'image/svg+xml',
    test: (b) => /^\s*(?:<\?xml|<!--|<!doctype svg|<svg)/i.test(b.toString('utf8', 0, 256)),
  },

  {
    // Either an ID3 tag or a bare MPEG frame header - plenty of exported stings
    // have no tag at all.
    kind: 'audio',
    ext: 'mp3',
    mime: 'audio/mpeg',
    test: (b) => b.length > 3 && (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)),
  },
  { kind: 'audio', ext: 'ogg', mime: 'audio/ogg', test: (b) => b.length > 4 && ascii(b, 0, 4) === 'OggS' },
  {
    kind: 'audio',
    ext: 'wav',
    mime: 'audio/wav',
    test: (b) => b.length > 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE',
  },
  {
    kind: 'audio',
    ext: 'm4a',
    mime: 'audio/mp4',
    test: (b) => b.length > 12 && ascii(b, 4, 8) === 'ftyp',
  },
  {
    kind: 'audio',
    ext: 'webm',
    mime: 'audio/webm',
    test: (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
  },
];

/** @returns {{kind: string, ext: string, mime: string}|null} null for anything unrecognised */
export function sniffMedia(buffer) {
  return MEDIA_SIGNATURES.find((entry) => entry.test(buffer)) ?? null;
}

export const MEDIA_MIME_TYPES = Object.fromEntries(MEDIA_SIGNATURES.map((entry) => [entry.ext, entry.mime]));

const MEDIA_EXTENSIONS = [...new Set(MEDIA_SIGNATURES.map((entry) => entry.ext))];

/** Hash-shaped names only. Anything else never reaches the filesystem. */
const MEDIA_NAME = new RegExp(`^[0-9a-f]{16}\\.(${MEDIA_EXTENSIONS.join('|')})$`);

/** The largest thing that could ever be accepted, for the request body cap. */
export const MEDIA_MAX_BYTES = Math.max(...Object.values(MEDIA_LIMITS));

/**
 * @param {string} dir where uploads live
 */
export function makeMediaStore(dir) {
  return {
    /**
     * @param {Buffer} buffer the raw upload
     * @returns {Promise<{name: string, url: string, bytes: number, mime: string, kind: string}>}
     */
    async save(buffer) {
      if (!buffer?.length) throw new Error('That upload was empty.');

      const kind = sniffMedia(buffer);
      if (!kind) {
        throw new Error('That file is not an image (PNG, JPEG, GIF, WebP, SVG) or audio (MP3, OGG, WAV, M4A, WebM).');
      }

      // Checked after sniffing so the message can name the right limit - "4 MB"
      // is unhelpful advice for somebody uploading a two-minute sting.
      const limit = MEDIA_LIMITS[kind.kind];
      if (buffer.length > limit) {
        throw new Error(`${kind.kind === 'audio' ? 'Audio' : 'Images'} are capped at ${Math.round(limit / 1024 / 1024)} MB.`);
      }

      const name = `${createHash('sha256').update(buffer).digest('hex').slice(0, 16)}.${kind.ext}`;
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, name), buffer);
      return { name, url: `/media/${name}`, bytes: buffer.length, mime: kind.mime, kind: kind.kind };
    },

    async list() {
      try {
        const names = (await readdir(dir)).filter((name) => MEDIA_NAME.test(name));
        return names.sort().map((name) => ({ name, url: `/media/${name}` }));
      } catch {
        return [];
      }
    },

    /**
     * Deliberately no delete. A file here is named after its own hash, so
     * leaving one costs a few kilobytes - whereas removing one that a saved
     * graphic still points at breaks that graphic silently, and finding out
     * mid-show is not a trade worth making. Clearing them out is `rm` on
     * .state/media between events.
     */

    /**
     * The absolute path to serve, or null. The name pattern is the whole guard -
     * no separators, no dots, no encoded traversal can match it.
     */
    resolve(name) {
      return MEDIA_NAME.test(String(name)) ? path.join(dir, name) : null;
    },
  };
}

// --------------------------------------------------------------- assets ---

/**
 * Agent portraits, role icons and map splashes come from valorant-api.com,
 * which is public, key-free and CORS-open. It is proxied rather than called
 * from the page so one cached copy serves the dashboard, the preview and every
 * output source, and so a broadcast survives the site being unreachable.
 */

const ASSET_TTL_MS = 24 * 60 * 60 * 1000;
const AGENTS_URL = 'https://valorant-api.com/v1/agents?isPlayableCharacter=true';
const MAPS_URL = 'https://valorant-api.com/v1/maps';

export function makeAssetCache(cachePath) {
  let cached = null;
  let fetchedAt = 0;
  let inFlight = null;

  const shrinkAgent = (agent) => ({
    uuid: agent.uuid,
    name: agent.displayName,
    // The name the game uses internally, which is what the agent-select feed
    // reports - "Sarge" for Brimstone. Kept because it is the only reliable way
    // to turn that feed into something an audience recognises.
    developerName: agent.developerName ?? null,
    icon: agent.displayIcon,
    portrait: agent.fullPortraitV2 ?? agent.fullPortrait ?? null,
    rightFacing: Boolean(agent.isFullPortraitRightFacing),
    role: agent.role ? { name: agent.role.displayName, icon: agent.role.displayIcon } : null,
    gradient: Array.isArray(agent.backgroundGradientColors) ? agent.backgroundGradientColors : [],
  });

  const shrinkMap = (map) => ({
    uuid: map.uuid,
    name: map.displayName,
    splash: map.splash,
    icon: map.listViewIcon,
  });

  async function download() {
    const [agents, maps] = await Promise.all([
      fetch(AGENTS_URL).then((r) => r.json()),
      fetch(MAPS_URL).then((r) => r.json()),
    ]);

    const payload = {
      fetchedAt: Date.now(),
      agents: (agents?.data ?? []).map(shrinkAgent).sort((a, b) => a.name.localeCompare(b.name)),
      // The map list carries tutorial ranges and unnamed skirmish boxes; a map
      // with no splash is not something a broadcast graphic can use.
      maps: (maps?.data ?? [])
        .filter((map) => map.displayName && map.splash && !/range|basic training|skirmish/i.test(map.displayName))
        .map(shrinkMap)
        .sort((a, b) => a.name.localeCompare(b.name)),

      /*
       * Code name to display name, for the game feed - which reports "Duality"
       * where an audience knows "Bind".
       *
       * Built from the *unfiltered* list on purpose. The picker above has no use
       * for the practice range, but the feed will happily report it, and a
       * lookup table that only covers the maps somebody might choose is a table
       * that fails on exactly the events nobody chose.
       */
      mapCodes: Object.fromEntries(
        (maps?.data ?? [])
          .filter((map) => map.displayName && map.mapUrl)
          .map((map) => [mapCodeFromUrl(map.mapUrl).toLowerCase(), map.displayName]),
      ),
    };

    if (!payload.agents.length || !payload.maps.length) throw new Error('valorant-api returned an empty catalogue');
    return payload;
  }

  async function readDisk() {
    try {
      const parsed = JSON.parse(await readFile(cachePath, 'utf8'));
      return parsed?.agents?.length && parsed?.maps?.length ? parsed : null;
    } catch {
      return null;
    }
  }

  return {
    /** Cached catalogue; falls back to the disk copy when the network is down. */
    async get() {
      if (cached && Date.now() - fetchedAt < ASSET_TTL_MS) return cached;
      if (inFlight) return inFlight;

      inFlight = (async () => {
        try {
          cached = await download();
          fetchedAt = cached.fetchedAt;
          await mkdir(path.dirname(cachePath), { recursive: true });
          await writeFile(cachePath, JSON.stringify(cached), 'utf8').catch(() => {});
          return cached;
        } catch (error) {
          const disk = await readDisk();
          if (!disk) throw error;
          // Stale beats nothing: keep the old timestamp so the next call retries.
          cached = disk;
          fetchedAt = Date.now() - ASSET_TTL_MS + 60_000;
          return cached;
        } finally {
          inFlight = null;
        }
      })();

      return inFlight;
    },
  };
}
