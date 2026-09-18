/**
 * The agent select strip: ten cards, a map in the middle, filled in live as a
 * lobby picks and locks.
 *
 * Unlike the other two graphics, most of this state is not typed by anybody. It
 * arrives on a webhook from a client sitting in the lobby, one event per player,
 * and the operator's job is to set the two team identities around it and put it
 * on air. That difference drives most of the decisions here:
 *
 *   - A slot is addressed by its index, 0-9, because that is what the feed
 *     sends. Five a side, with the second five on the right.
 *   - `character` is stored as the *internal* name the game uses, exactly as it
 *     arrived. Turning "Sarge" into "Brimstone" is a lookup against the live
 *     agent catalogue, and doing it at render rather than at ingest means a
 *     catalogue that shows up late still fixes what is on screen, and the saved
 *     state stays a faithful record of what was actually received.
 *   - A player has a `playerId`, which is stable, and a Riot ID, which is what
 *     they happen to be called today. The alias library keys on the former.
 *
 * Dependency-free and DOM-free so Node and the browser can both import it.
 */

import { ANIM_EASINGS, ANIM_EASING_KEYS, easingCurve } from './animation.js';
import { SIDE_CHOICES } from './teams.js';

export { ANIM_EASINGS as SELECT_EASINGS, ANIM_EASING_KEYS as SELECT_EASING_KEYS, easingCurve };

/** Five a side. The feed's indices 0-4 are one team and 5-9 the other. */
export const SELECT_SIDE_SIZE = 5;
export const SELECT_SLOTS = SELECT_SIDE_SIZE * 2;

// ------------------------------------------------------------------ scene ---

/**
 * The client also reports which screen the game is on, and that turns out to be
 * the most useful thing it sends.
 *
 * A roster event says a player picked something. A scene event says the lobby
 * exists at all - so it is what tells the graphic when to clear, when to start
 * the clock, and when agent select is over. Without it the only signal that a
 * new lobby began is a game id changing on the first roster event, which is one
 * event too late to have cleared the board tidily.
 *
 * The value is the level name, verbatim. There is no list of the others because
 * there is nothing to do with them: anything that is not agent select is not
 * agent select, and that is the whole of what this graphic needs to know.
 */
export const AGENT_SELECT_SCENE = 'CharacterSelectPersistentLevel';
export const MENU_SCENE = 'MainMenu';

export const isAgentSelectScene = (scene) => String(scene ?? '').trim() === AGENT_SELECT_SCENE;

// ------------------------------------------------------------------ timer ---

/**
 * Agent select's own clock, mirrored.
 *
 * Owned by the server rather than counted down in the page, for the same reason
 * the winner graphic's sequence position is: two browser sources and a preview
 * counting independently would drift apart, and the one that matters is the one
 * in OBS.
 *
 * `startedAt` is a wall-clock stamp rather than a remaining count, so a source
 * that loads halfway through arrives at the right place instead of starting a
 * fresh 85 seconds. Server and pages are the same machine, so the same clock.
 */
export const TIMER_DEFAULT_MS = 85_000;

/** How long the bar takes to close the gap when everyone locks in early. */
export const TIMER_SNAP_MS = 500;

export const DEFAULT_TIMER = {
  running: false,
  startedAt: 0,
  durationMs: TIMER_DEFAULT_MS,
  // Set when the bar reached the end - either because time ran out or because
  // everybody locked in. Kept apart from `running` so the bar can stay full on
  // screen rather than disappearing the instant it finishes.
  filled: false,
  // When it was stopped, which is what freezes the bar where it stood. Without
  // it a clock ended by hand at thirty seconds would keep computing elapsed
  // from its start stamp and quietly creep to full anyway.
  stoppedAt: 0,
};

/**
 * How much of the clock has been used, 0 to 1, ignoring an early finish.
 *
 * The bar fills *as the time runs out* rather than draining, because a full bar
 * meaning "agent select is over" needs no explaining to anybody watching.
 */
export function timerElapsed(timer, now = Date.now()) {
  if (!timer?.startedAt) return 0;
  const at = timer.running ? now : timer.stoppedAt || now;
  return Math.min(1, Math.max(0, (at - timer.startedAt) / Math.max(1, timer.durationMs)));
}

/** Where the bar belongs right now. A finished clock is full, however it ended. */
export const timerProgress = (timer, now = Date.now()) => (timer?.filled ? 1 : timerElapsed(timer, now));

/** Milliseconds left, for the dashboard's readout. */
export function timerRemainingMs(timer, now = Date.now()) {
  if (!timer?.running || timer.filled || !timer.startedAt) return 0;
  return Math.max(0, timer.startedAt + timer.durationMs - now);
}

/**
 * A slot with no character in it is an empty square, which is the resting state
 * of this graphic rather than an error - agent select starts with ten of them.
 */
export const EMPTY_SLOT = {
  playerId: '',
  riotId: '',
  // What goes on screen. Set from the alias library at ingest, or typed by hand
  // when the feed is not running.
  name: '',
  // The game's internal name - "Sarge", not "Brimstone".
  character: '',
  locked: false,
  // Informational: whose team the reporting client thought this was. Not used to
  // decide sides, because the client may be an observer on neither team.
  teammate: false,
};

export const emptySlots = () => Array.from({ length: SELECT_SLOTS }, () => ({ ...EMPTY_SLOT }));

// ------------------------------------------------------------------ sides ---

/**
 * The two team identities, which are the operator's to fill in - nothing in the
 * feed says who these people are playing for.
 *
 * Copied from the team library rather than linked, exactly like the winner
 * graphic: renaming an org next week must not rewrite a graphic that already
 * went to air.
 */
export const SELECT_SIDE_FIELDS = [
  { key: 'name', type: 'text', max: 32, label: 'Name', placeholder: 'Team' },
  { key: 'shortName', type: 'text', max: 8, label: 'Tricode', placeholder: 'TMA' },
  { key: 'label', type: 'text', max: 8, label: 'Side label', placeholder: 'DEF' },
  /*
   * Which half they are playing, as a fact rather than as the words on screen.
   *
   * The label above is free text and always was - an event may want "ATK", "ATT"
   * or its own wording - so it can never be read as a side. This can: it is what
   * lets a team with no colour of its own wear attack red or defence blue, and
   * what the global switch to plain side colours resolves against.
   */
  { key: 'side', type: 'choice', options: SIDE_CHOICES, label: 'Playing as' },
  { key: 'colour', type: 'hex', label: 'Colour', optional: true },
  { key: 'logo', type: 'image', label: 'Logo' },
];

const side = (label, colour, playing) => ({
  teamId: '',
  name: '',
  shortName: '',
  label,
  side: playing,
  colour,
  logo: '',
});

// ------------------------------------------------------------------ style ---

export const SELECT_ALIGNMENTS = [
  { key: 'top', label: 'Top of the frame' },
  { key: 'middle', label: 'Middle' },
  { key: 'bottom', label: 'Bottom of the frame' },
];

export const SELECT_ALIGNMENT_KEYS = SELECT_ALIGNMENTS.map((entry) => entry.key);

/**
 * type: hex    - a colour
 *       ratio  - 0..1
 *       bool   - a toggle
 *       ms     - a duration
 *       px     - a distance on the 1920x1080 stage
 *       choice - one of `options`
 *       font   - one of FONT_CHOICES
 */
export const SELECT_STYLE_FIELDS = [
  { key: 'font', type: 'font', group: 'Typeface', label: 'Font', default: 'Gabarito' },
  { key: 'uppercase', type: 'bool', group: 'Typeface', label: 'Uppercase all text', default: true },

  // Bottom by default because that is where the game puts its own roster and
  // where a strip belongs: the middle of frame is the part an observer needs.
  { key: 'align', type: 'choice', options: SELECT_ALIGNMENTS, group: 'Placement', label: 'Sit', default: 'bottom' },
  // Agent select puts the roster low on screen; a strip pinned to an edge almost
  // always wants a few pixels of daylight rather than to touch it.
  { key: 'offsetY', type: 'px', min: -400, max: 400, group: 'Placement', label: 'Nudge up/down (px)', default: 0 },

  { key: 'bg', type: 'hex', group: 'Backdrop', label: 'Strip colour', default: '#0b0f14' },
  { key: 'bgOpacity', type: 'ratio', group: 'Backdrop', label: 'Strip opacity', default: 0.92 },
  { key: 'panel', type: 'hex', group: 'Backdrop', label: 'Empty card fill', default: '#141a22' },

  { key: 'text', type: 'hex', group: 'Colour', label: 'Primary text', default: '#ffffff' },
  { key: 'dimText', type: 'hex', group: 'Colour', label: 'Secondary text', default: '#93a4b5' },
  /*
   * The trim, and on this graphic there is exactly one thing wearing it: the
   * VS mark between the two teams - a cut-cornered rule that is the only piece
   * of furniture here which is neither a surface nor a word.
   *
   * Blank means the EVENT's accent, which is the whole point. It used to take
   * `--dim-text`, so an install that had never touched a colour drew a
   * grey-blue mark; it now draws the tournament's, and the two halves of the
   * strip stay team-coloured as they always were.
   */
  { key: 'accent', type: 'hex', group: 'Colour', label: 'Accent', default: '' },

  /*
   * The three numbers that make an unlocked pick read as provisional.
   *
   * Faded and slightly small is the whole idea: the card is visibly not finished,
   * so locking in has somewhere to arrive from. Both are deliberately mild -
   * pushed too far the strip looks broken rather than pending, and an observer
   * cannot read a roster that is half transparent.
   */
  { key: 'pickOpacity', type: 'ratio', group: 'Before lock-in', label: 'How faded', default: 0.55 },
  { key: 'pickScale', type: 'ratio', group: 'Before lock-in', label: 'How zoomed out', default: 0.88 },
  { key: 'pulseMs', type: 'ms', min: 0, max: 6000, group: 'Before lock-in', label: 'Pulse (ms, 0 = off)', default: 1500 },

  // The clock runs along the top edge of the strip, closing in from both outer
  // edges - each half in its own team's colour, so the two ends meeting in the
  // middle is the picture of agent select being over.
  { key: 'showTimer', type: 'bool', group: 'Clock', label: 'Show the agent select clock', default: true },
  { key: 'timerHeight', type: 'px', min: 2, max: 40, group: 'Clock', label: 'Bar height (px)', default: 10 },
  { key: 'timerTrack', type: 'ratio', group: 'Clock', label: 'How visible the empty part is', default: 0.16 },

  { key: 'showMap', type: 'bool', group: 'Options', label: 'Show the map card', default: true },
  { key: 'showRole', type: 'bool', group: 'Options', label: 'Show agent role icons', default: true },
  { key: 'showAgentName', type: 'bool', group: 'Options', label: 'Show agent names', default: true },
  {
    key: 'showEmptyNumbers',
    type: 'bool',
    group: 'Options',
    label: 'Number the empty cards',
    default: false,
  },
];

export const SELECT_STYLE_KEYS = SELECT_STYLE_FIELDS.map((field) => field.key);
export const SELECT_STYLE_GROUPS = [...new Set(SELECT_STYLE_FIELDS.map((field) => field.group))];

export const DEFAULT_SELECT_STYLE = Object.fromEntries(SELECT_STYLE_FIELDS.map((field) => [field.key, field.default]));

// ------------------------------------------------------------- animation ---

/**
 * Far smaller than the scoreboard's, and on purpose: this graphic is up for the
 * whole of agent select rather than being cued against a caster read, so what it
 * needs is to arrive tidily and then stay out of the way.
 */
/**
 * How the cards arrive.
 *
 * All four are symmetrical about the map, because the strip is: anything that
 * favours one end of it reads as one team being introduced before the other,
 * which is a thing a graphic should never accidentally say.
 */
export const SELECT_ENTRANCES = [
  { key: 'deal', label: 'Deal - outwards from the map' },
  { key: 'split', label: 'Split - in from both edges' },
  { key: 'rise', label: 'Rise - up together' },
  { key: 'flip', label: 'Flip - turn in on edge' },
];

export const SELECT_ENTRANCE_KEYS = SELECT_ENTRANCES.map((entry) => entry.key);

export const SELECT_ANIM_FIELDS = [
  { key: 'entrance', type: 'choice', options: SELECT_ENTRANCES, group: 'Motion', label: 'Cards arrive', default: 'split' },
  { key: 'easing', type: 'choice', options: ANIM_EASINGS, group: 'Motion', label: 'Easing', default: 'out' },
  { key: 'inMs', type: 'ms', min: 60, max: 4000, group: 'Motion', label: 'In (ms)', default: 620 },
  { key: 'outMs', type: 'ms', min: 60, max: 4000, group: 'Motion', label: 'Out (ms)', default: 420 },
  { key: 'staggerMs', type: 'ms', min: 0, max: 300, group: 'Motion', label: 'Stagger per card (ms)', default: 45 },
  {
    key: 'animateOnLoad',
    type: 'bool',
    group: 'Motion',
    label: 'Play the entrance when a browser source loads',
    default: true,
  },
];

export const SELECT_ANIM_KEYS = SELECT_ANIM_FIELDS.map((field) => field.key);
export const SELECT_ANIM_GROUPS = [...new Set(SELECT_ANIM_FIELDS.map((field) => field.group))];

/**
 * What the scene feed is allowed to do on its own.
 *
 * Three of the four default on, because automation that has to be switched on
 * is not automation - and each of those is a thing an operator would otherwise
 * be doing by hand at the exact moment they are busiest.
 *
 * `autoHide` is the exception and defaults OFF. Agent select "ending" is the
 * client leaving CharacterSelectPersistentLevel, which is the loading screen -
 * the one moment the audience most wants to read the ten agents that were just
 * locked. Dropping the strip there took it off air exactly when it had become
 * worth watching, so taking it down is left to the operator, who can see what
 * the programme is doing. The next lobby still empties the cards on its own
 * (`autoClear`), so leaving it up costs nothing.
 *
 * With the feed not running these do nothing at all: no scene events, no
 * automatic anything, and the transport bar is the only thing that moves.
 */
export const SELECT_AUTO_FIELDS = [
  { key: 'autoShow', type: 'bool', label: 'Put it on air when agent select starts', default: true },
  { key: 'autoHide', type: 'bool', label: 'Take it off when agent select ends', default: false },
  { key: 'autoClear', type: 'bool', label: 'Empty the cards when the lobby changes', default: true },
  { key: 'autoTimer', type: 'bool', label: 'Start the clock when agent select starts', default: true },
];

export const SELECT_AUTO_KEYS = SELECT_AUTO_FIELDS.map((field) => field.key);

export const DEFAULT_SELECT_AUTO = Object.fromEntries(SELECT_AUTO_FIELDS.map((field) => [field.key, field.default]));

export const DEFAULT_SELECT_ANIM = {
  visible: false,
  // Same job it does on the other two graphics: every keystroke pushes the whole
  // state, so a page keying off state changes would replay the entrance whenever
  // somebody fixed a typo. Only Show and Hide bump this.
  cue: 0,
  ...Object.fromEntries(SELECT_ANIM_FIELDS.map((field) => [field.key, field.default])),
};

// ---------------------------------------------------------------- content ---

export const DEFAULT_SELECT = {
  version: 1,

  // Which lobby the current roster came from. A change means a different game,
  // which is what lets the feed clear the board without anybody pressing
  // anything - see ingestRoster.
  gameId: '',

  // The level the game is on, verbatim from the scene feed. Blank means nothing
  // has reported one, which is also what "the feed is not running" looks like.
  scene: '',

  mapName: '',
  mapImage: '',
  eventLogo: '',

  /*
   * Which half of the feed's roster shows on the left.
   *
   * The feed numbers players 0-9 and says nothing about which five are which
   * team, so this is the one control that cannot be derived. It moves the
   * rosters, not the team identities: the identities are typed once at the top
   * of a series, where which end of the feed they arrived on is a thing that can
   * differ from game to game.
   */
  swap: false,

  // Blank colours, so the two default to their side's own - which is what a
  // lobby nobody has set up should look like.
  /*
   * Where the two side colours come from. Owned by the Global page while its
   * sync is on, which is why it sits on the state rather than in `style` - the
   * server patches top-level keys, and nesting it would need a special case for
   * one setting.
   */
  colourSource: 'team',

  left: side('DEF', '', 'defence'),
  right: side('ATK', '', 'attack'),

  slots: emptySlots(),

  timer: { ...DEFAULT_TIMER },
  auto: { ...DEFAULT_SELECT_AUTO },
  anim: { ...DEFAULT_SELECT_ANIM },
  style: { ...DEFAULT_SELECT_STYLE },
};

// ------------------------------------------------------------- derivation ---

/** The feed's slot indices for one side, after any swap. */
export function sideSlots(state, half) {
  const first = (half === 'left') === !state?.swap ? 0 : SELECT_SIDE_SIZE;
  return Array.from({ length: SELECT_SIDE_SIZE }, (_, index) => first + index);
}

/** A Riot ID without its tagline - "Kuyareymark #6767" becomes "Kuyareymark". */
export const stripTagline = (riotId) => String(riotId ?? '').split('#')[0].trim();

/**
 * One spelling of a Riot ID, for comparing two that came from different places.
 *
 * The game client sends "RTLine #GLHF" - a space before the hash - and 41 of the
 * 50 records in a real alias library are stored exactly that way. The match
 * providers hand back the name and the tag as separate fields, so the obvious
 * `name + '#' + tag` comparison misses every one of them. Both sides go through
 * here instead: lowercased, split on the hash, each half trimmed.
 */
export const riotIdKey = (riotId) => {
  const [rawName, rawTag = ''] = String(riotId ?? '').split('#');
  const name = rawName.trim().toLowerCase();
  const tag = rawTag.trim().toLowerCase();
  return tag ? `${name}#${tag}` : name;
};

/**
 * The alias for a player, by id first and by Riot ID second.
 *
 * Two keys because the sources disagree about what a player is. The game client
 * and Riot's own endpoints both identify an account by UUID, which is exact; but
 * tracker.gg has no UUID at all and only ever reports the Riot ID, so a library
 * built from agent select would be unreachable from a scoreboard imported that
 * way. The Riot ID is the weaker key - people do change them - which is why it
 * is only consulted second.
 *
 * Only records that actually carry an alias can match. Every player the feed has
 * ever seen is in the library, most of them unnamed, and an unnamed record
 * matching first would shadow a named one.
 */
export function aliasForPlayer(list, { playerId, riotId } = {}) {
  const records = list ?? [];
  if (playerId) {
    const byId = records.find((entry) => entry.id === playerId);
    if (byId?.alias) return byId.alias;
  }
  const key = riotIdKey(riotId);
  if (!key) return '';
  const byName = records.find(
    (entry) =>
      entry.alias &&
      riotIdKey(entry.riotId) === key &&
      // An operator who has looked at this pair and said they are different
      // people is not asked twice, and their answer is not quietly ignored the
      // next time the same Riot ID turns up.
      !(playerId && (entry.rejected ?? []).includes(playerId)),
  );
  return byName?.alias ?? '';
}

/**
 * The record a list entry is addressed by.
 *
 * A player the feed has reported is keyed by their account id, which is exact.
 * One typed in before the event has no account id yet - only the Riot ID they
 * were written down under - so that is the key, namespaced so the two kinds can
 * never collide.
 */
export const aliasKey = (entry) =>
  entry?.id ? String(entry.id) : `riot:${riotIdKey(entry?.riotId)}`;

/**
 * Aliases typed in ahead of time that now look like somebody the feed has seen.
 *
 * Only a suggestion, never applied on its own. Riot IDs are not unique over
 * time - people change them, and two events can have a "Jett" who are not the
 * same person - so promoting a name match to an account link is a decision for
 * somebody who knows the players, not for a string comparison.
 */
export function pendingLinks(list) {
  const records = list ?? [];
  const seen = records.filter((entry) => entry.id && riotIdKey(entry.riotId));
  const pending = [];

  for (const manual of records) {
    if (manual.id || !manual.alias) continue;
    const key = riotIdKey(manual.riotId);
    if (!key) continue;
    for (const candidate of seen) {
      if (riotIdKey(candidate.riotId) !== key) continue;
      if ((manual.rejected ?? []).includes(candidate.id)) continue;
      pending.push({ manual, candidate });
    }
  }
  return pending;
}

/**
 * What to call a player.
 *
 * An alias wins because it is the thing somebody deliberately wrote down; the
 * Riot ID is only a default. The tagline always goes - it is four digits of
 * noise on a card that has to be read from across a room.
 */
export const displayName = (riotId, alias) => String(alias ?? '').trim() || stripTagline(riotId);

/**
 * Turn the game's internal character name into the one on the box.
 *
 * There is deliberately no hand-written table of these. The internal names are
 * not guessable - Cashew is Tejo, Sequoia is Iso, Smonk is Clove - so a table
 * written from memory would be confidently wrong, and one written from the API
 * would go stale the next time an agent ships. The catalogue already comes from
 * valorant-api, is cached to disk and survives being offline, so it is the only
 * source worth having.
 *
 * `displayName` is matched too, so a feed that ever sends the public name works
 * without a special case.
 *
 * @returns {object|null} the catalogue entry, or null if it is not known yet
 */
export function findAgent(agents, character) {
  const wanted = String(character ?? '').trim().toLowerCase();
  if (!wanted) return null;
  return (
    (agents ?? []).find((agent) => String(agent.developerName ?? '').toLowerCase() === wanted) ??
    (agents ?? []).find((agent) => String(agent.name ?? '').toLowerCase() === wanted) ??
    null
  );
}

/**
 * What the card should say the agent is.
 *
 * Falls back to the internal name rather than to nothing: "Sarge" on air is bad,
 * but it is visible and an operator can fix that slot by hand, where a blank
 * card looks like the feed simply failed.
 */
export const agentLabel = (agents, character) => findAgent(agents, character)?.name ?? String(character ?? '').trim();

/** How far through the lobby is - what the dashboard reports. */
export function selectProgress(state) {
  const slots = state?.slots ?? [];
  return {
    picked: slots.filter((slot) => String(slot?.character ?? '').trim()).length,
    locked: slots.filter((slot) => slot?.locked && String(slot?.character ?? '').trim()).length,
    total: SELECT_SLOTS,
  };
}

/**
 * Is the lobby finished picking?
 *
 * Requires a full ten, not just "everyone who has picked has locked" - which is
 * trivially true of an empty board and would end the clock before agent select
 * had begun.
 */
export function everyoneLocked(state) {
  const { picked, locked, total } = selectProgress(state);
  return picked === total && locked === total;
}
