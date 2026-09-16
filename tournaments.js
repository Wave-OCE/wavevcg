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

import { TOURNAMENT_ROLES, sanitiseTournamentFields, emptyTournament } from './public/tournament-schema.js';

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
     * The key in this tournament's OBS and webhook URLs.
     *
     * Self-minting, like the account key it replaces: a workspace that could
     * exist without one would be a browser source with nothing to put in it,
     * and there is no moment in a tournament's life where "no key yet" is a
     * state anybody wants.
     */
    sessionKey: text(source.sessionKey, 64) || randomUUID(),

    /*
     * The Companion control channel's key, and deliberately NOT self-minting -
     * the opposite of the line above, exactly as on an account.
     *
     * A key that opens a graphic is one thing; a key that operates the desk is
     * another. Every tournament minting a live remote control for its own
     * broadcast on first load - one nobody asked for and nobody knows exists -
     * is the kind of surprise a permission-shaped thing must never spring. So
     * the socket refuses every tournament until somebody asks for one.
     */
    controlKey: text(source.controlKey, 64),

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

    list: () => tournaments.map((tournament) => ({ ...tournament, members: { ...tournament.members } })),

    byId: (id) => {
      const found = find(id);
      return found ? { ...found, members: { ...found.members } } : null;
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
        .map((tournament) => ({ ...tournament, members: { ...tournament.members }, level: tournamentLevel(tournament, id) }));
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
      return { ...tournament, members: { ...tournament.members } };
    },

    /** Change the operator-editable fields. Never the id, members or stamps. */
    update(id, changes) {
      const tournament = find(id);
      if (!tournament) throw new Error('No such tournament.');
      Object.assign(tournament, sanitiseTournamentFields(changes, tournament));
      persist();
      return { ...tournament, members: { ...tournament.members } };
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
      return { ...tournament, members: { ...tournament.members } };
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
      return { ...tournament, members: { ...tournament.members } };
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
      tournaments.filter((tournament) => ownerCount(tournament) === 0).map((tournament) => ({ ...tournament, members: { ...tournament.members } })),
  };
}
