/**
 * The Bitfocus Companion control channel.
 *
 * A stream deck operator wants two things a browser dashboard cannot give
 * them: a physical button, and a lamp on that button that is right without
 * anybody looking at it. This module is both halves - it takes an operation in
 * and it sends the affected graphic's state back out.
 *
 * ---------------------------------------------------------------------------
 * The one rule this file exists to keep
 * ---------------------------------------------------------------------------
 *
 * Every operation here is *the same store write the dashboard button makes*.
 * Not an equivalent one - the same one. `winner.next` does what pressing Next
 * does, by writing to `bundle.winner.program`, and then stops.
 *
 * Everything else follows for free, because it already follows from the
 * dashboard: the SSE fan-out tells every browser source and every open
 * dashboard, the auto-hide timer sees the cue, the sequence driver reschedules
 * itself, the clock expiry re-arms. There is no second code path to keep in
 * step, and a Companion press and a mouse click cannot drift apart, because
 * downstream there is nothing that can tell them apart.
 *
 * The temptation this resists is a control channel that keeps its own idea of
 * what is on air. That idea is wrong the first time somebody uses the mouse.
 *
 * ---------------------------------------------------------------------------
 * Why the feedback is a projection and not the state
 * ---------------------------------------------------------------------------
 *
 * The stores push on every keystroke - that is what the cue counter exists to
 * work around (see the note in CLAUDE.md). A control channel that forwarded
 * raw state would send a message per character typed into a team name, and a
 * stream deck would spend a broadcast redrawing.
 *
 * So each graphic has a `project()` that returns a small, flat object of
 * scalars - is it up, which scene, how many locked in - and a push happens only
 * when that projection *changes*. Typing a team name changes `scoreboard_left`,
 * so that does go out; adjusting an easing curve changes nothing here and is
 * silent. The projection is the button's-eye view, and it is deliberately much
 * smaller than the graphic.
 *
 * Flat, and prefixed, because of what is on the other end. Companion's generic
 * WebSocket module does not enumerate an inbound message - nothing is
 * discovered, and no variable exists until an operator adds a feedback and
 * types a JSON path into it by hand. So every key here is one path segment
 * with no nesting to type, no dots inside a name (the lookup splits on those,
 * making such a key unreachable), and a real value rather than a structure:
 * an object or an array arrives as JSON *text*, which is useless to a button.
 * Booleans go out twice, as a boolean and as `1`/`0` under `_n`, because the
 * comparison a feedback does is string-ish and `true` vs `1` is exactly the
 * sort of thing that costs an hour. See public/companion-schema.js, which is
 * where the operator's table comes from.
 *
 * ---------------------------------------------------------------------------
 * Targeting
 * ---------------------------------------------------------------------------
 *
 * An operation answers with the graphic it touched and nothing else, and a
 * subscription pushes only the graphic that changed. Three graphics on one
 * socket, addressed separately - a winner cue does not repaint the agent-select
 * buttons.
 */

import {
  WINNER_STAGES,
  WINNER_STAGE_COUNT,
  resolveWinner,
  clearRosterState,
  settleSelect,
  startTimer,
  stopTimer,
  sanitiseState,
  sanitiseWinner,
  sanitiseSelect,
} from './graphics.js';
import { selectProgress, timerRemainingMs, isAgentSelectScene } from './public/select-schema.js';
import {
  COMPANION_PROTOCOL,
  COMPANION_GRAPHICS,
  COMPANION_GRAPHIC_ALIASES,
  COMPANION_OP_ALIASES,
  companionVariables,
  companionOps,
} from './public/companion-schema.js';
import { busName } from './buses.js';
import { accept, refuseUpgrade, CLOSE } from './websocket.js';

/** Matches the dashboards. The counter wraps so it cannot grow without bound. */
const CUE_WRAP = 1_000_000;
const bumpCue = (value) => ((value ?? 0) + 1) % CUE_WRAP;

const LAST_STAGE = WINNER_STAGE_COUNT - 1;
const clampStage = (value) => Math.min(LAST_STAGE, Math.max(0, value));

/** Sent to Companion as both a boolean and a 1/0 - see the header note. */
const lamp = (name, value) => ({ [name]: Boolean(value), [`${name}_n`]: value ? 1 : 0 });

/**
 * A refusal an operator can act on.
 *
 * Separate from a crash on purpose: "the sequence is not on air" is a normal
 * answer to a button pressed at the wrong moment, and it should reach the far
 * end as a message rather than closing the socket.
 */
class OpError extends Error {}
const refuse = (message) => {
  throw new OpError(message);
};

// ---------------------------------------------------------------------------
// the scoreboard
// ---------------------------------------------------------------------------

/**
 * Show, Hide and Replay are one move with a different flag, exactly as in
 * public/dashboard.js - and Replay is Show, because re-firing the cue on a
 * graphic that is already up is what replays the entry.
 */
function scoreboardCue(store, visible) {
  const anim = store.state.anim;
  store.patch({ anim: { ...anim, visible, cue: bumpCue(anim.cue) } });
}

/** Identity only: the same three keys public/dashboard.js calls IDENTITY_KEYS. */
const IDENTITY_KEYS = ['teamName', 'logo', 'teamId'];

/**
 * The two ops every graphic has, and the only ones that reach an audience.
 *
 * They take the bus rather than a store, because a take is a move BETWEEN the
 * two - the one operation a single store cannot express.
 */
const takeOps = {
  take: (store, value, bus) => ({ replayed: bus.take().replayed }),
  revert: (store, value, bus) => void bus.revert(),
};

const scoreboardOps = {
  show: (store) => scoreboardCue(store, true),
  hide: (store) => scoreboardCue(store, false),
  toggle: (store) => scoreboardCue(store, !store.state.anim.visible),
  replay: (store) => scoreboardCue(store, true),

  /*
   * Colours stay put: they describe the left and right halves of the design,
   * not the teams. Only the content moves. (public/dashboard.js says the same.)
   */
  swap: (store) => {
    const { left, right } = store.state;
    store.patch({ left: right, right: left });
  },

  /*
   * The identity fields and only those. A match import re-assigns rosters and
   * scores Blue-left / Red-right every map while the typed names stay put, so
   * roughly every other map the name sits over the other team's roster. Swap
   * sides moves both halves and keeps them mismatched - which is why this is a
   * second button and not the same one.
   */
  swapNames: (store) => {
    const left = { ...store.state.left };
    const right = { ...store.state.right };
    for (const key of IDENTITY_KEYS) {
      const held = left[key];
      left[key] = right[key];
      right[key] = held;
    }
    store.patch({ left, right });
  },

  sort: (store) => {
    const byAcs = (players) =>
      [...players].sort((a, b) => (b.acs ?? 0) - (a.acs ?? 0) || (b.kills ?? 0) - (a.kills ?? 0));
    store.patch({
      left: { ...store.state.left, players: byAcs(store.state.left.players) },
      right: { ...store.state.right, players: byAcs(store.state.right.players) },
    });
  },

  ...takeOps,
  reset: (store) => void store.reset(),
};


/**
 * The staged half of every projection.
 *
 * Three names rather than a preview twin for every variable: each one costs
 * the operator a hand-typed feedback, and a stream deck's job is air plus "is
 * there something waiting". The dashboard is where you look at what is staged.
 *
 * The cue counters are stripped before comparing, exactly as take-bar.js does
 * in the browser - the two buses keep their own on purpose, so a raw
 * comparison would report "staged" permanently within a minute of going live.
 * (Duplicated rather than imported because buses.js is Node-only and take-bar
 * runs in a page; if a third copy ever appears, that is the moment to move it.)
 */
const withoutCue = (state, path) => {
  if (!state) return '';
  const clone = structuredClone(state);
  if (clone[path]) delete clone[path].cue;
  return JSON.stringify(clone);
};

function stagedFields(name, cuePath, program, preview, legend) {
  const differs = Boolean(program && preview) && withoutCue(preview, cuePath) !== withoutCue(program, cuePath);
  return {
    ...lamp(`${name}_staged`, differs),
    [`${name}_preview_air`]: preview ? legend(preview) : '',
  };
}

function projectScoreboard(state, preview) {
  const { anim, left, right } = state;
  return {
    ...stagedFields('scoreboard', 'anim', state, preview, (p) => (p.anim?.visible ? 'UP' : 'OFF')),
    ...lamp('scoreboard_visible', anim.visible),
    scoreboard_air: anim.visible ? 'ON AIR' : 'OFF',
    scoreboard_cue: anim.cue ?? 0,
    scoreboard_map: state.map ?? '',
    scoreboard_left: left.teamName ?? '',
    scoreboard_right: right.teamName ?? '',
    scoreboard_left_score: left.roundsWon ?? 0,
    scoreboard_right_score: right.roundsWon ?? 0,
    scoreboard_score: `${left.roundsWon ?? 0}-${right.roundsWon ?? 0}`,
    scoreboard_auto_hide_ms: anim.holdMs ?? 0,
  };
}

// ---------------------------------------------------------------------------
// the winner sequence
// ---------------------------------------------------------------------------

/**
 * `restart: false` first, then the change, then the cue - the order in
 * public/winner-dashboard.js. `restart` has to be cleared explicitly because
 * "go to scene 0" is two different gestures: the overlay arriving, and stepping
 * back to the first scene while it is already up.
 */
function winnerCue(store, change) {
  const seq = store.state.seq;
  store.patch({ seq: { ...seq, restart: false, ...change, cue: bumpCue(seq.cue) } });
}

/** Whether starting the sequence should also start the music. */
const hasTrack = (state) => Boolean(state.audio.enabled && state.audio.track);

/*
 * Activate leaves pre-cued music alone: the output page only rewinds a track it
 * had to start from silence, so an early cue lifts to the bed rather than
 * jumping back to the top of the sting.
 */
const winnerActivate = (store) =>
  winnerCue(store, { active: true, stage: 0, restart: true, music: store.state.seq.music || hasTrack(store.state) });

/*
 * Stop normally takes the music with it. `keepPlaying` is what leaves it
 * running underneath whatever comes next.
 */
const winnerStop = (store) =>
  winnerCue(store, { active: false, music: store.state.seq.music && Boolean(store.state.audio.keepPlaying) });

/**
 * Next and Back match the desk exactly, including refusing when the desk would
 * have the button greyed out.
 *
 * This is a deliberate choice and not an oversight. Companion has no disabled
 * state, so the alternative was to let Next start the sequence - which would
 * mean the same button does two different things depending on a state the
 * operator cannot see, and means Companion and the dashboard disagree about
 * what Next is. `winner_can_next` is published so the button can go dark
 * instead, and `winner.stage` exists for jumping in cold.
 */
function winnerStep(store, delta) {
  const seq = store.state.seq;
  if (!seq.active) refuse('The winner sequence is not on air. Use winner.activate, or winner.stage to cut to a scene.');
  const wanted = seq.stage + delta;
  if (wanted < 0) refuse('Already on the first scene.');
  if (wanted > LAST_STAGE) refuse('Already on the last scene.');
  winnerCue(store, { active: true, stage: wanted });
}

/** Music without disturbing the graphic - so no cue. See setMusic() on the desk. */
const setMusic = (store, on) => store.patch({ seq: { ...store.state.seq, music: on } });

const winnerOps = {
  activate: winnerActivate,
  replay: winnerActivate,
  stop: winnerStop,
  // `winner.show` and `winner.hide` reach these through COMPANION_OP_ALIASES,
  // so that the same two words work on all three graphics.
  toggle: (store) => (store.state.seq.active ? winnerStop(store) : winnerActivate(store)),

  next: (store) => winnerStep(store, 1),
  prev: (store) => winnerStep(store, -1),

  /*
   * The stage pips, which are enabled whether or not the sequence is up - so
   * this is also how a Companion button cuts straight in at a scene.
   */
  stage: (store, value) => {
    const wanted = Number.parseInt(value, 10);
    if (!Number.isFinite(wanted)) refuse(`winner.stage needs a scene number, 1 to ${WINNER_STAGE_COUNT}.`);
    // One-based on the wire: the button legend says "scene 2" and so does the
    // dashboard's own readout. Zero-based is an internal detail.
    const stage = clampStage(wanted - 1);
    winnerCue(store, { active: true, stage, restart: stage === 0 });
  },

  music: (store, value) => setMusic(store, value === undefined ? !store.state.seq.music : Boolean(value)),
  musicOn: (store) => setMusic(store, true),
  musicOff: (store) => setMusic(store, false),

  ...takeOps,
  reset: (store) => void store.reset(),
};

function projectWinner(state, preview) {
  const seq = state.seq;
  const stage = WINNER_STAGES[seq.stage] ?? WINNER_STAGES[0];
  const champion = state[resolveWinner(state)] ?? {};

  return {
    ...stagedFields('winner', 'seq', state, preview, (p) =>
      p.seq?.active ? `SCENE ${(p.seq.stage ?? 0) + 1}` : 'OFF',
    ),
    winner_preview_scene: (preview?.seq?.stage ?? 0) + 1,
    ...lamp('winner_active', seq.active),
    winner_air: seq.active ? `SCENE ${seq.stage + 1}` : 'OFF',
    // One-based, matching the wire format of winner.stage and the desk's own
    // "On air - scene 2".
    winner_scene: seq.stage + 1,
    winner_scene_count: WINNER_STAGE_COUNT,
    winner_scene_key: stage?.key ?? '',
    winner_scene_label: stage?.label ?? '',
    // What the buttons should look like. Published rather than left for the far
    // end to work out, because the rule ("not at the end, and on air") is this
    // server's and would go stale in a Companion expression.
    ...lamp('winner_can_next', seq.active && seq.stage < LAST_STAGE),
    ...lamp('winner_can_prev', seq.active && seq.stage > 0),
    ...lamp('winner_music', seq.music),
    ...lamp('winner_auto_advance', seq.autoAdvance),
    winner_team: champion.name ?? '',
    winner_team_short: champion.shortName ?? '',
    winner_left: state.left?.name ?? '',
    winner_right: state.right?.name ?? '',
    winner_left_score: state.left?.score ?? 0,
    winner_right_score: state.right?.score ?? 0,
    winner_cue: seq.cue ?? 0,
  };
}

// ---------------------------------------------------------------------------
// agent select
// ---------------------------------------------------------------------------

function selectCue(store, visible) {
  const anim = store.state.anim;
  store.patch({ anim: { ...anim, visible, cue: bumpCue(anim.cue) } });
}

/**
 * Every write to the select board goes through here, for the same reason
 * /api/select does: locking the last card finishes agent select however it
 * happened, and the clock should shut for a Companion press exactly as it does
 * for the feed. A no-op unless this write completed the lobby, and settleSelect
 * itself leaves alone any write that moved the timer.
 */
function writeSelect(store, next) {
  const previous = store.state;
  const written = store.replace(next);
  const settled = settleSelect(previous, written);
  if (settled !== written) store.replace(settled);
}

const selectOps = {
  show: (store) => selectCue(store, true),
  hide: (store) => selectCue(store, false),
  toggle: (store) => selectCue(store, !store.state.anim.visible),

  /*
   * Moves the five people, not the identities - the feed numbers seats 0-9 and
   * says nothing about which end a team arrived on, while the names are typed
   * once at the top of a series. Not a cue: nothing about the entrance should
   * replay because the rosters changed ends.
   */
  swap: (store) => store.patch({ swap: !store.state.swap }),

  /*
   * `gameId` goes too, or the next event from the same lobby reads as a
   * continuation and the board stays half empty.
   */
  clear: (store) => writeSelect(store, { ...clearRosterState(store.state), gameId: '' }),

  // Start and Restart are the same move, as on the desk.
  clockStart: (store) => writeSelect(store, startTimer(store.state)),
  clockEnd: (store) => {
    if (!store.state.timer.running) refuse('The clock is not running.');
    writeSelect(store, stopTimer(store.state, { filled: true }));
  },

  ...takeOps,
  reset: (store) => void store.reset(),
};

function projectSelect(state, preview) {
  const { picked, locked, total } = selectProgress(state);
  const timer = state.timer;
  const remaining = timer.running ? Math.ceil(timerRemainingMs(timer) / 1000) : 0;

  const out = {
    ...stagedFields('select', 'anim', state, preview, (p) => (p.anim?.visible ? 'UP' : 'OFF')),
    ...lamp('select_visible', state.anim.visible),
    select_air: state.anim.visible ? 'ON AIR' : 'OFF',
    select_picked: picked,
    select_locked: locked,
    select_total: total,
    select_progress: `${picked}/${total}`,
    ...lamp('select_swap', state.swap),
    ...lamp('select_clock_running', timer.running),
    ...lamp('select_clock_filled', timer.filled),
    select_clock_remaining: remaining,
    // mm:ss, because a button legend wants the string and not the arithmetic.
    select_clock: timer.running ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : '',
    select_scene: state.scene ?? '',
    ...lamp('select_in_agent_select', isAgentSelectScene(state.scene)),
    select_game_id: state.gameId ?? '',
    select_cue: state.anim.cue ?? 0,
  };

  /*
   * The board itself, one flat group per seat.
   *
   * Ten seats times three keys is a big-ish message, and it is the point of the
   * exercise: "updates for agent select when data is being received" means the
   * picks, not a count of them. It still only goes out when one of these
   * actually changes, so a draft sends about twenty messages in total.
   *
   * One-based to match the dashboard's own numbering of the seats.
   */
  for (const [index, slot] of (state.slots ?? []).entries()) {
    const n = index + 1;
    out[`select_slot${n}_name`] = slot.name || slot.riotId || '';
    out[`select_slot${n}_agent`] = slot.character ?? '';
    out[`select_slot${n}_locked`] = Boolean(slot.locked && slot.character);
    out[`select_slot${n}_locked_n`] = slot.locked && slot.character ? 1 : 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// the graphics, as the control channel sees them
// ---------------------------------------------------------------------------

/**
 * One entry per graphic: where its store lives on a session bundle, what may be
 * done to it, and the button's-eye view of it.
 *
 * `scoreboard` rather than `graphic` on the wire. The store is called `graphics`
 * and the dashboard tab is called "Graphics dashboard", but to somebody
 * labelling a stream deck the thing is the scoreboard, and "graphic" is what all
 * three of these are. `graphic` stays as an alias so either works.
 */
const GRAPHICS = {
  scoreboard: {
    /*
     * The BUS, not a store. Ops drive preview and a take is what reaches an
     * audience - so the control channel needs both halves, and the take needs
     * the move between them, which no single store can express.
     */
    bus: (bundle) => bundle.graphics,
    ops: scoreboardOps,
    project: projectScoreboard,
    // Called with nothing, each sanitiser returns a clean copy of its own
    // defaults - which is a whole valid state to check the projection against
    // without a store, a session or a disk.
    defaults: sanitiseState(),
  },
  winner: { bus: (bundle) => bundle.winner, ops: winnerOps, project: projectWinner, defaults: sanitiseWinner() },
  select: { bus: (bundle) => bundle.select, ops: selectOps, project: projectSelect, defaults: sanitiseSelect() },
};

assertContract();

/**
 * The schema and the implementations must name exactly the same ops, and the
 * projections must emit exactly the variables the operator's table promises.
 *
 * Checked once, at import, and fatal - because the failure it prevents is
 * silent and lands on somebody else. A variable in the table that the server
 * never sends is a path an operator types into Companion, gets no error for
 * (a path that matches nothing leaves the variable alone), and discovers is
 * dead in the middle of a show. An op in the table that does not exist is the
 * same failure with a button on it.
 *
 * This is why the projections are pure functions of state: they can be run
 * here against the defaults with no server, no session and no socket.
 */
function assertContract() {
  const problems = [];

  for (const entry of COMPANION_GRAPHICS) {
    const implemented = GRAPHICS[entry.key];
    if (!implemented) {
      problems.push(`companion-schema.js describes "${entry.key}", which companion.js does not implement`);
      continue;
    }

    const documented = new Set(companionOps(entry.key));
    const actual = new Set(Object.keys(implemented.ops));
    for (const op of documented) if (!actual.has(op)) problems.push(`${entry.key}.${op} is documented but not implemented`);
    for (const op of actual) if (!documented.has(op)) problems.push(`${entry.key}.${op} is implemented but not documented`);

    const promised = new Set(companionVariables(entry.key).map((field) => field.key));
    const emitted = new Set(Object.keys(implemented.project(implemented.defaults, implemented.defaults)));
    for (const key of promised) if (!emitted.has(key)) problems.push(`${entry.key} promises the variable "${key}" and never sends it`);
    for (const key of emitted) if (!promised.has(key)) problems.push(`${entry.key} sends "${key}", which is in no table the operator can read`);
  }

  // A dot in a key would be unreachable: Companion's path lookup splits on it.
  for (const entry of COMPANION_GRAPHICS) {
    for (const field of companionVariables(entry.key)) {
      if (field.key.includes('.')) problems.push(`the variable "${field.key}" has a dot in it, which Companion cannot address`);
    }
  }

  if (problems.length) throw new Error(`Companion contract is broken:\n  - ${problems.join('\n  - ')}`);
}

const normaliseGraphic = (value) => {
  const key = String(value ?? '').trim().toLowerCase();
  const resolved = COMPANION_GRAPHIC_ALIASES[key] ?? key;
  return GRAPHICS[resolved] ? resolved : '';
};

/**
 * Resolve an op name against one graphic's table.
 *
 * Case- and separator-insensitive, because the name is typed into a Companion
 * text box by a person who is not looking at this file: `clockStart`,
 * `clock_start`, `clock-start` and `CLOCKSTART` are the same request, and
 * refusing three of them teaches nothing.
 */
function normaliseOp(graphic, value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const table = GRAPHICS[graphic].ops;
  if (table[raw]) return raw;

  const flat = raw.toLowerCase().replace(/[\s_-]/g, '');
  // Per graphic, not global: `show` means activate on the winner and show on
  // the other two, and one shared table could not say that.
  const alias = COMPANION_OP_ALIASES[graphic]?.[flat];
  if (alias && table[alias]) return alias;
  for (const name of Object.keys(table)) if (name.toLowerCase() === flat) return name;
  return '';
}

/** Everything this socket will answer to, for the `ops` request. */
const opCatalogue = () =>
  Object.fromEntries(Object.entries(GRAPHICS).map(([name, entry]) => [name, Object.keys(entry.ops)]));

// ---------------------------------------------------------------------------
// parsing what arrived
// ---------------------------------------------------------------------------

/**
 * A message, from whatever shape it turned up in.
 *
 * Forgiving in the same way and for the same reason as `matchIdFrom`: what is
 * on the other end is a configuration text box, not a program. Companion's
 * generic module sends a plain string most easily of all, so `winner.next` on
 * its own is the primary form and the JSON envelope is the richer one.
 */
export function parseCommand(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  if (!raw.startsWith('{')) return { op: raw };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON after all - a bare op that happened to start with a brace is
    // not a thing, so this is a genuine syntax error.
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const op = parsed.op ?? parsed.action ?? parsed.command ?? parsed.cmd ?? '';
  const value = parsed.value ?? parsed.arg ?? parsed.stage ?? parsed.scene;
  return { op: String(op), graphic: parsed.graphic ?? parsed.target ?? '', value, id: parsed.id };
}

/**
 * Split `winner.next` into its two halves.
 *
 * `.`, `/` and `:` all separate, because all three are what somebody types.
 * A bare op with no graphic is allowed only where it is unambiguous, which is
 * why this returns the halves rather than guessing here.
 */
function splitOp(text) {
  const parts = String(text ?? '')
    .split(/[./:]/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2) return { graphic: parts[0], op: parts.slice(1).join('.') };
  return { graphic: '', op: parts[0] ?? '' };
}

// ---------------------------------------------------------------------------
// the hub
// ---------------------------------------------------------------------------

/** Requests that are not operations on a graphic. */
const META_OPS = new Set(['ping', 'state', 'status', 'sync', 'ops', 'help', 'hello']);

/**
 * @param {object} deps
 * @param {(key: string) => {owner: object|null, hint?: string}} deps.ownerForKey
 *   Control key -> account. `hint` explains a refusal in terms the operator can
 *   act on, and must never contain the value it was given.
 * @param {(id: string) => Promise<object>} deps.bundleFor  account id -> session bundle
 * @param {() => boolean} deps.enabled  the server-wide switch
 * @param {object} deps.log
 */
export function makeCompanionHub({ ownerForKey, bundleFor, enabled, log, maxConnections = 16 }) {
  /**
   * Every open channel, and whose account it belongs to.
   *
   * A Map rather than a Set because a socket authenticates exactly once, at
   * the handshake, and then holds no credential to re-check. So the only way
   * to make revoking a key mean anything is to be able to find the sockets it
   * opened - which needs the owner recorded at the time.
   *
   * @type {Map<object, string>} connection -> owner id
   */
  const live = new Map();

  async function handleUpgrade(req, url, socket, head) {
    if (!enabled()) {
      // A switched-off feature answers as though it is not there, the same way
      // the Discord routes do.
      refuseUpgrade(socket, 404, 'The Companion control channel is switched off on this server.');
      return;
    }

    const key = url.searchParams.get('key') ?? '';
    if (!key) {
      refuseUpgrade(socket, 401, 'Add ?key=<control key> to this URL. Copy it from the dashboard, under Account.');
      return;
    }

    /*
     * `hint` is why it was refused, in words an operator can act on.
     *
     * Worth the extra return value, because the overwhelmingly likely cause is
     * somebody pasting their *session* key here - the two are both UUIDs
     * sitting on the same panel - and "that key is real, but it is the other
     * one" saves an evening of checking the firewall. The resolver is what
     * knows the difference; it reports it and never echoes either value.
     */
    const { owner, hint } = ownerForKey(key);
    if (!owner || owner.disabled) {
      const reason = owner?.disabled ? 'That account is disabled.' : (hint ?? 'That is not a control key.');
      log.warn('companion', `refused a control channel: ${reason}`);
      refuseUpgrade(socket, 403, reason);
      return;
    }

    if (live.size >= maxConnections) {
      log.warn('companion', `refused a connection: already at the limit of ${maxConnections}`);
      refuseUpgrade(socket, 503, 'Too many control connections are already open.');
      return;
    }

    let bundle;
    try {
      bundle = await bundleFor(owner.id);
    } catch (error) {
      log.error('companion', `could not open the session: ${error.message}`);
      refuseUpgrade(socket, 503, 'That session could not be opened.');
      return;
    }

    const connection = accept(req, socket, head);
    if (!connection) return; // already refused, with a reason

    install(connection, owner, bundle);
  }

  function install(connection, owner, bundle) {
    live.set(connection, owner.id);
    log.info('companion', `control channel open for ${owner.name || owner.id}`, { tournament: owner.id });

    /*
     * The last projection sent, per graphic. A push happens only against a
     * change in *this*, not in the store - which is the whole reason a
     * dashboard keystroke does not reach the stream deck.
     */
    const sent = new Map();

    const push = (name, { force = false, reason = 'update' } = {}) => {
      const entry = GRAPHICS[name];
      const bus = entry.bus(bundle);
      // Air first, because that is what the unqualified names mean - here, on
      // the SSE channels and on the HTTP routes. Preview rides along as the
      // handful of `_staged` names beside it.
      const next = entry.project(bus.program.state, bus.preview.state);
      const previous = sent.get(name);
      // Cheap and exact: the projections are flat objects of scalars, so
      // stringify is a total comparison and there is nothing here big enough
      // for it to matter.
      const encoded = JSON.stringify(next);
      if (!force && previous === encoded) return false;
      sent.set(name, encoded);
      connection.sendJson({ type: 'state', graphic: name, reason, ...next });
      return true;
    };

    const pushAll = (reason) => {
      for (const name of Object.keys(GRAPHICS)) push(name, { force: true, reason });
    };

    // ---- live updates -----------------------------------------------------

    /*
     * Both buses, per graphic. A take moves program, an operator's op moves
     * preview, and either can change what a button should be showing - so a
     * channel subscribed to only one of them would go quiet at exactly the
     * wrong moment. The projection is deduped, so the second subscription
     * costs nothing when nothing a button can see has changed.
     */
    const unsubscribes = Object.entries(GRAPHICS).flatMap(([name, entry]) => {
      const bus = entry.bus(bundle);
      const onChange = () => {
        push(name);
        if (name === 'select') armClock();
      };
      return [bus.program.subscribe(onChange), bus.preview.subscribe(onChange)];
    });

    /*
     * The agent-select clock, which is the one thing here that changes with
     * nobody writing anything.
     *
     * The store does not tick, so without this the countdown on a button would
     * freeze at whatever it read when the last pick landed. Armed only while
     * the clock is actually running, and it goes through the same `push`, so
     * once the seconds stop changing it stops sending.
     */
    let clockTick = null;
    function armClock() {
      clearInterval(clockTick);
      clockTick = null;
      if (!bundle.select.program.state.timer.running) return; // air's clock is the one on screen
      clockTick = setInterval(() => push('select', { reason: 'clock' }), 1000);
      clockTick.unref?.();
    }

    // ---- inbound ----------------------------------------------------------

    connection.on('message', (text) => {
      const message = parseCommand(text);
      if (!message) {
        connection.sendJson({ type: 'error', message: 'Send an op name, or a JSON object with an "op".' });
        return;
      }
      try {
        run(message);
      } catch (error) {
        if (error instanceof OpError) {
          connection.sendJson({ type: 'error', op: message.op, message: error.message, ...(message.id ? { id: message.id } : {}) });
          return;
        }
        // A bug in an op must not take a live control channel down.
        log.error('companion', `operation "${message.op}" failed: ${error.message}`, { tournament: owner.id });
        connection.sendJson({ type: 'error', op: message.op, message: 'That operation failed. The server log has the detail.' });
      }
    });

    function run(message) {
      const echo = message.id ? { id: message.id } : {};
      const split = splitOp(message.op);
      // An explicit `graphic` field wins over the prefix, so
      // {"op":"next","graphic":"winner"} works as well as "winner.next".
      const wantedGraphic = message.graphic || split.graphic;
      const bare = String(split.op || message.op || '').trim().toLowerCase();

      // ---- requests that are not operations ----
      if (!wantedGraphic && META_OPS.has(bare)) {
        if (bare === 'ping') return void connection.sendJson({ type: 'pong', ...echo });
        if (bare === 'ops' || bare === 'help') {
          return void connection.sendJson({ type: 'ops', graphics: opCatalogue(), ...echo });
        }
        pushAll('requested');
        return;
      }

      // `{"op":"state","graphic":"winner"}` - one graphic's snapshot.
      if (META_OPS.has(bare) && wantedGraphic) {
        const name = normaliseGraphic(wantedGraphic);
        if (!name) refuse(`No graphic called "${wantedGraphic}". Try scoreboard, winner or select.`);
        push(name, { force: true, reason: 'requested' });
        return;
      }

      const name = normaliseGraphic(wantedGraphic);
      if (!name) {
        refuse(
          wantedGraphic
            ? `No graphic called "${wantedGraphic}". Try scoreboard, winner or select.`
            : 'Name the graphic - "winner.next", not "next". Send "ops" for the list.',
        );
      }

      const op = normaliseOp(name, split.graphic ? split.op : message.op.includes('.') ? split.op : message.op);
      if (!op) refuse(`"${split.op || message.op}" is not something ${name} can do. Send "ops" for the list.`);

      const entry = GRAPHICS[name];
      const bus = entry.bus(bundle);

      /*
       * Ops drive PREVIEW, and `take` is the only thing that reaches an
       * audience. That is the whole point of the feature and it is a change in
       * what these buttons do, so it is worth being blunt: a stream deck that
       * used to put the scoreboard up now stages it.
       *
       * `bus` on the message is the escape hatch, mirroring `?bus=` on the HTTP
       * routes - {"op":"winner.next","bus":"program"} drives air directly, for
       * an operator who wants one button per scene rather than two. Defaults to
       * preview for the same reason a write does: the two ways of being wrong
       * are not comparable.
       */
      const target = busName(message.bus);
      const result = entry.ops[op](bus.of(target), message.value, bus);

      log.info('companion', `${name}.${op} (${target})`, { tournament: owner.id });

      /*
       * The answer is the graphic that was touched, and only that one.
       *
       * Forced, because an operation must always be acknowledged even when it
       * changed nothing a button can see - pressing Sort on an already-sorted
       * roster is a successful press, and a silent one would read as a dead
       * button. The subscription above has usually already sent this; the
       * dedupe means the far end does not get it twice.
       */
      push(name, { force: true, reason: `op:${op}` });
      connection.sendJson({ type: 'ok', graphic: name, op, bus: target, ...(result ?? {}), ...echo });
    }

    // ---- lifecycle --------------------------------------------------------

    connection.on('error', (error) => log.debug('companion', `socket error: ${error.message}`));

    connection.on('close', (reason) => {
      live.delete(connection);
      clearInterval(clockTick);
      for (const stop of unsubscribes) stop();
      log.info('companion', `control channel closed for ${owner.name || owner.id} (${reason})`, { tournament: owner.id });
    });

    /*
     * A hello and a full snapshot, unprompted.
     *
     * Companion reconnects on its own after a server restart or a network
     * blip, and the operator does not press anything to make that happen - so
     * if the lamps only updated on change, every button would sit dark until
     * something moved. State on connect is what makes a reconnect invisible.
     */
    connection.sendJson({
      type: 'hello',
      // So a future purpose-built Companion module can negotiate rather than
      // sniff the shape of what it gets.
      protocol: COMPANION_PROTOCOL,
      session: owner.name || owner.id,
      graphics: Object.keys(GRAPHICS),
      winnerScenes: WINNER_STAGES.map((stage) => stage.label),
    });
    pushAll('connected');
    armClock();
  }

  return {
    handleUpgrade,
    get connectionCount() {
      return live.size;
    },

    /**
     * Drop every channel one account has open.
     *
     * Called when its control key is rotated or withdrawn. Without it the
     * answer to "my control key leaked" would be "restart the broadcast
     * server", because the leaked socket is already past the only check there
     * is.
     */
    closeForOwner(ownerId, reason = 'The control key changed.') {
      let dropped = 0;
      for (const [connection, id] of live) {
        if (id !== String(ownerId)) continue;
        // Each close fires its own handler, which removes it from `live`.
        connection.close(CLOSE.POLICY, reason);
        dropped += 1;
      }
      return dropped;
    },

    closeAll(reason = 'Server shutting down.') {
      for (const connection of live.keys()) connection.close(CLOSE.GOING_AWAY, reason);
      live.clear();
    },
  };
}

// Exported for the suites: the projections are the contract with Companion, and
// a change to one of these key names is a change somebody's buttons depend on.
export { projectScoreboard, projectWinner, projectSelect, normaliseGraphic, normaliseOp, opCatalogue, GRAPHICS };
