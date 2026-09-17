/**
 * The map veto store: one document per tournament, at
 * `.state/tournaments/<id>/veto.json`.
 *
 * Shared across desks, beside the schedule and the team library, and for the
 * same reason: a veto is a fact about the COMPETITION. Two courts of one
 * tournament do not hold different opinions about which maps Crusaders banned,
 * and the veto for Court 2's match has to be visible to whoever is running the
 * event whichever desk they happen to be sitting at.
 *
 * Not a preview/program pair either, by the rule in sessions.js: an audience
 * never sees this. What an audience sees is the veto GRAPHIC, which takes a
 * copy of it - and that graphic is a bus like every other.
 *
 * ---------------------------------------------------------------------------
 * The tokens
 * ---------------------------------------------------------------------------
 *
 * A veto hands out three links and they are the SIXTH secret in this program.
 * Each is a random 32-byte value in a URL that needs no account, which is what
 * makes it usable - a team captain fifteen minutes before a match is not going
 * to be given a login - and is also exactly why the rules around it are tight:
 *
 *   MINTED HERE, never accepted from a request. `answer()` takes a token and
 *   looks up what it opens; nothing outside this file can set one. A save from
 *   the dashboard carries the whole record and its tokens are ignored, because
 *   the alternative is a write path that can mint a credential for a veto it
 *   was not given one for.
 *
 *   ONE VETO EACH. A token resolves to a veto and a ROLE inside it. There is no
 *   token that opens two, so a link forwarded to the wrong captain gives them
 *   somebody else's match and nothing more.
 *
 *   NEVER LOGGED, never in a public response. `publicView` in the schema is
 *   what a captain's page gets and it carries no token at all - not even their
 *   own, which they already have. A page that echoes a credential back is a
 *   page that puts it in a screenshot.
 *
 *   ROTATABLE, and rotation is the whole revocation story. `rotate()` replaces
 *   one or all of them, which is what "the link leaked" needs and is cheaper
 *   than an expiry nobody can predict the right length for.
 *
 * ---------------------------------------------------------------------------
 * Why writes go through `apply`
 * ---------------------------------------------------------------------------
 *
 * The same argument the schedule makes. What is worth enforcing here is a
 * relationship - a map must be in the pool, a step may only be answered when it
 * is that step's turn, a completed veto takes no more answers - and none of
 * that can be checked one field at a time. So a mutation runs on a CLONE, is
 * sanitised strictly, and is assigned only if it survives.
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_VETO_DOC,
  currentStep,
  sanitiseVetoDoc,
  sideChooser,
  turnOf,
  vetoComplete,
} from './public/veto-schema.js';

/** 32 bytes of urlsafe base64. Long enough that guessing is not a strategy. */
const mintToken = () => randomBytes(32).toString('base64url');

const fail = (status, message, hint = '') => {
  const error = new Error(message);
  error.status = status;
  error.hint = hint;
  return error;
};

/**
 * Compare a supplied token with a stored one without leaking its length or
 * content through timing.
 *
 * `timingSafeEqual` throws RangeError when the two buffers differ in length,
 * and the supplied side is attacker-chosen - the same trap `sameSecret` in the
 * Discord flow documents. So the lengths are checked first, and a mismatch is
 * an ordinary miss rather than a crash.
 */
function sameToken(supplied, stored) {
  if (!supplied || !stored) return false;
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(String(stored));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function makeVetoStore(filePath) {
  let doc = structuredClone(DEFAULT_VETO_DOC);
  // Tokens are kept BESIDE the sanitised document rather than inside it, keyed
  // by veto id. That is not tidiness: `document()` is what the dashboard and
  // every other reader gets, and keeping credentials out of the object that
  // gets cloned and handed around means a future caller cannot leak one by
  // forgetting to strip it.
  let secrets = new Map();
  let writeChain = Promise.resolve();

  const persist = () => {
    const snapshot = JSON.stringify(
      { ...doc, tokens: Object.fromEntries(secrets) },
      null,
      2,
    );
    writeChain = writeChain
      // The tournament's directory is created by whichever store writes first,
      // and on a brand new tournament that can be this one - a veto made before
      // anybody has touched a graphic. Every other store here does the same.
      .then(() => mkdir(path.dirname(filePath), { recursive: true }))
      .then(() => writeFile(filePath, snapshot, 'utf8'))
      .catch((error) => console.warn(`veto not saved: ${error.message}`));
    return writeChain;
  };

  /** Give a veto a full set of links, keeping any it already has. */
  const seed = (id, existing = {}) => ({
    a: existing.a || mintToken(),
    b: existing.b || mintToken(),
    referee: existing.referee || mintToken(),
  });

  const commit = (draft) => {
    const clean = sanitiseVetoDoc(draft);
    // Every veto has links; a veto without them is one nobody can run.
    const next = new Map();
    for (const veto of clean.vetoes) next.set(veto.id, seed(veto.id, secrets.get(veto.id)));
    doc = clean;
    secrets = next;
    persist();
    return structuredClone(doc);
  };

  return {
    async load() {
      try {
        const raw = JSON.parse(await readFile(filePath, 'utf8'));
        doc = sanitiseVetoDoc(raw);
        secrets = new Map();
        for (const veto of doc.vetoes) {
          const held = raw?.tokens?.[veto.id];
          secrets.set(veto.id, seed(veto.id, held && typeof held === 'object' ? held : {}));
        }
        return true;
      } catch (error) {
        if (error.code !== 'ENOENT') console.warn(`veto not read: ${error.message}`);
        doc = structuredClone(DEFAULT_VETO_DOC);
        secrets = new Map();
        return false;
      }
    },

    flush: () => writeChain,

    /** The whole document, cloned. Carries NO tokens - see the header. */
    document: () => structuredClone(doc),

    get: (id) => doc.vetoes.find((entry) => entry.id === String(id)) ?? null,

    /**
     * The three links for one veto.
     *
     * Its own method rather than a field on the record, so that reaching a
     * token is always a deliberate act by a caller that has already decided the
     * requester may see one.
     */
    tokens: (id) => ({ ...(secrets.get(String(id)) ?? {}) }),

    mintId: () => randomUUID(),

    /**
     * Which veto and which seat a token opens, or null.
     *
     * Linear over every veto and every role, on purpose: a Map keyed by token
     * would be faster and would compare with `===`, and this is a credential
     * check. The list is small - a tournament has tens of vetoes, not
     * thousands - so constant-time comparison is affordable and worth having.
     */
    resolve(token) {
      const supplied = String(token ?? '');
      if (!supplied) return null;
      for (const [id, set] of secrets) {
        for (const role of ['a', 'b', 'referee']) {
          if (sameToken(supplied, set[role])) {
            const veto = doc.vetoes.find((entry) => entry.id === id);
            return veto ? { veto: structuredClone(veto), role, id } : null;
          }
        }
      }
      return null;
    },

    /** New links for one veto - all three, or just the one named. */
    rotate(id, role = '') {
      const held = secrets.get(String(id));
      if (!held) throw fail(404, 'No such veto.');
      if (role && !['a', 'b', 'referee'].includes(role)) throw fail(400, 'No such veto link.');
      if (role) held[role] = mintToken();
      else secrets.set(String(id), seed(String(id)));
      persist();
      return { ...secrets.get(String(id)) };
    },

    /** The only way to change anything. See the header. */
    apply(mutate) {
      const draft = structuredClone(doc);
      mutate(draft);
      return commit(draft);
    },

    /**
     * Answer the step that is waiting, as a captain or a referee.
     *
     * Everything a public page may do lands here, and the guards are the point
     * rather than the plumbing:
     *
     *   IT MUST BE YOUR TURN. A captain holding a link cannot ban on the other
     *   team's step, and cannot run ahead - which matters because both pages
     *   are open at once and the obvious attack is the impatient one.
     *
     *   THE REFEREE MAY ANSWER ANY STEP, which is what the third link is FOR:
     *   a captain who cannot get the page open reads their ban down the line
     *   and somebody enters it. That is a deliberate power, not a hole.
     *
     *   THE MAP MUST STILL BE THERE. Two pages open, both looking at the same
     *   list, is exactly how the same map gets banned twice - so the check is
     *   here, against the document as it now stands, and not on the page.
     */
    answer({ token, map, side }) {
      const found = this.resolve(token);
      if (!found) throw fail(404, 'That veto link is not valid.');

      const live = doc.vetoes.find((entry) => entry.id === found.id);
      if (!live) throw fail(404, 'That veto is gone.');
      if (vetoComplete(live)) throw fail(409, 'That veto is already finished.');

      const step = currentStep(live);
      const turn = turnOf(live);
      const isReferee = found.role === 'referee';

      if (!isReferee) {
        if (step.kind === 'decider') {
          throw fail(409, 'The last map is whatever is left - the referee confirms it.');
        }
        if (turn !== found.role) throw fail(409, 'It is not your turn yet.');
      }

      const wanted = String(map ?? '').trim();
      // The decider is not chosen, it is what survives - so it is not taken
      // from the request at all. Accepting one would let a referee file a map
      // that two teams had already banned.
      const remaining = live.pool.filter((entry) => !live.steps.some((s) => s.map === entry));
      const landing = step.kind === 'decider' ? remaining[0] ?? '' : wanted;

      if (!landing) throw fail(400, 'No map to file.');
      if (!remaining.includes(landing)) throw fail(409, `${landing} is not still available.`);

      const chooser = sideChooser(step, live);
      const document = this.apply((draft) => {
        const target = draft.vetoes.find((entry) => entry.id === found.id);
        target.steps[step.at].map = landing;
        if (step.kind !== 'ban') {
          target.steps[step.at].sideBy = chooser;
          // A side is optional at the moment the map lands: the team choosing
          // it is often the OTHER one, who has not been asked yet. The referee
          // and that team can both set it afterwards.
          target.steps[step.at].side = ['attack', 'defence'].includes(side) ? side : '';
        }
      });

      return { document, at: step.at, map: landing, kind: step.kind };
    },

    /**
     * Set the side on a map that has already been picked.
     *
     * Separate from `answer` because it is a separate decision made by a
     * different team at a different moment - the ordinary rule gives the side
     * to whoever did NOT pick the map, so it cannot ride along with the pick.
     */
    setSide({ token, at, side }) {
      const found = this.resolve(token);
      if (!found) throw fail(404, 'That veto link is not valid.');

      const live = doc.vetoes.find((entry) => entry.id === found.id);
      const index = Number.parseInt(at, 10);
      if (!live || !Number.isInteger(index) || !live.steps[index]) throw fail(404, 'No such step.');

      const step = live.steps[index];
      if (step.kind === 'ban') throw fail(400, 'A banned map has no side.');
      if (!step.map) throw fail(409, 'That map has not been chosen yet.');

      const chooser = sideChooser(step, live);
      if (found.role !== 'referee' && found.role !== chooser) throw fail(409, 'That is not your side to choose.');
      if (!['attack', 'defence'].includes(side)) throw fail(400, 'Pick attack or defence.');

      return this.apply((draft) => {
        const target = draft.vetoes.find((entry) => entry.id === found.id);
        target.steps[index].side = side;
        target.steps[index].sideBy = chooser;
      });
    },
  };
}
