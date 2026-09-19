/**
 * The standings graphic: a group table, on air.
 *
 * An eighth graphic, and the first of the two this stage adds. The other is
 * Groups, which says WHO IS IN WHICH POOL; this one says WHAT HAPPENED. They
 * are separate graphics rather than one with a mode switch because those are
 * different questions, and an operator one click from answering the wrong one
 * would put last week's table up when they meant the draw.
 *
 * ---------------------------------------------------------------------------
 * It carries a TABLE, not a competition
 * ---------------------------------------------------------------------------
 *
 * The same rule the bracket follows, for the same three reasons. Load runs
 * `stageTables` - the SAME pure function the Schedule sub-page draws its tables
 * from - and stores its OUTPUT: rows with names, records and ranks already
 * worked out. So the output page needs no idea what a stage or a group is, the
 * desk and the air cannot disagree about who is second, and somebody filing a
 * result mid-show cannot move what is on screen. This is the other graphic most
 * likely to be up while results are being typed behind it.
 *
 * ---------------------------------------------------------------------------
 * Two things this table must NOT do
 * ---------------------------------------------------------------------------
 *
 * TIES ARE NOT BROKEN. `standings` shares a rank on purpose - 1, 2, 2, 4 -
 * because real VALORANT rulebooks tiebreak head-to-head, and a graphic that
 * ordered by map difference would be authoritative-looking and wrong in exactly
 * the situation that makes somebody look at the table. The graphic renders what
 * it is given and invents no order.
 *
 * That has one consequence worth stating out loud, because it is the whole
 * reason `qualify` counts RANKS rather than rows: with 1, 2, 2, 4 and "top two
 * go through", marking the first two ROWS marks one of the two tied teams and
 * not the other - which is precisely the order the table refuses to have. Every
 * row whose rank is within the cut is marked, so a tie for the last place
 * through shows as three teams through. That is honest about a table that
 * cannot separate them; the rulebook separates them, and the operator reads it.
 *
 * ---------------------------------------------------------------------------
 * What is not stored, and why
 * ---------------------------------------------------------------------------
 *
 * `played` is not in a row, although `standings` computes one. A VALORANT match
 * has no draw, and a void or unfinished fixture counts for neither side - so
 * `played` is `won + lost`, always, and a P column is a column that can never
 * disagree with the two beside it. The schedule's own "nothing derivable is
 * stored" rule, applied to the snapshot.
 *
 * Nor is `tied`: two rows both reading 2 already say it.
 *
 * Nor is a team id. The bracket's seats hold a name, a tricode and a crest and
 * nothing to dereference while the page paints, and a table is the same shape.
 */

/* ------------------------------------------------------------- helpers ---- */

const text = (value, max) =>
  typeof value === 'string' ? value.slice(0, max).replace(/[\x00-\x1f\x7f]/g, '').trim() : '';

const whole = (value, min, max, fallback = min) => {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
};

/*
 * A hex colour, or blank - and blank is a real answer here, meaning "whatever
 * the event says". See the note on `accent` below.
 */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const hex = (value) => {
  const candidate = String(value ?? '').trim();
  return HEX.test(candidate) ? candidate.toLowerCase() : '';
};

/*
 * A multiplier, two decimals, clamped to the field's own range - NOT a ratio.
 * `ratio` caps at 1 because everything it guards is a proportion, and running
 * an enlargement through one clamps every value to "no change" while the slider
 * claims otherwise.
 */
const multiplier = (value, fallback, min, max) => {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed * 100) / 100));
};

/* --------------------------------------------------------------- sizes ---- */

/**
 * The operator's own size handle, and what the fit may do on its own.
 *
 * THE FIT MAY SHRINK, which is the one deliberate difference from the bracket's,
 * and the reason is stated rather than inherited: `bracketAutoFit` never returns
 * less than 1 because a bracket has been drawn at exactly one size since the day
 * it was built, and quietly resizing a sheet already going to air is a change
 * nobody asked for. This graphic has no installed base to protect - nothing has
 * ever been drawn by it - so sixteen pools that do not fit a 1080 frame should be
 * made to fit rather than painted off the bottom of it.
 *
 * The range is keyed to TYPE, like the bracket's. A team name is 26px, so 0.5 is
 * 13px - the smallest that survives a stream - and 1.5 is 39px, the largest a
 * table cell can be before it reads as a headline rather than as a table.
 */
export const STANDINGS_AUTO_MIN = 0.5;
export const STANDINGS_AUTO_MAX = 1.5;
export const STANDINGS_SCALE_MIN = 0.6;
export const STANDINGS_SCALE_MAX = 1.6;
export const STANDINGS_SCALE_STEP = 0.05;

/** What the fit and the hand-set size may ever multiply out to together. */
const STANDINGS_SCALE_FLOOR = 0.35;
const STANDINGS_SCALE_CEIL = 2;

/**
 * The pixel constants a table is built from, in DRAW SPACE.
 *
 * They live in the schema rather than in the output page, unlike the bracket's
 * four, and that is because the SIZE of this drawing depends on how many rows
 * each group has - so `standingsLayout` below has to know them to answer at
 * all, and a suite asserting the fit would otherwise need a browser to find out
 * how tall a table is. The page writes them back out as custom properties so
 * the stylesheet lays out at exactly the numbers the arithmetic assumed; two
 * copies of these numbers is a fit that is right about a drawing nobody is
 * looking at.
 */
export const STANDINGS_METRICS = {
  /**
   * One table.
   *
   * 680 is what is left when the fixed columns are taken out of it and a long
   * org name still fits: a 52px rank, then 96 + 96 + 88 for the three stat
   * columns at their widest, which leaves 316px of name inside the row's own
   * padding - about 24 characters at 26px. With the round column off, which is
   * the default, it is 436px.
   */
  tableW: 680,
  /** A team's row. */
  rowH: 54,
  /** The column heads above the rows. */
  headH: 40,
  /** The group's name above the table. Zero when a stage has no groups. */
  nameH: 48,
  gapX: 56,
  gapY: 44,
};

/** The frame, less the header above the tables and the air below them. */
export const STANDINGS_FRAME = { left: 96, right: 96, top: 168, bottom: 96 };

/** At most four tables across. Five is 3300px of table on a 1920 frame. */
const MAX_ACROSS = 4;

/* ------------------------------------------------------------- the state -- */

/** One team's line. See the header for what is deliberately not in it. */
const row = (input) => {
  const source = input && typeof input === 'object' ? input : {};
  return {
    name: text(source.name, 32),
    shortName: text(source.shortName, 8),
    logo: text(source.logo, 500),
    /*
     * Shared on purpose - 1, 2, 2, 4 - and copied rather than recomputed. The
     * page has no idea how a rank is worked out and must not acquire one.
     */
    rank: whole(source.rank, 0, 99, 0),
    won: whole(source.won, 0, 999, 0),
    lost: whole(source.lost, 0, 999, 0),
    mapsWon: whole(source.mapsWon, 0, 999, 0),
    mapsLost: whole(source.mapsLost, 0, 999, 0),
    roundsWon: whole(source.roundsWon, 0, 9999, 0),
    roundsLost: whole(source.roundsLost, 0, 9999, 0),
  };
};

/** A table of 24 is not a group, it is a spreadsheet. */
export const STANDINGS_ROW_LIMIT = 24;

/**
 * MAX_GROUPS plus the leftover bucket.
 *
 * `stageTables` appends a "Not in a group" table when a stage has matches that
 * belong to no pool, so the most it can ever answer with is one more than a
 * stage may hold. Capping at MAX_GROUPS exactly would silently drop exactly the
 * table that exists to stop matches looking like they have vanished.
 */
export const STANDINGS_GROUP_LIMIT = 17;

const group = (input) => {
  const source = input && typeof input === 'object' ? input : {};
  return {
    id: text(source.id, 60),
    name: text(source.name, 40),
    rows: (Array.isArray(source.rows) ? source.rows : []).slice(0, STANDINGS_ROW_LIMIT).map(row),
  };
};

/** All the pools at once, or one at a time. */
export const STANDINGS_LAYOUTS = [
  { key: 'all', label: 'Every group at once' },
  { key: 'one', label: 'One group at a time' },
];

export const DEFAULT_STANDINGS = {
  version: 1,
  stageId: '',
  stageName: '',
  heading: '',
  groups: [],

  layout: 'all',
  /*
   * WHICH pool is shown, and it is an INDEX rather than a filter.
   *
   * Stored the way the bracket stores `reveal`, so a Next/Back pair on the
   * transport walks the pools - and, like `reveal`, it is NOT the cue. Stepping
   * to Group C animates Group C in; it must not replay the whole board's
   * entrance, which is what the counter exists to prevent.
   */
  group: 0,

  /*
   * How many PLACES go through, marked in the highlight.
   *
   * Counted in ranks rather than rows - see the header. Zero is the default and
   * means the table says nothing about qualification, which is the honest state
   * for a league table mid-season.
   */
  qualify: 0,

  showLogos: true,
  showRecord: true,
  showMaps: true,
  /*
   * Round difference is OFF by default. It is the second tiebreak a rulebook
   * reaches for and the one an audience reads least, so it is a column a show
   * turns on rather than one it has to turn off.
   */
  showRounds: false,

  /*
   * The two colours, and note that they are named the way round they MEAN -
   * unlike the bracket, whose `accent` is its highlight and whose `trim` is its
   * accent. That mismatch predates the word "highlight" existing here and is
   * documented as a trap; there is no reason to repeat it in a new file.
   *
   * `accent` is the TRIM: the rule under a column head, the eyebrow, the
   * furniture. `highlight` is what WENT THROUGH: the qualification band down
   * the side of a row. Blank means the event's own, live.
   */
  accent: '',
  highlight: '',
  eventLogo: '',

  autoSize: true,
  boardScale: 1,
  anim: { visible: false, cue: 0 },
};

export function sanitiseStandings(input, fallback = DEFAULT_STANDINGS) {
  const source = input && typeof input === 'object' ? input : {};
  const base = fallback ?? DEFAULT_STANDINGS;

  const groups = (Array.isArray(source.groups) ? source.groups : (base.groups ?? []))
    .slice(0, STANDINGS_GROUP_LIMIT)
    .map(group);

  return {
    version: 1,
    stageId: text(source.stageId ?? base.stageId, 64),
    stageName: text(source.stageName ?? base.stageName, 40),
    heading: text(source.heading ?? base.heading, 40),
    groups,

    layout: STANDINGS_LAYOUTS.some((entry) => entry.key === source.layout)
      ? source.layout
      : (base.layout ?? 'all'),
    /*
     * Clamped to the groups that EXIST, the same way the bracket clamps its
     * reveal to the columns that exist - an index past the end leaves an
     * operator pressing Next with nothing happening and no way to tell a broken
     * graphic from a finished one.
     */
    group: whole(source.group ?? base.group, 0, Math.max(0, groups.length - 1), 0),
    qualify: whole(source.qualify ?? base.qualify, 0, STANDINGS_ROW_LIMIT, 0),

    showLogos: typeof source.showLogos === 'boolean' ? source.showLogos : (base.showLogos ?? true),
    showRecord: typeof source.showRecord === 'boolean' ? source.showRecord : (base.showRecord ?? true),
    showMaps: typeof source.showMaps === 'boolean' ? source.showMaps : (base.showMaps ?? true),
    showRounds: typeof source.showRounds === 'boolean' ? source.showRounds : (base.showRounds ?? false),

    accent: hex(source.accent ?? base.accent),
    highlight: hex(source.highlight ?? base.highlight),
    eventLogo: text(source.eventLogo ?? base.eventLogo, 500),

    // A feature switch, so a record written before this existed reads as ON -
    // the asymmetry settings-schema.js states.
    autoSize: typeof source.autoSize === 'boolean' ? source.autoSize : (base.autoSize ?? true),
    boardScale: multiplier(source.boardScale ?? base.boardScale, 1, STANDINGS_SCALE_MIN, STANDINGS_SCALE_MAX),
    anim: {
      visible: typeof source.anim?.visible === 'boolean' ? source.anim.visible : (base.anim?.visible ?? false),
      cue: whole(source.anim?.cue ?? base.anim?.cue, 0, 1_000_000, 0),
    },
  };
}

/* ---------------------------------------------------- from the schedule --- */

/**
 * A stage of a schedule -> the tables that show it.
 *
 * Takes `stageTables`' output rather than re-deriving anything: one
 * implementation of the standings, used by the Schedule page and by this. The
 * teams are resolved to names HERE, where the fixtures are still to hand.
 *
 * `stageTables` ALREADY ANSWERS WITH A LIST OF ONE when a stage has no groups,
 * which is the whole reason the all-groups and one-at-a-time layouts are nearly
 * free: the grouped and ungrouped cases are one code path. Do not add a second.
 */
export function standingsFromStage({ tables, stage }) {
  return {
    stageId: stage?.id ?? '',
    stageName: stage?.name ?? '',
    groups: (tables ?? []).map((entry) => ({
      id: entry.id ?? '',
      name: entry.name ?? '',
      rows: (entry.table ?? []).map((line) => ({
        name: line.name,
        shortName: line.shortName,
        logo: line.logo,
        rank: line.rank,
        won: line.won,
        lost: line.lost,
        mapsWon: line.mapsWon,
        mapsLost: line.mapsLost,
        roundsWon: line.roundsWon,
        roundsLost: line.roundsLost,
      })),
    })),
  };
}

/**
 * Has the stage moved past what is on the board?
 *
 * Compared on what the graphic SHOWS - who is in each table, in what order,
 * with what record - so renaming the stage does not light a badge that then
 * gets ignored. Same rule the bracket, the veto board and the lineup follow.
 */
export function standingsIsStale(state, fresh) {
  if (!state?.stageId || !fresh || state.stageId !== fresh.stageId) return false;
  const shape = (value) =>
    JSON.stringify(
      (value.groups ?? []).map((entry) => [
        entry.name ?? '',
        (entry.rows ?? []).map((line) => [
          line.name,
          line.rank,
          line.won,
          line.lost,
          line.mapsWon,
          line.mapsLost,
          line.roundsWon,
          line.roundsLost,
        ]),
      ]),
    );
  return shape(state) !== shape(fresh);
}

/* -------------------------------------------------------------- the fit --- */

/** One table's height in draw space: its name, its heads, and its rows. */
export function standingsTableHeight(entry, { named = true } = {}) {
  const { rowH, headH, nameH } = STANDINGS_METRICS;
  return (named ? nameH : 0) + headH + Math.max(1, entry?.rows?.length ?? 0) * rowH;
}

/** Which tables are on screen: all of them, or the one the index names. */
export function shownGroups(state) {
  const groups = state?.groups ?? [];
  if (!groups.length) return [];
  if (state?.layout !== 'one') return groups;
  const index = Math.min(Math.max(0, state.group ?? 0), groups.length - 1);
  return [groups[index]];
}

/**
 * How the tables are arranged, how big that is, and what it is scaled by.
 *
 * ARITHMETIC, never measurement. This page is rendered by OBS while nothing is
 * on screen, so anything that asked its own width would read zero - the rule
 * the bracket's whole layout is built on, and the reason these constants are in
 * the schema at all.
 *
 * THE TABLES SPREAD AS WIDE AS THEY CAN WITHOUT BEING DRAWN SMALLER THAN THEY
 * WERE DESIGNED, and wrap when they cannot. So: the most across that still fits
 * at 1.0 or better, and if nothing does, whichever shape gets closest.
 *
 * The first version of this maximised the SCALE instead, on the argument that
 * the only thing a shape is for is making the tables as big as the frame
 * allows. It is a good argument and it produced a wrong answer for the most
 * ordinary case there is. Two pools of four stack into a COLUMN, because two
 * short tables leave height to spare and one 1020px-wide table is arithmetically
 * larger than two 816px ones - by two per cent. A group stage read as two pools
 * stacked one above the other, which is not what a group stage is: they are
 * parallel, they are played at the same time, and every broadcast puts them
 * side by side. Bigger is not the goal; bigger is a proxy for readable, and it
 * stops being one the moment a table is stretched past its own design.
 *
 * Four pools come out two-by-two, eight come out three-by-three and sixteen
 * four-by-four, none of which is a number written down anywhere - which is the
 * half of the original argument worth keeping.
 */
export function standingsLayout(state, frame = STANDINGS_FRAME) {
  const groups = shownGroups(state);
  const { tableW, gapX, gapY } = STANDINGS_METRICS;
  const availW = 1920 - frame.left - frame.right;
  const availH = 1080 - frame.top - frame.bottom;

  if (!groups.length) return { cols: 1, rows: 0, width: 0, height: 0, named: false, scale: 1 };

  // A single ungrouped table has no name above it, so it does not pay for one.
  const named = groups.some((entry) => Boolean(entry.name));
  const heights = groups.map((entry) => standingsTableHeight(entry, { named }));

  const shapes = [];
  for (let cols = 1; cols <= Math.min(MAX_ACROSS, groups.length); cols += 1) {
    const rows = Math.ceil(groups.length / cols);
    const width = cols * tableW + (cols - 1) * gapX;
    let height = (rows - 1) * gapY;
    for (let line = 0; line < rows; line += 1) {
      height += Math.max(...heights.slice(line * cols, line * cols + cols), 0);
    }
    shapes.push({ cols, rows, width, height, fit: Math.min(availW / width, availH / height) });
  }

  /*
   * The widest that still fits at full size; failing that, the biggest there
   * is. `reduce` from the narrow end, so among shapes that all clear 1.0 the
   * last one seen - the widest - wins outright rather than by a margin.
   */
  const full = shapes.filter((shape) => shape.fit >= 1);
  const best = full.length ? full[full.length - 1] : shapes.reduce((a, b) => (b.fit > a.fit ? b : a));

  return {
    cols: best.cols,
    rows: best.rows,
    width: best.width,
    height: best.height,
    named,
    scale: standingsAutoFit(best.fit),
  };
}

/**
 * A raw fit -> the factor the board is actually drawn at.
 *
 * FLOORED to the 0.05 grid, never rounded, for the reason `bracketAutoFit`
 * gives: rounding can land OUTSIDE the fit it came from and paint a few pixels
 * off the bottom of the frame with nothing failing. Flooring can only ever land
 * inside it.
 */
export function standingsAutoFit(fit) {
  if (!Number.isFinite(fit) || fit <= 0) return 1;
  return Math.min(STANDINGS_AUTO_MAX, Math.max(STANDINGS_AUTO_MIN, Math.floor(fit * 20) / 20));
}

/**
 * The factor the board is painted at, fit and operator together.
 *
 * The operator's number MULTIPLIES the fit rather than replacing it, so the
 * slider means the same thing in both modes - "a bit bigger than it would be" -
 * and switching the fit off hands them the number itself. The product is
 * bounded because two maxima multiply.
 */
export function standingsScale(state) {
  const manual = multiplier(state?.boardScale, 1, STANDINGS_SCALE_MIN, STANDINGS_SCALE_MAX);
  const auto = state?.autoSize === false ? 1 : standingsLayout(state).scale;
  return Math.min(STANDINGS_SCALE_CEIL, Math.max(STANDINGS_SCALE_FLOOR, Math.round(auto * manual * 100) / 100));
}

/**
 * Is this row inside the qualification cut?
 *
 * BY RANK, which is the point - see the header. With ranks 1, 2, 2, 4 and a cut
 * of two, three teams are marked, because the table cannot separate the two on
 * equal wins and a graphic must not invent an order the table refuses to have.
 */
export const standingsThrough = (state, line) =>
  (state?.qualify ?? 0) > 0 && (line?.rank ?? 0) > 0 && line.rank <= state.qualify;
