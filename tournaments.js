/**
 * Tournaments, and who may work on them.
 *
 * Deliberately shaped like `makeUserStore`: one JSON array at `.state/tournaments.json`,
 * loaded once, mutated in memory, persisted through a chain so two writes cannot
 * interleave. The symmetry is the point - `.state/users.json` indexes accounts and
 * `.state/users/<id>/` holds each one's stores, so `.state/tournaments.json` indexes
 * tournaments and `.state/tournaments/<id>/` will hold theirs.
 *
 * The noun is "tournament" rather than "event" on purpose. `event` is the most
 * overloaded word in this codebase already - server-sent events, roster events,
 * game events, scene events - and `GET /api/events` is the SSE multiplexer, so
 * the obvious route name was taken before this feature existed. "Tournament" is
 * also what an operator calls it, and what the capability gating it is called.
 *
 * ## Membership is held on the TOURNAMENT, and that is an inversion
 *
 * `auth.js` keeps a grant on the OWNER (`grants: { granteeId: level }`) because
 * the thing being shared is that person's own production: revoking is one write
 * to one record, and deleting an account cannot leave a permission pointing at a
 * session that no longer exists.
 *
 * A tournament has no owning person, so the same argument now points the other way.
 * Membership lives on the tournament (`members: { userId: level }`), where revoking
 * is still one write to one record, and where "who works on this tournament" is
 * answerable by reading one object instead of scanning every account.
 *
 * The consequence to keep hold of: removing somebody from a tournament and deleting
 * their account are now different operations with different blast radii, and
 * only the first one may ever touch a tournament. See `forgetUser`.
 *
 * ## What a tournament does NOT have yet
 *
 * No key, no workspace directory, no graphics. A tournament at this stage is a
 * record and a membership list; nothing routes to it and nothing renders from
 * it. That is what makes this deployable on a show day - the feature is inert
 * until the stage that gives it a workspace.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  FIRST_PRODUCTION_NAME,
  TOURNAMENT_ROLES,
  emptyTournament,
  sanitiseProductionFields,
  sanitiseTournamentFields,
} from './public/tournament-schema.js';

/**
 * The same guard `sessions.js` puts on a session id, for the same reason.
 *
 * A tournament id is generated here and is therefore safe - but it arrives back
 * through a JSON file and a query string before it is joined into a path, and
 * "it cannot happen" is how directory traversal happens.
 */
const SAFE_ID = /^[a-z0-9-]{1,64}$/i;

const now = () => Date.now();

const stamp = (value) => (Number.isFinite(value) ? value : 0);

/** An opaque identifier or key: a bounded string, or blank. */
const text = (value, max) => String(value ?? '').slice(0, max);

/**
 * One tournament.
 *
 * An allowlist, like `cleanUser`, with the same consequence: anything not named
 * here is dropped on load and erased on the next write. A field added to
 * tournament-schema.js reaches this automatically through `sanitiseTournamentFields`; a
 * field added by hand to tournaments.json does not survive.
 */
/**
 * One desk.
 *
 * The two keys keep the asymmetry they had on the tournament, because it was
 * never about tournaments - it is about what each key opens. The session key
 * self-mints: a production without one is a browser source with nothing to put
 * in it, and there is no moment in its life where "no key yet" is a state
 * anybody wants. The control key does NOT: a key that opens a graphic is one
 * thing, a key that operates the desk is another, and a production minting a
 * live remote control for a broadcast on first load - one nobody asked for and
 * nobody knows exists - is the surprise a permission-shaped thing must never
 * spring.
 */
function cleanProduction(input) {
  const source = input ?? {};
  return {
    id: SAFE_ID.test(String(source.id ?? '')) ? String(source.id) : randomUUID(),
    ...sanitiseProductionFields(source, { name: '' }),
    sessionKey: text(source.sessionKey, 64) || randomUUID(),
    controlKey: text(source.controlKey, 64),
    createdAt: stamp(source.createdAt) || now(),
  };
}

/**
 * The productions of a tournament, and the legacy read that makes migration day
 * invisible to the records.
 *
 * A record written before productions existed carries `sessionKey` and
 * `controlKey` at the top level and no `productions` at all. It is read here as
 * ONE production called "Main" holding both keys - so every OBS URL and every
 * webhook already in a config file keeps resolving, and no stream deck is
 * dropped. That is the same argument "program keeps the original file name"
 * made for the preview/program split: the change arrives invisible, and nothing
 * anybody typed into another program has to be retyped.
 *
 * Shipped in the same commit as the new storage, like `cleanUser`'s capability
 * fallback - a legacy read added later is a legacy read that was missing for
 * however long it took somebody to notice.
 *
 * The FILES still have to move; `tools/migrate-productions.mjs` does that, and
 * it is the half that cannot be done by reading.
 */
function cleanProductions(source) {
  const listed = Array.isArray(source.productions) ? source.productions : null;

  if (listed?.length) {
    const seen = new Set();
    const out = [];
    for (const entry of listed) {
      const production = cleanProduction(entry);
      // A duplicate id makes "which desk did you mean" unanswerable, and both
      // would answer to one key.
      if (seen.has(production.id)) continue;
      seen.add(production.id);
      out.push(production);
    }
    if (out.length) return out;
  }

  /*
   * The legacy shape, or a brand new tournament. Either way it gets one desk -
   * and its id is THE TOURNAMENT'S OWN, deterministically.
   *
   * That looks odd on disk (`tournaments/<id>/productions/<id>/`) and it is
   * load-bearing. A random UUID here is minted on every load and lost again
   * unless something happens to write, so two boots of an unmigrated tree would
   * name the same desk differently - and `tools/migrate-productions.mjs`, which
   * has to create that directory before anything writes the record, would move
   * a tournament's graphics into a directory the next boot no longer looks in.
   * A blank scoreboard, no error, no log line.
   *
   * A fixed literal like "main" would be deterministic too and is worse: ids
   * are globally unique so that `?production=` names a desk without also naming
   * its tournament, and forty tournaments all owning a desk called "main" would
   * make that impossible.
   */
  const first = SAFE_ID.test(String(source.id ?? '')) ? String(source.id) : randomUUID();
  return [
    cleanProduction({
      id: first,
      name: FIRST_PRODUCTION_NAME,
      sessionKey: text(source.sessionKey, 64),
      controlKey: text(source.controlKey, 64),
      createdAt: source.createdAt,
    }),
  ];
}

function cleanTournament(input) {
  const source = input ?? {};

  const members = {};
  for (const [id, level] of Object.entries(source.members ?? {})) {
    if (TOURNAMENT_ROLES.includes(level) && SAFE_ID.test(String(id))) members[String(id)] = level;
  }

  return {
    id: SAFE_ID.test(String(source.id ?? '')) ? String(source.id) : '',
    ...sanitiseTournamentFields(source, emptyTournament()),
    members,

    /*
     * The desks. One set of graphics, one OBS configuration and one stream deck
     * each - see PRODUCTION_FIELDS for why a tournament owns several.
     *
     * **The two keys live on a PRODUCTION now, not here.** A tournament has no
     * key of its own, which is the same sentence the cutover wrote about people
     * and for the same reason: a key names the thing whose graphics it opens,
     * and a tournament's graphics are not a single thing any more.
     */
    productions: cleanProductions(source),

    /*
     * The account whose workspace this was, before tournaments owned them.
     *
     * Written once by tools/migrate-tournaments.mjs and never again. It is what
     * makes that runner idempotent - a second run finds the tournament already
     * standing for this account and skips it, rather than making a duplicate -
     * and it stays afterwards because "where did this workspace come from" is a
     * question somebody asks once a season and cannot otherwise answer.
     */
    migratedFrom: text(source.migratedFrom, 64),
    createdAt: stamp(source.createdAt) || now(),
    createdBy: String(source.createdBy ?? '').slice(0, 64),
    /*
     * When somebody archived this, or 0.
     *
     * A timestamp rather than a boolean because "archived" is an event in time
     * that an operator will want to see - and because a boolean would have to
     * be paired with a date field anyway the first time anyone asked when.
     */
    archivedAt: stamp(source.archivedAt),
  };
}

/** What this account may do with this tournament, or null. */
export function tournamentLevel(tournament, userId) {
  if (!tournament || !userId) return null;
  return tournament.members?.[String(userId)] ?? null;
}

export const canEditTournament = (level) => level === 'owner' || level === 'editor';
export const canViewTournament = (level) => level === 'owner' || level === 'editor' || level === 'viewer';
export const isTournamentOwner = (level) => level === 'owner';

/** How many owners a tournament has. The last-owner lock counts this. */
const ownerCount = (tournament) =>
  Object.values(tournament?.members ?? {}).filter((level) => level === 'owner').length;

export function makeTournamentStore(filePath) {
  /** @type {ReturnType<typeof cleanTournament>[]} */
  let tournaments = [];
  let writeChain = Promise.resolve();

  function persist() {
    const snapshot = JSON.stringify(tournaments, null, 2);
    writeChain = writeChain
      .then(() => mkdir(path.dirname(filePath), { recursive: true }))
      .then(() => writeFile(filePath, snapshot, 'utf8'))
      .catch((error) => console.warn(`  tournaments not saved: ${error.message}`));
    return writeChain;
  }

  const find = (id) => tournaments.find((tournament) => tournament.id === String(id)) ?? null;

  /*
   * A record handed out, deep enough that a caller cannot reach back in.
   *
   * `members` was always copied; `productions` now has to be too, and it is an
   * array of objects rather than a flat map - so a shallow spread would hand a
   * caller the live production objects, keys and all. Every caller of this file
   * either sends a record over the wire or puts it in a template, and one that
   * mutated a production in passing would rotate a live OBS key with nothing
   * written to disk and nothing logged.
   */
  const copy = (tournament) => ({
    ...tournament,
    members: { ...tournament.members },
    productions: tournament.productions.map((production) => ({ ...production })),
  });

  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (!Array.isArray(parsed)) return false;
        // A record with no id cannot be addressed, so it is not a tournament.
        tournaments = parsed.map(cleanTournament).filter((tournament) => tournament.id);
        return true;
      } catch {
        return false;
      }
    },

    /**
     * Let the process exit without truncating an in-flight save.
     *
     * The omission that bit the alias store and the media index. Losing an
     * tournament record loses a tournament's membership list, which is not
     * reconstructable from anything else on disk.
     */
    flush: () => writeChain,

    get size() {
      return tournaments.length;
    },

    list: () => tournaments.map((tournament) => (copy(tournament))),

    byId: (id) => {
      const found = find(id);
      return found ? copy(found) : null;
    },

    /**
     * Every tournament this account can see, newest first.
     *
     * Archived ones are included and marked rather than hidden: an operator
     * looking for last season's team library needs to find it, and a workspace
     * that vanishes from a list reads as data loss.
     */
    forUser(userId) {
      const id = String(userId ?? '');
      return tournaments
        .filter((tournament) => canViewTournament(tournamentLevel(tournament, id)))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((tournament) => ({ ...copy(tournament), level: tournamentLevel(tournament, id) }));
    },

    /**
     * Make one. The creator is its first owner, and that is not optional.
     *
     * A tournament with no owner is a record nobody can administer, and nothing
     * else in this store would ever give it one - `setMember` refuses to remove
     * the last owner, so it can never manufacture the first.
     */
    create({ name = '', createdBy = '' } = {}) {
      if (!createdBy) throw new Error('A tournament needs a creator.');
      const tournament = cleanTournament({
        id: randomUUID(),
        name,
        createdBy: String(createdBy),
        createdAt: now(),
        members: { [String(createdBy)]: 'owner' },
      });
      tournaments.push(tournament);
      persist();
      return copy(tournament);
    },

    /** Change the operator-editable fields. Never the id, members or stamps. */
    update(id, changes) {
      const tournament = find(id);
      if (!tournament) throw new Error('No such tournament.');
      Object.assign(tournament, sanitiseTournamentFields(changes, tournament));
      persist();
      return copy(tournament);
    },

    /**
     * Add, change or remove a member.
     *
     * A falsy level removes. Refusing to remove the last owner is the same
     * shape as `adminCounts().withPassword` in auth.js and exists for the same
     * reason: a record that can be administered by nobody is one an
     * administrator has to go into a JSON file to fix.
     */
    setMember(id, userId, level) {
      const tournament = find(id);
      if (!tournament) throw new Error('No such tournament.');
      const member = String(userId ?? '');
      if (!SAFE_ID.test(member)) throw new Error('Bad user id.');

      const wanted = TOURNAMENT_ROLES.includes(level) ? level : null;
      const wasOwner = tournament.members[member] === 'owner';

      if (wasOwner && wanted !== 'owner' && ownerCount(tournament) <= 1) {
        throw new Error('This is the last owner of the tournament.');
      }

      if (wanted) tournament.members[member] = wanted;
      else delete tournament.members[member];

      persist();
      return copy(tournament);
    },

    /**
     * Archive or reopen.
     *
     * Archiving is deliberately not deleting. It stops a tournament being worked on
     * and leaves everything it holds exactly where it is, which is what a
     * tournament that finished actually wants - the team library and the alias
     * corrections are the valuable part and they outlive the competition.
     */
    setArchived(id, archived) {
      const tournament = find(id);
      if (!tournament) throw new Error('No such tournament.');
      tournament.archivedAt = archived ? (tournament.archivedAt || now()) : 0;
      persist();
      return copy(tournament);
    },

    /**
     * The tournament an OBS source or a webhook is pointing at.
     *
     * This is the lookup that used to live on the account store, and moving it
     * is most of what "the key names a workspace" means. A bare `?key=` has to
     * resolve to exactly one workspace with no other information in the request -
     * there is no cookie on an OBS browser source and no person behind it - which
     * is why the key had to move onto the tournament rather than stay on a person
     * who may be running three.
     */
    /**
     * The tournament AND the production a session key opens.
     *
     * Both, because everything downstream needs both: the directory a bundle
     * reads is under the tournament and then under the production, and the
     * shared libraries belong to the tournament. Returning only the production
     * would make every caller look its parent up again.
     *
     * A scan over one index file rather than a second index of keys. A separate
     * key table is a second thing to keep in step, and the failure when it
     * drifts is a key that opens nothing with the tournament sitting right
     * there holding it.
     */
    bySessionKey: (key) => {
      const wanted = String(key ?? '');
      if (!wanted) return null;
      for (const tournament of tournaments) {
        const production = tournament.productions.find((entry) => entry.sessionKey === wanted);
        if (production) return { tournament: copy(tournament), production: { ...production } };
      }
      return null;
    },

    byControlKey: (key) => {
      const wanted = String(key ?? '');
      // Never matches the blank field of a production that has not minted one.
      if (!wanted) return null;
      for (const tournament of tournaments) {
        const production = tournament.productions.find((entry) => entry.controlKey && entry.controlKey === wanted);
        if (production) return { tournament: copy(tournament), production: { ...production } };
      }
      return null;
    },

    /** One desk by its own id, wherever it lives. Ids are UUIDs, so globally unique. */
    byProductionId: (productionId) => {
      const wanted = String(productionId ?? '');
      if (!wanted) return null;
      for (const tournament of tournaments) {
        const production = tournament.productions.find((entry) => entry.id === wanted);
        if (production) return { tournament: copy(tournament), production: { ...production } };
      }
      return null;
    },

    /**
     * Which desk a request means when it names a tournament and nothing else.
     *
     * The first, which is the one migration day created and the one a
     * single-stream tournament will only ever have. It decides a first load
     * only - the picker writes the production into the URL after that.
     */
    defaultProduction: (tournament) => {
      const found = tournaments.find((t) => t.id === String(tournament?.id ?? tournament ?? ''));
      return found?.productions[0] ? { ...found.productions[0] } : null;
    },

    /** Add a desk. Its keys mint exactly as the first one's did. */
    addProduction(id, name = '') {
      const tournament = find(id);
      if (!tournament) throw new Error('No such tournament.');
      const production = cleanProduction({ name });
      tournament.productions.push(production);
      persist();
      return { tournament: copy(tournament), production: { ...production } };
    },

    updateProduction(id, productionId, fields) {
      const tournament = find(id);
      if (!tournament) throw new Error('No such tournament.');
      const production = tournament.productions.find((entry) => entry.id === String(productionId));
      if (!production) throw new Error('No such production.');
      Object.assign(production, sanitiseProductionFields(fields, production));
      persist();
      return { tournament: copy(tournament), production: { ...production } };
    },

    /**
     * Remove a desk.
     *
     * The LAST one is refused, for the same reason the last owner is: a
     * tournament with no production has no graphics, no OBS URL and no way back
     * except editing JSON by hand, and nothing in the UI would explain how it
     * got there. The caller is responsible for the directory.
     */
    removeProduction(id, productionId) {
      const tournament = find(id);
      if (!tournament) throw new Error('No such tournament.');
      if (tournament.productions.length <= 1) {
        throw new Error('A tournament needs at least one production.');
      }
      const before = tournament.productions.length;
      tournament.productions = tournament.productions.filter((entry) => entry.id !== String(productionId));
      if (tournament.productions.length === before) return null;
      persist();
      return copy(tournament);
    },

    /**
     * The same, with an explanation when it fails.
     *
     * The overwhelmingly likely mistake is pasting the session key, because both
     * are UUIDs that appear on the same page, and "that is the other key" is
     * unguessable from outside a stream deck.
     */
    resolveControlKey(key) {
      const wanted = String(key ?? '');
      if (!wanted) return { owner: null, hint: 'No control key was sent.' };

      /*
       * The owner handed back is the PRODUCTION, not the tournament.
       *
       * A stream deck drives one desk - that is what a control key opens - so
       * `owner.id` downstream has to be the production's id or every op would
       * land on whichever desk happened to be first. The tournament's name is
       * folded into the label because "Court 2" alone is not enough to know
       * what you have connected to, and its id travels for the bundle lookup.
       */
      for (const tournament of tournaments) {
        const production = tournament.productions.find((entry) => entry.controlKey && entry.controlKey === wanted);
        if (production) {
          return {
            owner: {
              ...production,
              tournamentId: tournament.id,
              name: [tournament.name || 'Untitled tournament', production.name].filter(Boolean).join(' - '),
            },
          };
        }
      }

      // The overwhelmingly likely mistake, now checked across every desk.
      if (tournaments.some((t) => t.productions.some((p) => p.sessionKey === wanted))) {
        return {
          owner: null,
          hint:
            'That is the OBS session key, not the control key. They are different on purpose - ' +
            'copy the one from the Companion panel on the Tournament page.',
        };
      }
      return { owner: null, hint: 'That control key matches no production. It may have been rotated or withdrawn.' };
    },

    /**
     * Which tournament a dashboard opens on when the URL does not say.
     *
     * The newest this account can see. Somebody on one tournament always gets
     * it; somebody on several gets the one they most likely just made, and the
     * picker is how they say otherwise - the URL carries `?session=` from then
     * on, so this only ever decides a first load.
     *
     * Null is a real answer and the pages have to handle it: an account on no
     * tournament at all is the ordinary state of somebody who has just been
     * given a login and not yet been added to anything.
     */
    defaultFor(userId) {
      const mine = this.forUser(userId);
      return mine.find((t) => !t.archivedAt) ?? mine[0] ?? null;
    },

    /** New OBS key for one desk. Every source pointing at THAT desk stops working. */
    rotateSessionKey(id, productionId) {
      const tournament = find(id);
      if (!tournament) throw new Error('No such tournament.');
      const production = tournament.productions.find((entry) => entry.id === String(productionId));
      if (!production) throw new Error('No such production.');
      production.sessionKey = randomUUID();
      persist();
      return { tournament: copy(tournament), production: { ...production } };
    },

    /**
     * Mint or withdraw the Companion control key.
     *
     * `false` withdraws, which is not the same as rotating: a withdrawn key
     * leaves the tournament unable to be driven by a stream deck at all, which
     * is the state every tournament starts in.
     */
    setControlKey(id, productionId, wanted) {
      const tournament = find(id);
      if (!tournament) throw new Error('No such tournament.');
      const production = tournament.productions.find((entry) => entry.id === String(productionId));
      if (!production) throw new Error('No such production.');
      const had = Boolean(production.controlKey);
      production.controlKey = wanted === false ? '' : randomUUID();
      persist();
      return { tournament: copy(tournament), production: { ...production }, had };
    },

    /** Drop a tournament entirely. The caller is responsible for its workspace. */
    remove(id) {
      const before = tournaments.length;
      tournaments = tournaments.filter((tournament) => tournament.id !== String(id));
      if (tournaments.length === before) return false;
      persist();
      return true;
    },

    /**
     * Forget an account, without touching any tournament's existence.
     *
     * The counterpart to `users.remove`, which already sweeps grants pointing at
     * a deleted account. The rule here is stronger and worth stating: deleting a
     * PERSON must never delete a TOURNAMENT. Several people work on one tournament,
     * the workspace is the shared thing, and an account being removed from the
     * roster is not a reason to take a competition's graphics with it.
     *
     * A tournament whose last owner is deleted is left ownerless rather than
     * destroyed. That is a state an administrator can see and repair; the
     * alternative is one that cannot be undone.
     */
    forgetUser(userId) {
      const id = String(userId ?? '');
      let touched = 0;
      const orphaned = [];
      for (const tournament of tournaments) {
        if (!(id in tournament.members)) continue;
        const wasOwner = tournament.members[id] === 'owner';
        delete tournament.members[id];
        touched += 1;
        if (wasOwner && ownerCount(tournament) === 0) orphaned.push(tournament.id);
      }
      if (touched) persist();
      return { touched, orphaned };
    },

    /** Tournaments with no owner left. For the admin panel to offer a repair. */
    ownerless: () =>
      tournaments.filter((tournament) => ownerCount(tournament) === 0).map((tournament) => (copy(tournament))),
  };
}
