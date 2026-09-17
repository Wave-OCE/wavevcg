/**
 * One graphics session per user, created on demand.
 *
 * Everything that used to be a module-level singleton in server.js now lives in
 * a bundle rooted at .state/users/<userId>/. Two operators running two matches
 * at once touch entirely separate files, entirely separate stores and entirely
 * separate timers.
 *
 * Not everything moved. Two things stay server-wide, and the difference is worth
 * stating because it is the whole design:
 *
 *   media/           content-addressed by hash, so two users uploading the same
 *                    logo get the same file, and a /media/<hash> URL saved
 *                    inside a graphic keeps resolving when the session is handed
 *                    to somebody else. What is *not* shared is the list of what
 *                    is in there - see makeMediaOwners at the bottom.
 *   valorant-assets  the game's own catalogue of agents and maps. Identical for
 *                    everybody by definition, and downloading it once per user
 *                    would be rude to an API that costs nothing to nobody.
 *
 * Bundles are never evicted on a timer. A handful of operators is the whole
 * expected scale, the state is small, and a session that got evicted mid-match
 * would drop its auto-hide and its agent-select clock on the floor. They go away
 * when the account does.
 */

import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { makeScheduleStore } from './schedule.js';
import { makeVetoStore } from './veto.js';
import {
  makeAliasStore,
  makeGlobalStore,
  makePresetStore,
  makeTeamStore,
} from './graphics.js';
import { BUS_KEYS, makeBus } from './buses.js';

/**
 * The plain stores a session owns, and the file each one lives in.
 *
 * The three graphics are NOT here. They are preview/program pairs and live in
 * BUS_KEYS below, because each of them is two files and a take rather than one
 * store - see buses.js.
 *
 * What stayed a single store is the interesting half of the list, and the rule
 * is "does an audience ever see this":
 *
 *   globals   the production's shared settings. It feeds preview, so it is one
 *             step behind air already; staging the stager would be a second
 *             take for no gain.
 *   presets   a library of styles, not a thing on screen.
 *   teams     a library of orgs, likewise.
 *   aliases   player-name corrections, which are wanted everywhere at once -
 *             an alias staged on preview while air keeps the wrong name is not
 *             a feature anybody asked for.
 */
/**
 * The COMPETITION's stores. One copy, shared by every production of it.
 *
 * The rule for this list is "would two desks running two matches of the same
 * competition ever want different answers". None of these would:
 *
 *   teams     one library of orgs. Two per tournament is two to keep in step,
 *             and the failure is a rename that reached one court and not the
 *             other - on air, with nothing raised.
 *   aliases   a player-name correction is wanted everywhere at once, which is
 *             already why it is not split across preview and program.
 *   schedule  there is one competition. A table per court is not a table.
 *   presets   the look of the broadcast. Both courts of one tournament should
 *             match, and that is the whole point of having a preset.
 *
 * They are shared by REFERENCE, so an edit made on one desk is visible to the
 * other immediately - no syncing, no second source of truth.
 */
const SHARED_STORES = [
  ['presets', makePresetStore, 'presets.json'],
  ['teams', makeTeamStore, 'teams.json'],
  ['aliases', makeAliasStore, 'aliases.json'],
  ['schedule', makeScheduleStore, 'schedule.json'],
  /*
   * The map vetoes, and the pool they draw from.
   *
   * Shared for the same reason the schedule is: two courts of one tournament do
   * not hold different opinions about which maps Crusaders banned, and whoever
   * is refereeing needs to reach a veto from whichever desk they happen to be
   * sitting at. The pool is a fact about the SEASON, which settles it twice
   * over.
   */
  ['veto', makeVetoStore, 'veto.json'],
];

/**
 * The DESK's stores. One set per production.
 *
 * `globals` is here rather than above and the reason is the one that made
 * productions necessary at all: it carries the map and the shared settings of
 * a match, and two courts are not on the same map.
 */
const STORES = [
  ['globals', makeGlobalStore, 'global.json'],
];

/**
 * A tournament id is a UUID we generated, so it is already safe in a path - but
 * it arrives here having passed through a query string and a JSON file, and "it
 * cannot happen" is how directory traversal happens. One regexp is cheaper than
 * being wrong.
 */
const SAFE_ID = /^[a-z0-9-]{1,64}$/i;

export function makeSessionRegistry({ root, onCreate, onDispose, log = () => {} }) {
  /** @type {Map<string, object>} */
  const bundles = new Map();
  /** A desk is identified by BOTH ids; a production id alone would not name its tree. */
  const keyOf = (tournamentId, productionId) => `${String(tournamentId)}/${String(productionId)}`;
  /** @type {Map<string, Promise<object>>} */
  const opening = new Map();

  /**
   * Where a workspace lives.
   *
   * This one line is the cutover. It was `users/<userId>`, because a production
   * belonged to the person who owned it; it is `tournaments/<tournamentId>`
   * because a production belongs to the competition and people are members of
   * it. Everything else in this file is unchanged - a bundle never cared who
   * the id belonged to, only that it was one - which is why the change lands
   * here and not in ten places.
   *
   * `tools/migrate-tournaments.mjs` is what moves the directories to match.
   * There is no fallback to the old path on purpose: a reader that quietly
   * tried `users/<id>` too would turn a half-finished migration into a server
   * that works for some workspaces and serves silent defaults for the rest.
   */
  const dirFor = (tournamentId) => path.join(root, 'tournaments', String(tournamentId));
  /*
   * And the second level, which is the productions cutover.
   *
   * A tournament's own directory still holds the competition - teams, aliases,
   * the schedule, the presets - and each DESK gets a subdirectory of it for the
   * graphics and the globals. The same rule as last time applies: there is no
   * fallback to the flat layout, because a reader that quietly tried the parent
   * directory too would turn a half-finished migration into a server that
   * serves real state for some desks and silent defaults for the rest - which
   * on air is an empty scoreboard nobody can explain.
   *
   * `tools/migrate-productions.mjs` is what moves the files.
   */
  const deskFor = (tournamentId, productionId) =>
    path.join(dirFor(tournamentId), 'productions', String(productionId));

  /** The competition's stores, opened once per tournament and shared by reference. */
  const shared = new Map();
  const sharing = new Map();

  async function openShared(tournamentId) {
    const id = String(tournamentId);
    const existing = shared.get(id);
    if (existing) return existing;
    const pending = sharing.get(id);
    if (pending) return pending;

    const work = (async () => {
      const dir = dirFor(id);
      const stores = {};
      for (const [key, make, file] of SHARED_STORES) stores[key] = make(path.join(dir, file));
      await Promise.all(SHARED_STORES.map(([key]) => stores[key].load()));
      shared.set(id, stores);
      sharing.delete(id);
      return stores;
    })().catch((error) => {
      sharing.delete(id);
      throw error;
    });

    sharing.set(id, work);
    return work;
  }

  async function open(tournamentId, productionId) {
    const id = String(tournamentId);
    const desk = String(productionId);
    if (!SAFE_ID.test(id) || !SAFE_ID.test(desk)) throw new Error('Bad session id.');

    const dir = deskFor(id, desk);
    const bundle = { tournamentId: id, productionId: desk, dir, teardown: [] };

    // The competition first, so a desk that opens second finds the same
    // library object the first one is already writing into.
    Object.assign(bundle, await openShared(id));

    for (const [key, make, file] of STORES) {
      bundle[key] = make(path.join(dir, file));
    }
    for (const key of BUS_KEYS) {
      bundle[key] = makeBus(key, (file) => path.join(dir, file));
    }

    // Loaded together: a session with half its state restored would render a
    // scoreboard from disk beside a winner sequence from the defaults.
    const [plain, buses] = await Promise.all([
      Promise.all(STORES.map(([key]) => bundle[key].load())),
      Promise.all(BUS_KEYS.map((key) => bundle[key].load())),
    ]);

    const restored = plain.filter(Boolean).length + buses.filter((r) => r.program).length;
    const total = STORES.length + BUS_KEYS.length;
    // Said out loud, because it happens exactly once per session per upgrade
    // and it is the moment preview comes into existence. A silent seed is a
    // thing somebody later wonders about.
    const seeded = buses.filter((r) => r.seeded).length;
    log(
      'session',
      `opened ${id} (${restored}/${total} restored from disk` +
        (seeded ? `, ${seeded} preview bus${seeded === 1 ? '' : 'es'} seeded from what is on air)` : ')'),
    );

    // The drivers - auto-hide, the winner sequence, the agent-select clock -
    // are wired by the caller, because what they do is server.js's business and
    // only their lifetime is this file's.
    onCreate?.(bundle);
    return bundle;
  }

  return {
    get size() {
      return bundles.size;
    },

    /** Every desk opened since boot, as `<tournamentId>/<productionId>`. */
    list: () => [...bundles.keys()],

    /**
     * Is a desk open? With no production, is ANY desk of this tournament open?
     *
     * Both questions get asked and they are genuinely different: the picker
     * wants to know about one court, and the tournament list wants to know
     * whether the competition is loaded at all.
     */
    has: (tournamentId, productionId) =>
      productionId === undefined
        ? [...bundles.keys()].some((entry) => entry.startsWith(`${String(tournamentId)}/`))
        : bundles.has(keyOf(tournamentId, productionId)),

    /** An already-open bundle, without opening one. For shutdown and reporting. */
    peek: (tournamentId, productionId) => bundles.get(keyOf(tournamentId, productionId)) ?? null,

    /**
     * The competition's stores alone, with no desk.
     *
     * For the export, which reads the team library, the aliases and the
     * schedule and has no business opening a set of graphics - or choosing
     * arbitrarily between two desks - to do it.
     */
    sharedFor: (tournamentId) => openShared(tournamentId),

    /** A bundle by the composite key `list()` hands out. For the shutdown flush. */
    peekKey: (key) => bundles.get(String(key)) ?? null,

    /** Which desks of one tournament are open. For a delete that has to close them all. */
    deskKeysFor: (tournamentId) => {
      const prefix = `${String(tournamentId)}/`;
      return [...bundles.keys()].filter((entry) => entry.startsWith(prefix));
    },

    /**
     * The bundle for a user, opening it if this is the first time.
     *
     * Concurrent callers share one open. Without that, two requests arriving
     * together - which is exactly what a dashboard load does - would each build
     * a full set of stores over the same files, and the loser's writes would
     * vanish into an object nobody was reading.
     */
    async get(tournamentId, productionId) {
      const id = keyOf(tournamentId, productionId);
      const existing = bundles.get(id);
      if (existing) return existing;

      const pending = opening.get(id);
      if (pending) return pending;

      const work = open(tournamentId, productionId)
        .then((bundle) => {
          bundles.set(id, bundle);
          opening.delete(id);
          return bundle;
        })
        .catch((error) => {
          opening.delete(id);
          throw error;
        });

      opening.set(id, work);
      return work;
    },

    /** Stop one desk's timers and forget it. The files stay. */
    dispose(tournamentId, productionId) {
      const id = keyOf(tournamentId, productionId);
      const bundle = bundles.get(id);
      if (!bundle) return false;
      for (const stop of bundle.teardown) {
        try {
          stop();
        } catch {
          /* a driver that will not stop must not block the rest */
        }
      }
      onDispose?.(bundle);
      bundles.delete(id);
      log('session', `closed ${id}`);
      return true;
    },

    /**
     * Everything a deleted TOURNAMENT leaves behind - every desk of it.
     *
     * Each desk is disposed first, because a driver still running would keep
     * writing into a tree being removed underneath it. The shared stores go too:
     * leaving them cached would let a tournament created later with the same id
     * - which cannot happen with UUIDs, but "cannot happen" is how this file
     * already got one directory-traversal guard - open onto a stale library.
     */
    async destroy(tournamentId) {
      const id = String(tournamentId);
      if (!SAFE_ID.test(id)) throw new Error('Bad session id.');
      for (const entry of this.deskKeysFor(id)) {
        const [, desk] = entry.split('/');
        this.dispose(id, desk);
      }
      shared.delete(id);
      await rm(dirFor(id), { recursive: true, force: true });
      log('session', `deleted the state of ${id}`);
    },

    /**
     * One desk removed, leaving the competition alone.
     *
     * The counterpart to `destroy`, and the distinction matters: removing a
     * court must not take the team library, the schedule or the other court
     * with it.
     */
    async destroyProduction(tournamentId, productionId) {
      const id = String(tournamentId);
      const desk = String(productionId);
      if (!SAFE_ID.test(id) || !SAFE_ID.test(desk)) throw new Error('Bad session id.');
      this.dispose(id, desk);
      await rm(deskFor(id, desk), { recursive: true, force: true });
      log('session', `deleted the state of desk ${desk}`);
    },
  };
}

/**
 * Who uploaded which file.
 *
 * The blobs stay in one shared, content-addressed directory - that is what
 * makes a `/media/<hash>.<ext>` URL saved inside a graphic keep working when
 * you hand the session to a colleague, and it means two operators uploading the
 * same event logo store it once. But `GET /api/media` used to readdir the lot,
 * so every dashboard's picker enumerated every other production's artwork.
 *
 * So: shared bytes, private index. A name is claimed by each account that
 * uploads it, which is a set rather than a single owner because two people
 * uploading identical bytes get identical names and neither of them is wrong.
 * Nothing is ever removed from a claim - there is no delete route for media
 * either, and a dangling name simply stops being listed.
 */
export function makeMediaOwners(filePath) {
  /** @type {Map<string, Set<string>>} name -> userIds */
  let owners = new Map();
  let writeChain = Promise.resolve();

  const persist = () => {
    const snapshot = JSON.stringify([...owners].map(([name, ids]) => [name, [...ids]]), null, 2);
    writeChain = writeChain
      .then(() => mkdir(path.dirname(filePath), { recursive: true }))
      .then(() => writeFile(filePath, snapshot, 'utf8'))
      .catch((error) => console.warn(`  media index not saved: ${error.message}`));
    return writeChain;
  };

  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (!Array.isArray(parsed)) return false;
        owners = new Map(parsed.map(([name, ids]) => [String(name), new Set(ids.map(String))]));
        return true;
      } catch {
        return false;
      }
    },

    claim(userId, name) {
      if (!userId || !name) return;
      const ids = owners.get(String(name)) ?? new Set();
      if (ids.has(String(userId))) return;
      ids.add(String(userId));
      owners.set(String(name), ids);
      return persist();
    },

    owns: (userId, name) => Boolean(owners.get(String(name))?.has(String(userId))),

    /**
     * Files this account uploaded.
     *
     * An unclaimed file belongs to nobody and is listed for nobody: on an
     * upgrade from the single-user layout the index starts empty, so the picker
     * starts empty too. The files are still there and every graphic that
     * references one still renders - only the browse list is affected, and it
     * fills up again as soon as somebody uploads.
     */
    filter: (userId, entries) => entries.filter((entry) => owners.get(entry.name)?.has(String(userId))),

    /**
     * Let the process exit without truncating an in-flight save.
     *
     * Same omission the alias store had. Losing a claim does not lose the file -
     * the bytes are content-addressed and every graphic referencing one still
     * renders - but the uploader stops seeing it in their own media browser,
     * and there is no way to claim it back short of uploading it again.
     */
    flush: () => writeChain,
  };
}
