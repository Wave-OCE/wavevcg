/**
 * The schedule store: one document per tournament, at
 * `.state/tournaments/<id>/schedule.json`.
 *
 * A fifth entry in `STORES` beside globals, presets, teams and aliases - and
 * NOT a preview/program pair. `sessions.js` states the rule for that choice
 * ("does an audience ever see this") and a schedule answers no: it is a library
 * of matches, like the team library is a library of orgs. A bus would also be
 * actively wrong here rather than merely unnecessary, because the take bar
 * would light "preview differs from air" every time somebody edited next
 * Tuesday's fixture.
 *
 * ## Why every write goes through `apply`
 *
 * The rules worth enforcing in a schedule are relationships, not fields - an
 * edge must name a fixture that exists, the graph must be acyclic, a stage must
 * not vanish under its fixtures. None of that can be checked on one record, so
 * the document is validated as a whole, and a write that fails must leave NO
 * trace.
 *
 * That last part is the lesson from `alias-import-atomic.mjs`, and it is worth
 * restating because the failure it describes is so quiet. The alias import
 * mutated the live library in place and checked the cap afterwards; a refused
 * import therefore left the over-cap list sitting in memory, where the next
 * unrelated `persist()` - a roster webhook, say - wrote it to disk. And because
 * the library was now over the cap, every later import was refused for ever.
 * Nothing logged it.
 *
 * So `apply` mutates a CLONE, propagates, validates, and only then assigns. A
 * refused write is not a partial write; it is no write.
 */

import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import {
  emptySchedule,
  fixturesFedBy,
  fixturesUsingTeam,
  propagate,
  sanitiseSchedule,
} from './public/schedule-schema.js';

export function makeScheduleStore(filePath) {
  let doc = emptySchedule();
  let writeChain = Promise.resolve();

  /*
   * Serialised through one chain, like the other stores. Two writes landing
   * together must not interleave into a half-written file, and the schedule is
   * the one store here where a truncated file loses a whole competition rather
   * than one row.
   */
  const persist = () => {
    const snapshot = JSON.stringify(doc, null, 2);
    writeChain = writeChain
      .then(() => writeFile(filePath, snapshot, 'utf8'))
      .catch((error) => console.warn(`schedule not saved: ${error.message}`));
    return writeChain;
  };

  return {
    /**
     * Read the file, and never throw.
     *
     * `sessions.js` opens every store in one `Promise.all`, so a store that
     * threw on a damaged file would take the whole bundle - and therefore the
     * whole production - down with it. Lenient rather than strict for the same
     * reason: a hand-edited schedule with one dangling edge should open with
     * that edge dropped and a warning, not refuse to open at all.
     */
    async load() {
      try {
        const raw = await readFile(filePath, 'utf8');
        const { schedule, problems } = sanitiseSchedule(JSON.parse(raw), { strict: false });
        doc = schedule;
        for (const entry of problems) console.warn(`schedule: ${entry.message} ${entry.hint}`.trim());
        return true;
      } catch (error) {
        if (error.code !== 'ENOENT') console.warn(`schedule not read: ${error.message}`);
        doc = emptySchedule();
        return false;
      }
    },

    flush: () => writeChain,

    /** The whole document. Cloned, so a caller cannot edit the live one by accident. */
    document: () => structuredClone(doc),

    stage: (id) => doc.stages.find((entry) => entry.id === String(id)) ?? null,
    fixture: (id) => doc.fixtures.find((entry) => entry.id === String(id)) ?? null,

    /** A fresh fixture id. A UUID, until something says it should be a foreign key. */
    mintId: () => randomUUID(),

    /** Which fixtures name this team - so a team delete can refuse and say where. */
    usesTeam: (teamId) => fixturesUsingTeam(doc, teamId),

    /** Which fixtures take a side from this one - so a fixture delete can refuse. */
    fedBy: (fixtureId) => fixturesFedBy(doc, fixtureId),

    /**
     * The only way to change anything.
     *
     * `mutate` is handed a deep clone and may do whatever it likes to it. What
     * comes back is propagated, validated strictly, and assigned only if it is
     * clean - so a caller cannot half-apply a change, and cannot leave a broken
     * draft behind for the next save to commit.
     *
     * Throws the first problem. Deliberately the first rather than all of them:
     * the problems that follow a real fault are usually consequences of it, and
     * a wall of them buries the one an operator can act on.
     */
    apply(mutate) {
      const draft = structuredClone(doc);
      mutate(draft);

      const carried = propagate(draft);
      const { schedule, problems } = sanitiseSchedule(draft, { strict: true });
      const all = [...carried, ...problems];
      if (all.length) {
        const error = new Error(all[0].message);
        error.status = 400;
        error.hint = all[0].hint ?? '';
        error.problems = all;
        throw error;
      }

      doc = schedule;
      persist();
      return structuredClone(doc);
    },
  };
}
