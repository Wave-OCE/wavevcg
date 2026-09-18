/**
 * The bracket graphic: a draw sheet, on air.
 *
 * A seventh graphic, and the one whose snapshot is least like its source.
 *
 * ---------------------------------------------------------------------------
 * It carries a DRAWING, not a competition
 * ---------------------------------------------------------------------------
 *
 * `bracketLayout` in schedule-schema.js answers in abstract units - columns and
 * rows, both possibly fractional - and the Schedule sub-page multiplies by its
 * own pixel constants. Load runs that same function once and stores the RESULT:
 * flat nodes with their teams and scores already resolved, and links as
 * coordinate pairs. Three things fall out of that and each one matters:
 *
 *   The output page needs no idea what a stage, a bracket half or a `source`
 *   edge is. It multiplies numbers by four constants and draws. Nothing on a
 *   1920x1080 stage is walking a graph while it paints.
 *
 *   The dashboard's drawing and the broadcast's cannot disagree, because there
 *   is one implementation of the geometry and the graphic holds its output
 *   rather than re-deriving it.
 *
 *   And it is the copy-not-link rule taken to its conclusion. A schedule edit
 *   mid-show - a score corrected, a fixture added - cannot move what is on air,
 *   which for a bracket matters more than anywhere else: this is the graphic
 *   most likely to be up while somebody is filing results behind it.
 *
 * The cost is that the board goes stale, so the dashboard says when it has and
 * Load is one press.
 *
 * ---------------------------------------------------------------------------
 * Revealing, and the flow
 * ---------------------------------------------------------------------------
 *
 * `reveal` counts COLUMNS, not nodes - a round at a time is how a caster walks
 * a bracket out, and revealing one match of a quarter-final while its neighbour
 * stays blank is not a thing anybody asks for.
 *
 * `flow` animates the edges somebody actually progressed along, which is the
 * "who came from where" a bracket is for. An edge whose source has no winner is
 * drawn and does not flow: a line that pulses toward an empty slot is telling
 * the audience about a result that does not exist.
 *
 * Neither is the cue. The cue replays the ENTRANCE and moves only on a Show
 * press; revealing round three animates round three.
 */

const text = (value, max) =>
  typeof value === 'string' ? value.slice(0, max).replace(/[\x00-\x1f\x7f]/g, '').trim() : '';

const whole = (value, min, max, fallback = min) => {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
};

/*
 * A hex colour, or blank.
 *
 * Blank is a real answer - it means "whatever the stylesheet says" - so an
 * empty string survives rather than falling back to black, which is what a
 * plain text field would have stored and what would have painted.
 */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const hex = (value) => {
  const candidate = String(value ?? '').trim();
  return HEX.test(candidate) ? candidate.toLowerCase() : '';
};

const number = (value, fallback = 0) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** A seat on a node: who, and how many maps they took. */
const seat = (input) => {
  const source = input && typeof input === 'object' ? input : {};
  return {
    name: text(source.name, 32),
    shortName: text(source.shortName, 8),
    logo: text(source.logo, 500),
    score: whole(source.score, 0, 99, 0),
  };
};

const node = (input) => {
  const source = input && typeof input === 'object' ? input : {};
  return {
    id: text(source.id, 64),
    column: whole(source.column, 0, 40, 0),
    // Fractional on purpose - a match centres BETWEEN the two that feed it.
    row: number(source.row, 0),
    half: ['upper', 'lower', 'final'].includes(source.half) ? source.half : 'upper',
    left: seat(source.left),
    right: seat(source.right),
    winner: ['left', 'right', 'void'].includes(source.winner) ? source.winner : '',
  };
};

const link = (input) => {
  const source = input && typeof input === 'object' ? input : {};
  return {
    fromColumn: whole(source.fromColumn, 0, 40, 0),
    fromRow: number(source.fromRow, 0),
    toColumn: whole(source.toColumn, 0, 40, 0),
    toRow: number(source.toRow, 0),
    take: source.take === 'loser' ? 'loser' : 'winner',
    /*
     * Whether anybody has actually come along this edge.
     *
     * Stored rather than derived at paint time because the page holds a drawing
     * and not a competition - it has no fixtures to ask. Computed once, in
     * `bracketFromStage`, where the fixtures are still to hand.
     */
    live: source.live === true,
  };
};

/**
 * The panel the whole sheet leads to.
 *
 * Its own object because every field in it is copy somebody writes - "1ST
 * PLACE", "CHAMPIONS", the event's own wording - and a show that wants none of
 * it turns the whole thing off with one switch rather than blanking four boxes.
 */
const DEFAULT_WINNER_PANEL = {
  show: false,
  /*
   * `footer` is printed ABOVE and BELOW the art, which is why it carries the
   * placing rather than the word "winner": on the reference board the same line
   * appears top and bottom and frames the crest between them. `heading` and
   * `label` are the extra lines a show may want and default to nothing, so the
   * panel out of the box is exactly the reference - two labels and a picture.
   */
  heading: '',
  label: '',
  image: '',
  footer: '1ST PLACE',
};

const winnerPanel = (input, base = DEFAULT_WINNER_PANEL) => {
  const source = input && typeof input === 'object' ? input : {};
  return {
    show: typeof source.show === 'boolean' ? source.show : base.show,
    heading: text(source.heading ?? base.heading, 24),
    label: text(source.label ?? base.label, 24),
    image: text(source.image ?? base.image, 500),
    footer: text(source.footer ?? base.footer, 24),
  };
};

export const DEFAULT_BRACKET_GRAPHIC = {
  version: 1,
  stageId: '',
  stageName: '',
  heading: '',
  columns: 0,
  rows: 0,
  nodes: [],
  links: [],
  reveal: 0,
  flow: true,
  showScores: true,
  winner: { ...DEFAULT_WINNER_PANEL },
  /*
   * The two colours a show actually restyles, and no more.
   *
   * `accent` is the HIGHLIGHT - the slot of whoever went through, the flow
   * along the edges, the eyebrow. `trim` is the FRAME - the corner marks on the
   * winner panel. They are separate because they mean different things: one
   * says "this team won" and the other is the show's furniture, and a single
   * colour for both makes the winner's slot the same colour as a decoration.
   *
   * Blank means "use the stylesheet's", so a show that restyles nothing is
   * unaffected and the defaults stay in one place - the CSS - rather than being
   * duplicated here.
   */
  accent: '',
  trim: '',
  eventLogo: '',
  anim: { visible: false, cue: 0 },
};

/** A bracket bigger than this is not a graphic, it is a spreadsheet. */
export const BRACKET_NODE_LIMIT = 64;

export function sanitiseBracketGraphic(input, fallback = DEFAULT_BRACKET_GRAPHIC) {
  const source = input && typeof input === 'object' ? input : {};
  const base = fallback ?? DEFAULT_BRACKET_GRAPHIC;

  const nodes = (Array.isArray(source.nodes) ? source.nodes : (base.nodes ?? []))
    .slice(0, BRACKET_NODE_LIMIT)
    .map(node)
    .filter((entry) => entry.id);

  const columns = whole(source.columns ?? base.columns, 0, 40, 0);

  return {
    version: 1,
    stageId: text(source.stageId ?? base.stageId, 64),
    stageName: text(source.stageName ?? base.stageName, 40),
    heading: text(source.heading ?? base.heading, 40),
    columns,
    rows: number(source.rows ?? base.rows, 0),
    nodes,
    links: (Array.isArray(source.links) ? source.links : (base.links ?? [])).slice(0, BRACKET_NODE_LIMIT * 2).map(link),
    /*
     * Clamped to the COLUMNS that exist rather than to a constant.
     *
     * A reveal past the end leaves an operator pressing Next with nothing
     * happening and no way to tell a broken graphic from a finished one -
     * exactly the note on the veto board's own reveal.
     */
    reveal: whole(source.reveal ?? base.reveal, 0, columns, 0),
    flow: typeof source.flow === 'boolean' ? source.flow : (base.flow ?? true),
    showScores: typeof source.showScores === 'boolean' ? source.showScores : (base.showScores ?? true),
    winner: winnerPanel(source.winner, base.winner ?? DEFAULT_WINNER_PANEL),
    accent: hex(source.accent ?? base.accent),
    trim: hex(source.trim ?? base.trim),
    eventLogo: text(source.eventLogo ?? base.eventLogo, 500),
    anim: {
      visible: typeof source.anim?.visible === 'boolean' ? source.anim.visible : (base.anim?.visible ?? false),
      cue: whole(source.anim?.cue ?? base.anim?.cue, 0, 1_000_000, 0),
    },
  };
}

/**
 * A stage of a schedule -> the drawing that shows it.
 *
 * Takes `bracketLayout`'s output rather than re-deriving anything: one
 * implementation of the geometry, used by the Schedule page and by this. The
 * teams are resolved to names HERE, where the fixtures are still to hand, so
 * the output page never dereferences anything while it paints.
 *
 * `score` and `winner` are asked of the caller rather than imported, because
 * this file would otherwise pull the whole schedule schema into an output page
 * that has no other use for it.
 */
export function bracketFromStage({ layout, stage, score, winnerOf }) {
  if (!layout) return null;

  const decided = new Map();
  const nodes = layout.nodes.map((entry) => {
    const fixture = entry.fixture ?? {};
    const tally = score ? score(fixture) : { left: 0, right: 0 };
    const won = winnerOf ? winnerOf(fixture) : '';
    decided.set(entry.id, won);
    return node({
      id: entry.id,
      column: entry.column,
      row: entry.row,
      half: entry.half,
      left: { ...(fixture.left ?? {}), score: tally.left },
      right: { ...(fixture.right ?? {}), score: tally.right },
      winner: won,
    });
  });

  /*
   * An edge is LIVE when the match it comes from has been decided - and for a
   * loser edge, decided is enough; for a winner edge it must not be a walkover
   * with nobody named. A line pulsing toward an empty slot tells an audience
   * about a result that does not exist.
   */
  const byId = new Map(layout.nodes.map((entry) => [`${entry.column}:${entry.row}`, entry.id]));
  const links = layout.links.map((entry) => {
    const fromId = byId.get(`${entry.from.column}:${entry.from.row}`);
    const won = fromId ? decided.get(fromId) : '';
    return link({
      fromColumn: entry.from.column,
      fromRow: entry.from.row,
      toColumn: entry.to.column,
      toRow: entry.to.row,
      take: entry.take,
      live: Boolean(won) && won !== 'void',
    });
  });

  return {
    stageId: stage?.id ?? '',
    stageName: stage?.name ?? '',
    columns: layout.columns,
    rows: layout.rows,
    nodes,
    links,
  };
}

/**
 * Has the stage moved past what is drawn?
 *
 * Compared on what the graphic SHOWS - the names, the scores, the winners - so
 * renaming the stage or nudging a fixture nobody can see does not light a badge
 * that then gets ignored. Same rule the veto board and the lineup follow.
 */
export function bracketIsStale(state, fresh) {
  if (!state?.stageId || !fresh || state.stageId !== fresh.stageId) return false;
  const shape = (value) =>
    JSON.stringify(
      (value.nodes ?? []).map((entry) => [
        entry.id,
        entry.left?.name ?? '',
        entry.right?.name ?? '',
        entry.left?.score ?? 0,
        entry.right?.score ?? 0,
        entry.winner ?? '',
      ]),
    );
  return shape(state) !== shape(fresh);
}

/** The team that won the last match of the drawing, for the winner panel. */
export function bracketChampion(state) {
  const nodes = state?.nodes ?? [];
  if (!nodes.length) return null;
  /*
   * The rightmost node, and on a tie the lowest row - which is the grand final
   * on a double elimination and the final on a single one. Derived rather than
   * stored because "which match is the final" is a question the drawing already
   * answers, and a stored pointer is one more thing to keep in step.
   */
  const last = nodes.reduce((best, entry) => {
    if (!best) return entry;
    if (entry.column !== best.column) return entry.column > best.column ? entry : best;
    return entry.row > best.row ? entry : best;
  }, null);
  if (!last || !last.winner || last.winner === 'void') return null;
  return last.winner === 'left' ? last.left : last.right;
}
