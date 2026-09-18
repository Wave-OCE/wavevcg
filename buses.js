/**
 * Preview and program: two copies of a graphic, and the take between them.
 *
 * A vision mixer has two buses. Program is what the audience sees; preview is
 * where the next thing is built, checked and held until somebody cuts it to
 * air. This is that, per graphic - so a scoreboard can be re-imported, restyled
 * and re-ordered while the one on air sits untouched, and goes live the moment
 * the operator says so and not a keystroke before.
 *
 * ---------------------------------------------------------------------------
 * Two whole states, not a transport flag
 * ---------------------------------------------------------------------------
 *
 * Each bus is a complete, independent store with its own file. Not a shared
 * state with a "live" flag on top, because the requirement is that *data* is
 * staged too: changing the match, the rosters, the colours or the map must not
 * reach air. A single state with a transport overlay cannot express "the board
 * on air says 13-5 and the one I am building says 13-11", which is the entire
 * point.
 *
 * The cost is honest and worth naming: two sets of drivers, two files, and a
 * take that has to decide what to carry across.
 *
 * ---------------------------------------------------------------------------
 * What a take does with the cue counter
 * ---------------------------------------------------------------------------
 *
 * This is the fiddly part, and getting it wrong is loud on air.
 *
 * Every animated output keys off an integer - `anim.cue`, `seq.cue` - bumped
 * only when a transport button is pressed. It exists so that ordinary editing
 * does not replay the entrance: an operator fixing a typo must not make the
 * scoreboard fly on again. See the note in CLAUDE.md.
 *
 * A take must respect that, and cannot do it by copying preview's cue:
 *
 *   - Preview's counter and program's counter drift apart on their own, because
 *     program runs the automatic drivers (auto-hide, auto-advance) and preview
 *     does not. Copying could move program's counter *backwards*, which the
 *     output page reads as a change like any other and replays on.
 *   - Always bumping would replay the entrance on every take, including a take
 *     that only corrected a name - exactly the failure the counter prevents.
 *   - Never bumping would mean pressing Show on preview and taking put the new
 *     state on air without ever playing the entrance.
 *
 * So the take computes program's counter itself: bump it when the take actually
 * moves something the page animates on, leave it alone when only data changed.
 * `transport` below is that "something", per graphic, and it is deliberately a
 * short list rather than a deep comparison - the question is "did the operator
 * change what this graphic is *doing*", not "did any byte differ".
 */

import {
  makeBracketGraphicStore,
  makeGraphicStore,
  makeHeadToHeadStore,
  makeLineupStore,
  makeSelectStore,
  makeVetoBoardStore,
  makeWinnerStore,
} from './graphics.js';

/** Matches the dashboards and companion.js. The counter wraps rather than growing. */
export const CUE_WRAP = 1_000_000;

/**
 * The three graphics that go to air, and what "doing something" means for each.
 *
 * `transport` returns the fields whose change should replay the graphic.
 * `cue` / `withCue` read and write the counter, which lives in a different
 * place on the winner (`seq`) than on the other two (`anim`).
 */
export const BUS_KINDS = {
  graphics: {
    file: 'graphic.json',
    make: makeGraphicStore,
    transport: (state) => [state.anim.visible],
    cue: (state) => state.anim.cue ?? 0,
    withCue: (state, cue) => ({ ...state, anim: { ...state.anim, cue } }),
  },
  winner: {
    file: 'winner.json',
    make: makeWinnerStore,
    /*
     * `restart` rides along with stage and active because "go to scene 0" is
     * two different gestures - the overlay arriving, and stepping back to the
     * first scene while it is already up - and the page needs to tell them
     * apart. Taking one must not be mistaken for taking the other.
     */
    transport: (state) => [state.seq.active, state.seq.stage, state.seq.restart],
    cue: (state) => state.seq.cue ?? 0,
    withCue: (state, cue) => ({ ...state, seq: { ...state.seq, cue } }),
  },
  select: {
    file: 'select.json',
    make: makeSelectStore,
    transport: (state) => [state.anim.visible],
    cue: (state) => state.anim.cue ?? 0,
    withCue: (state, cue) => ({ ...state, anim: { ...state.anim, cue } }),
  },
  vetoBoard: {
    file: 'veto-board.json',
    make: makeVetoBoardStore,
    /*
     * Visibility ONLY, and deliberately not `reveal`.
     *
     * Revealing the fourth ban should animate the fourth row and leave the
     * three above it alone. Putting reveal in here would bump the cue on a take
     * that moved it, and the page would fly the whole board on again every
     * time - which is exactly the failure the counter exists to prevent. The
     * page animates a row on its own arrival instead.
     */
    transport: (state) => [state.anim.visible],
    cue: (state) => state.anim.cue ?? 0,
    withCue: (state, cue) => ({ ...state, anim: { ...state.anim, cue } }),
  },
  /*
   * The lineup and the head-to-head. Both are one-shot splashes: they arrive,
   * they sit, they go. Visibility is the only thing an audience sees change, so
   * it is the only thing in `transport` - a take that swapped the TEAM without
   * changing whether it is up should not replay the entrance, because the
   * operator is fixing a mistake rather than presenting a new graphic.
   */
  lineup: {
    file: 'lineup.json',
    make: makeLineupStore,
    transport: (state) => [state.anim.visible],
    cue: (state) => state.anim.cue ?? 0,
    withCue: (state, cue) => ({ ...state, anim: { ...state.anim, cue } }),
  },
  headToHead: {
    file: 'headtohead.json',
    make: makeHeadToHeadStore,
    transport: (state) => [state.anim.visible],
    cue: (state) => state.anim.cue ?? 0,
    withCue: (state, cue) => ({ ...state, anim: { ...state.anim, cue } }),
  },
  /*
   * The bracket. Visibility only, like the veto board and for the same reason:
   * `reveal` walks rounds out of a sheet that is already up, and bumping the
   * cue for that would fly the whole draw on again every time.
   */
  bracket: {
    file: 'bracket.json',
    make: makeBracketGraphicStore,
    transport: (state) => [state.anim.visible],
    cue: (state) => state.anim.cue ?? 0,
    withCue: (state, cue) => ({ ...state, anim: { ...state.anim, cue } }),
  },
};

export const BUS_NAMES = ['preview', 'program'];

/** Anything that is not exactly "program" is preview - the safe side to land on. */
export const busName = (value) => (String(value ?? '') === 'program' ? 'program' : 'preview');

const sameTransport = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * The old single-store API, kept only to fail loudly.
 *
 * `bundle.graphics` used to be a store; it is now a pair of them. Every call
 * site had to be looked at, and the ones that were missed must not quietly read
 * `undefined` and write a graphic nobody is watching. A throwing getter turns
 * each of those into an error that names the fix, at the moment it happens,
 * instead of a scoreboard that mysteriously stops updating.
 *
 * Kept after the migration rather than deleted: the same mistake is available
 * to every future edit, and this is four lines.
 *
 * `load` and `flush` are deliberately NOT in this list. The bus answers to both
 * itself - it has two files to open and two to drain - so every caller that
 * only ever wanted "persist yourself" still works untouched. Adding them here
 * would not just throw, it would silently overwrite the real methods defined
 * above, since defineProperty runs after the object literal.
 */
const OLD_STORE_MEMBERS = ['state', 'revision', 'replace', 'patch', 'reset', 'subscribe', 'subscriberCount'];

/**
 * One graphic, on both buses.
 *
 * @param {string} kind  a key of BUS_KINDS
 * @param {(file: string) => object} resolve  kind's file name -> a full path
 */
export function makeBus(kind, resolve) {
  const spec = BUS_KINDS[kind];
  if (!spec) throw new Error(`No such graphic: ${kind}`);

  /*
   * Program keeps the original file name, and that is the migration.
   *
   * An installation upgrading into this has a graphic.json that is currently on
   * air. It stays on air, every OBS source keeps rendering the same thing, and
   * preview is seeded from it below - so the split arrives invisible, and the
   * operator's first take is a no-op rather than a surprise.
   */
  const program = spec.make(resolve(spec.file));
  const preview = spec.make(resolve(spec.file.replace(/\.json$/, '.preview.json')));

  const bus = {
    kind,
    preview,
    program,

    /** The store for a bus name. Unknown names resolve to preview, never air. */
    of: (name) => (busName(name) === 'program' ? program : preview),

    /**
     * Cut preview to air.
     *
     * Everything crosses - data, styling, transport - because staging the data
     * is the point. Only the cue counter is computed rather than copied; see
     * the header.
     *
     * @returns {{state: object, replayed: boolean}} `replayed` is whether the
     *   graphic will play its entrance again, which is what the operator wants
     *   reported back rather than the whole state.
     */
    take() {
      const from = preview.state;
      const moved = !sameTransport(spec.transport(from), spec.transport(program.state));
      const cue = moved ? (spec.cue(program.state) + 1) % CUE_WRAP : spec.cue(program.state);
      const state = program.replace(spec.withCue(from, cue));
      return { state, replayed: moved };
    },

    /**
     * Bring preview back in line with what is on air.
     *
     * The undo for a take that has not happened: an operator who has staged
     * half a graphic and changed their mind wants the thing on air back in
     * front of them, not the defaults. Program's cue crosses unchanged - preview
     * plays nothing on its own.
     */
    revert() {
      return preview.replace(program.state);
    },

    /**
     * Both files, and the seed.
     *
     * @returns {{program: boolean, preview: boolean, seeded: boolean}}
     */
    async load() {
      const [hadProgram, hadPreview] = await Promise.all([program.load(), preview.load()]);
      // First run after the split - or a preview file deleted by hand. Preview
      // starts as a copy of air rather than as the defaults, so nothing appears
      // to have moved.
      if (!hadPreview) preview.replace(program.state);
      return { program: hadProgram, preview: hadPreview, seeded: !hadPreview };
    },

    flush: () => Promise.all([program.flush(), preview.flush()]),
  };

  for (const member of OLD_STORE_MEMBERS) {
    Object.defineProperty(bus, member, {
      get() {
        throw new Error(
          `"${kind}" is a preview/program pair now, not a store - reach for ${kind}.preview, ` +
            `${kind}.program or ${kind}.of(bus). (Something asked for .${member}.)`,
        );
      },
      configurable: true,
    });
  }

  return bus;
}

export const BUS_KEYS = Object.keys(BUS_KINDS);
