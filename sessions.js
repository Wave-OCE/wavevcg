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
const STORES = [
  ['globals', makeGlobalStore, 'global.json'],
  ['presets', makePresetStore, 'presets.json'],
  ['teams', makeTeamStore, 'teams.json'],
  ['aliases', makeAliasStore, 'aliases.json'],
  /*
   * The schedule: stages, fixtures, and the edges that carry a winner forward.
   *
   * A single store rather than a bus, by the rule above. It is a library of
   * matches exactly as `teams` is a library of orgs - no audience sees it, and
   * a bus would light "preview differs from air" every time somebody edited
   * next Tuesday's fixture.
   */
  ['schedule', makeScheduleStore, 'schedule.json'],
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

  async function open(tournamentId) {
    const id = String(tournamentId);
    if (!SAFE_ID.test(id)) throw new Error('Bad session id.');

    const dir = dirFor(id);
    const bundle = { tournamentId: id, dir, teardown: [] };

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

    /** Every session that has been opened since boot. For the admin panel. */
    list: () => [...bundles.keys()],

    has: (userId) => bundles.has(String(userId)),

    /** An already-open bundle, without opening one. For shutdown and reporting. */
    peek: (userId) => bundles.get(String(userId)) ?? null,

    /**
     * The bundle for a user, opening it if this is the first time.
     *
     * Concurrent callers share one open. Without that, two requests arriving
     * together - which is exactly what a dashboard load does - would each build
     * a full set of stores over the same files, and the loser's writes would
     * vanish into an object nobody was reading.
     */
    async get(userId) {
      const id = String(userId);
      const existing = bundles.get(id);
      if (existing) return existing;

      const pending = opening.get(id);
      if (pending) return pending;

      const work = open(id)
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

    /** Stop a session's timers and forget it. The files stay. */
    dispose(userId) {
      const id = String(userId);
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

    /** Everything a deleted account leaves behind. */
    async destroy(userId) {
      const id = String(userId);
      if (!SAFE_ID.test(id)) throw new Error('Bad session id.');
      this.dispose(id);
      await rm(dirFor(id), { recursive: true, force: true });
      log('session', `deleted the state of ${id}`);
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
