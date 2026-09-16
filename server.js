/**
 * VALORANT Broadcast Production Tool - local server.
 *
 * Serves the static UI from ./public and proxies two data providers:
 *
 *   riot     - official Riot Games API      (needs RIOT_API_KEY)
 *   tracker  - tracker.gg website via Playwright (needs TRACKER_ENABLED, no API key)
 *
 * Both are normalised in providers.js so the UI renders them identically.
 * The proxy exists because neither source allows cross-origin browser calls,
 * and API keys must never reach the client.
 *
 * It also hosts the broadcast graphic (see graphics.js): /graphic edits the
 * state, /post-match.html renders it, and they stay in sync over SSE because OBS
 * runs the output page in its own browser process.
 *
 * Zero npm dependencies - Node 18+ built-ins only.
 */

import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  HENRIK_AFFINITIES,
  HENRIK_MODES,
  HENRIK_PLATFORMS,
  ProviderError,
  TRACKER_MATCH_TYPES,
  henrikAccount,
  henrikMatchDetail,
  henrikMatchList,
  makeRiotClient,
  riotMatchDetail,
  riotMatchList,
  trackerMatchDetail,
  trackerMatchList,
} from './providers.js';
import { makeTrackerBrowser } from './browser.js';
import {
  PASSWORD_MIN,
  SESSION_TTL_MS,
  adminCounts,
  canOpenTrackerLogin,
  can,
  isSnowflake,
  usernameProblem,
  makeSessionStore,
  makeUserStore,
  publicUser,
} from './auth.js';
import { makeMediaOwners, makeSessionRegistry } from './sessions.js';
import {
  canEditTournament,
  canViewTournament,
  isTournamentOwner,
  makeTournamentStore,
  tournamentLevel,
} from './tournaments.js';
import { LOG_LEVELS, captureConsole, makeLogger, safeUrl as safeLogUrl } from './log.js';
import { makeCompanionHub } from './companion.js';
import { BUS_KEYS, CUE_WRAP, busName } from './buses.js';
import { refuseUpgrade } from './websocket.js';
import {
  ANIM_TIER_COUNT,
  FONT_CHOICES,
  MEDIA_MAX_BYTES,
  MEDIA_MIME_TYPES,
  PLAYERS_PER_SIDE,
  STAT_SLOTS,
  TEAM_REGIONS,
  WINNER_STAGES,
  WINNER_STAGE_COUNT,
  inDurationMs,
  isOverlayEntry,
  makeAssetCache,
  makeMediaStore,
  makeSettingsStore,
  aliasForPlayer,
  displayName,
  isAgentSelectScene,
  ingestGame,
  graphicPatch,
  ingestRoster,
  ingestLobby,
  clearLobbyState,
  emptyLobby,
  lobbySides,
  matchIdFrom,
  settleSelect,
  stopTimer,
  stageBands,
  stageEnterMs,
} from './graphics.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
/*
 * Where operator state lives.
 *
 * Relative to the checkout by default, which is right for a laptop. A container
 * points it at a mounted volume instead - everything that must survive a
 * redeploy is under this one directory, so the backup story is "copy this" and
 * the upgrade story is "the volume outlives the image".
 */
const STATE_DIR = path.resolve(ROOT, (process.env.STATE_DIR ?? '').trim() || '.state');

/** Riot VAL platform routing hosts - match + content endpoints. */
const PLATFORM_HOSTS = ['ap', 'br', 'esports', 'eu', 'kr', 'latam', 'na'];
/** Riot regional routing hosts - account-v1. */
const ROUTING_HOSTS = ['americas', 'asia', 'esports', 'europe'];
const PROVIDERS = ['henrik', 'riot', 'tracker'];

// ---------------------------------------------------------------- config ---

/** Minimal .env reader. Real environment variables take precedence. */
function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!existsSync(envPath)) return;

  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const splitAt = line.indexOf('=');
    if (splitAt === -1) continue;

    const key = line.slice(0, splitAt).trim();
    const value = line.slice(splitAt + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

function pick(value, allowed, fallback) {
  const candidate = (value ?? '').trim().toLowerCase();
  return allowed.includes(candidate) ? candidate : fallback;
}

const RIOT_API_KEY = (process.env.RIOT_API_KEY ?? '').trim();
const HENRIK_API_KEY = (process.env.HENRIK_API_KEY ?? '').trim();

/*
 * tracker.gg is driven from the public website - no API key. It needs a real
 * browser: the site is Cloudflare-protected and loads matches by XHR.
 *
 * Two switches, and they answer different questions.
 *
 *   TRACKER_ENABLED (environment)  can this machine do it at all? Playwright
 *                                  installed, a Chromium to drive, a profile
 *                                  directory it may write to. A deployment fact,
 *                                  fixed at boot.
 *   settings.tracker (admin panel) should it, right now? An operational one -
 *                                  tracker.gg is throttling, or nobody wants a
 *                                  browser running during a show.
 *
 * Both have to be true. That is why the environment variable did not simply
 * become a setting: an administrator toggling a switch on a server with no
 * Chromium would be told it was on and then watch every lookup fail.
 */
const TRACKER_AVAILABLE = /^(1|true|yes)$/i.test((process.env.TRACKER_ENABLED ?? '').trim());
const TRACKER_HEADLESS = !/^(0|false|no)$/i.test((process.env.TRACKER_HEADLESS ?? 'true').trim());
const TRACKER_CHANNEL = (process.env.TRACKER_BROWSER_CHANNEL ?? 'auto').trim() || 'auto';

/**
 * The one browser, made on demand and dropped when the switch goes off.
 *
 * It used to be a `const` decided at boot, which is exactly what could not
 * survive a runtime toggle. Made lazily rather than eagerly so that switching
 * tracker off and leaving it off costs nothing at all - no Chromium, no profile
 * lock, no memory - which is half the reason an administrator would want the
 * switch.
 */
let browser = null;

function trackerBrowser() {
  if (!TRACKER_AVAILABLE || !settings.state.tracker) return null;
  browser ??= makeTrackerBrowser({
    headless: TRACKER_HEADLESS,
    timeoutMs: Number(process.env.TRACKER_TIMEOUT_MS ?? 45_000),
    channel: TRACKER_CHANNEL,
  });
  return browser;
}

/** Is the tracker source usable right now? Capability and permission, both. */
const trackerOn = () => TRACKER_AVAILABLE && settings.state.tracker;

/** Is the multi-account post-match watch allowed right now? */
const watchOn = () => settings.state.watch;

/*
 * The Companion control channel.
 *
 * One condition rather than tracker's two, and the asymmetry is the point: a
 * websocket needs nothing of the machine that the server does not already
 * have, so there is no capability to check and no env var that would say
 * anything this does not.
 */
const companionOn = () => settings.state.companion;

/**
 * The log.
 *
 * `LOG_LEVEL=debug` is the verbose mode: every request with its timing, every
 * SSE connection opening and closing, every state save. `info` is the default
 * and is what a show should produce - who signed in, what went on air, what the
 * game feed said, and anything that failed.
 *
 * An administrator can raise or lower it at runtime from the Admin tab, because
 * the moment you want debug output is the moment you cannot afford to restart
 * the server.
 */
const logger = makeLogger({
  level: (process.env.LOG_LEVEL ?? 'info').trim().toLowerCase(),
  capacity: Number(process.env.LOG_BUFFER ?? 500),
});

// Anything written with console.warn or console.error - the state stores report
// a failed save that way - joins the buffer the admin panel reads. Installed
// after the logger, which captured the real console functions on construction.
captureConsole(logger);

/** Kept as a short name because it is used on nearly every other line below. */
const log = logger;

/**
 * Why tracker is unavailable, said in the terms of whoever can fix it.
 *
 * "Disabled" is the same word for two different problems - one an administrator
 * solves in the panel, the other somebody solves with an environment variable
 * and a restart. An operator staring at a failed lookup should be told which.
 */
const trackerOffReason = () =>
  TRACKER_AVAILABLE
    ? 'The tracker.gg source is switched off. An administrator can turn it back on under Admin > Server settings.'
    : 'The tracker.gg source is not available on this server. TRACKER_ENABLED is not set in its environment.';
/*
 * Where to listen, and whether the login cookie insists on HTTPS.
 *
 * The default is still loopback: run it on your own machine and nothing outside
 * it can reach the port, which is what a studio wants. A container has to bind
 * 0.0.0.0 or Docker's port publishing has nothing to forward to, so the image
 * sets HOST - it is a deployment decision and it should have to be made out
 * loud, not inherited from a default.
 *
 * COOKIE_SECURE follows the same shape. Behind the tunnel the browser only ever
 * speaks https, so the cookie should refuse to travel any other way; on
 * http://127.0.0.1 a Secure cookie is silently dropped and nobody can log in.
 */
const HOST = (process.env.HOST ?? '127.0.0.1').trim() || '127.0.0.1';
const COOKIE_SECURE = /^(1|true|yes)$/i.test((process.env.COOKIE_SECURE ?? '').trim());

// --------------------------------------------------------- discord sign-in ---

/*
 * Signing in with Discord, where a guild role is the roster.
 *
 * The same two-part shape as tracker.gg above, for the same reason: the switch
 * says whether this server SHOULD offer it, and the five required values say
 * whether it CAN. Both must hold. Collapsing them would mean either a switch
 * that reports "on" while every sign-in fails, or - worse - no way to close the
 * door without deleting the credentials that describe it.
 *
 * Everything here is a deployment fact: an OAuth application, one guild, the
 * roles inside it, and the name this server answers to. None of it is
 * meaningfully typeable into a panel, and sanitiseSettings is boolean-only, so
 * none of it could live in settings.json even if it wanted to.
 */
const DISCORD_SWITCH = /^(1|true|yes)$/i.test((process.env.DISCORD_ENABLED ?? '').trim());
const DISCORD_CLIENT_ID = (process.env.DISCORD_CLIENT_ID ?? '').trim();
const DISCORD_CLIENT_SECRET = (process.env.DISCORD_CLIENT_SECRET ?? '').trim();
const DISCORD_GUILD_ID = (process.env.DISCORD_GUILD_ID ?? '').trim();
const DISCORD_ROLE_NAME = (process.env.DISCORD_ROLE_NAME ?? '').trim() || 'the production role';
const DISCORD_ALLOW_SIGNUP = !/^(0|false|no)$/i.test((process.env.DISCORD_ALLOW_SIGNUP ?? 'true').trim());

/*
 * Role ids, plural.
 *
 * An organisation with two eligible roles - Production and Casters, say - has
 * to be able to say so, and the natural way to try is a comma-separated list.
 * Parsed here rather than matched as one string, because
 * `roles.includes('111...,222...')` is false for every member alive: the whole
 * org would be refused with the same message a correct denial gives, and
 * nothing anywhere would say why.
 */
const parseRoleIds = (raw) =>
  String(raw ?? '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

const DISCORD_ROLES = parseRoleIds(process.env.DISCORD_ROLE_OPERATOR);
const DISCORD_ADMIN_ROLES = parseRoleIds(process.env.DISCORD_ROLE_ADMIN);

/**
 * The public name this server answers to - declared, never derived.
 *
 * Validated hard at boot, because every other way of learning it is wrong here.
 * `Host` and the `X-Forwarded-*` family are set by the caller, and neither
 * documented front end strips them: cloudflared sends no headers at all and the
 * nginx block sets only Host, Upgrade and Connection. Trusting one would hand
 * an attacker the redirect target. HOST and PORT are provably not it either -
 * HOST is 0.0.0.0 in the container and the port is published on the host's
 * loopback, which is why the boot banner already refuses to print the bind
 * address as a URL.
 *
 * @returns {string} the normalised origin, or '' if it cannot be used
 */
function validPublicOrigin(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    // A local studio on a laptop is a real deployment for this tool, so plain
    // http is allowed there and nowhere else.
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return '';
    // A path, query or fragment means somebody pasted the wrong thing, and the
    // redirect URI has to match Discord's allowlist byte for byte.
    if (url.pathname !== '/' || url.search || url.hash) return '';
    return url.origin;
  } catch {
    return '';
  }
}

const DISCORD_PUBLIC_ORIGIN = validPublicOrigin(process.env.DISCORD_PUBLIC_ORIGIN);
const DISCORD_REDIRECT_URI = DISCORD_PUBLIC_ORIGIN ? `${DISCORD_PUBLIC_ORIGIN}/api/auth/discord/callback` : '';

/*
 * Where the two Discord endpoints live. A seam for the test suite, which runs a
 * fake authorization server on loopback - the same `config.baseUrl ?? CONSTANT`
 * shape providers.js already uses. Honoured only for https or loopback http,
 * and whoever can set an environment variable already owns the machine.
 */
function validEndpoint(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    // A path is expected here - the real one is /api/v10 - so unlike the public
    // origin only the scheme is constrained.
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return '';
    return url.href.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

const DISCORD_API_BASE = validEndpoint(process.env.DISCORD_API_BASE) || 'https://discord.com/api/v10';
const DISCORD_AUTHORIZE_URL = validEndpoint(process.env.DISCORD_AUTHORIZE_URL) || 'https://discord.com/oauth2/authorize';

/**
 * The first required value that is absent or unusable, for the boot banner and
 * the health panel. Naming it is the difference between "Discord is off" and
 * twenty minutes of guessing.
 *
 * The role and guild ids get the same validation the origin does, because the
 * alternative is that every misconfiguration - a typo'd guild, a role id with a
 * stray character - collapses into the same "you do not have the role" the
 * gate gives a genuine outsider.
 */
function discordMissing() {
  if (!DISCORD_CLIENT_ID) return 'DISCORD_CLIENT_ID';
  if (!DISCORD_CLIENT_SECRET) return 'DISCORD_CLIENT_SECRET';
  if (!isSnowflake(DISCORD_GUILD_ID)) return 'DISCORD_GUILD_ID';
  if (!DISCORD_ROLES.length || !DISCORD_ROLES.every(isSnowflake)) return 'DISCORD_ROLE_OPERATOR';
  if (DISCORD_ADMIN_ROLES.length && !DISCORD_ADMIN_ROLES.every(isSnowflake)) return 'DISCORD_ROLE_ADMIN';
  if (!DISCORD_PUBLIC_ORIGIN) return 'DISCORD_PUBLIC_ORIGIN';
  return '';
}

const DISCORD_CONFIGURED = discordMissing() === '';

/*
 * Three things have to agree, not two.
 *
 * DISCORD_CONFIGURED  the deployment has an app, a guild, roles and a name
 * DISCORD_SWITCH      the environment says this machine may offer it
 * settings.discord    an administrator has not turned it off just now
 *
 * The first two are fixed at boot and together make the capability; the third
 * is live, because the moment you need the door shut is the moment a restart
 * would take every graphic off air. Same split as tracker.gg, one layer deeper.
 */
const DISCORD_AVAILABLE = DISCORD_SWITCH && DISCORD_CONFIGURED;
const discordOn = () => DISCORD_AVAILABLE && settings.state.discord;

/*
 * The key that signs the flow cookie, minted fresh at boot and never stored.
 *
 * A restart invalidates every sign-in half way through Discord, which is right:
 * they are ten minutes old at most, and the alternative is another secret to
 * keep somewhere.
 */
const DISCORD_HMAC_KEY = randomBytes(32);

const TRACKER_LOGIN_PORT = Number(process.env.TRACKER_LOGIN_PORT ?? 6080);
const TRACKER_LOGIN_TIMEOUT_MS = Number(process.env.TRACKER_LOGIN_TIMEOUT_MS ?? 6 * 60 * 1000);
/*
 * A getter, not a captured value.
 *
 * providers.js reads `config.browser` at the moment it needs one, so this hands
 * it whatever the switch says now rather than whatever it said at boot. The
 * whole point of a runtime toggle is that a value captured once is wrong.
 */
const TRACKER_CONFIG = {
  get browser() {
    return trackerBrowser();
  },
};

/**
 * Who is looking something up right now, shared with every open dashboard.
 *
 * Deliberately not a makeStateStore: this is the state of a request in flight,
 * so it is meaningless across a restart and must never touch the disk. It only
 * has to satisfy the shape streamStores reads - a revision, a state, and a way
 * to subscribe.
 *
 * One slot per session, not one per server. Two operators looking up two
 * different matches at once used to overwrite each other's match list - the
 * feature was "a fetch on one dashboard fills in every other one", which is
 * exactly right within a production and exactly wrong across two of them.
 */
function makeLookupSlot() {
  let revision = 0;
  let state = {
    active: false,
    handle: '',
    type: '',
    startedAt: 0,
    finishedAt: 0,
    outcome: '',
    message: '',
    // The list itself, so every dashboard shows what was just fetched rather
    // than only the operator who asked for it.
    matches: null,
  };
  const listeners = new Set();

  const publish = (next) => {
    state = { ...state, ...next };
    revision += 1;
    for (const listener of listeners) {
      try {
        listener({ revision, state });
      } catch {
        /* a dead connection must not take the lookup down with it */
      }
    }
  };

  return {
    get revision() {
      return revision;
    },
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    started(handle, type) {
      publish({ active: true, handle, type, startedAt: Date.now(), finishedAt: 0, outcome: '', message: '' });
    },
    /**
     * @param {object[]|null} matches the list to share, or null to leave the
     *   last one standing - a match-detail lookup has no list of its own, and
     *   blanking it would clear the dashboards mid-broadcast.
     */
    finished(outcome, message = '', matches = null) {
      publish({ active: false, finishedAt: Date.now(), outcome, message, ...(matches ? { matches } : {}) });
    },
  };
}

/**
 * The last match id the game client reported, for this session.
 *
 * In memory and never on disk, the same call makeLookupSlot makes and for a
 * related reason: this is a hand-off, not a setting. It has to survive a
 * dashboard reload - the stream replays current state to whoever connects, so
 * an operator who opens the tab after the match ended still finds the id
 * waiting - but it must not survive a restart, because a match id repopulating
 * the box an hour later is a prompt to look up a game that is long off air.
 *
 * One slot per session, like the lookup slot. Two operators running two matches
 * are each pointing their own game client at their own key, and an id from one
 * production appearing in the other's box would be worse than useless.
 */
function makeMatchFeed() {
  let revision = 0;
  let state = { matchId: '', receivedAt: 0, count: 0 };
  const listeners = new Set();

  return {
    get revision() {
      return revision;
    },
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /**
     * @returns {boolean} whether this was a new id - a client that re-posts the
     *   same match every few seconds should not keep re-arming the dashboard
     */
    receive(matchId) {
      const fresh = matchId !== state.matchId;

      /*
       * `count` moves even when the id does not.
       *
       * The dashboard only fills the box on a change, but "we heard from the
       * client again" is still worth being able to see - it is the difference
       * between a hook that is wired up and quiet and one that was never wired
       * up at all, which is otherwise indistinguishable from the operator's
       * side at exactly the moment they need to know.
       */
      state = { matchId, receivedAt: Date.now(), count: state.count + 1 };
      revision += 1;
      for (const listener of listeners) {
        try {
          listener({ revision, state });
        } catch {
          /* a dead connection must not take the feed down with it */
        }
      }
      return fresh;
    },
  };
}

/**
 * The staged lobby - what Overwolf saw, and what the operator decided about it.
 *
 * In memory and never on disk, for the reason makeMatchFeed is: this is a
 * hand-off, not a setting. It must survive a dashboard reload, because the
 * stream replays current state to whoever connects; it must not survive a
 * restart, because a roster from an hour ago repopulating the board is a prompt
 * to put the wrong ten names on air.
 *
 * Two boards rather than one, and that is the whole design. `incoming` moves
 * every time the feed says anything; `staged` only moves when the operator
 * presses Stage, and `staged` is the only one the export serves. A single board
 * would mean GStack pulling mid-lobby gets whoever had picked by then - and
 * worse, that the board can change *between* the operator checking it and the
 * key being pressed in VHUD, which is the one moment nothing should move.
 *
 * `swapped` deliberately sits outside both. It is the operator's answer to a
 * question the feed cannot answer - an observer client's `teammate` flag says
 * which side the *reporting* machine was on, which is not a fact about the
 * broadcast - so it applies to whatever board is being looked at and survives
 * re-staging. Having it snapshot with the board would mean every new stage
 * silently un-swapped the sides.
 */
function makeLobbyFeed() {
  let revision = 0;
  let incoming = emptyLobby();
  let staged = null;
  let swapped = false;
  let stagedAt = 0;
  const listeners = new Set();

  const view = () => ({ incoming, staged, swapped, stagedAt });

  const publish = () => {
    revision += 1;
    const state = view();
    for (const listener of listeners) {
      try {
        listener({ revision, state });
      } catch {
        /* a dead connection must not take the feed down with it */
      }
    }
  };

  return {
    get revision() {
      return revision;
    },
    get state() {
      return view();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** One webhook post. Returns what ingestLobby made of it. */
    receive(payload) {
      const result = ingestLobby(incoming, payload);
      // Identity, not `applied`: a post can be accepted and change nothing a
      // seat can see, and repainting every dashboard for that is the cue-counter
      // mistake in a different coat.
      if (result.state !== incoming) {
        incoming = result.state;
        publish();
      }
      return result;
    },

    /** The operator's "this is right". Snapshots incoming for the export. */
    stage() {
      staged = incoming;
      stagedAt = Date.now();
      publish();
      return view();
    },

    /** Which side is which. Applies to both boards - see above. */
    swap() {
      swapped = !swapped;
      publish();
      return view();
    },

    /**
     * Back to nothing.
     *
     * Clears the staged board too. Leaving it behind would mean the export kept
     * serving the last lobby after the operator had visibly emptied the panel,
     * which is the worst kind of stale: it looks cleared.
     */
    clear() {
      incoming = clearLobbyState(incoming);
      staged = null;
      swapped = false;
      stagedAt = 0;
      publish();
      return view();
    },
  };
}

/**
 * A tracker.gg Cloudflare solve any operator can drive from their own browser.
 *
 * The clearance is bound to the IP and user agent that earned it, so the solve
 * has to happen in this container's Chrome. docker/tracker-login-session.sh
 * puts that browser on a throwaway X display and serves it over noVNC; all
 * this has to do is start one at a time, relay the progress, and make sure the
 * viewer does not outlive the solve.
 *
 * ponytail: state lives in this one object, so a restart mid-solve forgets the
 * session. The script's own EXIT trap still tears the browser down, which is
 * the part that matters.
 *
 * Server-wide, and it has to be: there is one Chromium profile and one noVNC
 * port, so this can never be per-session however many accounts exist. What
 * accounts change is who may drive it - see `canSolveTracker`. Everyone is told
 * a solve is running and by whom, because it takes the lookup browser away from
 * them; only the operator who started it and the administrators are told the
 * password, because that password is an interactive desktop on this machine.
 */
const trackerLogin = (() => {
  let revision = 0;
  let state = {
    active: false,
    phase: 'idle',
    message: '',
    webPort: TRACKER_LOGIN_PORT,
    startedAt: 0,
    password: '',
    startedBy: '',
    startedById: '',
  };
  let child = null;
  let timer = null;
  const listeners = new Set();

  const publish = (next) => {
    const before = state.phase;
    state = { ...state, ...next };
    revision += 1;

    /*
     * Every phase change, once.
     *
     * A solve is the one thing here that involves a human staring at a browser
     * for minutes, and when it goes wrong the useful question is always "how
     * far did it get?" - `starting` and no `ready` means the viewer stack never
     * came up, `ready` and no `passed` means nobody cleared the challenge. The
     * password is in `state` and is never in this line.
     */
    if (state.phase !== before) {
      const level = state.phase === 'failed' ? 'warn' : 'info';
      log[level]('tracker', `login ${state.phase}${state.message ? ` - ${state.message}` : ''}`, {
        by: state.startedBy || '-',
      });
    }

    for (const listener of listeners) {
      try {
        listener({ revision, state });
      } catch {
        /* a dead dashboard must not take the solve down with it */
      }
    }
  };

  const stop = () => {
    clearTimeout(timer);
    timer = null;
    if (child) {
      // Negative pid: the whole group, not just the script. SIGTERM so the
      // script's own trap still gets to run - it is what removes the X lock
      // that would otherwise stop the next session starting.
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // Already gone, or never made it into a group of its own.
        child.kill('SIGTERM');
      }
      child = null;
    }
  };

  return {
    get revision() {
      return revision;
    },
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async start(user) {
      if (state.active) throw new ProviderError(409, 'A tracker login is already running.');
      if (!trackerOn()) throw new ProviderError(400, trackerOffReason());

      /*
       * Hand the profile over before starting.
       *
       * The server keeps its own browser warm on the very same profile
       * directory, and Chromium allows exactly one browser per profile. Leave
       * it running and the login's Chrome cannot open the profile at all: the
       * solve dies within seconds, and its teardown closes the viewer while the
       * operator is still watching it connect. The lookup browser reopens by
       * itself on the next request.
       */
      await browser?.close().catch(() => {});

      /*
       * Held in state so the viewer can autoconnect, and redacted on the way
       * out to everyone but the operator who started it and the admins.
       *
       * It used to be broadcast to every dashboard on the grounds that anyone
       * who could see it could start their own session anyway. Accounts remove
       * that premise: what this password opens is a real keyboard and mouse on
       * a real browser on the production machine, which is a bigger thing than
       * a viewer and should not be handed to a "viewer"-level guest who happens
       * to have a dashboard open.
       */
      const password = randomBytes(6).toString('base64url').slice(0, 8);

      // Its own process group, so a cancel can take the whole tree down. The
      // script starts Xvfb, x11vnc and websockify as children: signalling only
      // the script leaves those three running if it dies without its trap.
      child = spawn(path.join(ROOT, 'docker', 'tracker-login-session.sh'), [], {
        env: { ...process.env, VNC_PASSWORD: password, WEB_PORT: String(TRACKER_LOGIN_PORT) },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });

      publish({
        active: true,
        phase: 'starting',
        message: 'Starting the browser...',
        startedAt: Date.now(),
        password,
        startedBy: user?.username ?? '',
        startedById: user?.id ?? '',
      });

      const readLines = (stream) => {
        let buffered = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          buffered += chunk;
          const lines = buffered.split(/\r?\n/);
          buffered = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('STATUS ')) continue;
            const [phase, ...rest] = line.slice('STATUS '.length).split(' ');
            publish({ phase, message: rest.join(' ') });
          }
        });
      };
      readLines(child.stdout);
      readLines(child.stderr);

      child.on('close', (code) => {
        clearTimeout(timer);
        timer = null;
        child = null;

        /*
         * The script reports its own outcome, so this only has to cover the
         * case where it died without saying anything.
         *
         * "closed" counts as a proper ending: pressing Done signals the browser
         * to shut down, which surfaces here as exit 143 (SIGTERM). Reporting
         * that as a failure told operators their solve had not worked when it
         * very likely had.
         */
        const TERMINAL = new Set(['passed', 'failed', 'closed']);
        if (TERMINAL.has(state.phase)) publish({ active: false, password: '' });
        else publish({ active: false, phase: 'failed', message: `the login exited with code ${code}`, password: '' });
      });

      child.on('error', (error) => {
        child = null;
        publish({ active: false, phase: 'failed', message: error.message, password: '' });
      });

      // tracker-login.js waits five minutes for a human; this is that plus room
      // to start up, after which the viewer is not left open indefinitely.
      timer = setTimeout(() => {
        publish({ phase: 'failed', message: 'nobody cleared the challenge in time' });
        stop();
      }, TRACKER_LOGIN_TIMEOUT_MS);

      return { password, webPort: TRACKER_LOGIN_PORT };
    },

    cancel() {
      if (!state.active) return { cancelled: false };
      stop();
      publish({ active: false, phase: 'closed', message: 'browser closed - run a lookup to confirm it took', password: '' });
      return { cancelled: true };
    },
  };
})();

/**
 * Announce a tracker lookup so the other dashboards can show it, and make sure
 * the "finished" always fires - an operator staring at a spinner that a thrown
 * error left running is worse than no indicator at all.
 */
async function announceLookup(lookups, handle, type, run) {
  // A lookup here would relaunch the browser on the profile the solve is using,
  // taking it back mid-challenge and losing both. It is one browser for the
  // whole server, so this waits on anybody's solve, not only your own - hence
  // the message naming who is holding it.
  if (trackerLogin.state.active) {
    const who = trackerLogin.state.startedBy ? ` (${trackerLogin.state.startedBy})` : '';
    throw new ProviderError(409, `A tracker login is in progress${who} - try again once it finishes.`);
  }

  lookups.started(handle, type);
  try {
    const result = await run();
    // Only a match list is worth sharing; a detail lookup answers a question
    // the asking dashboard already has open.
    lookups.finished('ok', '', Array.isArray(result?.matches) ? result.matches : null);
    return result;
  } catch (error) {
    lookups.finished('failed', error?.message ?? 'Lookup failed');
    throw error;
  }
}
const PORT = Number(process.env.PORT ?? 8080);
const DEFAULT_REGION = pick(process.env.RIOT_REGION, PLATFORM_HOSTS, 'na');
const DEFAULT_ROUTING = pick(process.env.RIOT_ROUTING, ROUTING_HOSTS, 'americas');
const DEFAULT_PROVIDER = pick(process.env.DEFAULT_PROVIDER, PROVIDERS, 'henrik');
const DEFAULT_AFFINITY = pick(process.env.HENRIK_AFFINITY, HENRIK_AFFINITIES, 'ap');
const DEFAULT_PLATFORM = pick(process.env.HENRIK_PLATFORM, HENRIK_PLATFORMS, 'pc');

const riotGet = makeRiotClient(RIOT_API_KEY);

/*
 * The two stores that stay server-wide, and why.
 *
 * media  - content-addressed by hash. Two operators uploading the same event
 *          logo get the same file, and every `/media/<hash>.<ext>` URL saved
 *          inside a graphic keeps resolving no matter who is looking at it.
 *          Sharding it per user would break exactly the feature that makes
 *          accounts worth having: handing your session to a colleague.
 * assets - the game's own catalogue of agents and maps. Identical for everyone
 *          by definition, and it is fetched by the output pages, which have no
 *          account at all.
 */
// The administrator's switches. Server-wide, like the two below it, because
// what they decide is what this machine does rather than what one show looks
// like - see public/settings-schema.js.
const settings = makeSettingsStore(path.join(STATE_DIR, 'settings.json'));
const media = makeMediaStore(path.join(STATE_DIR, 'media'));
const mediaOwners = makeMediaOwners(path.join(STATE_DIR, 'media-owners.json'));
const assets = makeAssetCache(path.join(STATE_DIR, 'valorant-assets.json'));
await mediaOwners.load();
await settings.load();

// Accounts, and the login tokens that stand for them. Separate files because
// they have separate lifetimes: signing out everywhere must not touch a
// password, and changing a password must not need the account rewritten.
const users = makeUserStore(path.join(STATE_DIR, 'users.json'));
const logins = makeSessionStore(path.join(STATE_DIR, 'logins.json'));
await users.load();
await logins.load();

/*
 * Tournaments.
 *
 * Server-wide rather than per-session, because it is the index a request is
 * resolved THROUGH - a store that lived inside a session bundle could not be
 * consulted to decide which bundle to open. Same reason users.json is here.
 *
 * Nothing routes to a tournament yet and no graphic reads one. At this stage it
 * is a record and a membership list, and the feature is inert until the stage
 * that gives a tournament a workspace.
 */
const tournaments = makeTournamentStore(path.join(STATE_DIR, 'tournaments.json'));
await tournaments.load();

/*
 * The first administrator, from the environment.
 *
 * There is no "create the first account" page, deliberately: a route that hands
 * out an admin account to whoever reaches it first is a race that a stranger
 * can win, and this server is reachable over a tunnel. Whoever can set an
 * environment variable already owns the machine, so that is the right place for
 * the one credential that has to exist before anybody can log in.
 */
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME ?? '').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
let adminNote = users.count ? `${users.count} account${users.count === 1 ? '' : 's'}` : 'none yet';

if (ADMIN_USERNAME && ADMIN_PASSWORD) {
  const existing = users.byName(ADMIN_USERNAME);
  if (existing) {
    // Present but not re-applied. Rewriting the password on every boot would
    // mean a leaked .env silently undoes a password change made in the UI, and
    // would put the plaintext back in reach of anyone who can read the file.
    adminNote = `${users.count} account${users.count === 1 ? '' : 's'} (${ADMIN_USERNAME} already exists)`;
  } else {
    try {
      /*
       * The first administrator, and the only account that is handed
       * manageTournaments rather than being given it by somebody.
       *
       * Without this a fresh install deadlocks, and it is worth spelling out
       * because every step of it looks right on its own. Permissions default
       * closed, so the new admin has no capabilities. manageTournaments is
       * adminImplied: false, deliberately, because administering accounts and
       * operating a broadcast are different powers. So the administrator cannot
       * create a tournament - and nobody else exists to create one for them, or
       * to grant them the capability. A server with an admin, no production, and
       * no way to make one.
       *
       * This is the same argument that made ADMIN_USERNAME exist at all: there
       * is no "create the first account" page because a route that hands out an
       * admin to whoever reaches it first is a race a stranger can win, so the
       * environment - which only somebody who already owns the machine can set -
       * is where the first grant belongs. The bootstrap grants the capability;
       * it does not create a tournament, because what the first competition is
       * called is not something an environment variable should guess.
       */
      const first = await users.create({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD, role: 'admin' });
      await users.update(first.id, { capabilities: { manageTournaments: true } });
      adminNote = `created administrator "${ADMIN_USERNAME}"`;
    } catch (error) {
      adminNote = `could not create "${ADMIN_USERNAME}": ${error.message}`;
    }
  }
}

/*
 * One set of graphics per account, opened on first use.
 *
 * Everything below this line that used to be a module-level store now comes out
 * of a bundle. The drivers - auto-hide, the winner sequence, the agent-select
 * clock - are wired here rather than in sessions.js because what they do is
 * this file's business; only their lifetime is the registry's.
 */
const sessions = makeSessionRegistry({
  root: STATE_DIR,
  onCreate: installSession,
  log: (tag, message) => log.info(tag, message),
});

/**
 * The Bitfocus Companion control channel.
 *
 * Server-wide, like the tracker browser and unlike a graphic: it is one hub
 * holding every open socket, and each socket is bound to one account's session
 * for its lifetime. Placed after the registry because it resolves a bundle
 * through it, and before the routes because the upgrade listener closes over
 * it.
 */
const companion = makeCompanionHub({
  ownerForKey: (key) => tournaments.resolveControlKey(key),
  bundleFor: (id) => sessions.get(id),
  enabled: companionOn,
  log,
});


// Left where it is, and said out loud on boot. The single-user layout is not
// migrated: a graphic.json from before accounts existed has no owner, and
// guessing one would hand somebody else's production to whoever logs in first.
const legacyState = existsSync(path.join(STATE_DIR, 'graphic.json'));

/**
 * Wire one session's timers, and hand back the way to stop them.
 *
 * These three used to be module-level `let`s with one timer apiece, which is
 * the single most load-bearing assumption multi-user breaks: two productions
 * running at once each need their own auto-hide and their own agent-select
 * clock, and one shared `autoHideTimer` would have the second lobby cancelling
 * the first one's hide. Everything they need is now closed over per bundle.
 *
 * Called by the registry the moment a session opens, so a browser source that
 * connects before its operator has touched anything still gets a live clock.
 */
/**
 * Auto-hide, for one store.
 *
 * Timed here rather than in the output page so that every browser source and
 * the dashboard agree the graphic came down - a page that hid itself would
 * leave the dashboard's Show button claiming it was still on air.
 *
 * The trigger is the cue counter, not `visible`: an operator adjusting the
 * roster during the hold should not keep resetting the clock. The boot value
 * is seeded here so restoring a visible graphic from disk does not count as a
 * cue and immediately hide it.
 *
 * Only ever installed on program. Preview is a thing being looked at rather
 * than a thing playing out, and a staged graphic that vanished eight seconds
 * after the operator brought it up to check it would be a bug, not a feature.
 */
function installAutoHide(store, { session }) {
  let autoHideTimer = null;
  let lastSeenCue = store.state.anim.cue;

  const stop = store.subscribe(({ state }) => {
    const { cue, visible, holdMs } = state.anim;
    if (cue === lastSeenCue) return;
    lastSeenCue = cue;

    /*
     * What went on air, and when.
     *
     * At info, because this is the log line a production actually wants
     * afterwards - "the scoreboard was up from 19:42:11 for eleven seconds" is
     * the answer to most questions asked after a show. The cue is exactly the
     * right trigger: it moves on an operator's intent and not on their typing.
     */
    log.info('air', `scoreboard ${visible ? 'on' : 'off'}`, {
      session,
      ...(visible && holdMs ? { autoHideMs: holdMs } : {}),
    });

    clearTimeout(autoHideTimer);
    autoHideTimer = null;
    if (!visible || !holdMs) return;

    // Measured from the last tier settling, so "hold for 8s" is eight seconds of
    // the graphic fully on screen rather than eight from the button press.
    autoHideTimer = setTimeout(() => {
      autoHideTimer = null;
      const anim = store.state.anim;
      if (!anim.visible) return; // hidden by hand in the meantime
      store.patch({ anim: { ...anim, visible: false, cue: anim.cue + 1 } });
    }, inDurationMs(state.anim, ANIM_TIER_COUNT) + holdMs);

    // A pending auto-hide must not be the reason the process stays alive.
    autoHideTimer.unref?.();
  });

  return () => {
    clearTimeout(autoHideTimer);
    stop();
  };
}

/**
 * The winner sequence driver, for one store.
 *
 * Same reasoning as auto-hide, one step further: the sequence has a position,
 * so something has to decide when scene 1 becomes scene 2. Doing it here
 * rather than in the output page means the dashboard's stage indicator, the
 * preview and every browser source are all reading the same position from the
 * same place - a page that advanced itself would leave three of them guessing.
 *
 * Every automatic move bumps the cue exactly like a button press, so the pages
 * cannot tell the difference and do not need to.
 *
 * `advances` is what differs between the two buses, and it is the whole reason
 * this took an argument:
 *
 *   program   the operator's `autoAdvance` setting. The sequence runs itself
 *             on air exactly as it always has.
 *   preview   only while a rehearsal is running. Preview is manual by default -
 *             next and prev are for stepping through and checking a scene - and
 *             a preview that marched on by itself would never let anybody look
 *             at anything. Play is the opt-in.
 *
 * `onAir` keeps preview out of the air log. That log is the production's record
 * of what an audience saw; a rehearsal in it would be a lie by omission.
 */
function installSequence(store, { session, advances, onAir }) {
  let sequenceTimer = null;
  let lastSeenSeqCue = store.state.seq.cue;

  const clearSequenceTimer = () => {
    clearTimeout(sequenceTimer);
    sequenceTimer = null;
  };

  function scheduleSequence(state) {
    clearSequenceTimer();

    const seq = state.seq;
    if (!seq.active || !advances(seq)) return;

    const stage = WINNER_STAGES[seq.stage];
    if (!stage) return;

    const last = seq.stage >= WINNER_STAGE_COUNT - 1;
    // Nothing left to do: the last scene holds until an operator takes it off.
    if (last && !seq.exitAtEnd) return;

    // Measured from the scene's last band settling, so "hold on the map for 3s"
    // is three seconds of a finished scene rather than three from the cue.
    const bands = stageBands(state, stage.key);
    const wait = stageEnterMs(seq, bands, isOverlayEntry(seq)) + (seq[stage.hold] ?? 0);

    sequenceTimer = setTimeout(() => {
      sequenceTimer = null;
      const current = store.state.seq;
      // Taken over by hand in the meantime - an operator's cue always wins.
      if (!current.active || current.cue !== seq.cue) return;

      store.patch({
        seq: {
          ...current,
          active: !last,
          stage: last ? current.stage : current.stage + 1,
          restart: false,
          // The graphic coming off takes the music with it unless the operator
          // asked for it to carry on underneath whatever follows.
          music: last ? Boolean(store.state.audio.keepPlaying) : current.music,
          cue: current.cue + 1,
        },
      });
    }, wait);

    sequenceTimer.unref?.();
  }

  const stop = store.subscribe(({ state }) => {
    if (state.seq.cue === lastSeenSeqCue) return;
    lastSeenSeqCue = state.seq.cue;
    if (onAir) {
      log.info('air', state.seq.active ? `winner sequence scene ${state.seq.stage + 1}` : 'winner sequence off', {
        session,
      });
    }
    scheduleSequence(state);
  });

  return {
    stop: () => {
      clearSequenceTimer();
      stop();
    },
    /** Re-arm after something outside the store changed whether it may advance. */
    reschedule: () => scheduleSequence(store.state),
  };
}

/**
 * The agent select clock, expired on the server.
 *
 * The bar in the page fills itself off a start stamp and needs no help to look
 * right, so this exists purely to keep the *state* honest: once the 85 seconds
 * are up the clock is not running, and a dashboard opened a minute later
 * should not be told that it is. Without this the graphic would look finished
 * while every readout still claimed it was counting.
 *
 * Keyed on the start stamp rather than a cue, because restarting the clock is
 * the only thing that should ever cancel a pending expiry.
 *
 * Installed on BOTH buses, unlike the other two. This is not an on-air
 * behaviour that preview should be spared - it is the state telling the truth
 * about itself, and a preview whose clock said "running" forty minutes after
 * the draft ended would be wrong on the dashboard an operator is reading.
 */
function installClock(store, { session, onAir }) {
  let timerExpiry = null;
  let lastTimerStart = null;

  const stop = store.subscribe(({ state }) => {
    const { running, startedAt, durationMs } = state.timer;
    if (running && startedAt === lastTimerStart) return;

    clearTimeout(timerExpiry);
    timerExpiry = null;
    // Only a real transition. Every state change on a board whose clock is not
    // running reaches here, so logging "stopped" unconditionally announced the
    // stopping of a clock that had never started - once per roster event.
    const wasRunning = lastTimerStart !== null;
    lastTimerStart = running ? startedAt : null;
    if (onAir && (running || wasRunning)) {
      log.info('air', running ? 'agent select clock started' : 'agent select clock stopped', {
        session,
        ...(running ? { forMs: durationMs } : {}),
      });
    }

    if (!running) return;

    const wait = Math.max(0, startedAt + durationMs - Date.now());
    timerExpiry = setTimeout(() => {
      timerExpiry = null;
      const current = store.state.timer;
      // Restarted or stopped by hand in the meantime - an operator always wins.
      if (!current.running || current.startedAt !== startedAt) return;
      store.replace(stopTimer(store.state, { filled: true }));
    }, wait);

    timerExpiry.unref?.();
  });

  return () => {
    clearTimeout(timerExpiry);
    stop();
  };
}

/**
 * Whether a rehearsal is running, per graphic.
 *
 * In memory, per session, never flushed - the same call makeMatchFeed and
 * makeLookupSlot make, and for a sharper reason here. This is the operator
 * pressing Play to watch the sequence play out at its real timings on preview;
 * it is not a property of the graphic, it must never cross to air on a take,
 * and a server restart mid-rehearsal should leave nothing behind claiming a
 * rehearsal is still running.
 *
 * Kept out of the winner state entirely for that last reason: a `seq.rehearse`
 * field would be copied to program by the very next take.
 */
function makeRehearsal() {
  let revision = 0;
  let state = { winner: false };
  const listeners = new Set();

  return {
    get revision() {
      return revision;
    },
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(graphic, running) {
      if (state[graphic] === running) return state;
      state = { ...state, [graphic]: running };
      revision += 1;
      for (const listener of listeners) listener({ revision, state });
      return state;
    },
  };
}

function installSession(bundle) {
  // Every session gets its own lookup slot - see makeLookupSlot. It is not a
  // persisted store, so the registry does not know about it.
  bundle.lookups = makeLookupSlot();
  // Likewise the match-id feed: in memory, per session, never flushed.
  bundle.matchFeed = makeMatchFeed();
  // And the staged lobby: the Overwolf feed writes it, the operator stages it,
  // the GStack export reads it. Memory only, per session.
  bundle.lobby = makeLobbyFeed();
  // Whether Play is running on a preview. Memory only, and never taken to air.
  bundle.rehearsal = makeRehearsal();

  /*
   * Which drivers each bus gets, and why they differ.
   *
   * Program is the audience's copy and runs everything it always did. Preview
   * is a thing being looked at, so it gets neither auto-hide nor auto-advance -
   * a staged graphic that vanished, or marched on to the next scene, while
   * somebody was checking it would be a bug.
   *
   * The clock is the exception and goes on both, because it is not an on-air
   * behaviour: it is the state telling the truth about itself, and the
   * dashboard reads preview.
   */
  const session = bundle.tournamentId;

  const stopAutoHide = installAutoHide(bundle.graphics.program, { session });

  const airSequence = installSequence(bundle.winner.program, {
    session,
    onAir: true,
    advances: (seq) => seq.autoAdvance,
  });

  const previewSequence = installSequence(bundle.winner.preview, {
    session,
    onAir: false,
    // Only while Play is held down, so to speak. `seq.autoAdvance` is ignored
    // here deliberately - it is the operator's setting for what air should do,
    // not permission for preview to run off on its own.
    advances: () => bundle.rehearsal.state.winner === true,
  });

  /*
   * Starting a rehearsal is a change the store never sees.
   *
   * The sequence driver re-arms on a store event, and pressing Play does not
   * write the winner state - it flips a flag beside it. Without this the
   * rehearsal would not begin until the operator happened to touch something.
   */
  const stopRehearsal = bundle.rehearsal.subscribe(() => previewSequence.reschedule());

  const stopAirClock = installClock(bundle.select.program, { session, onAir: true });
  const stopPreviewClock = installClock(bundle.select.preview, { session, onAir: false });

  bundle.teardown.push(() => {
    stopAutoHide();
    airSequence.stop();
    previewSequence.stop();
    stopRehearsal();
    stopAirClock();
    stopPreviewClock();
  });
}

/**
 * Flush everything a session holds. Called on shutdown and on eviction.
 *
 * All SEVEN stores. It was six, and the missing one was aliases - which is the
 * store written most often without anybody pressing anything, because every
 * roster event records the players it saw. A restart could therefore drop the
 * last lobby's sightings, or a name typed a second earlier, with the write half
 * done and nothing said.
 */
const flushSession = (bundle) =>
  Promise.all([
    bundle.graphics.flush(),
    bundle.winner.flush(),
    bundle.select.flush(),
    bundle.globals.flush(),
    bundle.presets.flush(),
    bundle.teams.flush(),
    bundle.aliases.flush(),
  ]).catch(() => {});

// ----------------------------------------------------------------- riot ---

function splitRiotId(riotId) {
  const value = (riotId ?? '').trim();
  if (!value.includes('#')) {
    throw new ProviderError(400, 'Riot ID must include a tagline.', 'Use the full form, for example: TenZ#SEN');
  }

  const splitAt = value.lastIndexOf('#');
  const gameName = value.slice(0, splitAt).trim();
  const tagLine = value.slice(splitAt + 1).trim();

  if (!gameName || !tagLine) throw new ProviderError(400, 'Riot ID must look like Name#TAG.', 'Example: TenZ#SEN');
  return { gameName, tagLine };
}

// --------------------------------------------------------------- routes ---

async function handleApi(pathname, params, ctx) {
  // The session being read. Resolved by the gate, which has already checked
  // that whoever is asking is allowed to see it - by that point this is just
  // the set of stores to answer from.
  const { globals, aliases, presets, teams, lookups, lobby } = ctx.bundle ?? {};
  // Reads answer for whichever bus was asked for, defaulting to air - see
  // busFor. `?bus=preview` is what the dashboard will ask for from stage 4.
  const readBus = busFor(params);
  const graphics = ctx.bundle?.graphics?.of(readBus);
  const winner = ctx.bundle?.winner?.of(readBus);
  const select = ctx.bundle?.select?.of(readBus);

  // The configured default, unless it is the source an administrator has just
  // switched off - in which case falling back to it would break every lookup
  // that did not name a provider of its own.
  const fallbackProvider = DEFAULT_PROVIDER === 'tracker' && !trackerOn() ? 'henrik' : DEFAULT_PROVIDER;
  const provider = pick(params.get('provider'), PROVIDERS, fallbackProvider);
  const region = pick(params.get('region'), PLATFORM_HOSTS, DEFAULT_REGION);
  const affinity = pick(params.get('affinity'), HENRIK_AFFINITIES, DEFAULT_AFFINITY);
  const platform = pick(params.get('platform'), HENRIK_PLATFORMS, DEFAULT_PLATFORM);

  const requestedType = params.get('type') ?? '';
  const allowedTypes = provider === 'henrik' ? HENRIK_MODES : TRACKER_MATCH_TYPES;
  const type = allowedTypes.includes(requestedType) ? requestedType : 'custom';

  /*
   * The two administrator switches, enforced here rather than in the browser.
   *
   * Hiding a panel is a courtesy to an operator, not a control: the routes are
   * reachable by anyone with an account and a URL bar, and "the watch is off"
   * has to mean the server will not run one. The watch marks its own requests
   * because it has no route of its own - it is ordinary lookups, five at a
   * time, and five at a time is exactly the thing being switched off.
   */
  if (provider === 'tracker' && !trackerOn()) throw new ProviderError(400, trackerOffReason());
  if (params.get('watch') === '1' && !watchOn()) {
    throw new ProviderError(
      403,
      'Post-match lookup across several accounts is switched off on this server.',
      'An administrator can turn it back on under Admin > Server settings.',
    );
  }

  switch (pathname) {
    case '/api/config':
      return {
        providers: PROVIDERS,
        provider: fallbackProvider,
        hasRiotKey: Boolean(RIOT_API_KEY),
        // Named for what the lookup tab does with it - show the source or grey
        // it out - so an administrator's switch and a missing Playwright reach
        // the UI as the same fact, which is the only fact it can act on.
        hasTrackerKey: trackerOn(),
        hasHenrikKey: Boolean(HENRIK_API_KEY),
        // What the two administrator switches say, for the panels that have to
        // hide themselves. The server refuses either way; this is so an
        // operator is not offered a button that cannot work.
        trackerEnabled: trackerOn(),
        trackerAvailable: TRACKER_AVAILABLE,
        watchEnabled: watchOn(),
        region: DEFAULT_REGION,
        routing: DEFAULT_ROUTING,
        regions: PLATFORM_HOSTS,
        routings: ROUTING_HOSTS,
        matchTypes: TRACKER_MATCH_TYPES,
        affinity: DEFAULT_AFFINITY,
        affinities: HENRIK_AFFINITIES,
        platform: DEFAULT_PLATFORM,
        platforms: HENRIK_PLATFORMS,
        henrikModes: HENRIK_MODES,
        fonts: FONT_CHOICES,
        playersPerSide: PLAYERS_PER_SIDE,
        statSlots: STAT_SLOTS,
        // Distinct from `regions` above, which is Riot's platform routing.
        teamRegions: TEAM_REGIONS,
        mediaMaxBytes: MEDIA_MAX_BYTES,
      };

    case '/api/valorant-assets':
      return assets.get();

    /*
     * The staged lobby, in the shape GStack's "GET JSON" reads.
     *
     * This is the one route here written to somebody else's schema, and the
     * names are theirs: VHUD.exe parses `attackers` / `defenders`, each player
     * as `displayName` + `lockedAgentCharacterId`, and it matches the agent on
     * the *uuid*. Getting a name into the right seat is therefore two joins -
     * the UI order onto the roster, then the internal agent name onto the
     * catalogue - and neither of the two programs at the ends of this pipe can
     * do either, because only this one holds the valorant-api catalogue.
     *
     * GET only, deliberately. It is in KEYED_ROUTES so VHUD can reach it with
     * the same key as the output pages, and that list ends "a key shows a
     * graphic and feeds it a lobby; it does not operate the desk" - reading a
     * staged board is showing, and it is exactly as much as a key should buy.
     * Nothing here writes, so the open question hanging over keyed POSTs to
     * /api/graphic does not get a second instance.
     *
     * Serves `staged` and never `incoming`: the export must not change between
     * an operator checking the board and somebody pressing the key in VHUD.
     * Before the first Stage it answers with empty sides rather than 404, so a
     * misconfigured URL and an unstaged board look different from VHUD's end.
     */
    case '/api/gstack': {
      const { staged, swapped, stagedAt } = lobby.state;
      const catalogue = await assets.get().catch(() => null);
      const sides = lobbySides(staged ?? emptyLobby(), catalogue?.agents ?? [], { swapped });

      const absolute = (value) => {
        const raw = String(value ?? '').trim();
        if (!raw) return '';
        return /^https?:\/\//i.test(raw) ? raw : `${ctx.origin}${raw.startsWith('/') ? '' : '/'}${raw}`;
      };

      const side = (players) =>
        players
          .filter((player) => player.filled)
          .map((player) => ({
            // The alias library resolved here rather than at ingest, so a name
            // an operator fixes after the lobby landed is used by the very next
            // pull instead of needing the feed to say it again.
            displayName: displayName(player.riotId, aliases.aliasFor(player.playerId, player.riotId)),
            lockedAgentCharacterId: player.agentUuid,
            player: player.riotId,
          }));

      const team = (half) => {
        const entry = half.teamId ? teams.get(half.teamId) : null;
        return {
          name: half.teamName ?? '',
          // The tricode lives in the library, not on the graphic - the graphic
          // only keeps the id it was picked from.
          shortForm: entry?.shortName ?? '',
          logo: absolute(half.logo),
          score: half.roundsWon ?? 0,
        };
      };

      const left = team(graphics.state.left);
      const right = team(graphics.state.right);

      return {
        attackers: side(sides.left),
        defenders: side(sides.right),
        attackerTeam: left.name,
        attackerTeamShortForm: left.shortForm,
        attackerTeamLogo: left.logo,
        attackerTeamScore: left.score,
        defenderTeam: right.name,
        defenderTeamShortForm: right.shortForm,
        defenderTeamLogo: right.logo,
        defenderTeamScore: right.score,
        // Not ours to know. Sent as the shape expects so the parse does not
        // fall over, and left at the values that mean "still playing".
        bestOf: 0,
        completed: false,
        winner: '',
        // Ours, not GStack's, and ignored by it. Here because the first
        // question about a pull that looked wrong is "which board was that".
        stagedAt,
        staged: Boolean(staged),
      };
    }

    case '/api/graphic':
      return { revision: graphics.revision, state: graphics.state };

    case '/api/winner':
      return { revision: winner.revision, state: winner.state };

    case '/api/select':
      return { revision: select.revision, state: select.state };

    case '/api/global':
      return { revision: globals.revision, state: globals.state };

    case '/api/aliases':
      // The pending list rides along: it is derived from the same records, and a
      // second round trip to ask "anything to confirm?" would only ever be made
      // at exactly the moments this one already is.
      return { players: aliases.list(), pending: aliases.pending() };

    case '/api/presets':
      return { presets: presets.list(), activeId: graphics.state.presetId };

    case '/api/teams':
      return { teams: teams.list() };

    case '/api/media': {
      /*
       * This tournament's uploads, plus your own. The files are shared - the
       * list of them is not, or every picker would be a window into every other
       * production's artwork.
       *
       * Both axes, matching the claim on upload. One alone gets it wrong in
       * opposite directions: filtering only by tournament hides the logo you
       * uploaded last season and want again, and filtering only by person hides
       * the one your colleague uploaded to the tournament you are both working
       * on. Neither failure raises anything - the bytes still serve and every
       * saved graphic still renders - so it reads as artwork going missing.
       */
      const all = await media.list();
      const mine = new Set(mediaOwners.filter(ctx.user?.id, all).map((entry) => entry.name));
      const here = mediaOwners.filter(ctx.owner?.id, all);
      for (const entry of here) mine.add(entry.name);
      return { media: all.filter((entry) => mine.has(entry.name)) };
    }

    case '/api/account': {
      const { gameName, tagLine } = splitRiotId(params.get('riotId'));

      if (provider === 'henrik') {
        return henrikAccount(HENRIK_API_KEY, { gameName, tagLine });
      }

      // tracker.gg is keyed on the Riot ID itself - no puuid lookup needed,
      // so this pathway works without a Riot key at all.
      if (provider === 'tracker') {
        return { gameName, tagLine, puuid: null, handle: `${gameName}#${tagLine}` };
      }

      const routing = pick(params.get('routing'), ROUTING_HOSTS, DEFAULT_ROUTING);
      return riotGet(
        routing,
        `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
      );
    }

    case '/api/matches': {
      if (provider === 'henrik') {
        const { gameName, tagLine } = splitRiotId(params.get('handle'));
        return henrikMatchList(HENRIK_API_KEY, {
          gameName,
          tagLine,
          affinity,
          platform,
          mode: type,
          puuid: (params.get('puuid') ?? '').trim() || null,
        });
      }

      if (provider === 'tracker') {
        const handle = (params.get('handle') ?? '').trim();
        if (!handle) throw new ProviderError(400, 'Missing Riot ID handle.');
        return announceLookup(lookups, handle, type, () => trackerMatchList(TRACKER_CONFIG, { handle, type }));
      }

      const puuid = (params.get('puuid') ?? '').trim();
      if (!puuid) throw new ProviderError(400, 'Missing puuid.');
      return riotMatchList(riotGet, { puuid, region });
    }

    case '/api/match': {
      const matchId = (params.get('matchId') ?? '').trim();
      if (!matchId) throw new ProviderError(400, 'Missing matchId.');

      if (provider === 'henrik') {
        return henrikMatchDetail(HENRIK_API_KEY, { matchId, affinity });
      }

      if (provider === 'tracker') {
        /*
         * The handle is optional here, and only here.
         *
         * A match list needs a profile to read - there is nowhere else a list
         * of somebody's games exists. A single match does not: tracker's own
         * backend answers on the id alone, and so does the match page. All the
         * handle buys is the third fallback, which reads the id back out of a
         * cached profile list, so its absence costs one retry route and nothing
         * else. That is what lets the match-id hook hand an operator a game
         * nobody has searched for yet.
         */
        const handle = (params.get('handle') ?? '').trim();
        // The id is the useful label when there is no handle - it is what the
        // other dashboards see in the "looking up" indicator.
        return announceLookup(lookups, handle || matchId, type, () =>
          trackerMatchDetail(TRACKER_CONFIG, { matchId, handle, type }),
        );
      }

      return riotMatchDetail(riotGet, { matchId, region });
    }

    default:
      throw new ProviderError(404, `No such API route: ${pathname}`);
  }
}

// --------------------------------------------------------------- static ---

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(pathname, res, method = 'GET') {
  // Inside the try, not before it: decodeURIComponent throws on a malformed
  // escape, and this used to be the outermost statement of an async handler -
  // so `GET /%ZZ` became an unhandled rejection, which under Node's default
  // means the process exits. One stranger, one request, broadcast over.
  let target;
  try {
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    target = path.resolve(PUBLIC_DIR, relative);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400 - bad request');
  }

  // Block path traversal outside ./public.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 - forbidden');
  }

  try {
    const file = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': file.length,
      'Cache-Control': 'no-store',
    });
    res.end(method === 'HEAD' ? undefined : file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 - not found');
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// ------------------------------------------------------- graphic plumbing ---

const MAX_BODY_BYTES = 256 * 1024;

/**
 * Read a request body into one buffer, refusing anything over `limit`.
 *
 * Once over the limit the rest is drained rather than kept, and the socket is
 * left open: tearing it down here would reach the browser as a network failure
 * instead of as the 413 that says which limit was hit and by how much. The drain
 * has its own ceiling so a client that ignores the response cannot stream for
 * ever into a request nobody is going to answer.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let refused = false;

    req.on('data', (chunk) => {
      size += chunk.length;

      if (refused) {
        if (size > limit * 4) req.destroy();
        return;
      }

      if (size > limit) {
        refused = true;
        chunks.length = 0;
        reject(new ProviderError(413, `Payload too large - the limit is ${Math.round(limit / 1024)} KB.`));
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!refused) resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (!refused) reject(error);
    });
  });
}

async function readJsonBody(req) {
  const raw = (await readBody(req, MAX_BODY_BYTES)).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ProviderError(400, 'Payload was not valid JSON.');
  }
}

/**
 * Preset actions. Applying one writes into the live graphic, which is what
 * pushes it out to every open output source; the others only touch the library.
 */
async function handlePresetAction({ graphics, presets }, body) {
  const action = String(body?.action ?? '');
  const id = String(body?.id ?? '');

  switch (action) {
    case 'apply': {
      const entry = presets.get(id);
      if (!entry) throw new ProviderError(404, `No preset called "${id}".`);
      // Only the styling block moves - never the scoreboard on air.
      graphics.patch({ preset: entry.preset, presetId: entry.id });
      break;
    }

    case 'save': {
      const saved = presets.save({ id: body?.id ?? null, name: body?.name, preset: body?.preset });
      // Adopt it so the dashboard shows the new preset as the active one.
      graphics.patch({ preset: saved.preset, presetId: saved.id });
      await presets.flush();
      return { presets: presets.list(), activeId: saved.id, saved };
    }

    case 'delete': {
      if (!presets.remove(id)) throw new ProviderError(400, 'That preset cannot be deleted.');
      await presets.flush();
      break;
    }

    default:
      throw new ProviderError(400, `Unknown preset action: ${action || '(none)'}`);
  }

  return { presets: presets.list(), activeId: graphics.state.presetId };
}

/**
 * Team library actions. Saving or deleting a team never touches a graphic: the
 * fields were copied on the way in, so what is on air stays on air.
 */
async function handleTeamAction({ teams }, body) {
  const action = String(body?.action ?? '');

  switch (action) {
    case 'save': {
      const saved = teams.save(body?.team ?? {});
      await teams.flush();
      return { teams: teams.list(), saved };
    }

    case 'delete': {
      if (!teams.remove(String(body?.id ?? ''))) throw new ProviderError(404, 'No such team.');
      await teams.flush();
      return { teams: teams.list() };
    }

    /*
     * A library file from another desk, folded in.
     *
     * The whole payload lands in one store call and one write. It ADDS and
     * UPDATES and never removes, so a 12-team file cannot delete the 30 orgs it
     * does not mention - the panel promises that and `import()` is what keeps
     * the promise. Nothing here touches a graphic: a team is copied onto the
     * scoreboard when it is picked, and `teamId` is never dereferenced at
     * render, so importing cannot change anything already on air.
     */
    case 'import': {
      const incoming = Array.isArray(body?.teams) ? body.teams : [];
      if (!incoming.length) throw new ProviderError(400, 'That file had no teams in it.');
      if (incoming.length > 500) throw new ProviderError(400, 'That file has more than 500 teams in it.');

      const result = teams.import(incoming);
      await teams.flush();
      return { teams: result.teams, added: result.added, updated: result.updated };
    }

    default:
      throw new ProviderError(400, `Unknown team action: ${action || '(none)'}`);
  }
}

/**
 * Player alias actions.
 *
 * Saving an alias re-resolves the names on any card that came from the feed, so
 * naming somebody mid-lobby fixes the strip that is already on air rather than
 * waiting for their next event. Cards typed by hand have no player id and are
 * left exactly as they are - an operator's own words are not the library's to
 * overwrite.
 */
/**
 * Copy whatever is shared onto the graphics that are following it.
 *
 * Patches only the keys that actually differ, so a save that changed the event
 * logo does not also re-push a map nobody touched - every push is an SSE frame
 * to every browser source, and a graphic that repaints for no reason is a
 * graphic that can flicker on air.
 *
 * @returns {string[]} the graphics that changed, for the caller to report.
 */
function pushGlobal({ graphics, winner, select, globals }) {
  /*
   * Onto PREVIEW, and only preview.
   *
   * The Global tab is where an operator sets the map, the event logo and the
   * colour source once for the production, and those are staged data like any
   * other - a map typed there must not appear on air before the operator says
   * so. The take is what carries them across, per graphic, like everything else.
   *
   * This also removes a whole class of surprise: with the push landing on air,
   * touching Global would have been the one edit in the dashboard that went
   * live immediately, which is exactly the kind of exception nobody remembers
   * at the wrong moment.
   */
  graphics = graphics.preview;
  winner = winner.preview;
  select = select.preview;
  const pushed = [];
  for (const [name, store] of [['graphic', graphics], ['winner', winner], ['select', select]]) {
    const patch = graphicPatch(globals.state, name, store.state);
    if (!patch) continue;
    store.patch(patch);
    pushed.push(name);
  }
  return pushed;
}

async function handleAliasAction({ graphics, select, aliases }, body) {
  const action = String(body?.action ?? '');

  const reresolve = () => {
    const slots = select.state.slots.map((slot) =>
      slot.playerId ? { ...slot, name: displayName(slot.riotId, aliases.aliasFor(slot.playerId, slot.riotId)) } : slot,
    );
    if (slots.some((slot, index) => slot.name !== select.state.slots[index].name)) select.patch({ slots });

    /*
     * And the scoreboard, for the same reason. A post-match board is on air for
     * minutes rather than seconds, so it is the graphic an operator is most
     * likely to be looking at when they notice a name is wrong.
     *
     * Matched on either key: an imported row may carry a puuid, a Riot ID, or -
     * from tracker.gg - only the second. A row with neither was typed by hand
     * and is left alone.
     */
    const library = aliases.list();
    const patch = {};
    for (const half of ['left', 'right']) {
      const current = graphics.state[half];
      const players = current.players.map((player) => {
        if (!player.playerId && !player.riotId) return player;
        // displayName is the same rule the strip uses: the alias if there is
        // one, otherwise the Riot ID without its tagline - so deleting an alias
        // undoes it rather than leaving the old name behind.
        const next = displayName(player.riotId, aliasForPlayer(library, player)) || player.name;
        return next === player.name ? player : { ...player, name: next };
      });
      if (players.some((player, index) => player !== current.players[index])) {
        // patch is a shallow merge of top-level keys, so the whole side goes.
        patch[half] = { ...current, players };
      }
    }
    if (Object.keys(patch).length) graphics.patch(patch);
  };

  switch (action) {
    case 'save': {
      const players = aliases.save(body?.player ?? {});
      reresolve();
      return { players, pending: aliases.pending() };
    }

    case 'delete': {
      const players = aliases.remove(String(body?.key ?? body?.id ?? ''));
      reresolve();
      return { players, pending: aliases.pending() };
    }

    /*
     * The two answers to "is this hand-written alias this player?".
     *
     * Asked rather than assumed, because a Riot ID is not a stable identity -
     * people rename themselves, and two events can both have a Jett. A name
     * match is enough to raise the question and never enough to settle it.
     */
    case 'link': {
      const players = aliases.link(String(body?.key ?? ''), String(body?.playerId ?? ''));
      reresolve();
      return { players, pending: aliases.pending() };
    }

    case 'reject': {
      const players = aliases.reject(String(body?.key ?? ''), String(body?.playerId ?? ''));
      reresolve();
      return { players, pending: aliases.pending() };
    }

    /*
     * A library file from another desk, folded in.
     *
     * Adds and updates; never removes. That matters more here than for teams,
     * because `reresolve()` below rewrites both scoreboard sides and every
     * select slot from whatever the library now holds - so a swap would revert
     * every name it dropped to a raw Riot ID, in one frame, live. An import
     * also leaves `rejected` and `seenAt` alone on records that already exist:
     * those are answers somebody gave at THIS desk about who a player is not,
     * and the file has no business overwriting them.
     *
     * reresolve() runs once at the end rather than per row, so a hundred names
     * cost at most three SSE frames instead of three hundred.
     */
    case 'import': {
      const incoming = Array.isArray(body?.players) ? body.players : [];
      if (!incoming.length) throw new ProviderError(400, 'That file had no named players in it.');
      if (incoming.length > 1000) throw new ProviderError(400, 'That file has more than 1000 players in it.');

      let result;
      try {
        result = aliases.import(incoming);
      } catch (error) {
        // The alias cap is the one refusal an operator can act on, so it comes
        // back as a message rather than a 500.
        throw new ProviderError(400, error.message);
      }

      await aliases.flush();
      reresolve();
      return { players: result.players, pending: aliases.pending(), added: result.added, updated: result.updated };
    }

    case 'clear-unnamed':
      return { players: aliases.clearUnnamed(), pending: aliases.pending() };

    default:
      throw new ProviderError(400, `Unknown alias action: ${action || '(none)'}`);
  }
}

/**
 * Server-sent events, one connection per output source. OBS keeps the page
 * open for the whole broadcast, so the heartbeat exists to stop an idle proxy
 * or the OS from quietly dropping a connection that then never updates again.
 *
 * @param {string} name the SSE event name the page listens for
 */
let streamCount = 0;

function streamStores(entries, req, res) {
  streamCount += 1;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const unsubscribes = entries.map(([name, store]) => {
    const send = ({ revision, state }) => {
      res.write(`event: ${name}\ndata: ${JSON.stringify({ revision, state })}\n\n`);
    };
    send({ revision: store.revision, state: store.state });
    return store.subscribe(send);
  });

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);

  let stopped = false;
  const stop = () => {
    if (stopped) return; // close and error both fire on a dropped connection
    stopped = true;
    streamCount -= 1;
    clearInterval(heartbeat);
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
  req.on('close', stop);
  res.on('error', stop);
}

const streamState = (store, name, req, res) => streamStores([[name, store]], req, res);

/**
 * Uploads are the one thing served from outside ./public, so they get their own
 * handler rather than a second static root.
 *
 * The two headers are what make it safe to accept SVG at all: nosniff stops a
 * mislabelled file being reinterpreted, and a `default-src 'none'` policy means
 * script inside an SVG has nothing it is allowed to do even if the file is
 * opened directly rather than drawn into an <img>.
 */
async function serveMedia(pathname, res, method = 'GET') {
  // Same reasoning as serveStatic: a malformed escape must be a 404, not an
  // exit code.
  let target = null;
  try {
    target = media.resolve(decodeURIComponent(pathname.slice('/media/'.length)));
  } catch {
    target = null;
  }

  if (!target) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 - not found');
  }

  try {
    const file = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MEDIA_MIME_TYPES[path.extname(target).slice(1).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': file.length,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      // Named after their own hash, so a given URL is always the same bytes.
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    res.end(method === 'HEAD' ? undefined : file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 - not found');
  }
}

/** POST bodies all answer the same way, so the error shape is written once. */
async function handleWrite(res, work) {
  try {
    return sendJson(res, 200, await work());
  } catch (error) {
    const status = error instanceof ProviderError ? error.status : 400;
    // The hint travels too. ProviderError has carried one since it was written
    // and the read path at the bottom of this file sends it, but this - the
    // path every write takes - dropped it, so the half of the message that says
    // what to do about it never reached anybody.
    return sendJson(res, status, { error: { status, message: error.message, hint: error.hint ?? '' } });
  }
}

// ------------------------------------------------------------- accounts ---

const COOKIE_NAME = 'rl_session';

/**
 * Cookies, parsed by hand.
 *
 * One header, one syntax, and the only cookie this server sets is its own -
 * a parser that gets confused by somebody else's is not a risk worth a
 * dependency. Anything malformed is skipped rather than thrown on: a stale
 * cookie from another app on the same host must not 500 the dashboard.
 */
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return '';
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      return part.slice(at + 1).trim();
    }
  }
  return '';
}

/**
 * The login cookie.
 *
 * HttpOnly so a script on the page cannot read it - the whole reason the token
 * is not in localStorage. SameSite=Lax is what closes the CSRF hole the survey
 * found: this server reads JSON bodies without checking Content-Type, so a form
 * on another site could POST to it, and Lax means the browser sends no cookie
 * on that request. Secure is conditional because the tool is also run on plain
 * http://127.0.0.1 in a studio, and a Secure cookie there is simply dropped.
 */
const sessionCookie = (token, { maxAgeSec = Math.floor(SESSION_TTL_MS / 1000) } = {}) =>
  [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
    ...(COOKIE_SECURE ? ['Secure'] : []),
  ].join('; ');

const clearedCookie = () => `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

// ------------------------------------------------- the discord flow cookie ---

const FLOW_COOKIE = 'rl_oauth';
const FLOW_TTL_MS = 10 * 60 * 1000;

/*
 * The fourth secret in this system, and the shortest-lived.
 *
 * A sign-in leaves this origin, spends time on discord.com and comes back, so
 * something has to survive the round trip and say what the flow was for. It
 * carries the CSRF state, the PKCE verifier, where to go afterwards, and - for
 * a link - which account asked. It is HttpOnly, path-scoped to the callback,
 * ten minutes old at most, and never written to disk.
 *
 * Signed rather than stored, so that an anonymous GET to /start allocates
 * nothing on the server and cannot be used to exhaust anything. What it CANNOT
 * do is enforce its own single use - clearing a cookie is an instruction to a
 * browser, and a script that ignores Set-Cookie keeps a working flow for the
 * full ten minutes. That is what `spentFlows` below is for, and the ordering
 * matters: the record is only allocated once a caller has proved they hold a
 * cookie this server signed.
 */
const signFlow = (body) => createHmac('sha256', DISCORD_HMAC_KEY).update(body).digest('base64url');

function discordFlowCookie(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return [
    `${FLOW_COOKIE}=${body}.${signFlow(body)}`,
    'Path=/api/auth/discord',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(FLOW_TTL_MS / 1000)}`,
    ...(COOKIE_SECURE ? ['Secure'] : []),
  ].join('; ');
}

const clearedFlowCookie = () => `${FLOW_COOKIE}=; Path=/api/auth/discord; HttpOnly; SameSite=Lax; Max-Age=0`;

/** Constant-time, and length-checked first because unequal buffers throw. */
function sameSecret(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  // `timingSafeEqual` raises RangeError on a length mismatch, and the received
  // side's length is chosen by the caller. Inside an async handler that became
  // a 500 with the whole query string logged at error level. Comparing lengths
  // of two random nonces first discloses nothing.
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** The flow this request is part of, or null if it has none we signed. */
function readDiscordFlow(req) {
  const raw = readCookie(req, FLOW_COOKIE);
  if (!raw) return null;

  const at = raw.lastIndexOf('.');
  if (at <= 0) return null;

  const body = raw.slice(0, at);
  if (!sameSecret(raw.slice(at + 1), signFlow(body))) return null;

  try {
    const flow = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    // An expiry inside the signed payload as well as on the cookie: the cookie's
    // Max-Age is enforced by the browser, and a browser is exactly what an
    // attacker is not obliged to be.
    if (!flow || typeof flow !== 'object' || !Number.isFinite(flow.exp) || flow.exp < Date.now()) return null;
    return flow;
  } catch {
    return null;
  }
}

/*
 * Flows that have already been answered.
 *
 * Keyed on a random `jti` from inside the signed payload, so an entry can only
 * be created by somebody who already completed a /start and is holding the
 * cookie it returned. That is the whole difference from the pending-flow table
 * this replaced: there, an anonymous GET allocated; here, allocating costs a
 * full round trip, and the entry self-expires within ten minutes.
 */
const spentFlows = new Map();

function burnFlow(jti) {
  const now = Date.now();
  for (const [key, exp] of spentFlows) if (exp < now) spentFlows.delete(key);
  if (spentFlows.has(jti)) return false;
  spentFlows.set(jti, now + FLOW_TTL_MS);
  return true;
}

/** The signed-in account behind a request, or null. */
function userFor(req) {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return null;
  const id = logins.userIdFor(token);
  if (!id) return null;
  const user = users.byId(id);
  // Disabled mid-session: the token stays valid on paper but the account is
  // not, and checking here means switching somebody off takes effect on their
  // next request rather than at their next login.
  if (!user || user.disabled) return null;

  // Recorded for the request log, which runs on `finish` and by then has no
  // other way to know who this was.
  req.rlUser = user.username;
  return user;
}

/**
 * Who is asking, whose graphics they are asking about, and what they may do.
 *
 * Two ways in, and they are deliberately not equal:
 *
 *   cookie  a person at a dashboard. Can address their own session or any
 *           session shared with them, and the level says whether they may write.
 *   ?key=   an OBS browser source or a game-client webhook. Identifies a
 *           session and nothing else - there is no person behind it, it ends up
 *           written into OBS configuration and read out over screen shares, and
 *           it is the weakest of the three secrets in this system by design.
 *           So it never reaches the dashboard API, only the routes in
 *           KEYED_ROUTES.
 *
 * @returns {{user: object|null, owner: object|null, bundle: object|null,
 *   level: 'owner'|'editor'|'viewer'|null, viaKey: boolean}}
 */
async function contextFor(req, url) {
  const key = url.searchParams.get('key');
  if (key) {
    req.rlViaKey = true;
    const owner = tournaments.bySessionKey(key);
    if (!owner) {
      /*
       * Worth a line of its own, and worth more now than it used to be.
       *
       * Before the cutover this meant a rotated key still sitting in an OBS
       * source, or somebody guessing. It now also means a key from BEFORE
       * migration day - every one of those stopped resolving the moment the
       * runner re-keyed, which was the deliberate choice. This warn line is
       * how somebody finds out that the browser source which has gone black is
       * carrying an old key rather than a broken one.
       */
      log.warn('auth', 'a request arrived with a session key that matches no tournament', {
        path: safeLogUrl(req.url),
      });
      return { user: null, owner: null, bundle: null, level: null, viaKey: true };
    }
    req.rlUser = owner.name || 'tournament';
    return { user: null, owner, bundle: await sessions.get(owner.id), level: 'owner', viaKey: true };
  }

  const user = userFor(req);
  if (!user) return { user: null, owner: null, bundle: null, level: null, viaKey: false };

  /*
   * Which production. Absent, the newest tournament this account can see.
   *
   * "Your own" is no longer a thing a request can mean - nobody owns a
   * production any more, they are members of tournaments that own them - so the
   * default had to become a choice rather than an identity. It only ever
   * decides a first load: the picker writes `?session=` into the URL and every
   * request after that says which.
   *
   * Null is a real answer. An account on no tournament is the ordinary state of
   * somebody who has just been given a login, and the pages handle it.
   */
  const wanted = (url.searchParams.get('session') ?? '').trim();
  const owner = wanted ? tournaments.byId(wanted) : tournaments.defaultFor(user.id);
  if (!owner) return { user, owner: null, bundle: null, level: null, viaKey: false };

  const level = tournamentLevel(owner, user.id);
  if (!canViewTournament(level)) return { user, owner, bundle: null, level: null, viaKey: false };

  return { user, owner, bundle: await sessions.get(owner.id), level, viaKey: false };
}

/**
 * Routes an OBS source or a game client may reach with `?key=`.
 *
 * Kept as an explicit list rather than a rule, because the interesting question
 * about every new route is which side of this line it falls on, and a list makes
 * that a decision somebody has to make rather than one a pattern makes for them.
 * Note what is not here: the libraries, the lookups, anything under /api/auth,
 * and anything that replaces a whole graphic. A key shows a graphic and feeds it
 * a lobby; it does not operate the desk.
 */
const KEYED_ROUTES = new Set([
  '/api/graphic',
  '/api/winner',
  '/api/select',
  '/api/global',
  '/api/graphic/events',
  '/api/winner/events',
  '/api/select/events',
  '/api/events',
  '/api/roster',
  '/api/game',
  '/api/match-id',
  // The fourth webhook, and the read the fourth webhook exists to feed. The
  // export is GET-only and shows a staged board; the hook only writes a board
  // nothing is looking at yet. Neither operates the desk - staging does, and
  // that is /api/lobby/control, which is not here.
  '/api/lobby',
  '/api/gstack',
]);

/** The webhooks. A key is the only credential a game client can carry. */
const WEBHOOK_ROUTES = new Set(['/api/roster', '/api/game', '/api/match-id', '/api/lobby']);

/**
 * The Companion control channel - and the reason it is NOT in the list above.
 *
 * KEYED_ROUTES is a list rather than a rule so that every new route forces the
 * question, and this is the route the question was for. The answer is no: that
 * list ends "a key shows a graphic and feeds it a lobby; it does not operate
 * the desk", and show / hide / next / swap / reset is the desk. Putting this
 * path in there would not have been adding a route, it would have been
 * deleting the sentence - and every session key already sitting in an OBS
 * config would have silently become a remote control for a live broadcast.
 *
 * So it takes a *different* credential, `user.controlKey`, resolved in the
 * upgrade handler at the bottom of this file and nowhere near contextFor. It
 * is also not an HTTP route at all: nothing serves it, and a GET lands on the
 * 404 like any other unknown path.
 */
const COMPANION_PATH = '/api/companion';

/**
 * Which bus a request means - and the one asymmetry in this whole feature.
 *
 * An explicit `?bus=` always wins. What differs is what a request that says
 * nothing gets, and reads and writes deliberately get opposite answers:
 *
 *   read   -> program.  Every URL that existed before this feature keeps
 *            answering exactly as it did. An OBS browser source saved months
 *            ago, a script somebody wrote against /api/graphic, the health of
 *            an old scene collection - none of them know the word "bus" and
 *            all of them mean what is on air.
 *   write  -> preview.  A write that forgot to say which bus is a bug, and the
 *            two ways of being wrong are not comparable: staging something by
 *            accident is invisible until somebody takes it, putting something
 *            on air by accident is on a stream in front of an audience.
 *
 * The same shape as the settings/permissions asymmetry in settings-schema.js -
 * the default is chosen per-direction by what the mistake costs, not by
 * whichever is tidier to write down.
 */
const busFor = (params, { write = false } = {}) => {
  const asked = params.get('bus');
  if (asked) return busName(asked);
  return write ? 'preview' : 'program';
};

/** Routes only an administrator may reach. */
const isAdminRoute = (pathname) => pathname.startsWith('/api/admin/');

/**
 * Whoever is holding the one interactive browser this machine has.
 *
 * A per-account permission, off by default, granted on the Admin tab.
 *
 * Having an account is not enough, and the reason is that "viewer" is a property
 * of a *grant on one session*, never of a person - everyone owns their own
 * session, where they are the owner. So a check that only asked "are you signed
 * in?" let somebody who had been given a look at one production switch back to
 * their own dashboard and open an interactive desktop on the server. The
 * clearance a solve wins is shared, which is a good argument for letting more
 * than the admins do it and no argument at all for letting everybody.
 */
const canSolveTracker = (ctx) => canOpenTrackerLogin(ctx.user);

// Said the same way wherever it is refused, and it names who can change it -
// the operator reading this cannot, and guessing costs them the show.
const TRACKER_LOGIN_DENIED =
  'Your account is not allowed to open a tracker login. An administrator can allow it under Admin > Accounts.';

/** May this request see the noVNC password? */
const canSeeTrackerPassword = (ctx) =>
  Boolean(ctx.user) && (ctx.user.role === 'admin' || ctx.user.id === trackerLogin.state.startedById);

/**
 * A store seen through a filter, for the SSE fan-out.
 *
 * streamStores sends `store.state` verbatim to every subscriber, which is right
 * for a graphic and wrong for anything that differs by who is watching. Rather
 * than teach the stream about accounts, wrap the store: it satisfies the same
 * three-member shape and the stream never knows.
 */
const filteredView = (store, filter) => ({
  get revision() {
    return store.revision;
  },
  get state() {
    return filter(store.state);
  },
  subscribe: (listener) => store.subscribe(({ revision, state }) => listener({ revision, state: filter(state) })),
});

const trackerLoginView = (ctx) =>
  filteredView(trackerLogin, (state) => (canSeeTrackerPassword(ctx) ? state : { ...state, password: '' }));

const unauthorised = (res, status, message) => sendJson(res, status, { error: { status, message } });

/**
 * The three Content-Types an HTML form can send.
 *
 * A cross-site form post arrives with the browser's cookies attached and no way
 * for us to tell it apart from the real dashboard, which is what CSRF is. It
 * cannot, however, set a Content-Type outside this list without triggering a
 * preflight, and this server answers no preflight at all. So refusing these
 * three on a cookie-authenticated write closes the hole with one comparison -
 * both the JSON saves and the raw-bytes media upload send something else.
 *
 * SameSite=Lax on the cookie already blocks the same attack. Two independent
 * mechanisms, because this is the request that puts something on air.
 */
const FORM_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];

const looksCrossSite = (req) => {
  const declared = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return !declared || FORM_TYPES.includes(declared);
};

/**
 * A URL, or null if the client sent something that cannot be one.
 *
 * `decodeURIComponent` throws on a malformed escape, and it used to sit outside
 * every try block in this file - so `GET /%ZZ` reached an unhandled rejection
 * inside an async request handler, which under Node's default is a process
 * exit. An unauthenticated stranger could stop the broadcast server with one
 * request and nothing in the log would say why.
 */
/**
 * Where a sign-in may send the browser afterwards. Same-origin paths only.
 *
 * Parsed rather than string-tested, and what comes back is the parser's own
 * serialisation rather than the caller's string. Both halves are load-bearing,
 * and both were verified against the real parser:
 *
 *   `/\evil.com`      passes `startsWith('/') && !startsWith('//')` and then
 *                     resolves to http://evil.com/, because a backslash is a
 *                     slash to the URL parser for http and https.
 *   `/a\r\nX: 1`      passes an origin check, because CR and LF are stripped
 *                     from the path only after the origin has been computed.
 *                     Handed back raw and written into a Location header, that
 *                     throws ERR_INVALID_CHAR - after the login token has been
 *                     minted and Set-Cookie is already on the response.
 *
 * Serialising neutralises both: the first becomes '/', the second '/aX:%201'.
 */
function safeNext(raw) {
  try {
    const url = new URL(String(raw ?? '/'), 'http://next.invalid');
    if (url.origin !== 'http://next.invalid') return '/';
    return (url.pathname + url.search + url.hash).slice(0, 256) || '/';
  } catch {
    return '/';
  }
}

function safeUrl(req) {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
    decodeURIComponent(url.pathname);
    return url;
  } catch {
    return null;
  }
}

/**
 * Login attempts, counted per address.
 *
 * Deliberately crude - a Map that empties itself, no dependency, no store. The
 * threat is somebody working through a password list against a dashboard on a
 * public hostname, and 200ms of scrypt per attempt already makes that slow;
 * this makes it slow *and* finite. It counts failures only, so an operator
 * signing in ten times in a morning is never affected.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map();

function loginBlocked(from) {
  const entry = loginFailures.get(from);
  if (!entry) return false;
  if (Date.now() - entry.first > LOGIN_WINDOW_MS) {
    loginFailures.delete(from);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function noteLoginFailure(from) {
  const entry = loginFailures.get(from);
  if (!entry || Date.now() - entry.first > LOGIN_WINDOW_MS) {
    loginFailures.set(from, { first: Date.now(), count: 1 });
    return;
  }
  entry.count += 1;
}

/**
 * Every session this account can reach, for the dashboard's target selector.
 *
 * Yours first, then the ones other operators have shared with you. An admin is
 * not silently given every session here: administering accounts and taking over
 * somebody's live broadcast are different powers, and an admin who needs to
 * drive a production is granted access to it like anybody else.
 */
/**
 * The productions this account can reach, for the topbar selector.
 *
 * Tournaments now, not accounts. The row keeps the same shape so the pages did
 * not all have to change at once, with one rename that could not be avoided:
 * `username` became `name`, because it is a competition's name and calling it a
 * username would have been a lie that read fine right up until somebody
 * wondered whose account "Champions Tour" was.
 */
const visibleSessions = (user) =>
  tournaments.forUser(user.id).map((tournament) => ({
    id: tournament.id,
    name: tournament.name || 'Untitled tournament',
    level: tournament.level,
    archived: Boolean(tournament.archivedAt),
    live: sessions.has(tournament.id),
    // Editors get the key, viewers do not. An editor can already put things on
    // air through the dashboard, so withholding the OBS URL would only stop
    // them setting up the browser source for the show they are running. A
    // viewer writing nothing must not be handed a webhook.
    ...(canEditTournament(tournament.level) ? { sessionKey: tournament.sessionKey } : {}),
  }));

/** Accounts that could be added to a tournament, for the Access panel's picker. */
const grantableUsers = (user) =>
  users
    .list()
    .filter((other) => other.id !== user.id && !other.disabled)
    .map((other) => ({ id: other.id, username: other.username }))
    .sort((a, b) => a.username.localeCompare(b.username));

// ---------------------------------------------------------------- routes ---

// ------------------------------------------------------- the discord flow ---

/*
 * How much Discord work may be in progress at once.
 *
 * A count of work, not of identity, and that distinction is why it is safe
 * where a per-address FAILURE counter would not be. Behind the documented
 * Cloudflare tunnel every remote caller shares one `remoteAddress`, so a rule
 * that locks an address out for fifteen minutes is a rule a stranger can use to
 * lock out the whole organisation. A concurrency limit drains by itself in
 * seconds: the worst a flood achieves is that its own requests queue.
 *
 * The per-address limit sits alongside the global one so that one caller cannot
 * take all eight slots and leave a real operator with `e=busy`.
 */
const DISCORD_INFLIGHT_MAX = 8;
const DISCORD_INFLIGHT_PER_ADDRESS = 2;
let discordInFlight = 0;
const discordInFlightBy = new Map();

function takeDiscordSlot(from) {
  const mine = discordInFlightBy.get(from) ?? 0;
  if (discordInFlight >= DISCORD_INFLIGHT_MAX || mine >= DISCORD_INFLIGHT_PER_ADDRESS) return null;

  discordInFlight += 1;
  discordInFlightBy.set(from, mine + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    discordInFlight -= 1;
    const left = (discordInFlightBy.get(from) ?? 1) - 1;
    if (left > 0) discordInFlightBy.set(from, left);
    else discordInFlightBy.delete(from);
  };
}

/** A 302 that always carries whatever cookies the flow needs to settle. */
function bounce(res, cookies, location) {
  res.writeHead(302, { Location: location, 'Set-Cookie': cookies, 'Cache-Control': 'no-store' });
  return res.end();
}

const pkceChallenge = (verifier) => createHash('sha256').update(verifier).digest('base64url');

/** Exchange the one-shot code for an access token. Null on any refusal. */
async function discordExchange(code, verifier, signal) {
  const response = await fetch(`${DISCORD_API_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: DISCORD_REDIRECT_URI,
      code_verifier: verifier,
    }),
    signal,
  }).catch(() => null);

  if (!response?.ok) return null;
  const body = await response.json().catch(() => null);
  return typeof body?.access_token === 'string' ? body.access_token : null;
}

/**
 * The caller's membership of the one configured guild.
 *
 * The guild id comes from a boot constant and goes into the PATH; it is never
 * read back out of a response, so nothing Discord returns can move the check to
 * a guild somebody else controls.
 *
 * `reachable` separates "Discord answered, and the answer is no" from "Discord
 * did not answer", because those need different words from a person at 3am and
 * only one of them is worth clicking again.
 */
async function discordMember(token, signal) {
  const url = `${DISCORD_API_BASE}/users/@me/guilds/${encodeURIComponent(DISCORD_GUILD_ID)}/member`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal }).catch(() => null);

  if (!response) return { member: null, reachable: false };
  // Not a member, or the scope was declined: a real answer, and it is no.
  if (response.status === 403 || response.status === 404) return { member: null, reachable: true };
  if (!response.ok) return { member: null, reachable: false };

  return { member: await response.json().catch(() => null), reachable: true };
}

/*
 * Roles, read strictly. A body that is not the shape we expect is a denial, not
 * an empty list to be waved through - the whole access decision rests here.
 */
const rolesOf = (member) => (Array.isArray(member?.roles) ? member.roles.map(String) : null);
const holdsAny = (roles, permitted) => roles.some((role) => permitted.includes(role));

const DISCORD_NAME_MAX = 32;

/**
 * A Discord name, reduced to something `usernameProblem` will accept.
 *
 * Absence was never the only failure: an on-air nick like `Riot | Xander`, or a
 * non-ASCII one, is present and still unusable, and handing it to
 * `createFromDiscord` would throw inside the callback with a spent code.
 */
function sanitiseHandle(raw) {
  return String(raw ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, DISCORD_NAME_MAX);
}

const withSuffix = (base, n) => `${base.slice(0, DISCORD_NAME_MAX - `-${n}`.length)}-${n}`;

/**
 * A username nobody else has.
 *
 * `member.user.username` first, not `member.nick`: the handle is globally
 * unique and rate-limited by Discord, while a nick is free-form and
 * self-chosen. The Access panel picks an operator to hand a live production to
 * BY NAME, so somebody nicking themselves `boss` and landing beside the real
 * `boss` is a manufactured mis-click, and no ergonomics are worth that.
 *
 * ADMIN_USERNAME is excluded so a sign-in cannot squat the emergency admin name
 * and quietly break the documented recovery path.
 */
function discordUsernameFor(member, snowflake) {
  const fallback = `op-${String(snowflake).slice(-6)}`;
  const bases = [sanitiseHandle(member?.user?.username), sanitiseHandle(member?.nick), fallback].filter(Boolean);

  for (const base of bases) {
    for (let n = 1; n <= 99; n += 1) {
      const candidate = n === 1 ? base : withSuffix(base, n);
      if (usernameProblem(candidate)) continue;
      if (ADMIN_USERNAME && candidate.toLowerCase() === ADMIN_USERNAME.toLowerCase()) continue;
      if (users.byName(candidate)) continue;
      return candidate;
    }
  }
  return '';
}

async function handleAuth(pathname, req, res) {
  switch (pathname) {
    /*
     * Whether anybody exists yet.
     *
     * The login page asks so it can say "no accounts - set ADMIN_USERNAME"
     * rather than leave somebody guessing at a password that was never made.
     * It answers one boolean and no names: whether the server has been set up
     * is not a secret, who is on it is.
     */
    case '/api/auth/state':
      return sendJson(res, 200, {
        empty: users.count === 0,
        secure: COOKIE_SECURE,
        // One nullable object carrying a display string. No client id, no guild
        // id, no role id - the route's ethic is that whether the server has
        // been set up is not a secret but who is on it is, and a role NAME is
        // what the refusal message has to say out loud anyway.
        discord: discordOn() ? { role: DISCORD_ROLE_NAME, signup: DISCORD_ALLOW_SIGNUP } : null,
      });

    /*
     * Begin a Discord flow.
     *
     * Anonymous by necessity - somebody signed out has to be able to start one.
     * It authenticates nobody and allocates nothing on the server, which is why
     * it carries no rate limit: a per-address counter here would be a remote
     * off-switch for the whole organisation's sign-in, because behind the
     * tunnel every remote caller shares one address.
     */
    case '/api/auth/discord/start': {
      if (!discordOn()) return unauthorised(res, 404, `No such route: ${pathname}`);
      if (req.method !== 'GET') return unauthorised(res, 405, 'Use GET.');

      /*
       * A sign-in has to begin on our own page.
       *
       * Without this, a link posted in a Discord channel navigates a signed-in
       * producer through an app they have already authorised and lands them
       * somewhere they never asked to be. An absent header is allowed, because
       * old browsers do not send one - which is why the callback closes the
       * same attack twice more, by never destroying an existing login and by
       * refusing to swap accounts.
       */
      if (req.headers['sec-fetch-site'] === 'cross-site') {
        return bounce(res, [clearedFlowCookie()], '/login.html?e=start');
      }

      const asked = new URL(req.url, 'http://internal.invalid');
      const verifier = randomBytes(32).toString('base64url');
      const flow = {
        mode: 'signin',
        state: randomBytes(32).toString('base64url'),
        verifier,
        jti: randomBytes(16).toString('base64url'),
        next: safeNext(asked.searchParams.get('next')),
        exp: Date.now() + FLOW_TTL_MS,
      };

      const authorize = new URL(DISCORD_AUTHORIZE_URL);
      authorize.searchParams.set('client_id', DISCORD_CLIENT_ID);
      authorize.searchParams.set('redirect_uri', DISCORD_REDIRECT_URI);
      authorize.searchParams.set('response_type', 'code');
      authorize.searchParams.set('scope', 'identify guilds.members.read');
      authorize.searchParams.set('state', flow.state);
      authorize.searchParams.set('code_challenge', pkceChallenge(verifier));
      authorize.searchParams.set('code_challenge_method', 'S256');
      // Ask every time rather than bouncing silently through an already-granted
      // authorisation. It costs one click on a sign-in that happens at most
      // monthly, and it means no navigation can complete a flow unattended.
      authorize.searchParams.set('prompt', 'consent');

      return bounce(res, [discordFlowCookie(flow)], authorize.href);
    }

    /*
     * Come back from Discord.
     *
     * Anonymous by necessity too - it is a top-level navigation arriving from
     * discord.com, so `looksCrossSite` cannot help and is not used. What stands
     * in its place: the state is bound to this browser by a signed HttpOnly
     * cookie that also holds the PKCE verifier, the flow is burned server-side
     * once its signature checks out, no redirect target is accepted from the
     * query string, and an existing login is never destroyed or swapped.
     */
    case '/api/auth/discord/callback': {
      if (!discordOn()) return unauthorised(res, 404, `No such route: ${pathname}`);
      if (req.method !== 'GET') return unauthorised(res, 405, 'Use GET.');

      // First, before any branch: every exit below burns the flow cookie, so no
      // failure can be retried with the one that produced it.
      const cookies = [clearedFlowCookie()];
      const refuse = (code) => bounce(res, cookies, `/login.html?e=${code}`);

      const back = new URL(req.url, 'http://internal.invalid');
      const flow = readDiscordFlow(req);
      if (!flow) return refuse('expired');
      if (back.searchParams.get('error')) return refuse('cancelled');
      if (!sameSecret(back.searchParams.get('state'), flow.state)) return refuse('expired');

      /*
       * Only now, once the caller has proved they hold a cookie this server
       * signed, is a server-side record allocated. Clearing a cookie is an
       * instruction to a browser, and a script that ignores Set-Cookie would
       * otherwise keep one working flow - and unlimited outbound token
       * exchanges - for the full ten minutes.
       */
      if (!burnFlow(flow.jti)) return refuse('expired');

      const code = (back.searchParams.get('code') ?? '').trim();
      if (!code) return refuse('expired');

      const from = req.socket.remoteAddress ?? 'unknown';
      const release = takeDiscordSlot(from);
      if (!release) return refuse('busy');

      try {
        // One budget for the whole exchange rather than one per leg: two
        // unbounded fetches under undici's defaults is a blank tab for minutes.
        const signal = AbortSignal.timeout(9_000);

        const token = await discordExchange(code, flow.verifier, signal);
        if (!token) {
          log.warn('auth', 'a Discord token exchange was refused - check the client id, secret and redirect URI');
          return refuse('misconfigured');
        }

        const { member, reachable } = await discordMember(token, signal);
        if (!reachable) {
          log.warn('auth', 'Discord did not answer the membership check');
          return refuse('unavailable');
        }

        const roles = rolesOf(member);
        if (!roles || !holdsAny(roles, DISCORD_ROLES)) return refuse('norole');

        const snowflake = String(member?.user?.id ?? '');
        if (!isSnowflake(snowflake)) {
          log.warn('auth', 'Discord returned a member with no usable account id');
          return refuse('unavailable');
        }
        const tag = String(member?.user?.username ?? '').slice(0, 64);
        const signedIn = userFor(req);

        // ---------------------------------------------------------- link ---
        if (flow.mode === 'link') {
          /*
           * The signed cookie says which account asked; the login cookie says
           * who is actually here. Both, always. The signed one alone is a
           * bearer token - it survives a sign-out, and whoever holds it would
           * otherwise decide which account an identity is bound to for ever.
           */
          if (!signedIn || signedIn.id !== flow.linkTo) return bounce(res, cookies, '/?discord=notyours');

          const taken = users.byDiscordId(snowflake);
          if (taken && taken.id !== signedIn.id) return bounce(res, cookies, '/?discord=taken');

          await users.update(signedIn.id, { discord: { id: snowflake, tag } });
          log.info('auth', `${signedIn.username} linked a Discord account`);
          return bounce(res, cookies, '/?discord=linked');
        }

        // -------------------------------------------------------- sign in ---
        let user = users.byDiscordId(snowflake);

        /*
         * Whether this account existed before this request.
         *
         * The admin-role sync below is gated on it, and that gate is the whole
         * point of `createFromDiscord` having no role parameter. Landing the
         * new record as `user` and then promoting it in the same handler would
         * be exactly the same thing as creating an admin, and would restore the
         * hole it exists to close: delete an administrator, and they click the
         * button and are back, as an administrator, with the delete looking as
         * though it had worked.
         */
        let created = false;

        if (!user) {
          if (!DISCORD_ALLOW_SIGNUP) return refuse('nosignup');

          const name = discordUsernameFor(member, snowflake);
          if (!name) return refuse('noname');

          try {
            user = await users.createFromDiscord({ username: name, discordId: snowflake, discordTag: tag });
          } catch (error) {
            log.warn('auth', `could not create an account from a Discord sign-in: ${error.message}`);
            return refuse('noname');
          }
          created = true;
          log.info('auth', `created "${user.username}" from a Discord sign-in`, { from });
        }

        // Before any write on their behalf. A disabled account causes exactly
        // one thing to happen, and no field on that record moves.
        if (user.disabled) return refuse('disabled');

        /*
         * Never swap accounts silently. Somebody already signed in as one
         * person, arriving here as another, keeps the session they have - the
         * alternative destroys a live desk's login on a navigation.
         */
        if (signedIn && signedIn.id !== user.id) return bounce(res, cookies, '/?discord=notswitched');

        const changes = {};
        if (user.discordTag !== tag) changes.discordTag = tag;

        /*
         * The admin role, symmetric but only over what it promoted.
         *
         * `discordRole` is why the demote arm is safe: one mistyped character
         * in DISCORD_ROLE_ADMIN matches nobody, and without the flag that typo
         * would demote every administrator in turn as they signed in, the
         * server converging on one admin chosen by arrival order. An admin made
         * by hand is never unmade from Discord.
         */
        if (DISCORD_ADMIN_ROLES.length && !created) {
          const shouldBeAdmin = holdsAny(roles, DISCORD_ADMIN_ROLES);
          if (shouldBeAdmin && user.role !== 'admin') {
            changes.role = 'admin';
            changes.discordRole = true;
          } else if (!shouldBeAdmin && user.role === 'admin' && user.discordRole) {
            const counts = adminCounts(users.list());
            if (counts.enabled > 1 && counts.withPassword > 0) {
              changes.role = 'user';
              changes.discordRole = false;
            } else {
              log.warn('auth', `kept ${user.username} as an administrator - demoting would leave nobody able to administer`);
            }
          }
        }

        if (Object.keys(changes).length) {
          await users.update(user.id, changes);
          if (changes.role) log.warn('auth', `Discord ${changes.role === 'admin' ? 'promoted' : 'demoted'} ${user.username}`);
          user = users.byId(user.id);
        }

        await users.noteSignIn(user.id);
        req.rlUser = user.username;
        log.info('auth', `${user.username} signed in with Discord`, { role: user.role, from });

        const sessionToken = logins.create(user.id);
        await sessions.get(user.id);
        cookies.push(sessionCookie(sessionToken));

        return bounce(res, cookies, safeNext(flow.next));
      } finally {
        release();
      }
    }

    case '/api/auth/login': {
      if (req.method !== 'POST') return unauthorised(res, 405, 'Use POST.');

      const from = req.socket.remoteAddress ?? 'unknown';
      if (loginBlocked(from)) {
        log.warn('auth', 'sign-in blocked - too many failures from this address', { from });
        return unauthorised(res, 429, 'Too many failed sign-ins. Wait fifteen minutes and try again.');
      }

      const body = await readJsonBody(req);
      const user = await users.verify(body?.username, body?.password);

      if (!user) {
        noteLoginFailure(from);
        // The username is kept because it is what makes the line useful - a
        // colleague's typo and somebody working through a list look completely
        // different, and only the attempted name tells them apart.
        log.warn('auth', 'sign-in refused', { username: String(body?.username ?? '').slice(0, 32), from });
        // One message for "no such account", "wrong password" and "disabled".
        // Three messages would tell somebody working through a list which
        // usernames are real, which is half of what they came for.
        return unauthorised(res, 401, 'Wrong username or password.');
      }

      loginFailures.delete(from);
      log.info('auth', `${user.username} signed in`, { role: user.role, from });
      // So the request line for the sign-in itself names them too. There was no
      // cookie on the way in, so nothing else has stamped it.
      req.rlUser = user.username;
      const token = logins.create(user.id);
      // Opened here rather than on their first save, so the auto-hide and the
      // agent-select clock are running before they touch anything.
      await sessions.get(user.id);

      res.setHeader('Set-Cookie', sessionCookie(token));
      return sendJson(res, 200, { user: publicUser(user, { includeKey: true }) });
    }

    case '/api/auth/logout': {
      if (req.method !== 'POST') return unauthorised(res, 405, 'Use POST.');
      log.info('auth', `${userFor(req)?.username ?? 'somebody'} signed out`);
      logins.destroy(readCookie(req, COOKIE_NAME));
      res.setHeader('Set-Cookie', clearedCookie());
      return sendJson(res, 200, { ok: true });
    }

    default:
      return unauthorised(res, 404, `No such route: ${pathname}`);
  }
}

/**
 * A tournament as a browser may see it.
 *
 * Members are resolved to usernames here rather than in the browser, because
 * the alternative is shipping the whole account list to every page that wants
 * to draw a membership row - and `visibleSessions` already exists precisely to
 * avoid doing that.
 *
 * `level` is the CALLER's, folded in by `forUser`, so a page never has to work
 * out its own access from a members map.
 */
const publicTournament = (tournament, { includeControlKey = false } = {}) => ({
  ...tournament,
  /*
   * The control key travels only when it is asked for, and it is asked for only
   * by the owner who just minted it. It opens the desk - show, hide, next, swap
   * - so it must not ride along in a list every member of every tournament
   * fetches on page load, the way the session key does.
   */
  controlKey: includeControlKey ? tournament.controlKey : undefined,
  hasControlKey: Boolean(tournament.controlKey),
  members: Object.entries(tournament.members ?? {}).map(([id, level]) => ({
    id,
    level,
    // An account that has been deleted leaves no member behind - forgetUser
    // sweeps them - so an unknown id here means a record edited by hand.
    username: users.byId(id)?.username ?? '(unknown account)',
  })),
});

/**
 * Tournaments: make one, configure it, decide who works on it.
 *
 * Two routes and an action verb, the same shape as the admin panel and the
 * lobby control route, rather than a REST surface per verb. The gate differs
 * per action and is stated at each one:
 *
 *   create   the `manageTournaments` capability. A fact about the account.
 *   update   editor or owner ON THAT TOURNAMENT. Not the capability - somebody
 *            can be handed a tournament to run without being able to start one.
 *   member   owner. Deciding who else is in is the owner's alone.
 *   archive  owner.
 *
 * Note what `manageTournaments` deliberately does NOT do: it grants access to
 * nothing that already exists. Holding it lets you create; being a member lets
 * you work. An operator with no capability at all can still run every
 * tournament they have been added to, which is the common case - most people
 * who touch a broadcast never start a competition.
 */
async function handleTournaments(pathname, req, res, ctx) {
  const user = ctx.user;
  if (!user) return unauthorised(res, 401, 'Sign in first.');

  if (req.method === 'GET' && pathname === '/api/tournaments') {
    return sendJson(res, 200, {
      tournaments: tournaments.forUser(user.id).map(publicTournament),
      mayCreate: can(user, 'manageTournaments'),
    });
  }

  if (req.method !== 'POST' || pathname !== '/api/tournaments') {
    return unauthorised(res, 404, 'No such tournament route.');
  }

  return handleWrite(res, async () => {
    const body = await readJsonBody(req);
    const action = String(body?.action ?? '').trim().toLowerCase();

    /*
     * Every action but `create` names a tournament, and every one of them has
     * to answer "may this caller touch THIS one" before anything else.
     *
     * Resolved once, here, rather than in each branch. A missing tournament and
     * one the caller cannot see give the same answer on purpose: "no such
     * tournament" for both, so the route cannot be used to discover which
     * competitions exist on this server.
     */
    const target = () => {
      const found = tournaments.byId(body?.id);
      const level = tournamentLevel(found, user.id);
      if (!found || !canViewTournament(level)) throw new ProviderError(404, 'No such tournament.');
      return { tournament: found, level };
    };

    switch (action) {
      case 'create': {
        if (!can(user, 'manageTournaments')) {
          throw new ProviderError(403, 'You cannot create tournaments.', 'An administrator can grant this on the Admin tab.');
        }
        const made = tournaments.create({ name: body?.name, createdBy: user.id });
        log.info('tournament', `${user.username} created "${made.name || 'Untitled tournament'}"`, { tournament: made.id });
        return { tournament: publicTournament(made), tournaments: tournaments.forUser(user.id).map(publicTournament) };
      }

      case 'update': {
        const { tournament, level } = target();
        if (!canEditTournament(level)) throw new ProviderError(403, 'You have view-only access to this tournament.');
        if (tournament.archivedAt) {
          throw new ProviderError(409, 'This tournament is archived.', 'Reopen it before changing its settings.');
        }
        const saved = tournaments.update(tournament.id, body?.fields);
        return { tournament: publicTournament(saved) };
      }

      case 'member': {
        const { tournament, level } = target();
        if (!isTournamentOwner(level)) throw new ProviderError(403, 'Only an owner may change who is on a tournament.');

        const who = users.byId(body?.userId);
        // Checked before the store, so the message can say what is wrong. The
        // store's own guard stays: it is what makes the rule true rather than
        // merely enforced here.
        if (!who) throw new ProviderError(400, 'No such account.');
        if (who.disabled) throw new ProviderError(400, 'That account is disabled.');

        const saved = tournaments.setMember(tournament.id, who.id, body?.level);
        log.info(
          'tournament',
          `${user.username} ${body?.level ? `made ${who.username} ${body.level} on` : `removed ${who.username} from`} "${saved.name || 'Untitled tournament'}"`,
          { tournament: saved.id },
        );
        return { tournament: publicTournament(saved) };
      }

      case 'archive': {
        const { tournament, level } = target();
        if (!isTournamentOwner(level)) throw new ProviderError(403, 'Only an owner may archive a tournament.');
        const wanted = body?.archived !== false;
        const saved = tournaments.setArchived(tournament.id, wanted);
        log.info('tournament', `${user.username} ${wanted ? 'archived' : 'reopened'} "${saved.name || 'Untitled tournament'}"`, {
          tournament: saved.id,
        });
        return { tournament: publicTournament(saved), tournaments: tournaments.forUser(user.id).map(publicTournament) };
      }

      /*
       * A new OBS key. Every browser source and webhook pointing at this
       * tournament stops working, which is why it is owner-only and why it is
       * said at info: somebody will ask why the graphics went black.
       */
      case 'rotate-key': {
        const { tournament, level } = target();
        if (!isTournamentOwner(level)) throw new ProviderError(403, 'Only an owner may re-key a tournament.');
        const saved = tournaments.rotateSessionKey(tournament.id);
        log.info('tournament', `${user.username} made a new session key for "${saved.name}" - its OBS and webhook URLs changed`, {
          tournament: saved.id,
        });
        return { tournament: publicTournament(saved) };
      }

      /*
       * Mint, replace or withdraw the Companion control key.
       *
       * Its own action rather than a flag on rotate-key, which is the whole
       * reason there are two keys: this one drops a stream deck and leaves
       * every browser source alone, and that one re-points OBS and leaves the
       * stream deck running. One button doing both would take the graphics off
       * air to fix a control channel.
       */
      case 'control-key': {
        const { tournament, level } = target();
        if (!isTournamentOwner(level)) throw new ProviderError(403, 'Only an owner may change the control key.');
        const clearing = String(body?.mode ?? '') === 'clear';
        const { tournament: saved, had } = tournaments.setControlKey(tournament.id, clearing ? false : true);

        log.info(
          'tournament',
          clearing
            ? `${user.username} withdrew the Companion control key for "${saved.name}"`
            : `${user.username} ${had ? 'made a new' : 'created a'} Companion control key for "${saved.name}"`,
          { tournament: saved.id },
        );

        /*
         * Every open channel for this tournament, dropped.
         *
         * Not optional and not cosmetic. A socket authenticates once, at the
         * handshake, so one already open holds no credential to re-check -
         * without this, revoking a leaked key would leave the leak connected
         * until somebody restarted the server.
         */
        companion.closeForOwner(saved.id, clearing ? 'The control key was withdrawn.' : 'The control key changed.');

        return { tournament: publicTournament(saved), controlKey: saved.controlKey };
      }

      default:
        throw new ProviderError(400, 'Unknown tournament action.', 'One of: create, update, member, archive, rotate-key, control-key.');
    }
  });
}

/**
 * The account pages: who am I, change my password, rotate my key, share my
 * session. All of it is about the *caller's own* account - there is no id
 * parameter anywhere in here, so no amount of guessing reaches somebody else's.
 */
async function handleAccount(pathname, req, res, ctx) {
  const user = ctx.user;

  if (pathname === '/api/account/me') {
    return sendJson(res, 200, {
      // The control key travels only here: the caller's own account, over a
      // cookie. Deliberately not in the login response and not in
      // visibleSessions - see the note on publicUser.
      user: publicUser(user, { includeKey: true, includeControlKey: true }),
      companion: { enabled: companionOn(), path: COMPANION_PATH },
      sessions: visibleSessions(user),
      grantable: grantableUsers(user),
      passwordMin: PASSWORD_MIN,
    });
  }

  if (req.method !== 'POST') return unauthorised(res, 405, 'Use POST.');

  switch (pathname) {
    case '/api/account/password':
      return handleWrite(res, async () => {
        const body = await readJsonBody(req);
        // The current password, even though they are already signed in. It is
        // the difference between "somebody walked past an unlocked dashboard"
        // and "somebody has the account".
        if (!(await users.verify(user.username, body?.current))) {
          throw new ProviderError(403, 'That is not your current password.');
        }

        /*
         * Taking the password door off, leaving Discord as the only way in.
         *
         * Behind the same `current` check as setting one, deliberately: it is
         * irreversible without an administrator, and somebody walking past an
         * unlocked dashboard should not be able to do it.
         */
        if (body?.clearPassword === true) {
          if (!user.discordId) throw new ProviderError(400, 'Link a Discord account first, or you could not sign in.');

          const counts = adminCounts(users.list());
          if (user.role === 'admin' && !user.disabled && counts.withPassword <= 1) {
            throw new ProviderError(
              400,
              'You are the last administrator who can sign in with a password.',
              'Give another administrator a password first.',
            );
          }
          await users.update(user.id, { clearPassword: true });
          log.warn('account', `${user.username} removed their password - they now sign in with Discord only`);
        } else {
          await users.update(user.id, { password: String(body?.password ?? '') });
          log.info('account', `${user.username} changed their password`);
        }

        // Every other login for this account goes. A password change that left
        // an intruder's session running would be a password change that did
        // nothing about the reason it was made.
        const token = readCookie(req, COOKIE_NAME);
        logins.destroyFor(user.id);
        const fresh = logins.create(user.id);
        res.setHeader('Set-Cookie', sessionCookie(fresh));
        return { ok: true, signedOutElsewhere: token ? true : false };
      });

    /*
     * Attach a Discord identity to the account already signed in here.
     *
     * A POST, so it gets the full CSRF treatment - `looksCrossSite` refuses a
     * Content-Type an HTML form could have set, and an absent one counts as
     * cross-site. The GET that follows carries only an opaque signed cookie,
     * and the callback checks that cookie against the login cookie it was
     * minted for, so holding one alone decides nothing.
     */
    case '/api/account/discord/link':
      return handleWrite(res, async () => {
        if (!discordOn()) throw new ProviderError(404, 'Discord sign-in is not set up on this server.');
        if (user.discordId) throw new ProviderError(400, 'This account already has a Discord account linked.');

        const verifier = randomBytes(32).toString('base64url');
        const flow = {
          mode: 'link',
          state: randomBytes(32).toString('base64url'),
          verifier,
          jti: randomBytes(16).toString('base64url'),
          linkTo: user.id,
          next: '/',
          exp: Date.now() + FLOW_TTL_MS,
        };

        const authorize = new URL(DISCORD_AUTHORIZE_URL);
        authorize.searchParams.set('client_id', DISCORD_CLIENT_ID);
        authorize.searchParams.set('redirect_uri', DISCORD_REDIRECT_URI);
        authorize.searchParams.set('response_type', 'code');
        authorize.searchParams.set('scope', 'identify guilds.members.read');
        authorize.searchParams.set('state', flow.state);
        authorize.searchParams.set('code_challenge', pkceChallenge(verifier));
        authorize.searchParams.set('code_challenge_method', 'S256');
        authorize.searchParams.set('prompt', 'consent');

        res.setHeader('Set-Cookie', discordFlowCookie(flow));
        return { authorize: authorize.href };
      });

    /*
     * Detach it again. Refused when it is the only way in - an account with no
     * password and no link is a record nobody can use, including its owner.
     */
    case '/api/account/discord/unlink':
      return handleWrite(res, async () => {
        if (!user.discordId) throw new ProviderError(400, 'This account has no Discord account linked.');
        if (!(user.salt && user.hash)) {
          throw new ProviderError(
            400,
            'Set a password first, or you would have no way to sign in.',
            'An administrator can set one for you if you cannot.',
          );
        }

        await users.update(user.id, { discord: null });
        log.warn('account', `${user.username} unlinked their Discord account`);

        // Same reasoning as a password change: the credential set changed, so
        // every other session for it goes.
        logins.destroyFor(user.id);
        const fresh = logins.create(user.id);
        res.setHeader('Set-Cookie', sessionCookie(fresh));
        return { ok: true };
      });

    /*
     * A new session key, which changes every OBS and webhook URL this account
     * has. Destructive on purpose and never automatic: it is the thing to press
     * when a key has been on a stream, and the cost is walking round OBS.
     */
    /*
     * The OBS key, the control key and sharing have all left this file.
     *
     * They were about the caller's own account because a production WAS an
     * account. A key now names a tournament and access to one is membership of
     * it, so all three live on /api/tournaments where the thing they describe
     * lives - and, importantly, where they can be owner-only. On this route
     * they could only ever have been "yours", which is no longer a question a
     * key can answer.
     *
     * What stays here is what is genuinely personal: your password, and your
     * Discord link.
     */
    default:
      return unauthorised(res, 404, `No such route: ${pathname}`);
  }
}

/**
 * Administration.
 *
 * Making accounts, switching them off, and looking at what the server is doing.
 * Not included, deliberately: reading or writing anybody's graphics. An admin
 * who needs to operate a production is granted access to it the same way a
 * colleague would be, and that grant is visible to its owner.
 */
async function handleAdmin(pathname, req, res, ctx) {
  if (pathname === '/api/admin/users' && req.method === 'GET') {
    return sendJson(res, 200, {
      users: users.list().map((user) => ({
        ...publicUser(user),
        live: sessions.has(user.id),
        logins: 0,
      })),
      passwordMin: PASSWORD_MIN,
    });
  }

  /*
   * The server switches.
   *
   * `available` is sent alongside each value because two of the three states an
   * operator can be in look identical from a boolean: off because somebody
   * turned it off, and off because this deployment cannot do it. The panel says
   * which, and only the first is a switch worth offering.
   */
  if (pathname === '/api/admin/settings' && req.method === 'GET') {
    return sendJson(res, 200, {
      settings: settings.state,
      available: { tracker: TRACKER_AVAILABLE, discord: DISCORD_AVAILABLE },
    });
  }

  if (pathname === '/api/admin/settings' && req.method === 'POST') {
    return handleWrite(res, async () => {
      const body = await readJsonBody(req);
      const before = settings.state;
      const state = settings.replace({ ...before, ...(body?.settings ?? body) });

      /*
       * The browser follows the switch immediately.
       *
       * Turning tracker off has to actually stop the Chromium - leaving it
       * running would make the switch a label rather than a control, and the
       * memory and the profile lock are half the reason to throw it. Turning it
       * on does not start one: `trackerBrowser` makes it on first use, and the
       * first use is a lookup that is about to warm it up anyway.
       */
      if (before.tracker && !state.tracker && browser) {
        const closing = browser;
        browser = null;
        // Not awaited: a Chromium that will not close must not hold up the
        // response to a switch that has, as far as this server is concerned,
        // already been thrown.
        void closing.close().catch(() => {});
        log.info('settings', 'tracker switched off - closing the browser', { by: ctx.user.username });
      }
      if (!before.tracker && state.tracker) log.info('settings', 'tracker switched on', { by: ctx.user.username });
      if (before.watch !== state.watch) {
        log.info('settings', `post-match watch switched ${state.watch ? 'on' : 'off'}`, { by: ctx.user.username });
      }

      // A solve in progress on a source that has just been switched off has
      // nothing left to earn clearance for.
      if (!state.tracker && trackerLogin.state.active) trackerLogin.cancel();

      /*
       * A hidden panel is a courtesy, not a control - and neither is a refused
       * handshake on its own. Sockets that are already open were authorised
       * before the switch moved, so switching it off has to reach them too or
       * an administrator's "off" leaves every stream deck in the building still
       * driving the graphics.
       */
      if (before.companion !== state.companion) {
        log.info('settings', `Companion control channel switched ${state.companion ? 'on' : 'off'}`, { by: ctx.user.username });
        if (!state.companion) companion.closeAll('An administrator switched the control channel off.');
      }

      await settings.flush();
      return { settings: state, available: { tracker: TRACKER_AVAILABLE, discord: DISCORD_AVAILABLE } };
    });
  }

  /*
   * The log, for the Admin tab.
   *
   * Served from the ring buffer rather than a file, because the person who
   * needs it is standing at a desk with OBS open and cannot get to a shell.
   * `since` is a sequence number so the panel can poll for what it has not seen
   * instead of re-rendering the lot - two lines can share a millisecond, and a
   * clock can go backwards.
   */
  if (pathname === '/api/admin/logs' && req.method === 'GET') {
    const params = new URL(req.url, 'http://localhost').searchParams;
    return sendJson(res, 200, {
      entries: log.recent({
        limit: Math.min(500, Math.max(1, Number(params.get('limit') ?? 200))),
        level: params.get('level') ?? 'debug',
        since: Number(params.get('since') ?? 0),
        tag: params.get('tag') ?? '',
      }),
      cursor: log.cursor,
      level: log.level,
      levels: LOG_LEVELS,
      held: log.size,
    });
  }

  /*
   * Turn verbose logging on without a restart.
   *
   * The moment you want debug output is the moment you cannot afford to bounce
   * the server - something is wrong during a broadcast, and restarting takes
   * every graphic off air to find out why.
   */
  if (pathname === '/api/admin/logs' && req.method === 'POST') {
    return handleWrite(res, async () => {
      const body = await readJsonBody(req);
      const wanted = String(body?.level ?? '');
      if (!LOG_LEVELS.includes(wanted)) throw new ProviderError(400, `Unknown log level: ${wanted || '(none)'}`);

      // Written before the change and at warn, so it is recorded under both the
      // old level and the new one. Logged at info, turning the log down to
      // `warn` would have erased the record of who turned it down.
      log.warn('admin', `${ctx.user.username} set the log level to ${wanted}`, { from: log.level });
      log.setLevel(wanted);
      return { level: log.level, levels: LOG_LEVELS };
    });
  }

  if (pathname === '/api/admin/health' && req.method === 'GET') {
    const memory = process.memoryUsage();
    return sendJson(res, 200, {
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      accounts: users.count,
      logins: logins.count,
      openSessions: sessions.size,
      liveSessions: sessions.list(),
      streams: streamCount,
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapMb: Math.round(memory.heapUsed / 1024 / 1024),
      tracker: {
        available: TRACKER_AVAILABLE,
        enabled: trackerOn(),
        loginActive: trackerLogin.state.active,
        loginPhase: trackerLogin.state.phase,
        startedBy: trackerLogin.state.startedBy,
        browserOpen: Boolean(browser),
      },
      watch: watchOn(),
      /*
       * Presence and counts, never a value - the same shape `providers` uses
       * below. `passwordAdmins: 0` is the row that matters: it means every
       * administrator depends on Discord, and a rotated client secret would
       * lock this server out of itself.
       */
      discord: (() => {
        const counts = adminCounts(users.list());
        return {
          configured: DISCORD_CONFIGURED,
          available: DISCORD_AVAILABLE,
          enabled: discordOn(),
          missing: discordMissing(),
          signup: DISCORD_ALLOW_SIGNUP,
          roles: DISCORD_ROLES.length,
          adminRole: DISCORD_ADMIN_ROLES.length > 0,
          linked: users.list().filter((entry) => entry.discordId).length,
          admins: counts.enabled,
          passwordAdmins: counts.withPassword,
        };
      })(),
      providers: {
        henrik: Boolean(HENRIK_API_KEY),
        riot: Boolean(RIOT_API_KEY),
      },
      host: HOST,
      port: PORT,
      cookieSecure: COOKIE_SECURE,
      logLevel: log.level,
      logHeld: log.size,
    });
  }

  if (pathname !== '/api/admin/users' || req.method !== 'POST') {
    return unauthorised(res, 404, `No such route: ${pathname}`);
  }

  return handleWrite(res, async () => {
    const body = await readJsonBody(req);
    const action = String(body?.action ?? '');
    const id = String(body?.id ?? '');
    const target = id ? users.byId(id) : null;
    if (id && !target) throw new ProviderError(404, 'No such account.');

    // The last administrator cannot be removed, demoted or switched off. Not a
    // policy so much as a locked door with the key inside: there is no route
    // that makes an admin except this one, so a server with none is a server
    // that has to be repaired from a shell.
    //
    // Counted through `adminCounts` in auth.js rather than inline, because the
    // count now answers two questions and both of them get asked from more than
    // one place. See the docblock there.
    const counts = adminCounts(users.list());
    const targetIsAdmin = target?.role === 'admin' && !target.disabled;

    /** Would this write leave the server with nobody who can administer it? */
    const wouldStrandAdmins = targetIsAdmin && counts.enabled <= 1;

    /**
     * Would it leave every remaining administrator unable to sign in without an
     * external identity provider? A server whose only admin signs in through
     * Discord is one that a rotated client secret locks out of itself.
     */
    const wouldStrandPasswordAdmins =
      targetIsAdmin && Boolean(target.salt && target.hash) && counts.withPassword <= 1;

    switch (action) {
      case 'create': {
        const created = await users.create({
          username: body?.username,
          password: body?.password,
          role: body?.role === 'admin' ? 'admin' : 'user',
        });
        log.info('admin', `${ctx.user.username} created the account "${created.username}"`, { role: created.role });
        return { users: users.list().map((user) => ({ ...publicUser(user), live: sessions.has(user.id) })), created: publicUser(created) };
      }

      case 'update': {
        const changes = {};
        if (typeof body?.username === 'string') changes.username = body.username;
        if (typeof body?.password === 'string' && body.password) changes.password = body.password;
        if (body?.role === 'admin' || body?.role === 'user') changes.role = body.role;
        if (typeof body?.disabled === 'boolean') changes.disabled = body.disabled;

        /*
         * Capabilities arrive as a partial object - the panel sends only the
         * toggle that moved - and auth.js patches rather than replaces, so an
         * absent key preserves rather than clearing. Nothing is validated
         * against the schema here on purpose: sanitiseCapabilities drops keys
         * it does not recognise and treats anything but `true` as false, and a
         * second check in this file is a second thing to forget to update.
         */
        if (body?.capabilities && typeof body.capabilities === 'object') {
          changes.capabilities = body.capabilities;
        }
        // The single-permission spelling, still accepted for one season.
        if (typeof body?.trackerLogin === 'boolean') changes.trackerLogin = body.trackerLogin;

        if (changes.role === 'user' || changes.disabled === true) {
          if (wouldStrandAdmins) throw new ProviderError(400, 'This is the last administrator.');
          if (wouldStrandPasswordAdmins) {
            throw new ProviderError(
              400,
              'This is the last administrator who can sign in with a password.',
              'Give another administrator a password first.',
            );
          }
        }

        /*
         * Giving a password to an account that had none is kept, and said out
         * loud.
         *
         * It is the second door the Discord role does not govern, and the
         * honest thing is to admit that rather than hide it: an administrator
         * can grow a password onto an account the Production role was supposed
         * to control. It stays because it is the only recovery when somebody's
         * Discord account is deleted or the OAuth app is rotated out from under
         * you - and refusing it would make that recovery an unlink-and-recreate
         * that loses their graphics.
         *
         * What changes is that the log stops saying merely "password". Reading
         * `Object.keys(changes)` afterwards could not distinguish a routine
         * reset from turning a Discord-only account into one with its own way
         * in, and those are not the same event.
         */
        const grewAPassword = Boolean(changes.password) && !(target.salt && target.hash);

        await users.update(id, changes);
        // What changed, not the values - `changes` carries a password when one
        // was set, and the log is served to a browser.
        log.info('admin', `${ctx.user.username} changed the account "${target.username}"`, {
          changed: Object.keys(changes).join(', ') || '(nothing)',
        });
        if (grewAPassword) {
          log.warn(
            'admin',
            `${ctx.user.username} gave "${target.username}" a password - that account signed in with Discord only until now`,
            { discordLinked: Boolean(target.discordId) },
          );
        }

        // A disabled account's dashboards should stop working now, not when
        // their cookie happens to expire.
        if (changes.disabled === true || changes.password) logins.destroyFor(id);
        /*
         * Disabling a person no longer stops a production.
         *
         * It used to call sessions.dispose(id), which stops the auto-hide
         * timer, both winner sequence drivers and both agent-select clocks -
         * fine when the workspace WAS that account, and wrong now that it is a
         * tournament several people work on. Disabling one guest would have
         * frozen the draft clock on a show they are not even working.
         *
         * Dropping their logins, directly above, is what disabling means: they
         * lose access. Everything they had access to keeps running.
         */
        return { users: users.list().map((user) => ({ ...publicUser(user), live: sessions.has(user.id) })) };
      }

      case 'delete': {
        if (wouldStrandAdmins) throw new ProviderError(400, 'This is the last administrator.');
        if (wouldStrandPasswordAdmins) {
          throw new ProviderError(
            400,
            'This is the last administrator who can sign in with a password.',
            'Give another administrator a password first.',
          );
        }
        if (id === ctx.user.id) throw new ProviderError(400, 'Delete your own account from another administrator.');

        // At warn, not info: this deletes their graphics, presets, teams and
        // aliases with them, and it is the one action here that cannot be undone.
        log.warn('admin', `${ctx.user.username} deleted the account "${target.username}" and all of its state`);
        logins.destroyFor(id);

        /*
         * Detached from every tournament, never deleting one.
         *
         * Deleting a PERSON must not delete a COMPETITION. Several people work
         * on one tournament and the workspace is the shared thing, so an
         * account leaving the roster is not a reason to take a tournament with
         * it. A tournament whose last owner is deleted is left ownerless and
         * reported here - a state an administrator can see and repair, where
         * the alternative cannot be undone.
         */
        const detached = tournaments.forgetUser(id);
        if (detached.touched) {
          log.info('tournament', `${target.username} was on ${detached.touched} tournament(s), and is no longer`);
        }
        for (const orphan of detached.orphaned) {
          log.warn('tournament', `"${tournaments.byId(orphan)?.name || orphan}" has no owner left`, {
            tournament: orphan,
          });
        }

        /*
         * No sessions.destroy(id) any more, and this is the single most
         * destructive line the cutover removed.
         *
         * It was an rm -rf of the workspace directory, which was right when a
         * workspace belonged to one account and is catastrophic now: removing
         * one operator from the roster would have deleted a tournament several
         * people were running, with no undo and no backup route. forgetUser
         * above detaches them; the competition stays.
         *
         * Deleting a tournament is a separate, deliberate act on the Tournament
         * page, which is where somebody doing it knows what they are deleting.
         */
        await users.remove(id);
        return { users: users.list().map((user) => ({ ...publicUser(user), live: sessions.has(user.id) })) };
      }

      /*
       * Detach somebody's Discord account, for when they have lost it.
       *
       * Only unlink - there is deliberately no `link-discord`. Attaching an
       * identity to an account an administrator does not own is an
       * impersonation primitive with no honest use: the recovery path for a
       * locked-out operator is to set them a password, which is visible to them
       * the moment they use it.
       *
       * Refused when it would leave the account with no way in at all, and
       * refused by the two admin guards for the same reason `update` is.
       */
      case 'unlink-discord': {
        if (!target.discordId) throw new ProviderError(400, 'That account has no Discord account linked.');
        if (!(target.salt && target.hash)) {
          throw new ProviderError(
            400,
            `"${target.username}" would have no way to sign in.`,
            'Set them a password in the same panel first.',
          );
        }
        if (wouldStrandAdmins) throw new ProviderError(400, 'This is the last administrator.');

        await users.update(id, { discord: null });
        log.warn('admin', `${ctx.user.username} unlinked the Discord account from "${target.username}"`);
        logins.destroyFor(id);
        return { users: users.list().map((user) => ({ ...publicUser(user), live: sessions.has(user.id) })) };
      }

      /** Close every login for an account without touching the password. */
      case 'sign-out': {
        const removed = logins.destroyFor(id);
        log.info('admin', `${ctx.user.username} signed "${target.username}" out everywhere`, { logins: removed });
        return { removed, users: users.list().map((user) => ({ ...publicUser(user), live: sessions.has(user.id) })) };
      }

      default:
        throw new ProviderError(400, `Unknown user action: ${action || '(none)'}`);
    }
  });
}

/**
 * noVNC, served through this origin instead of its own port.
 *
 * websockify listens inside the container only. Publishing it would put the
 * viewer on a second port, and a second port is exactly what a Cloudflare
 * tunnel cannot carry - gfx.maahir.dev maps to this port and nothing else. So
 * the page and its websocket are proxied under /tracker-login/, which means
 * the viewer works over the tunnel, on the LAN, and on localhost without the
 * client having to know where it really lives.
 */
const TRACKER_LOGIN_PREFIX = '/tracker-login';

/**
 * What goes upstream to websockify.
 *
 * Everything except the login cookie. websockify has no use for it and no
 * concept of it, and forwarding a session token to a process whose whole job is
 * to hand a socket to a browser is the kind of thing that is fine right up
 * until websockify logs its request headers.
 */
const upstreamHeaders = (req) => {
  const headers = { ...req.headers, host: `127.0.0.1:${TRACKER_LOGIN_PORT}` };
  delete headers.cookie;
  delete headers.authorization;
  return headers;
};

function proxyTrackerLogin(req, res) {
  if (!trackerLogin.state.active) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No tracker login is running.');
    return;
  }

  // Trailing path only: websockify serves noVNC from its own root, and the
  // page's asset links are relative to wherever it was served from.
  const upstreamPath = req.url.slice(TRACKER_LOGIN_PREFIX.length) || '/';

  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port: TRACKER_LOGIN_PORT,
      method: req.method,
      path: upstreamPath,
      headers: upstreamHeaders(req),
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );

  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('The login viewer is not reachable.');
  });

  req.pipe(upstream);
}

/**
 * The viewer's websocket, forwarded raw.
 *
 * Nothing here understands the VNC protocol - the handshake is replayed
 * upstream and the two sockets are then piped together, which is all a
 * websocket proxy has to be when both ends already agree on the protocol.
 */
function proxyTrackerLoginSocket(req, socket, head) {
  if (!trackerLogin.state.active) {
    socket.destroy();
    return;
  }

  const upstreamPath = req.url.slice(TRACKER_LOGIN_PREFIX.length) || '/';
  const upstream = netConnect(TRACKER_LOGIN_PORT, '127.0.0.1', () => {
    const headers = upstreamHeaders(req);
    const lines = Object.entries(headers).map(([key, value]) => `${key}: ${value}`);
    upstream.write(`GET ${upstreamPath} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  const drop = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on('error', drop);
  socket.on('error', drop);
}

/**
 * One request.
 *
 * Split out of createServer so that every path through it, including the ones
 * that throw, ends up inside the one try below. An async handler that rejects
 * is an unhandled rejection, and an unhandled rejection under Node's default
 * settings is a process exit - which for this server means the graphics come
 * off air. There is no error worth that.
 */
async function route(req, res) {
  const url = safeUrl(req);
  if (!url) return unauthorised(res, 400, 'That URL is not valid.');

  const { pathname } = url;

  /*
   * The noVNC viewer. Behind the same permission that opens a solve, not merely
   * behind a login: what is on the other end is a real keyboard on a real
   * browser on this machine, not a picture of one.
   *
   * The password already stops anyone else connecting, so this is the second
   * lock rather than the first - but it makes the rule one rule, and it closes
   * the case of somebody who may not open a solve being handed a password by
   * somebody who may.
   */
  if (pathname === TRACKER_LOGIN_PREFIX || pathname.startsWith(`${TRACKER_LOGIN_PREFIX}/`)) {
    const user = userFor(req);
    if (!user) return unauthorised(res, 401, 'Sign in first.');
    if (!canOpenTrackerLogin(user)) return unauthorised(res, 403, TRACKER_LOGIN_DENIED);
    return proxyTrackerLogin(req, res);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
    return unauthorised(res, 405, 'Only GET and POST are supported.');
  }

  // Uploads. Named after their own hash, so the name is the credential: 64 bits
  // of it, unguessable, and known already to anyone holding the same bytes.
  // Gating this would break every OBS source, which carries a session key and
  // no cookie, for no gain.
  if (pathname.startsWith('/media/')) {
    if (req.method === 'POST') return unauthorised(res, 405, 'Use POST /api/media to upload.');
    return serveMedia(pathname, res, req.method);
  }

  if (!pathname.startsWith('/api/')) {
    if (req.method === 'POST') return unauthorised(res, 405, 'Only GET is supported.');

    /*
     * The dashboard, for somebody who is not signed in.
     *
     * A redirect rather than a 403: this is the one page a person types in by
     * hand, and bouncing them to the login with their destination attached is
     * the difference between a tool that works and one that scolds. Nothing is
     * being protected here - index.html holds no data, and every route it calls
     * is checked on its own - so this is a courtesy, not the fence.
     */
    if ((pathname === '/' || pathname === '/index.html') && !userFor(req)) {
      const next = encodeURIComponent(pathname === '/' ? '/' : pathname);
      res.writeHead(302, { Location: `/login.html?next=${next}`, 'Cache-Control': 'no-store' });
      return res.end();
    }

    /*
     * The scoreboard's old address.
     *
     * It was `/output.html` for the whole life of this tool, which means it is
     * sitting in OBS browser sources on machines nobody is about to edit, and
     * in scene collections saved months ago. Renaming the file without this
     * would take those sources black at the next show, with the only clue being
     * a 404 in a log nobody reads mid-broadcast.
     *
     * The query string is carried across because the whole point of the URL is
     * the `?key=` on the end of it.
     *
     * 302 rather than 301: a permanent redirect is cached by the browser more
     * or less forever, and if `/output.html` is ever wanted for something else
     * that cache is unreachable from here. This costs one extra request when a
     * browser source starts, which is once.
     */
    if (pathname === '/output.html') {
      res.writeHead(302, { Location: `/post-match.html${url.search}`, 'Cache-Control': 'no-store' });
      return res.end();
    }

    return serveStatic(pathname, res, req.method);
  }

  // Anything a page needs before it has an account: the login itself, the
  // server's own configuration, and the game's asset catalogue - which the
  // output pages fetch, and they have no account at all.
  if (pathname.startsWith('/api/auth/')) return handleAuth(pathname, req, res);

  /*
   * Liveness, for a container's HEALTHCHECK.
   *
   * Its own route rather than reusing /api/config, because a health check has no
   * cookie and no session key and never will - so it has to be something that is
   * deliberately outside the gate and safe to leave there. It answers three
   * facts, none of them a secret: the process is up, it can serve, and how long
   * it has been doing so. Nothing about accounts, nothing about what is on air.
   */
  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, uptimeSec: Math.round(process.uptime()), version: 1 });
  }

  if (pathname === '/api/config' || pathname === '/api/valorant-assets') {
    return sendJson(res, 200, await handleApi(pathname, url.searchParams, { bundle: null }));
  }

  // ------------------------------------------------------------- the gate ---

  const ctx = await contextFor(req, url);

  /*
   * Where this server looks like it is, from the outside.
   *
   * Only the GStack export needs it, and it needs it because that payload
   * carries logo URLs which a *different* program fetches. A relative
   * "/media/<hash>" is correct for a browser source that already has an origin
   * and useless to VHUD, which downloads them into its own PlayerPic folder.
   * Taken from the request rather than from configuration because whatever host
   * reached us is by construction a host the caller can reach - which is the
   * only property the URL actually needs, and the one a configured base URL
   * gets wrong the first time somebody runs this behind the tunnel.
   */
  ctx.origin = `${String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || 'http'}://${req.headers.host ?? HOST}`;

  if (ctx.viaKey) {
    // A session key on a route that is not a browser source or a webhook. It
    // lives in OBS configuration and gets read out over screen shares, so it
    // opens exactly two kinds of door and this is not one of them.
    if (!KEYED_ROUTES.has(pathname)) return unauthorised(res, 403, 'That key is only good for the output pages and the webhooks.');
    if (!ctx.bundle) return unauthorised(res, 404, 'No session has that key. It may have been rotated.');
  } else if (!ctx.user) {
    // A webhook says so plainly rather than talking about signing in - what is
    // reading the answer is a game client's log, not a person.
    return WEBHOOK_ROUTES.has(pathname)
      ? unauthorised(res, 401, 'Add ?key=<session key> to this URL. Copy it from the dashboard.')
      : unauthorised(res, 401, 'Sign in first.');
  }

  if (isAdminRoute(pathname)) {
    if (ctx.user?.role !== 'admin') return unauthorised(res, 403, 'Administrators only.');
    /*
     * The same CSRF shape the account routes have had.
     *
     * These were relying on SameSite=Lax alone, which is a real defence and not
     * the whole of one. It mattered less when every admin action was a role or
     * a password an administrator was already in a position to change; it
     * matters now that unlinking a Discord account is one of them. A
     * pre-existing gap is a reason not to add to it, not a reason to leave it.
     */
    if (req.method === 'POST' && looksCrossSite(req)) return unauthorised(res, 415, 'Send JSON.');
    return handleAdmin(pathname, req, res, ctx);
  }

  if (pathname.startsWith('/api/account/')) {
    if (req.method === 'POST' && looksCrossSite(req)) return unauthorised(res, 415, 'Send JSON.');
    return handleAccount(pathname, req, res, ctx);
  }

  /*
   * Tournaments, above the bundle check and therefore above the session write
   * gate below - the same position the account routes hold, for the same
   * reason: none of this is about a session.
   *
   * Putting them below would have tied them to one, and the failure would have
   * been quiet and confusing: an operator viewing a colleague's production as a
   * viewer would find themselves unable to rename their OWN tournament, because
   * `canEdit(ctx.level)` was answering a question nobody asked. A tournament
   * write is gated on the capability and on membership of THAT tournament, and
   * on nothing else.
   *
   * A session key cannot reach here, and there is deliberately NO check for one
   * in this block. KEYED_ROUTES above already refuses every path that is not on
   * it, and that list is the whole mechanism - "a list rather than a rule so
   * that every new route forces the question". A second check here would be
   * unreachable today and actively misleading tomorrow: somebody who decided a
   * key SHOULD reach a tournament route would add it to the list, watch nothing
   * change, and have no way to find out why.
   *
   * The question the list forces, answered: no. A key shows a graphic and feeds
   * it a lobby; administering a competition is further from a graphic than
   * operating the desk is, and the desk is already out of bounds.
   */
  if (pathname === '/api/tournaments' || pathname.startsWith('/api/tournaments/')) {
    if (req.method === 'POST' && looksCrossSite(req)) return unauthorised(res, 415, 'Send JSON.');
    return handleTournaments(pathname, req, res, ctx);
  }

  if (!ctx.bundle) {
    return unauthorised(res, 403, ctx.owner ? 'You do not have access to that session.' : 'No such session.');
  }

  if (req.method === 'POST') {
    // Two independent CSRF defences; see FORM_TYPES. The key path is exempt
    // because there is no cookie on it - nothing to ride.
    if (!ctx.viaKey && looksCrossSite(req)) return unauthorised(res, 415, 'Send JSON.');

    /*
     * Read-only means read-only.
     *
     * Checked here, once, rather than in each handler: a viewer who found the
     * URL of a save is exactly the case a per-handler check gets wrong by
     * omission when somebody adds the eleventh write route.
     */
    if (!canEditTournament(ctx.level)) {
      return unauthorised(res, 403, 'You have view-only access to this tournament.');
    }

    return handlePost(pathname, req, res, ctx, url.searchParams);
  }

  if (req.method === 'GET' && (await handleStream(pathname, req, res, ctx, url.searchParams))) return undefined;

  try {
    return sendJson(res, 200, await handleApi(pathname, url.searchParams, ctx));
  } catch (error) {
    const status = error instanceof ProviderError && error.status >= 400 && error.status <= 599 ? error.status : 500;
    const message = error instanceof ProviderError ? error.message : `Unexpected server error: ${error.message}`;
    return sendJson(res, status, { error: { status, message, hint: error.hint ?? '' } });
  }
}

/** The SSE routes. Returns true if this request was one. */
async function handleStream(pathname, req, res, ctx, params) {
  const { globals, lookups, matchFeed, lobby } = ctx.bundle;

  /*
   * An output page's own stream answers for the bus its URL named, defaulting
   * to air. That default is what keeps an OBS source saved before this feature
   * existed rendering exactly what it always did.
   */
  const streamBus = busFor(params);
  const graphics = ctx.bundle.graphics.of(streamBus);
  const winner = ctx.bundle.winner.of(streamBus);
  const select = ctx.bundle.select.of(streamBus);

  if (pathname === '/api/graphic/events') return streamState(graphics, 'graphic', req, res), true;
  if (pathname === '/api/winner/events') return streamState(winner, 'winner', req, res), true;
  if (pathname === '/api/select/events') return streamState(select, 'select', req, res), true;

  /*
   * Every graphic on one connection, for the dashboard.
   *
   * A browser allows six HTTP/1.1 connections to an origin, and a server-sent
   * event stream holds one open for as long as the page lives. The dashboard
   * has a module per graphic and a live preview of each, so one stream apiece
   * came to exactly six - at which point the seventh request, which is the POST
   * that saves what you just typed, queues behind connections that never
   * finish. The symptom is a dashboard stuck on "Saving..." for ever, with
   * nothing in the log to say why.
   *
   * The output pages keep their own single-store streams: each is a separate
   * browser source holding one connection, which was never the problem.
   */
  if (pathname === '/api/events') {
    streamStores(
      [
        /*
         * BOTH buses, on the one connection.
         *
         * The dashboard edits one and has to show the other beside it, which is
         * two states per graphic - and the six-connection cap means a second
         * EventSource is not available to carry the second one. So both ride
         * here.
         *
         * The naming is the same invariant as busFor: UNQUALIFIED MEANS AIR.
         * `graphic` is program, here and on the output pages' own streams, and
         * always has been; `graphicPreview` is the new thing and says so. That
         * way nothing already listening changes meaning underneath itself, and
         * a reader who has not met this feature still guesses right.
         *
         * The preview channels are the noisy ones - they move on every
         * keystroke. Program only moves on a take or on one of its own drivers.
         */
        ['graphic', ctx.bundle.graphics.program],
        ['winner', ctx.bundle.winner.program],
        ['select', ctx.bundle.select.program],
        ['graphicPreview', ctx.bundle.graphics.preview],
        ['winnerPreview', ctx.bundle.winner.preview],
        ['selectPreview', ctx.bundle.select.preview],
        ['global', globals],
        ['lookup', lookups],
        ['matchFeed', matchFeed],
        ['lobby', lobby],
        // Whether Play is running, so the button can say Stop. Not part of any
        // graphic's state - see makeRehearsal.
        ['rehearsal', ctx.bundle.rehearsal],
        // The one entry that is not this session's: there is a single browser
        // on this machine, so a solve concerns everybody. Filtered so the
        // password reaches only whoever started it.
        ['trackerLogin', trackerLoginView(ctx)],
      ],
      req,
      res,
    );
    return true;
  }

  return false;
}

/**
 * A game-client event, applied to BOTH of agent select's buses.
 *
 * Agent select is the one graphic whose data reaches an audience without a
 * take, and that is a decision rather than an oversight: a draft produces ten
 * picks and a handful of scene changes, and an operator pressing Send to
 * program once per lock-in is not a workflow anybody wants. So the feed is
 * auto-taken. What still needs taking is everything an operator does by hand -
 * showing the strip, swapping the sides, the styling.
 *
 * Applied to each bus SEPARATELY rather than applied once and copied, and the
 * difference matters. Preview may be carrying operator edits that air has not
 * been given yet; copying would throw them away on the next pick, which is the
 * opposite of what staging is for. Running the same event against each state
 * folds the pick into whatever that bus already held.
 *
 * `now` is shared so the two clocks agree. Letting each call Date.now() for
 * itself would leave the countdown on the dashboard a few milliseconds from the
 * one on air - invisible, until somebody screenshots both.
 *
 * @param {object} bus      the select bus
 * @param {(state: object) => object} apply  state -> {state, ...}
 * @returns {object} the result for AIR, which is what the client is told about
 */
function feedBothBuses(bus, apply) {
  const air = apply(bus.program.state);
  if (air.state !== bus.program.state) bus.program.replace(air.state);

  const staged = apply(bus.preview.state);
  if (staged.state !== bus.preview.state) bus.preview.replace(staged.state);

  return air;
}

/** The write routes. `ctx.bundle` is the session, and it may be written to. */
async function handlePost(pathname, req, res, ctx, params) {
  const bundle = ctx.bundle;
  const { globals, aliases, matchFeed, lobby } = bundle;

  /*
   * A write says which bus, or it stages. See busFor.
   *
   * The three graphic routes honour it. The webhooks below deliberately do not
   * and are pinned to air - a game client has no opinion about buses and the
   * automation it drives has to keep reaching the audience. Stage 5 gives the
   * agent-select feed both buses; until then, air is where it already went.
   */
  const writeBus = busFor(params, { write: true });
  const graphics = bundle.graphics.of(writeBus);
  const winner = bundle.winner.of(writeBus);
  const select = bundle.select.of(writeBus);
  // The webhooks' select, pinned to air whatever the query string says.
  const selectAir = bundle.select.program;

  switch (pathname) {
    // Starting a login is a POST because it launches a browser; the progress
    // comes back on the same event stream as everything else.
    case '/api/tracker/login':
      return handleWrite(res, async () => {
        if (!canSolveTracker(ctx)) throw new ProviderError(403, TRACKER_LOGIN_DENIED);
        return trackerLogin.start(ctx.user);
      });

    case '/api/tracker/login/cancel':
      return handleWrite(res, async () => {
        // Whoever started it, or an admin. Anyone else cancelling would be
        // taking a half-solved challenge away from the person solving it.
        if (!ctx.user || (ctx.user.role !== 'admin' && ctx.user.id !== trackerLogin.state.startedById)) {
          throw new ProviderError(403, 'Only the operator who started this login can close it.');
        }
        return trackerLogin.cancel();
      });

    /*
     * Cut a graphic to air, or pull air back into preview.
     *
     * Deliberately NOT in KEYED_ROUTES. A take is the single most consequential
     * button in this tool - it is the moment something reaches an audience - and
     * the session key is the weak secret that lives in OBS configuration and
     * gets read out over screen shares. "A key shows a graphic and feeds it a
     * lobby; it does not operate the desk" applies here more than anywhere.
     *
     * One route rather than three, so there is one place that decides who may
     * put something on air rather than three that have to agree.
     */
    /*
     * Play the sequence on preview, at its real timings.
     *
     * Preview is manual by default - next and prev are for stepping through and
     * checking a scene, and a preview that marched on by itself would never let
     * anybody look at anything. This is the opt-in: run it once, as air would,
     * so the operator can see whether the holds are right before it matters.
     *
     * Never touches program, whatever is passed. There is no bus argument on
     * purpose: rehearsing on air is not a thing, it is just being on air.
     */
    case '/api/rehearse':
      return handleWrite(res, async () => {
        const body = await readJsonBody(req);
        const which = String(body?.graphic ?? 'winner');
        if (which !== 'winner') {
          throw new ProviderError(400, `Only the winner sequence can be rehearsed, not "${which}".`);
        }

        const run = body?.run !== false;
        if (run) {
          // From the top, like Activate - a rehearsal that began halfway
          // through would not tell the operator what an audience will see.
          const seq = bundle.winner.preview.state.seq;
          bundle.winner.preview.patch({
            seq: { ...seq, active: true, stage: 0, restart: true, cue: (seq.cue + 1) % CUE_WRAP },
          });
        }
        /*
         * Set after the write, so the driver's own subscription sees the new
         * scene and the flag together. Setting it first would re-arm against
         * the old stage and then be re-armed again a microtask later - correct
         * by accident, and only while the two happen to stay in that order.
         */
        bundle.rehearsal.set('winner', run);

        log.debug('preview', `winner rehearsal ${run ? 'started' : 'stopped'}`, { tournament: ctx.owner?.id, who: ctx.user?.username ?? "(key)" });
        return { graphic: 'winner', running: run, state: bundle.winner.preview.state };
      });

    case '/api/take':
      return handleWrite(res, async () => {
        const body = await readJsonBody(req);
        const which = String(body?.graphic ?? '');
        const bus = bundle[which];
        if (!BUS_KEYS.includes(which) || !bus) {
          throw new ProviderError(400, `No such graphic: "${which}".`, `Try one of: ${BUS_KEYS.join(', ')}.`);
        }

        // Reverting is the undo for a take that has not happened - it pulls air
        // back over preview, which is what an operator who has staged half a
        // graphic and changed their mind actually wants.
        if (String(body?.action ?? '') === 'revert') {
          const state = bus.revert();
          log.info('air', `${which} preview reverted to what is on air`, { tournament: ctx.owner?.id, who: ctx.user?.username ?? "(key)" });
          return { graphic: which, action: 'revert', revision: bus.preview.revision, state };
        }

        const { state, replayed } = bus.take();
        /*
         * At info, and this is the line a production wants afterwards. The cue
         * counter moving is what separates "they put a new thing on air" from
         * "they corrected a name on something already up", and that distinction
         * is exactly what somebody asks about after a show.
         */
        log.info('air', `${which} taken to program${replayed ? ' (replayed)' : ' (data only)'}`, {
          tournament: ctx.owner?.id, who: ctx.user?.username ?? "(key)",
        });
        return { graphic: which, action: 'take', replayed, revision: bus.program.revision, state };
      });

    case '/api/graphic':
      return handleWrite(res, async () => {
        const body = await readJsonBody(req);
        const state = body?.reset === true ? graphics.reset() : graphics.replace(body?.state ?? body);
        // Which bus this landed on, always. A caller that meant air and forgot
        // to say so gets told, rather than watching a write go quiet.
        return { bus: writeBus, revision: graphics.revision, state };
      });

    case '/api/winner':
      return handleWrite(res, async () => {
        const body = await readJsonBody(req);
        const state = body?.reset === true ? winner.reset() : winner.replace(body?.state ?? body);
        return { bus: writeBus, revision: winner.revision, state };
      });

    /*
     * The production's own settings, and the push that keeps the graphics in
     * step with them.
     *
     * One way on purpose. The Global tab owns the value and the graphics follow
     * it while their sync is on; a graphic never pushes back. Two-way would mean
     * an operator correcting the winner sequence's map silently rewriting the
     * scoreboard that is on air behind it, and there would be no way to tell
     * which of the two had won.
     */
    case '/api/global':
      return handleWrite(res, async () => {
        const body = await readJsonBody(req);
        const state = globals.replace(body?.state ?? body);
        return { revision: globals.revision, state, pushed: pushGlobal(bundle) };
      });

    case '/api/select':
      return handleWrite(res, async () => {
        const body = await readJsonBody(req);
        const previous = select.state;
        const written = body?.reset === true ? select.reset() : select.replace(body?.state ?? body);

        /*
         * Settled after the write rather than before it, because the rule reads
         * the sanitised board: an operator locking the last card by hand has
         * finished agent select, and the clock should shut for that the same way
         * it does for the feed. Only ever a second write on the one save that
         * completes the lobby - once the bar is shut this is a no-op.
         */
        const settled = settleSelect(previous, written);
        const state = settled === written ? written : select.replace(settled);
        return { bus: writeBus, revision: select.revision, state };
      });

    /*
     * The agent-select feed.
     *
     * A separate route from /api/select on purpose. That one takes a whole
     * graphic and replaces it, which is what a dashboard does; this one takes
     * whatever a client in the lobby happens to send and folds it in, which is a
     * different contract and wants a different name in whatever is configured to
     * call it.
     *
     * Answers with what changed rather than with the whole state: the caller is
     * a game client, not a dashboard, and "applied: 1" is a far more useful
     * thing to find in its log than ten cards of JSON.
     */
    case '/api/roster':
      return handleWrite(res, async () => {
        // Read once - a request body is a stream and the second bus would get
        // an empty one.
        const payload = await readJsonBody(req);
        const result = feedBothBuses(bundle.select, (state) =>
          ingestRoster(state, payload, (id, riotId) => aliases.aliasFor(id, riotId)),
        );

        // Recorded before the state goes out, so a player who has just been seen
        // is already in the library by the time the dashboard repaints.
        aliases.seen(result.seen);

        /*
         * Saved when the state actually moved, which is not the same question as
         * whether an event was accepted. A post can change nothing a seat can
         * see and still finish the lobby - shutting the clock because the last
         * card was already locked, or clearing for a new game - and keying this
         * on `applied` threw those away. Identity is the honest test:
         * ingestRoster only rebuilds what it touched.
         */
        // At debug: a lobby produces ten of these, and one line each is noise
        // right up until the moment you need every one of them.
        log.debug('feed', `roster: ${result.applied} applied`, {
          tournament: ctx.owner?.id, who: ctx.user?.username ?? "(key)",
          reset: result.reset,
          locked: selectAir.state.slots.filter((slot) => slot.locked).length,
        });

        return {
          applied: result.applied,
          reset: result.reset,
          gameId: selectAir.state.gameId,
          slots: selectAir.state.slots.map((slot) => ({ name: slot.name, character: slot.character, locked: slot.locked })),
        };
      });

    /*
     * The general game feed - scenes and match facts.
     *
     * A second hook rather than a mode on the first, because the two are
     * different shapes doing different jobs: /api/roster addresses a seat and
     * says who is in it, this says what the game as a whole is doing. Whatever
     * is watching the client can point each of its features at its own URL
     * instead of at one that has to work out which it was sent.
     */
    case '/api/game':
      return handleWrite(res, async () => {
        const body = await readJsonBody(req);
        // Cached in memory after the first call, so this costs nothing per
        // event. Null when there is no network and nothing on disk, which the
        // written-down table covers.
        const catalogue = await assets.get().catch(() => null);
        /*
         * Read BEFORE the feed is applied. `feedBothBuses` replaces the store,
         * so a comparison made afterwards is the new state against itself and
         * the shared map would never move again - a silent no-op that only
         * shows up as "the map stopped following the game".
         */
        const mapOnAirBefore = selectAir.state.mapName;

        // One stamp for both buses, so the two clocks cannot drift apart.
        const now = Date.now();
        const result = feedBothBuses(bundle.select, (state) => ingestGame(state, body, { catalogue, now }));

        // The feed knowing the map is the whole reason to share one: the game
        // says it once and every graphic gets it.
        const mapBefore = globals.state.mapName;
        if (result.state.mapName && result.state.mapName !== mapOnAirBefore) {
          globals.patch({ mapName: result.state.mapName });
        }
        const movedTheSharedMap = globals.state.mapName !== mapBefore;
        // A scene change is different from a roster event: it drives the
        // automation toggles, so it is worth a line at info even when the ten
        // events around it are not.
        if (result.entered || result.left) {
          log.info('feed', `agent select ${result.entered ? 'started' : 'ended'}`, {
            tournament: ctx.owner?.id, who: ctx.user?.username ?? "(key)",
            map: selectAir.state.mapName || '-',
          });
        }

        /*
         * Only when this event actually moved the shared map.
         *
         * It used to run on every event, and that quietly undid operator work.
         * `pushGlobal` copies the Global tab's map onto all three graphics
         * whenever they differ, so a bare `scene` event - which carries no map
         * and changes nothing here - was still enough to overwrite a map an
         * operator had just picked by hand. The winner graphic is where it hurt:
         * its map is "the map just played", the operator sets it at the end of a
         * map, and the client is posting MainMenu / CharacterSelect the whole
         * time. The field would revert a second later with nothing to say why,
         * and the background splash with it.
         *
         * The one-way rule is intact - Global still owns the value and a graphic
         * still never pushes back. What changed is that a write nobody made no
         * longer counts as Global having spoken.
         */
        if (movedTheSharedMap) pushGlobal(bundle);
        return {
          applied: result.applied,
          scene: selectAir.state.scene,
          agentSelect: isAgentSelectScene(selectAir.state.scene),
          entered: result.entered,
          left: result.left,
          map: selectAir.state.mapName,
          onAir: selectAir.state.anim.visible,
        };
      });

    /*
     * The match-id feed.
     *
     * A third hook rather than a field on /api/game, on the same reasoning that
     * split the first two: this one hands the operator something to act on
     * rather than driving a graphic. Nothing it receives reaches air by itself -
     * it fills a box on the lookup tab and waits to be pressed, because the
     * moment a match ends is the moment tracker.gg has least chance of knowing
     * about it, and a lookup that fired automatically would spend its one shot
     * on a 404.
     *
     * The body may be the bare id as text/plain. A game client posting a string
     * is not going to negotiate a content type, and the key path is exempt from
     * the CSRF check precisely because it carries no cookie to ride.
     */
    case '/api/match-id':
      return handleWrite(res, async () => {
        const raw = (await readBody(req, MAX_BODY_BYTES)).toString('utf8').trim();

        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // Not JSON, so the body is the id. This is the documented shape.
          parsed = raw;
        }

        const matchId = matchIdFrom(parsed);
        if (!matchId) {
          // 400 rather than a quiet 200: unlike a roster event that is simply
          // not ours, there is exactly one thing this hook is for, and a client
          // that posted something else is misconfigured and should be told.
          throw new ProviderError(
            400,
            'No usable match id in that payload.',
            'Post the id on its own, or as {"matchId": "..."}. Letters, digits, - and _ only.',
          );
        }

        const fresh = matchFeed.receive(matchId);
        // Once per match, so info is the right level - and the id is the whole
        // point of the line, which is why it is not redacted.
        log.info('feed', `match id ${fresh ? 'received' : 're-sent'}: ${matchId}`, { tournament: ctx.owner?.id, who: ctx.user?.username ?? "(key)" });

        return { matchId, fresh };
      });

    /*
     * The Overwolf lobby feed - a fourth hook, and the only one that shows
     * nothing.
     *
     * Same envelope as /api/roster, because it is the same client sending it:
     * Shots Fired splits its event key on "." and posts {gameId, feature, event,
     * category, eventIndex, data}. A separate route rather than a mode on the
     * roster hook so an operator can point one Shots Fired action at the graphic
     * and another at the staging board, or at only one of them, without either
     * choice being implied by the other.
     *
     * Answers with what it made of the post rather than with the board: the
     * caller is a game client, and "applied: 1" is the useful thing to find in
     * its log.
     */
    case '/api/lobby':
      return handleWrite(res, async () => {
        const result = lobby.receive(await readJsonBody(req));

        // The alias library learns from this feed exactly as it learns from the
        // roster one - a player seen in a staged lobby is a player worth having
        // a name for, whether or not the operator ever stages them.
        aliases.seen(result.seen);

        // Debug, for the same reason the roster hook is: a lobby produces ten of
        // these and one line each is noise until the moment you need every one.
        log.debug('feed', `lobby: ${result.applied} applied`, {
          tournament: ctx.owner?.id, who: ctx.user?.username ?? "(key)",
          seats: lobby.state.incoming.seats.filter((seat) => seat.seen).length,
        });

        return { applied: result.applied, count: lobby.state.incoming.count };
      });

    /*
     * The operator's three buttons.
     *
     * Split from the hook above because they are a different credential: this
     * is the desk, so it wants a signed-in editor and the CSRF shape, where the
     * hook wants a key and a game client. A key must never reach these - staging
     * is the act of putting ten names on air.
     */
    case '/api/lobby/control':
      return handleWrite(res, async () => {
        const body = await readJsonBody(req);
        const action = String(body?.action ?? '').trim().toLowerCase();

        switch (action) {
          case 'stage':
            log.info('feed', 'lobby staged', { tournament: ctx.owner?.id, who: ctx.user?.username ?? "(key)" });
            return lobby.stage();
          case 'swap':
            return lobby.swap();
          case 'clear':
            log.info('feed', 'lobby cleared', { tournament: ctx.owner?.id, who: ctx.user?.username ?? "(key)" });
            return lobby.clear();
          default:
            throw new ProviderError(400, 'Unknown lobby action.', 'One of: stage, swap, clear.');
        }
      });

    case '/api/aliases':
      return handleWrite(res, async () => handleAliasAction(bundle, await readJsonBody(req)));

    case '/api/presets':
      return handleWrite(res, async () => handlePresetAction(bundle, await readJsonBody(req)));

    case '/api/teams':
      return handleWrite(res, async () => handleTeamAction(bundle, await readJsonBody(req)));

    // Raw bytes rather than multipart: there is exactly one file per request and
    // no other fields, so parsing a multipart envelope by hand would be work
    // with nothing to show for it. The declared type is ignored - the store
    // reads the format out of the bytes themselves.
    case '/api/media':
      return handleWrite(res, async () => {
        const saved = await media.save(await readBody(req, MEDIA_MAX_BYTES));
        // Recorded against the account that uploaded it so the media browser
        // shows your own files rather than the whole server's. The bytes stay
        // shared - see makeMediaOwners.
        /*
         * Claimed by the tournament AND by the person who uploaded it.
         *
         * Two axes because there are two honest answers to "whose logo is
         * this". It belongs to the competition, so everybody working on that
         * tournament should find it in their picker - which one axis alone
         * could not give, and the symptom would have read as "my colleague's
         * upload vanished". And it belongs to whoever uploaded it, so it
         * follows them to their next tournament rather than being stranded in
         * a season that has finished.
         *
         * It also settles an asymmetry that was only ever invisible by
         * accident: the claim used `ctx.owner?.id ?? ctx.user?.id` while the
         * listing filtered on `ctx.owner?.id` alone. Those were the same value
         * while a workspace was a person. They are not any more.
         */
        await mediaOwners.claim(ctx.owner?.id, saved.name);
        if (ctx.user?.id) await mediaOwners.claim(ctx.user.id, saved.name);
        log.info('media', `${ctx.user?.username ?? 'somebody'} uploaded ${saved.name}`, { bytes: saved.bytes });
        return saved;
      });

    default:
      return unauthorised(res, 404, `No such route: ${pathname}`);
  }
}

/**
 * One line per request, once it has finished.
 *
 * On `finish` rather than at the start, so the line carries the status and how
 * long it took - which is the whole reason to have it. For an event stream that
 * means the line appears when the browser source disconnects, and the duration
 * is how long it was watching: exactly the question asked after a source drops
 * mid-show.
 *
 * The level is the status, because that is what makes a log skimmable: a 500 is
 * an error, a refusal is a warning, a write is worth seeing at info, and the
 * hundreds of ordinary reads belong at debug where they can be switched on.
 *
 * The health check is dropped entirely. Docker runs it every thirty seconds
 * forever, and a log whose bulk is "the server is still up" is a log nobody
 * reads the rest of.
 */
function logRequest(req, res, startedAt) {
  const path = safeLogUrl(req.url);
  if (path === '/api/health') return;

  const status = res.statusCode;
  const ms = Date.now() - startedAt;
  // Stamped on the request by userFor and contextFor as they resolve it, which
  // is the only place that knows. "(key)" marks a browser source or a game
  // client rather than a person at a dashboard.
  const who = req.rlUser ? `${req.rlUser}${req.rlViaKey ? ' (key)' : ''}` : req.rlViaKey ? 'unknown key' : '-';
  const meta = { status, ms, who };

  const line = `${req.method} ${path}`;
  if (status >= 500) log.error('request', line, meta);
  else if (status >= 400) log.warn('request', line, meta);
  else if (req.method === 'POST') log.info('request', line, meta);
  else log.debug('request', line, meta);
}

const server = createServer((req, res) => {
  const startedAt = Date.now();
  res.on('finish', () => logRequest(req, res, startedAt));

  void route(req, res).catch((error) => {
    // Last resort. Everything below this has its own error shape; what reaches
    // here is a bug, and the only thing that must not happen is the process
    // going down with it.
    log.error('request', `${req.method} ${safeLogUrl(req.url)} threw`, { error: error?.stack ?? String(error) });
    if (res.headersSent) return res.destroy();
    sendJson(res, 500, { error: { status: 500, message: 'Unexpected server error.' } });
  });
});

// Don't leave a headless Chromium behind on Ctrl+C, and don't truncate an
// in-flight graphic save.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // Every open session, not one - and the two server-wide stores that are not
    // in any bundle: the login table, whose lastSeen stamps are held in memory
    // between writes on purpose, and the media index, where a lost claim means
    // an uploader stops seeing their own file in the picker.
    // Said properly rather than dropped: a close frame lets Companion show
    // "disconnected" instead of retrying into a socket that is already gone.
    companion.closeAll('The graphics server is shutting down.');
    logins.flush();
    mediaOwners.flush();
    /*
     * The tournament index, added here in the same commit that made anything
     * depend on it.
     *
     * flushSession below covers a bundle's seven stores and its own comment
     * records the bug from when that list was six and one was missed. This is
     * the server-wide half of the same hazard, and losing it loses a
     * tournament's membership list and its keys - which is not reconstructable
     * from anything else on disk, unlike a graphic that would simply reload
     * from its last save.
     */
    tournaments.flush();
    void Promise.all(sessions.list().map((id) => flushSession(sessions.peek(id))))
      .catch(() => {})
      .then(() => browser?.close())
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}

/**
 * An upgrade that a *browser* started somewhere else.
 *
 * Companion is not a browser and sends no Origin at all, so absent is the
 * normal case and is allowed. A present-but-foreign Origin, though, can only
 * have come from a page on somebody else's site, and this endpoint has no
 * business being opened by one.
 *
 * It is defence in depth rather than the main lock - the credential is in the
 * query string, not a cookie, so a hostile page would have to already know the
 * control key. But the repo's own posture on this is that one real defence is
 * not the whole of one, and the check costs a string compare.
 */
function foreignOriginUpgrade(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== String(req.headers.host ?? '');
  } catch {
    return true; // unparseable, so certainly not ours
  }
}

/*
 * Every upgrade, inside one try.
 *
 * This listener sits outside the `.catch` that wraps the request path, and an
 * upgrade is reachable without any credential at all - so a throw in here is a
 * remote kill in exactly the way `GET /%ZZ` was, with as little in the log to
 * say what happened. `safeUrl` is used for the same reason it is used there:
 * `decodeURIComponent` throws on a malformed escape.
 */
server.on('upgrade', (req, socket, head) => {
  /*
   * Every path out of here - the tracker proxy, a refusal, a plain destroy -
   * leaves a raw socket that can emit 'error' after we have stopped looking at
   * it, and an unlistened 'error' on a socket exits the process. One listener
   * at the top covers all of them; the handlers below add their own on top.
   */
  socket.on('error', (error) => log.debug('upgrade', `socket error: ${error.message}`));

  try {
    // The same check the HTTP side does. An upgrade that skipped it would be a way
    // to reach the VNC socket without one, which is the whole door - and the
    // websocket is the half that carries the keystrokes.
    if (req.url?.startsWith(`${TRACKER_LOGIN_PREFIX}/`) && canOpenTrackerLogin(userFor(req))) {
      return proxyTrackerLoginSocket(req, socket, head);
    }

    const url = safeUrl(req);

    if (url?.pathname === COMPANION_PATH) {
      if (foreignOriginUpgrade(req)) {
        log.warn('companion', 'refused a control channel opened from another site');
        return refuseUpgrade(socket, 403, 'This endpoint is not for cross-site use.');
      }
      // Async, and the only thing that could reject is opening the session -
      // which handleUpgrade answers for itself. This catch is the backstop.
      return void companion.handleUpgrade(req, url, socket, head).catch((error) => {
        log.error('companion', `upgrade failed: ${error.message}`);
        socket.destroy();
      });
    }

    // Nothing else upgrades. No log line: an unmatched upgrade is a scanner.
    socket.destroy();
  } catch (error) {
    log.error('upgrade', `${safeLogUrl(req.url)} threw`, { error: error?.stack ?? String(error) });
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
  const line = '='.repeat(64);
  console.log(line);
  console.log('  Riotline Tool');
  console.log(line);
  console.log(`  UI              http://${shown}:${PORT}`);
  console.log(`  Listening on    ${HOST}:${PORT}${HOST === '0.0.0.0' ? '  (every interface - container mode)' : '  (this machine only)'}`);
  console.log('  OBS + webhooks  per account, with ?key= - copy them from the dashboard');
  console.log(`  Accounts        ${adminNote}`);
  console.log(`  Logins          ${logins.count} open`);
  if (legacyState) {
    console.log('  Note            .state/graphic.json is from before accounts and is NOT in use.');
    console.log('                  Each account now has its own under .state/users/<id>/.');
  }
  console.log(`  Default source  ${DEFAULT_PROVIDER}`);
  console.log(`  Riot region     ${DEFAULT_REGION} / routing ${DEFAULT_ROUTING}`);
  console.log(`  HenrikDev       ${HENRIK_API_KEY ? 'key loaded' : 'missing (HENRIK_API_KEY)'} | ${DEFAULT_AFFINITY}/${DEFAULT_PLATFORM}`);
  console.log(`  Riot key        ${RIOT_API_KEY ? 'loaded' : 'missing (RIOT_API_KEY)'}`);
  console.log(
    `  tracker.gg      ${
      !TRACKER_AVAILABLE
        ? 'unavailable (set TRACKER_ENABLED=true)'
        : trackerOn()
          ? `enabled (${TRACKER_HEADLESS ? 'headless' : 'headed'})`
          : 'switched off by an administrator'
    }`,
  );
  console.log(`  Post-match      ${watchOn() ? 'multi-account watch enabled' : 'multi-account watch switched off'}`);
  /*
   * Two facts, because either one alone is misleading. The switch being on
   * does not mean anybody can connect - every account starts with no control
   * key - and a room full of control keys does nothing while the switch is off.
   */
  {
    const withKeys = tournaments.list().filter((entry) => entry.controlKey).length;
    console.log(
      `  Companion       ${
        !companionOn()
          ? 'switched off by an administrator'
          : `ws://${shown}:${PORT}${COMPANION_PATH}  (${withKeys} tournament${withKeys === 1 ? '' : 's'} with a control key)`
      }`,
    );
  }
  /*
   * Three states, like tracker.gg above, and the middle one names the variable.
   * "Discord is off" and "Discord is on but DISCORD_GUILD_ID is not a
   * snowflake" are twenty minutes apart if the banner will not say which.
   *
   * Never a value: this goes through `console.log`, which `captureConsole` does
   * not wrap, so nothing here passes through redaction.
   */
  console.log(
    `  Discord         ${
      !DISCORD_CONFIGURED
        ? `not configured (${discordMissing()})`
        : !DISCORD_SWITCH
          ? 'off (set DISCORD_ENABLED=true)'
          : !settings.state.discord
            ? 'switched off by an administrator'
            : `enabled (${DISCORD_ROLES.length} role${DISCORD_ROLES.length === 1 ? '' : 's'}, new accounts ${
                DISCORD_ALLOW_SIGNUP ? 'on' : 'off'
              })`
    }`,
  );
  {
    // The one state worth shouting about: every administrator depends on an
    // external service, so a rotated secret locks this server out of itself.
    const counts = adminCounts(users.list());
    if (counts.enabled > 0 && counts.withPassword === 0) {
      console.warn('  WARNING         no administrator has a password - only Discord can administer this server');
    }

    /*
     * An https public name with cookies that are not marked Secure.
     *
     * This is the ordinary deployment - a tunnel or a proxy terminating TLS and
     * forwarding to plain http - so it is worth saying out loud, because
     * nothing else will. The symptom is not an error: everything works, and the
     * login cookie and the ten-minute flow cookie simply travel without the one
     * flag that stops a browser ever sending them over plain http.
     */
    if (DISCORD_PUBLIC_ORIGIN.startsWith('https:') && !COOKIE_SECURE) {
      console.warn('  WARNING         DISCORD_PUBLIC_ORIGIN is https but COOKIE_SECURE is off - set COOKIE_SECURE=true');
    }
  }
  console.log(`  Logging         ${log.level}  (LOG_LEVEL; debug is verbose, and the Admin tab can change it live)`);
  console.log('  Ctrl+C to stop');
  console.log(line);

  // Launch the browser now rather than on the first lookup: it spends its first
  // page load warming up, and that is better spent before a show than during it.
  // Through trackerBrowser, so a server booted with the switch off starts no
  // Chromium at all - which is most of what the switch is for.
  const warm = trackerBrowser();
  if (warm) {
    void warm.prepare().then((ok) =>
      ok ? log.info('tracker', 'browser warmed') : log.warn('tracker', 'browser could not start'),
    );
  }
});
