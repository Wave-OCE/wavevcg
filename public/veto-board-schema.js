/**
 * The map veto GRAPHIC: what goes to air, and what it is a copy of.
 *
 * A fourth graphic beside the scoreboard, the winner splash and agent select,
 * and like all three it exists twice - preview and program - with a take
 * between them. `veto.js` holds the veto itself; this holds a picture of one.
 *
 * ---------------------------------------------------------------------------
 * It is a SNAPSHOT, not a view
 * ---------------------------------------------------------------------------
 *
 * `board` is copied out of the veto when an operator presses Load, and nothing
 * keeps it in step afterwards. That is the copy-not-link rule this codebase
 * applies everywhere a graphic names something in a library - a fixture copies
 * its teams, a scoreboard copies the org it was given - and the argument is
 * sharper here than anywhere else: a veto is being driven by two people with no
 * account, on their phones, while this graphic may be on air. A live view would
 * put a captain's mis-tap on a stream.
 *
 * The cost is stated rather than hidden: the board can be stale, so the
 * dashboard says when the veto has moved past what is loaded and Load is one
 * press away.
 *
 * ---------------------------------------------------------------------------
 * The SHAPE arrives whole; the DATA arrives one step at a time
 * ---------------------------------------------------------------------------
 *
 * Every cell is on screen from the moment the board is up, carrying the one
 * thing that is not a secret - whose turn it is and whether they are banning or
 * picking. What `revealed` controls is only the MAP inside it.
 *
 * That is a change from a count of visible cells, and the reason is what the
 * graphic is for. A veto board that grows a cell at a time never shows the
 * audience how long the process is; one that stands complete and fills in tells
 * them "six more of these to go" from the first frame, and every reveal lands
 * in a box they have already been looking at. It also means the layout is
 * settled before anything is revealed - nothing shifts as the board fills.
 *
 * A SET rather than a count, because an operator does not always walk forwards.
 * A veto read out over comms arrives in whatever order people speak, and a
 * board that could only reveal the next one would force them to reveal three
 * steps to show the fourth.
 *
 * Neither is the cue. The cue exists so the page can replay its ENTRANCE and is
 * bumped only when the operator presses Show; revealing the fourth ban fills in
 * the fourth box. If it bumped the cue the whole board would fly on again every
 * time, which is precisely the failure the counter was invented to prevent -
 * and `transport` in buses.js is `[anim.visible]` for the same reason.
 */

const LAYOUTS = [
  {
    key: 'lower',
    label: 'Lower third',
    help: 'A strip along the bottom. Every step in order, which is what a veto looks like while it is happening.',
  },
  {
    key: 'full',
    label: 'Full screen',
    help:
      'The whole frame, with the bans grouped and the maps that will be played laid out large. Same sequence - ' +
      'grouping is a layout choice here and never changes the record.',
  },
];

export const VETO_BOARD_LAYOUTS = LAYOUTS;
export const VETO_BOARD_LAYOUT_KEYS = LAYOUTS.map((entry) => entry.key);

/**
 * One row of the board as the PAGE needs it, which is not the shape the veto
 * record uses.
 *
 * The record says "step 3 was a pick by A". A page needs "Haven, picked by
 * Crusaders, Jail Time on attack" - the seats resolved to names, because
 * nothing at 1920x1080 should be dereferencing an 'a' into a team while it
 * paints. Same reason a fixture carries a copy rather than a teamId.
 */
const emptyRow = () => ({ kind: 'ban', map: '', by: '', byShort: '', side: '', sideBy: '', sideByShort: '' });

/**
 * Which SIDE of the board a step belongs to, so the page can find their logo.
 *
 * A row records who acted by NAME, not by seat - `boardFromVeto` resolves the
 * seats to names precisely so that nothing at 1920x1080 dereferences an 'a'
 * into a team while it paints. That is still right, and it means the one place
 * that does need the seat back - the logo behind a box - has to match on what
 * the row carries.
 *
 * Matched on the tricode first and the full name second, both case-folded: the
 * tricode is what a row usually carries and what a team is most consistently
 * spelled as. Returns null rather than guessing, and a box with no match simply
 * shows no mark, which is the ordinary state for a decider that nobody chose.
 */
export function sideOfRow(row, state) {
  const want = (value) => String(value ?? '').trim().toLowerCase();
  const short = want(row?.byShort);
  const full = want(row?.by);
  if (!short && !full) return null;

  for (const seat of ['left', 'right']) {
    const team = state?.[seat];
    if (!team) continue;
    if (short && want(team.shortName) === short) return team;
    if (full && want(team.name) === full) return team;
  }
  return null;
}

import { brandHex } from './brand.js';

const text = (value, max) =>
  typeof value === 'string' ? value.slice(0, max).replace(/[\x00-\x1f\x7f]/g, '').trim() : '';

const whole = (value, min, max, fallback = min) => {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
};

/** The most steps a board can hold. A VALORANT pool is seven; nine is headroom. */
export const VETO_BOARD_ROWS = 9;

export const DEFAULT_VETO_BOARD = {
  version: 1,
  layout: 'lower',
  // What the veto was loaded from, so the dashboard can say "this has moved".
  // Never dereferenced at paint time - see the header.
  vetoId: '',
  title: '',
  subtitle: '',
  eventLogo: '',
  left: { name: '', shortName: '', logo: '', colour: '' },
  right: { name: '', shortName: '', logo: '', colour: '' },
  rows: [],
  /*
   * Which steps have had their MAP revealed, one flag per row. Every row is on
   * screen either way - see the header. All false is a real and common state:
   * the board goes up complete and empty before the veto starts.
   */
  revealed: [],
  showSides: true,

  /*
   * ---------------------------------------------------------------- colour --
   *
   * This graphic had none. `veto-board.css` carried `--accent` and `--ban` as
   * literals, and a comment claiming they were "set from the graphic's own
   * fields" that had never been true - nothing on the page wrote either of
   * them, so restyling a veto board meant editing a stylesheet.
   *
   * THREE THINGS, because the board says three things:
   *
   *   accent     the TRIM - the VS divider and the header rules. Blank means
   *              the EVENT's accent. It is the show's furniture, not a verdict
   *              about a map.
   *   highlight  a map that WENT THROUGH - the edge under a revealed pick and
   *              the decider. Blank means the EVENT's highlight. This is
   *              exactly what the event-wide highlight is for, so it inherits
   *              rather than carrying a default of its own.
   *   banColour  a map that is GONE - the strike and the box's edge. Its OWN
   *              colour with a real default, deliberately: a ban reads red
   *              because that is the convention every audience already knows,
   *              and tying it to an event accent would make a board whose trim
   *              is green announce its bans in green.
   */
  accent: '',
  highlight: '',
  banColour: '#ff4655',

  /*
   * The banning team's mark, large and faint behind each box.
   *
   * What it buys is the thing a veto board is hardest at: reading WHO did what
   * at a glance, on a stream, in two seconds. The words already say it and the
   * words are small. Their logo, or their tricode when they have no logo, is
   * recognisable at a distance in a way "CRU" in 15px is not.
   *
   * ON by default. It is a new thing rather than a change to an old one, it is
   * what this was asked for, and it is one switch away.
   */
  showTeamArt: true,
  anim: { visible: false, cue: 0 },
};

const side = (input) => {
  const source = input && typeof input === 'object' ? input : {};
  return {
    name: text(source.name, 32),
    shortName: text(source.shortName, 8),
    logo: text(source.logo, 500),
    colour: text(source.colour, 24),
  };
};

const row = (input) => {
  const source = input && typeof input === 'object' ? input : {};
  return {
    kind: ['ban', 'pick', 'decider'].includes(source.kind) ? source.kind : 'ban',
    map: text(source.map, 40),
    by: text(source.by, 32),
    byShort: text(source.byShort, 8),
    side: ['attack', 'defence'].includes(source.side) ? source.side : '',
    sideBy: text(source.sideBy, 32),
    sideByShort: text(source.sideByShort, 8),
  };
};

export function sanitiseVetoBoard(input, fallback = DEFAULT_VETO_BOARD) {
  const source = input && typeof input === 'object' ? input : {};
  const base = fallback ?? DEFAULT_VETO_BOARD;
  const rows = (Array.isArray(source.rows) ? source.rows : base.rows ?? []).slice(0, VETO_BOARD_ROWS).map(row);

  return {
    version: 1,
    layout: VETO_BOARD_LAYOUT_KEYS.includes(source.layout) ? source.layout : base.layout,
    vetoId: text(source.vetoId ?? base.vetoId, 64),
    title: text(source.title ?? base.title, 60),
    subtitle: text(source.subtitle ?? base.subtitle, 60),
    eventLogo: text(source.eventLogo ?? base.eventLogo, 500),
    left: side(source.left ?? base.left),
    right: side(source.right ?? base.right),
    rows,
    /*
     * Sized to the rows that exist, always.
     *
     * A flag with no row is a reveal nobody can see and nobody can take back;
     * a row with no flag would read as undefined and paint as revealed. Both
     * are fixed by deriving the length here rather than trusting what arrived,
     * which also means a board reloaded with more steps than before gets its
     * new ones unrevealed rather than inheriting a neighbour's flag.
     */
    revealed: Array.from({ length: rows.length }, (_, index) => {
      const given = Array.isArray(source.revealed) ? source.revealed : base.revealed;
      return Array.isArray(given) && given[index] === true;
    }),
    showSides: typeof source.showSides === 'boolean' ? source.showSides : (base.showSides ?? true),

    /*
     * Blank passes through as blank for the two that INHERIT, because blank is
     * how "the event's" is spelled. `banColour` is not one of them: it has a
     * real default, so a blank there falls back to it rather than to nothing.
     */
    accent: brandHex(source.accent ?? base.accent, ''),
    highlight: brandHex(source.highlight ?? base.highlight, ''),
    banColour: brandHex(source.banColour ?? base.banColour, base.banColour ?? '') || DEFAULT_VETO_BOARD.banColour,
    showTeamArt: typeof source.showTeamArt === 'boolean' ? source.showTeamArt : (base.showTeamArt ?? true),
    anim: {
      visible: typeof source.anim?.visible === 'boolean' ? source.anim.visible : (base.anim?.visible ?? false),
      cue: whole(source.anim?.cue ?? base.anim?.cue, 0, 1_000_000, 0),
    },
  };
}

/**
 * A veto record -> the board that shows it.
 *
 * The one place the two shapes meet, and it lives here rather than in the
 * server for the reason `SHARED_FIELDS` lives in global-schema.js: the source
 * of a value owns the mapping, or the dashboard, the route and the output page
 * each grow their own idea of what a veto looks like.
 *
 * Both sides of `sideBy` are resolved to a NAME here. The page must not be
 * turning an 'a' into a team while it paints - that is a dereference at render
 * time, which is the one failure this codebase has actually shipped.
 */
export function boardFromVeto(veto, { playedOnly = false } = {}) {
  if (!veto) return null;
  const seat = (which) => (which === 'a' ? veto.a : which === 'b' ? veto.b : null);
  const name = (which) => seat(which)?.name ?? '';
  const short = (which) => seat(which)?.shortName ?? '';

  const steps = (veto.steps ?? []).filter((step) => (playedOnly ? step.kind !== 'ban' : true));

  return {
    vetoId: veto.id ?? '',
    title: veto.name || [veto.a?.name, veto.b?.name].filter(Boolean).join(' vs '),
    subtitle: String(veto.format ?? '').toUpperCase(),
    left: side(veto.a),
    right: side(veto.b),
    rows: steps.map((step) =>
      row({
        kind: step.kind,
        map: step.map,
        by: name(step.who),
        byShort: short(step.who),
        side: step.side,
        sideBy: name(step.sideBy),
        sideByShort: short(step.sideBy),
      }),
    ),
  };
}

/**
 * Has the veto moved past what is on the board?
 *
 * Compared on the answered MAPS rather than on the whole record, because an
 * operator renaming a veto or fixing a tricode has not changed what the graphic
 * is showing, and a "reload me" badge that lights for that is one nobody reads.
 */
export function boardIsStale(board, veto) {
  if (!board?.vetoId || board.vetoId !== veto?.id) return false;
  const live = (veto.steps ?? []).map((step) => `${step.kind}:${step.map}:${step.side}`).join('|');
  const shown = (board.rows ?? []).map((entry) => `${entry.kind}:${entry.map}:${entry.side}`).join('|');
  return live !== shown;
}

/**
 * The rows a FULL SCREEN layout draws, grouped.
 *
 * Bans together, then the maps that will be played - which is what the
 * reference board does, and is a property of this layout and of nothing else.
 * The record keeps the true order and grouping never reaches back into it.
 *
 * EVERY row comes back, each carrying whether its map has been revealed. The
 * grouping cannot depend on that: an unrevealed step still has to take its
 * place, or revealing one would move the boxes either side of it - and a board
 * that reflows as it fills is the thing this design exists to avoid.
 *
 * Which does mean the two groups are sized by the FORMAT rather than by what
 * has been shown, so a Bo3 board says "four bans and three maps" before anybody
 * has banned anything. That is the intent: the shape is the information.
 */
export function groupedRows(rows, revealed) {
  const flags = Array.isArray(revealed) ? revealed : [];
  const all = (rows ?? []).map((entry, index) => ({ ...entry, shown: flags[index] === true, at: index }));
  return {
    bans: all.filter((entry) => entry.kind === 'ban'),
    maps: all.filter((entry) => entry.kind !== 'ban'),
  };
}

/** How many steps have been revealed, for the dashboard's own counter. */
export const revealedCount = (state) => (state?.revealed ?? []).filter(Boolean).length;
