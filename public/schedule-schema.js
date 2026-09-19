/**
 * What a competition IS: stages, the fixtures inside them, and the edges that
 * carry a winner from one fixture into the next.
 *
 * Shared by Node and the browser, like every other `public/*-schema.js` - one
 * definition drives the editor, the server's sanitiser and anything that reads
 * a schedule, so three copies cannot drift apart.
 *
 * ## One document, not a table of rows
 *
 * A schedule is validated as a WHOLE or not at all, because the interesting
 * rules are relationships rather than fields: an edge must name a fixture that
 * exists, the graph must be acyclic, and a stage must not be deleted while
 * fixtures sit in it. None of that can be checked one record at a time, which
 * is why `sanitiseSchedule` takes the document and `makeScheduleStore.apply`
 * mutates a CLONE and keeps it only if the result is legal.
 *
 * That shape is the alias-import scar generalised (see `graphics.js`, and
 * `alias-import-atomic.mjs`): an import that mutated the live library in place
 * and then failed its cap check left the over-cap list behind, where the next
 * unrelated `persist()` committed it - and the library stayed over the cap, so
 * every later import was refused for ever. A refused write here cannot leave a
 * mutation behind for somebody else's save to commit.
 *
 * ## Nothing derivable is stored
 *
 * There is no `status`, no series score, no standings table and no `completed`
 * flag anywhere in the record. All of it is a pure function of the maps, and a
 * stored copy is a second source of truth that goes wrong silently - the whole
 * argument the globals one-way sync had to learn the hard way.
 *
 * The single exception is `fixture.winner`, and it earns it: a forfeit moves a
 * series with no map row behind it, so `'left'` / `'right'` state a result
 * nothing else can imply, and `'void'` is the only thing a cancelled match or a
 * walkover can say. `'auto'` - the default - means "read it off the maps".
 *
 * ## Teams are COPIED into a slot, never linked
 *
 * `public/teams.js` states the rule for graphics and it holds here for the same
 * reason: a fixture records who played, and editing the team library afterwards
 * must not rewrite history. It is also the one failure this codebase has
 * actually shipped - `server.js`'s gstack export is the only live `teamId`
 * dereference in the tree and it failed as `''`, silently, with nothing logged
 * and only the exported name missing. A schedule resolving ids live would make
 * that every row.
 *
 * A slot may instead carry a `source` edge, and then the copy is written IN by
 * `propagate` as part of the same write that recorded the result. So the copy
 * is never stale: it is derived at write time, deterministically, from the
 * whole document - and still nothing dereferences a `teamId` at read time.
 *
 * ## What is NOT here yet, and why
 *
 * No pointer at "the fixture being played", and no seam onto the graphics.
 * Both were designed and both are blocked on a question this file cannot
 * answer: a tournament runs more than one match at a time, and a tournament
 * today has exactly one set of graphics (`BUS_KEYS` in `sessions.js` hangs off
 * one bundle, which is one per tournament). A single `current` pointer would be
 * wrong on arrival and wrong loudly - an operator on the second match presses
 * Load and puts the first match's teams on air. The schedule itself does not
 * care how many matches run at once, so it ships now and the pointer waits for
 * the productions question to be settled.
 */

import { EMPTY_TEAM, TEAM_KEYS, applyTeam, teamSlug } from './teams.js';

/**
 * How long a series can be.
 *
 * Nine, not five. `WINNER_MAP_ROWS` caps the winner graphic at five rows and
 * that is a layout decision about a 1920x1080 stage - it is not a fact about a
 * competition, and letting one output page's design decide what a tournament
 * record can express is the dependency the wrong way round. A Bo7 grand final
 * is representable here whether or not a graphic can currently draw it.
 */
export const MAX_MAPS = 9;
export const BEST_OF_CHOICES = [1, 3, 5, 7, 9];

/**
 * What shape a stage is.
 *
 * Three kinds because all three are run, and they differ in how fixtures are
 * generated and how the page draws them - not in what a fixture IS.
 *
 *   group       a pool with a table. Fixtures are whatever was drawn.
 *   roundrobin  a pool where everybody plays everybody. Same table, and the
 *               fixtures can be generated rather than typed.
 *   bracket     elimination. `round` and `slot` are its geometry, and edges
 *               carry winners forward.
 */
export const STAGE_KINDS = [
  { key: 'group', label: 'Group', help: 'A pool with a table. Fixtures are whatever was drawn.' },
  { key: 'roundrobin', label: 'Round robin', help: 'Everybody plays everybody. The fixtures can be generated.' },
  { key: 'bracket', label: 'Bracket', help: 'Elimination. Winners carry forward into the next round.' },
];
export const STAGE_KIND_KEYS = STAGE_KINDS.map((entry) => entry.key);

/**
 * Which half of a double-elimination bracket a fixture sits in.
 *
 * One field rather than two stages, because upper and lower are one bracket
 * drawn as two rows - a team falls from one into the other, which an edge
 * between separate stages could express but nothing would then line the rounds
 * up. `'final'` is the grand final, which belongs to neither.
 *
 * A single-elimination bracket leaves every fixture on `'upper'` and never
 * looks at this field. A bracket reset - a second grand final that exists only
 * if the lower-bracket team wins the first - is TWO fixtures, the second left
 * `'void'` until it is needed. That is deliberate: a fixture that may not
 * happen is not expressible as an edge, and inventing a conditional edge to
 * model one match a season would be a rule nobody could read afterwards.
 */
export const BRACKET_HALVES = ['upper', 'lower', 'final'];

/** `'winner'` carries the victor forward; `'loser'` drops them into the lower half. */
export const EDGE_TAKES = ['winner', 'loser'];

/** What a fixture's result can say beyond what its maps already say. */
export const FIXTURE_RESULTS = ['auto', 'left', 'right', 'void'];

const text = (value, max) =>
  typeof value === 'string' ? value.slice(0, max).replace(/[\x00-\x1f\x7f]/g, '').trim() : '';

const whole = (value, max) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(max, Math.round(number)));
};

const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

/** A date, or a blank. The same validator the tournament's own dates use. */
const dateText = (value) => {
  const raw = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
  const [year, month, day] = raw.split('-').map(Number);
  const made = new Date(Date.UTC(year, month - 1, day));
  // Rejects 2026-02-31, which Date would roll forward into March rather than
  // refuse - the silent kind of wrong that puts a match on a day nobody meant.
  return made.getUTCFullYear() === year && made.getUTCMonth() === month - 1 && made.getUTCDate() === day ? raw : '';
};

// ------------------------------------------------------------------ slots ---

/**
 * One side of a fixture.
 *
 * It carries a COPY of the team's fields (the rule at the top of this file) and
 * optionally an EDGE saying where the team comes from.
 *
 * **Where there is an edge, the copy is DERIVED and `propagate` owns it.** The
 * sanitiser keeps both and arbitrates neither, which it has to: an earlier
 * version cleared the edge as soon as a `teamId` appeared beside it, reasoning
 * that a hand-picked team should pin the slot - and since propagation writes
 * exactly such a `teamId`, every edge fired once and then died. A quarter-final
 * corrected afterwards left the semi-final showing the team that had already
 * been carried across, with nothing to say the link was gone.
 *
 * So pinning a slot means clearing `source` explicitly, which is what picking a
 * team in the editor does. The two are separate controls, so nothing here has
 * to guess which the operator meant.
 *
 * `seed` and `label` survive either way. A slot with no team yet still wants to
 * say "Seed 3" or "Winner of QF1" on a bracket nobody has played.
 */
export const emptySlot = () => ({
  ...EMPTY_TEAM,
  teamId: '',
  seed: 0,
  label: '',
  source: null,
});

export function sanitiseSlot(input) {
  const source = input ?? {};
  const out = { ...emptySlot() };

  for (const key of TEAM_KEYS) out[key] = text(source[key], 120);
  out.teamId = text(source.teamId, 80);
  out.seed = whole(source.seed, 999);
  out.label = text(source.label, 60);

  const edge = source.source;
  if (edge && typeof edge === 'object') {
    const fixtureId = text(edge.fixtureId, 80);
    if (fixtureId) out.source = { fixtureId, take: oneOf(edge.take, EDGE_TAKES, 'winner') };
  }

  return out;
}

/** Does this slot name anybody yet? A label alone is a promise, not a team. */
export const slotFilled = (slot) => Boolean(slot?.teamId || slot?.name);

/** What to print in a bracket cell that has no team in it. */
export const slotLabel = (slot) =>
  slot?.name || slot?.label || (slot?.seed ? `Seed ${slot.seed}` : '');

// ------------------------------------------------------------------- maps ---

/**
 * One map of a series.
 *
 * `award` sits beside the two scores rather than replacing them, and it is the
 * difference between "13-8" and "they did not turn up". A 0-0 row is the normal
 * state of a map nobody has played, so a map won by forfeit cannot be expressed
 * as a score at all - without `award` it would either read as unplayed or want
 * a fake 13-0 that then flows into the round differential on a table.
 */
export const emptyMapRow = () => ({ name: '', left: 0, right: 0, award: '' });

export function sanitiseMapRow(input) {
  const source = input ?? {};
  return {
    name: text(source.name, 40),
    left: whole(source.left, 99),
    right: whole(source.right, 99),
    award: oneOf(source.award, ['left', 'right'], ''),
  };
}

/** Who won this map: the award if there is one, otherwise the higher score. */
export function mapRowWinner(row) {
  if (!row) return '';
  if (row.award) return row.award;
  if (row.left === row.right) return '';
  return row.left > row.right ? 'left' : 'right';
}

/** A row nobody has touched. Not the same as a row that ended 0-0 by award. */
export const mapRowPlayed = (row) => Boolean(row && (row.award || row.left || row.right));

// --------------------------------------------------------------- fixtures ---

export const emptyFixture = () => ({
  id: '',
  stageId: '',
  externalId: '',
  label: '',
  round: 0,
  slot: 0,
  order: 0,
  bracket: 'upper',
  /*
   * Which group of its stage this match belongs to, or blank.
   *
   * Blank is the ordinary state: a bracket has no groups, and so does a pool
   * nobody has split. An id that names no group on the stage is treated as
   * blank by everything that reads it rather than being refused - a group can
   * be removed, and the document must not become unloadable because of it.
   */
  group: '',
  bestOf: 3,
  startsAt: '',
  note: '',
  left: emptySlot(),
  right: emptySlot(),
  maps: [],
  winner: 'auto',
});

export function sanitiseFixture(input) {
  const source = input ?? {};
  const bestOf = oneOf(whole(source.bestOf, MAX_MAPS), BEST_OF_CHOICES, 3);

  return {
    id: text(source.id, 80),
    stageId: text(source.stageId, 80),
    // Empty until something imports a schedule from elsewhere. It exists from
    // the first commit so that a later import has somewhere to put a foreign
    // key without a migration - adding a field is cheap, re-keying every
    // fixture in every saved schedule is not.
    externalId: text(source.externalId, 120),
    label: text(source.label, 60),
    round: whole(source.round, 99),
    slot: whole(source.slot, 999),
    order: whole(source.order, 9999),
    bracket: oneOf(source.bracket, BRACKET_HALVES, 'upper'),
    group: text(source.group, 60),
    bestOf,
    startsAt: dateText(source.startsAt),
    note: text(source.note, 200),
    left: sanitiseSlot(source.left),
    right: sanitiseSlot(source.right),
    /*
     * Sliced rather than refused, because this runs on LOAD as well as on
     * write. A Bo5 edited down to a Bo3 in the editor should not make the file
     * unreadable; the write path refuses the same thing up front, so the only
     * way to reach a slice is a hand-edited file or a `bestOf` that changed
     * under existing rows.
     */
    maps: (Array.isArray(source.maps) ? source.maps : []).slice(0, bestOf).map(sanitiseMapRow),
    winner: oneOf(source.winner, FIXTURE_RESULTS, 'auto'),
  };
}

/** How many maps win a series of this length. Bo3 -> 2, Bo5 -> 3. */
export const mapsNeeded = (bestOf) => Math.floor(oneOf(bestOf, BEST_OF_CHOICES, 3) / 2) + 1;

/** Maps won, per side. The series score. */
export function fixtureScore(fixture) {
  const out = { left: 0, right: 0 };
  for (const row of fixture?.maps ?? []) {
    const won = mapRowWinner(row);
    if (won) out[won] += 1;
  }
  return out;
}

/** Rounds won across every played map, per side. For a table's differential. */
export function fixtureRounds(fixture) {
  const out = { left: 0, right: 0 };
  for (const row of fixture?.maps ?? []) {
    if (!mapRowPlayed(row)) continue;
    out.left += row.left;
    out.right += row.right;
  }
  return out;
}

/**
 * Who won the series: `''`, `'left'`, `'right'`, or `'void'`.
 *
 * An explicit result beats the maps, which is what makes a forfeit expressible.
 * Otherwise a side has won once it holds enough maps - NOT once the rows run
 * out, because a Bo5 sitting at 2-1 with two rows left is a live match and a
 * Bo3 at 2-1 is over. That difference is the entire justification for storing
 * `bestOf` at all.
 */
export function fixtureWinner(fixture) {
  if (!fixture) return '';
  if (fixture.winner === 'void') return 'void';
  if (fixture.winner === 'left' || fixture.winner === 'right') return fixture.winner;

  const need = mapsNeeded(fixture.bestOf);
  const score = fixtureScore(fixture);
  if (score.left >= need) return 'left';
  if (score.right >= need) return 'right';
  return '';
}

/** Is there anything left to play? A void fixture is settled, with no winner. */
export const fixtureDecided = (fixture) => fixtureWinner(fixture) !== '';

/**
 * What to show beside a fixture. Derived, never stored.
 *
 *   void       cancelled, or a walkover with no match behind it
 *   done       settled
 *   live       somebody has played a map and it is not over
 *   scheduled  nothing has happened yet
 */
export function fixtureStatus(fixture) {
  const won = fixtureWinner(fixture);
  if (won === 'void') return 'void';
  if (won) return 'done';
  return (fixture?.maps ?? []).some(mapRowPlayed) ? 'live' : 'scheduled';
}

/** Which map is being played, or -1. The first row nobody has finished. */
export function currentMapIndex(fixture) {
  const rows = fixture?.maps ?? [];
  for (let i = 0; i < rows.length; i += 1) {
    if (!mapRowWinner(rows[i])) return i;
  }
  return -1;
}

/** `Sentinels vs Loud`, or whatever of it is known yet. */
export function fixtureLabel(fixture) {
  const left = slotLabel(fixture?.left);
  const right = slotLabel(fixture?.right);
  if (left && right) return `${left} vs ${right}`;
  return fixture?.label || left || right || 'Fixture';
}


// ------------------------------------------------------------- templates ---

/**
 * The shapes a competition actually comes in.
 *
 * `generate` lays out round ONE of a single elimination and the whole of a
 * round robin, and stops - so a bracket's later rounds had to be added by hand
 * and then WIRED by hand, one source edge per slot. A sixteen-team double
 * elimination is thirty matches and fifty-eight edges, and an operator doing
 * that at eight in the morning gets one wrong. A wrong edge is the worst kind
 * of wrong here: it carries the right team into the wrong match, silently, and
 * only the semi-final tells you.
 */
export const STAGE_TEMPLATES = [
  {
    key: 'single',
    label: 'Single elimination',
    kind: 'bracket',
    help: 'Lose once and you are out. Rounds down to a final, wired so a winner carries forward on its own.',
  },
  {
    key: 'double',
    label: 'Double elimination',
    kind: 'bracket',
    help:
      'An upper and a lower bracket, and a grand final. Losing once drops you; losing twice is out. Every ' +
      'winner AND every loser is wired.',
  },
  {
    key: 'roundrobin',
    label: 'Round robin',
    kind: 'roundrobin',
    help: 'Everybody plays everybody. Split it into groups to turn one long pool into several short ones.',
  },
];

export const STAGE_TEMPLATE_KEYS = STAGE_TEMPLATES.map((entry) => entry.key);

/**
 * Seeded first-round order: 1 plays the last seed, 2 the second-last.
 *
 * The seeds a bracket is drawn from, not the slots they sit in - `slot` is
 * geometry and this is the draw. Byes are left as empty slots rather than
 * auto-advanced, because a bye is a real thing an operator wants to see and
 * label rather than a match that silently is not there.
 */
const seedOrder = (size) => Array.from({ length: size / 2 }, (_, i) => [i, size - 1 - i]);

/**
 * Lay a whole stage out: matches, rounds, halves and EDGES.
 *
 * Pure - a list of teams in, a list of fixtures out, no ids minted and nothing
 * touched. The caller mints the ids and writes them, which is what lets the
 * suite drive this with no server and no port, the same way `bracketLayout` is
 * tested.
 *
 * Fixtures come back with a `ref` instead of an id, and edges name a `ref`.
 * The caller swaps both for real ids in one pass - see `applyTemplate` on the
 * server. Minting here would mean this function knowing about a store.
 *
 * @param {object} options
 * @param {string} options.template  one of STAGE_TEMPLATE_KEYS
 * @param {object[]} options.teams   slots, already copied from the library
 * @param {number} [options.bestOf]
 * @param {number} [options.groups]  round robin only: how many pools
 * @returns {{fixtures: object[], groups: {id: string, name: string}[]}}
 */
export function buildTemplate({ template, teams, bestOf = 3, groups = 1 } = {}) {
  const seats = Array.isArray(teams) ? teams : [];
  if (seats.length < 2) throw new Error('A template needs at least two teams.');

  if (template === 'roundrobin') return roundRobinTemplate(seats, bestOf, groups);
  if (template === 'single') return { fixtures: singleElim(seats, bestOf), groups: [] };
  if (template === 'double') return { fixtures: doubleElim(seats, bestOf), groups: [] };
  throw new Error(`Unknown template: ${template}`);
}

/** A pool, or several. Teams are dealt round the groups rather than sliced. */
function roundRobinTemplate(seats, bestOf, groups) {
  const pools = Math.max(1, Math.min(MAX_GROUPS, Math.floor(groups) || 1));

  if (pools === 1) {
    return { fixtures: poolFixtures(seats, bestOf, ''), groups: [] };
  }

  /*
   * DEALT, not sliced. Slicing sixteen seeded teams into four gives the top
   * four their own group and the bottom four theirs, which is the opposite of
   * a draw - dealing round puts one of each quarter in every pool, which is
   * what a seeded group stage is for.
   */
  const dealt = Array.from({ length: pools }, () => []);
  seats.forEach((seat, index) => dealt[index % pools].push(seat));

  const made = [];
  const named = dealt.map((_, index) => ({
    id: teamSlug(`group ${String.fromCharCode(65 + index)}`),
    name: `Group ${String.fromCharCode(65 + index)}`,
  }));

  dealt.forEach((pool, index) => {
    // A pool of one plays nobody. It is still a group - somebody may be about
    // to add a team to it - so it is created and simply has no matches.
    if (pool.length < 2) return;
    made.push(...poolFixtures(pool, bestOf, named[index].id));
  });

  return { fixtures: made, groups: named };
}

function poolFixtures(seats, bestOf, group) {
  const made = [];
  roundRobinPairs(seats.length).forEach((pairs, round) => {
    pairs.forEach(([a, b], slot) => {
      made.push({
        ref: `${group || 'pool'}-r${round + 1}-s${slot}`,
        group,
        round: round + 1,
        slot,
        bestOf,
        bracket: 'upper',
        left: seats[a],
        right: seats[b],
      });
    });
  });
  return made;
}

/**
 * Upper-bracket rounds, wired winner-forward.
 *
 * Round one carries the teams; every later round is empty and takes its two
 * sides from the winners below it. That is the whole difference between this
 * and `generate`, which laid out round one and left the rest to be typed.
 */
function singleElim(seats, bestOf, prefix = 'u') {
  const size = 2 ** Math.ceil(Math.log2(seats.length));
  const rounds = Math.log2(size);
  const made = [];

  seedOrder(size).forEach(([a, b], slot) => {
    made.push({
      ref: `${prefix}1-${slot}`,
      round: 1,
      slot,
      bestOf,
      bracket: 'upper',
      left: seats[a] ?? {},
      right: seats[b] ?? {},
    });
  });

  for (let round = 2; round <= rounds; round += 1) {
    const count = size / 2 ** round;
    for (let slot = 0; slot < count; slot += 1) {
      made.push({
        ref: `${prefix}${round}-${slot}`,
        round,
        slot,
        bestOf,
        bracket: 'upper',
        left: { source: { ref: `${prefix}${round - 1}-${slot * 2}`, take: 'winner' } },
        right: { source: { ref: `${prefix}${round - 1}-${slot * 2 + 1}`, take: 'winner' } },
      });
    }
  }

  return made;
}

/**
 * Upper, lower and a grand final, every edge wired.
 *
 * The lower bracket alternates MINOR rounds (two lower-bracket survivors meet)
 * with MAJOR ones (a survivor meets somebody who has just dropped out of the
 * upper bracket). That alternation is what makes the two halves finish
 * together, and it is the part nobody gets right by hand.
 *
 * The major rounds CROSS: lower slot i meets the loser of upper slot
 * `count - 1 - i` rather than slot i. Without it a team that has just knocked
 * somebody into the lower bracket meets them again immediately, which is the
 * one pairing a double elimination exists to avoid.
 */
function doubleElim(seats, bestOf) {
  const size = 2 ** Math.ceil(Math.log2(seats.length));
  const k = Math.log2(size);
  const made = singleElim(seats, bestOf);

  // A two-team draw has no lower bracket to build - one match decides it, and
  // a grand final between the same two people is the same match again.
  if (k < 2) return made;

  const lower = (round, slot) => `l${round}-${slot}`;
  let lowerRound = 0;

  // The first lower round is the only one fed entirely by the upper bracket.
  lowerRound += 1;
  for (let slot = 0; slot < size / 4; slot += 1) {
    made.push({
      ref: lower(lowerRound, slot),
      round: lowerRound,
      slot,
      bestOf,
      bracket: 'lower',
      left: { source: { ref: `u1-${slot * 2}`, take: 'loser' } },
      right: { source: { ref: `u1-${slot * 2 + 1}`, take: 'loser' } },
    });
  }

  for (let m = 1; m <= k - 1; m += 1) {
    // MAJOR: a lower-bracket survivor meets somebody dropping out of the upper.
    const majorCount = size / 2 ** (m + 1);
    const previous = lowerRound;
    lowerRound += 1;
    for (let slot = 0; slot < majorCount; slot += 1) {
      made.push({
        ref: lower(lowerRound, slot),
        round: lowerRound,
        slot,
        bestOf,
        bracket: 'lower',
        left: { source: { ref: lower(previous, slot), take: 'winner' } },
        // Crossed - see the note above.
        right: { source: { ref: `u${m + 1}-${majorCount - 1 - slot}`, take: 'loser' } },
      });
    }

    // MINOR: two survivors meet. The last major round is the lower final and
    // has nothing after it, so there is no minor round to follow it.
    if (m > k - 2) continue;
    const minorCount = size / 2 ** (m + 2);
    const beforeMinor = lowerRound;
    lowerRound += 1;
    for (let slot = 0; slot < minorCount; slot += 1) {
      made.push({
        ref: lower(lowerRound, slot),
        round: lowerRound,
        slot,
        bestOf,
        bracket: 'lower',
        left: { source: { ref: lower(beforeMinor, slot * 2), take: 'winner' } },
        right: { source: { ref: lower(beforeMinor, slot * 2 + 1), take: 'winner' } },
      });
    }
  }

  /*
   * The grand final belongs to NEITHER half, which is why `bracket` has three
   * values rather than two - `bracketLayout` centres it on the whole drawing
   * for the same reason.
   */
  made.push({
    ref: 'gf',
    round: 1,
    slot: 0,
    bestOf,
    bracket: 'final',
    left: { source: { ref: `u${k}-0`, take: 'winner' } },
    right: { source: { ref: lower(lowerRound, 0), take: 'winner' } },
  });

  return made;
}

// ----------------------------------------------------------------- stages ---

/**
 * How many groups one stage may hold.
 *
 * Sixteen is more than any real draw and small enough that a page of tables is
 * still a page. The cap exists so a hand-edited file cannot ask the dashboard
 * to paint four hundred standings tables.
 */
export const MAX_GROUPS = 16;

export const emptyStage = () => ({
  id: '',
  externalId: '',
  name: '',
  kind: 'bracket',
  order: 0,
  bestOf: 3,
  /*
   * GROUPS ARE A DIVISION INSIDE ONE STAGE, not stages of their own.
   *
   * "Group stage" is one phase of a competition and reads as one thing on a
   * strip; four separate stages called Group A to Group D is four entries
   * before the playoffs even appear, and an eight-group event is unusable. One
   * standings table per group, shown together, is what an operator is looking
   * at when they open this.
   *
   * Empty is the ordinary state and means "one pool" - every bracket has no
   * groups, and so does a round robin that nobody has split.
   *
   * `{ id, name }` rather than bare names, and for the reason stages carry an
   * id: renaming "Group A" to "Alpha" must not orphan the matches in it. The
   * id is slugged from the name at creation and never moves again.
   */
  groups: [],
});

export function sanitiseStage(input) {
  const source = input ?? {};
  const name = text(source.name, 80);
  return {
    // A slug, like a team id, and for the same reason: a hand-edited
    // schedule.json should still be something a person can follow.
    id: text(source.id, 80) || teamSlug(name),
    externalId: text(source.externalId, 120),
    name,
    kind: oneOf(source.kind, STAGE_KIND_KEYS, 'bracket'),
    order: whole(source.order, 999),
    // The default a new fixture in this stage takes. Not a constraint - a
    // grand final in a Bo3 bracket is a Bo5 and the record must allow it.
    bestOf: oneOf(whole(source.bestOf, MAX_MAPS), BEST_OF_CHOICES, 3),
    groups: sanitiseGroups(source.groups),
  };
}

/**
 * The groups on a stage, cleaned.
 *
 * A group with no name is not a group - it cannot be picked out of a list and
 * it cannot be labelled on a table, which is the same rule a nameless team and
 * a nameless stage both get. Ids are deduplicated because two groups resolving
 * to one slug would put both their matches in one table and lose half the draw
 * with nothing failing.
 */
export function sanitiseGroups(input) {
  const rows = Array.isArray(input) ? input : [];
  const seen = new Set();
  const out = [];

  for (const row of rows) {
    const source = row && typeof row === 'object' ? row : { name: row };
    const name = text(source.name, 60);
    if (!name) continue;
    const id = text(source.id, 60) || teamSlug(name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
    if (out.length >= MAX_GROUPS) break;
  }
  return out;
}

/** Does this stage divide into groups? Blank and one group both read as no. */
export const stageHasGroups = (stage) => (stage?.groups?.length ?? 0) > 1;

/**
 * Every table a stage wants to show, in the order it wants them.
 *
 * ONE ENTRY when the stage has no groups, so a caller never has to ask which
 * shape it is dealing with - the page renders a list either way, and the
 * ungrouped case is a list of one. That is the whole reason this exists rather
 * than the page branching on `stageHasGroups`: two rendering paths for one
 * table is how the grouped one ends up missing whatever the ungrouped one
 * gains next.
 *
 * A LEFTOVER BUCKET comes last, and only when something is actually in it.
 * Splitting an existing pool into groups leaves every match ungrouped until
 * somebody assigns them, and those matches have to be visible - a table that
 * silently omitted them would read as teams having been dropped from the draw.
 * It is named rather than blank for the same reason.
 *
 * @returns {{id: string, name: string, table: object[]}[]}
 */
export function stageTables(schedule, stage) {
  if (!stage) return [];
  const groups = stage.groups ?? [];
  if (!groups.length) return [{ id: '', name: '', table: standings(schedule, stage.id) }];

  const known = new Set(groups.map((group) => group.id));
  const loose = (schedule.fixtures ?? []).some(
    (fixture) => fixture.stageId === stage.id && !known.has(fixture.group ?? ''),
  );

  const tables = groups.map((group) => ({
    id: group.id,
    name: group.name,
    table: standings(schedule, stage.id, group.id),
  }));

  /*
   * Asked for by id `''` rather than by "not in any group", which matters: a
   * match whose group was REMOVED keeps the dead id, and it has to land
   * somewhere an operator can see it. `standings` filters on an exact match, so
   * this bucket catches only the genuinely unassigned - the orphans are swept
   * up by the stage save instead, which is where the removal happened.
   */
  if (loose) tables.push({ id: '', name: 'Not in a group', table: standings(schedule, stage.id, '') });
  return tables;
}

/** Does this stage want a table? Both pool kinds do; a bracket does not. */
export const stageHasTable = (stage) => stage?.kind === 'group' || stage?.kind === 'roundrobin';

// --------------------------------------------------------------- the whole ---

export const SCHEDULE_VERSION = 1;

export const emptySchedule = () => ({ version: SCHEDULE_VERSION, stages: [], fixtures: [] });

/** Ordering is a property of the document, so it is applied on the way in. */
const byOrder = (a, b) => a.order - b.order;
const byFixture = (a, b) =>
  a.round - b.round || a.bracket.localeCompare(b.bracket) || a.slot - b.slot || a.order - b.order;

/**
 * Every fixture that has to exist before this one can be resolved.
 *
 * Only the slot edges. `round` is presentation - a bracket drawn with a fixture
 * in round 3 fed from round 1 is unusual and legal, and refusing it would stop
 * an operator laying a lower bracket out in the order they actually build it.
 */
const edgesOf = (fixture) =>
  [fixture.left?.source?.fixtureId, fixture.right?.source?.fixtureId].filter(Boolean);

/**
 * Fixtures in an order where every edge points backwards, or null on a cycle.
 *
 * A depth-first walk with three colours, which is one pass and settles the
 * question for the whole graph. The alternative considered and rejected was a
 * rule that an edge may only point at a lower `round` - cheaper to write, and
 * it refuses the operator who lays out the lower bracket first, which is how
 * people actually build one.
 */
function topological(fixtures) {
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const colour = new Map();
  const out = [];
  let cycle = null;

  const walk = (fixture) => {
    const seen = colour.get(fixture.id);
    if (seen === 'done') return true;
    if (seen === 'open') {
      cycle = fixture.id;
      return false;
    }
    colour.set(fixture.id, 'open');
    for (const id of edgesOf(fixture)) {
      const next = byId.get(id);
      // A dangling edge is somebody else's problem to report - it is not a
      // cycle, and treating it as one would name the wrong fault.
      if (next && !walk(next)) return false;
    }
    colour.set(fixture.id, 'done');
    out.push(fixture);
    return true;
  };

  for (const fixture of fixtures) {
    if (!walk(fixture)) return { order: null, cycle };
  }
  return { order: out, cycle: null };
}

const problem = (code, message, hint = '') => ({ code, message, hint });

/**
 * Carry results forward along the edges.
 *
 * Runs inside the same write that recorded a result, so a sourced slot's copied
 * fields are never stale - they are derived, deterministically, from the whole
 * document, and nothing has to dereference a `teamId` at read time.
 *
 * **It will not rewrite a slot on a fixture that has already been played**, and
 * that refusal is the important half. Correcting a quarter-final after the
 * semi-final has been played would otherwise silently replace one of the teams
 * in a match that actually happened - the schedule inventing a fixture nobody
 * played. It raises a problem instead and leaves both alone, which is what
 * amber means everywhere else on this desk: there is a decision waiting, and
 * only a person can make it.
 *
 * Mutates `draft` in place. It is only ever called on a clone.
 */
export function propagate(draft) {
  const problems = [];
  const { order, cycle } = topological(draft.fixtures);
  if (!order) {
    problems.push(
      problem('cycle', 'These fixtures feed each other in a loop.', `Fixture ${cycle} is reachable from itself.`),
    );
    return problems;
  }

  const byId = new Map(draft.fixtures.map((fixture) => [fixture.id, fixture]));

  for (const fixture of order) {
    for (const side of ['left', 'right']) {
      const slot = fixture[side];
      if (!slot.source) continue;

      const from = byId.get(slot.source.fixtureId);
      if (!from) continue; // dangling; reported by sanitiseSchedule

      const won = fixtureWinner(from);
      // Not decided yet, or void - nothing to carry. The slot keeps whatever
      // label it has ("Winner of QF1") and stays empty.
      if (!won || won === 'void') continue;

      const take = slot.source.take === 'loser' ? (won === 'left' ? 'right' : 'left') : won;
      const team = from[take];
      if (!slotFilled(team)) continue;

      const already = TEAM_KEYS.every((key) => slot[key] === team[key]) && slot.teamId === team.teamId;
      if (already) continue;

      if ((fixture.maps ?? []).some(mapRowPlayed)) {
        problems.push(
          problem(
            'resultAfterAdvance',
            `"${fixtureLabel(fixture)}" has already been played, so its teams were left alone.`,
            `It takes its ${side} side from "${fixtureLabel(from)}", whose result changed. Fix it by hand if the match really did change.`,
          ),
        );
        continue;
      }

      for (const key of TEAM_KEYS) slot[key] = team[key];
      slot.teamId = team.teamId;
    }
  }

  return problems;
}

/**
 * Clean a whole schedule, and say what is wrong with it.
 *
 * Two dispositions, because the two callers want opposite things:
 *
 *   strict    a write. Any problem means the write is refused and the live
 *             document is untouched.
 *   lenient   a load. Degrade rather than throw - drop a dangling edge, keep
 *             the fixture, warn. A hand-edited file must not stop the tool
 *             opening, which is the whole reason `load` cannot be strict.
 */
export function sanitiseSchedule(input, { strict = false } = {}) {
  const source = input ?? {};
  const problems = [];

  const stages = (Array.isArray(source.stages) ? source.stages : [])
    .map(sanitiseStage)
    .filter((stage) => stage.id)
    .sort(byOrder);

  // A duplicate id makes "which one did you mean" unanswerable, so the later
  // one loses rather than both surviving to confuse every lookup.
  const stageIds = new Set();
  const keptStages = [];
  for (const stage of stages) {
    if (stageIds.has(stage.id)) {
      problems.push(problem('duplicateStage', `There is already a stage called "${stage.name}".`));
      continue;
    }
    stageIds.add(stage.id);
    keptStages.push(stage);
  }

  const fixtures = (Array.isArray(source.fixtures) ? source.fixtures : [])
    .map(sanitiseFixture)
    .filter((fixture) => fixture.id);

  const fixtureIds = new Set();
  const keptFixtures = [];
  for (const fixture of fixtures) {
    if (fixtureIds.has(fixture.id)) {
      problems.push(problem('duplicateFixture', `Two fixtures share the id ${fixture.id}.`));
      continue;
    }
    fixtureIds.add(fixture.id);
    keptFixtures.push(fixture);
  }

  for (const fixture of keptFixtures) {
    if (fixture.stageId && !stageIds.has(fixture.stageId)) {
      problems.push(
        problem('orphanFixture', `"${fixtureLabel(fixture)}" is in a stage that does not exist.`, `Stage: ${fixture.stageId}`),
      );
      if (!strict) fixture.stageId = '';
    }

    for (const side of ['left', 'right']) {
      const edge = fixture[side].source;
      if (!edge) continue;
      if (!fixtureIds.has(edge.fixtureId)) {
        problems.push(
          problem(
            'danglingEdge',
            `"${fixtureLabel(fixture)}" takes its ${side} side from a fixture that does not exist.`,
            `Fixture: ${edge.fixtureId}`,
          ),
        );
        if (!strict) fixture[side].source = null;
      } else if (edge.fixtureId === fixture.id) {
        problems.push(problem('selfEdge', `"${fixtureLabel(fixture)}" feeds itself.`));
        if (!strict) fixture[side].source = null;
      }
    }

    if (fixture.maps.length > fixture.bestOf) {
      problems.push(
        problem(
          'tooManyMaps',
          `"${fixtureLabel(fixture)}" has more maps than a best of ${fixture.bestOf} can hold.`,
          `${fixture.maps.length} rows for ${fixture.bestOf}.`,
        ),
      );
      // sanitiseFixture has already sliced. Strict refuses; lenient keeps the slice.
    }
  }

  keptFixtures.sort(byFixture);

  const schedule = { version: SCHEDULE_VERSION, stages: keptStages, fixtures: keptFixtures };
  return { schedule, problems };
}

// ------------------------------------------------------------- derivations ---

/**
 * A table for a pool stage.
 *
 * **Ties are not broken, and that is the decision rather than an omission.**
 * Real VALORANT group rulebooks tiebreak head-to-head first, so ranking by map
 * differential would be authoritative-looking and wrong in exactly the
 * situation that makes somebody open the table. Teams on equal wins share a
 * rank, the numbers that a rulebook would use are all shown, and the operator
 * reads the rulebook.
 *
 * Within a shared rank the order is alphabetical - arbitrary on purpose, so
 * that it does not read as a placing.
 */
/**
 * One table, for a stage or for one group of one.
 *
 * @param {object} schedule
 * @param {string} stageId
 * @param {string} [groupId] only matches in this group; omit for all of them
 */
export function standings(schedule, stageId, groupId) {
  const rows = new Map();
  /*
   * `undefined` means every match in the stage; a STRING means exactly that
   * group. The two are deliberately different from each other and from `''`,
   * which means the ungrouped ones - a stage part-way through being split has
   * matches that belong to no group yet, and they are a real bucket rather
   * than an error.
   */
  const wanted = (fixture) => groupId === undefined || (fixture.group ?? '') === groupId;

  const seat = (slot) => {
    const key = slot.teamId || slot.name;
    if (!key) return null;
    if (!rows.has(key)) {
      rows.set(key, {
        key,
        teamId: slot.teamId,
        name: slot.name,
        shortName: slot.shortName,
        logo: slot.logo,
        colour: slot.colour,
        played: 0,
        won: 0,
        lost: 0,
        mapsWon: 0,
        mapsLost: 0,
        roundsWon: 0,
        roundsLost: 0,
      });
    }
    return rows.get(key);
  };

  /*
   * Seat everybody who appears in the stage FIRST, before counting anything.
   *
   * A group of four with one match played is still a group of four, and a table
   * that grew a row each time somebody finished a match would be unreadable on
   * the morning of a show - an operator checking the draw would see two names
   * and no way to tell whether the other two had been left out or simply had
   * not played. The numbers fill in; the rows do not appear.
   */
  for (const fixture of schedule.fixtures) {
    if (stageId && fixture.stageId !== stageId) continue;
    if (!wanted(fixture)) continue;
    seat(fixture.left);
    seat(fixture.right);
  }

  for (const fixture of schedule.fixtures) {
    if (stageId && fixture.stageId !== stageId) continue;
    if (!wanted(fixture)) continue;
    const won = fixtureWinner(fixture);
    // A void fixture and a half-played one both contribute nothing. A table
    // that counted a match in progress would move under a live audience.
    if (!won || won === 'void') continue;

    const left = seat(fixture.left);
    const right = seat(fixture.right);
    if (!left || !right) continue;

    const maps = fixtureScore(fixture);
    const rounds = fixtureRounds(fixture);

    for (const [row, side, other] of [
      [left, 'left', 'right'],
      [right, 'right', 'left'],
    ]) {
      row.played += 1;
      row[won === side ? 'won' : 'lost'] += 1;
      row.mapsWon += maps[side];
      row.mapsLost += maps[other];
      row.roundsWon += rounds[side];
      row.roundsLost += rounds[other];
    }
  }

  const table = [...rows.values()].sort((a, b) => b.won - a.won || a.name.localeCompare(b.name));

  // Standard competition ranking: 1, 2, 2, 4. A shared rank is marked so the
  // page can say so rather than leaving it to be noticed.
  let rank = 0;
  let seen = 0;
  let lastWon = null;
  for (const row of table) {
    seen += 1;
    if (row.won !== lastWon) {
      rank = seen;
      lastWon = row.won;
    }
    row.rank = rank;
  }
  for (const row of table) row.tied = table.some((other) => other !== row && other.rank === row.rank);

  return table;
}

/**
 * A bracket, as columns to draw.
 *
 * Arithmetic from `round` and `slot` - never measurement. Sub-tabs are hidden
 * with `display: none`, `shell.js` fires no event when one opens, and anything
 * that measured itself while hidden would read zero and lay the whole bracket
 * out on top of itself.
 */
export function bracketColumns(schedule, stageId, half = null) {
  const mine = schedule.fixtures.filter(
    (fixture) => (!stageId || fixture.stageId === stageId) && (!half || fixture.bracket === half),
  );
  const rounds = [...new Set(mine.map((fixture) => fixture.round))].sort((a, b) => a - b);
  return rounds.map((round) => ({
    round,
    fixtures: mine.filter((fixture) => fixture.round === round).sort((a, b) => a.slot - b.slot || a.order - b.order),
  }));
}

/** Everything wrong with a schedule right now. Derived, and never auto-repaired. */
export function scheduleProblems(schedule) {
  return sanitiseSchedule(schedule, { strict: false }).problems;
}

/** Which fixtures name this team, so a delete can refuse and say where. */
export function fixturesUsingTeam(schedule, teamId) {
  const id = String(teamId ?? '');
  if (!id) return [];
  return schedule.fixtures.filter((fixture) => fixture.left.teamId === id || fixture.right.teamId === id);
}

/** Which fixtures take a side from this one, so a delete can refuse and say where. */
export function fixturesFedBy(schedule, fixtureId) {
  const id = String(fixtureId ?? '');
  if (!id) return [];
  return schedule.fixtures.filter((fixture) => edgesOf(fixture).includes(id));
}

/**
 * Every pairing in a round robin, in a fair order.
 *
 * The circle method: one team is pinned and the rest rotate, so every team
 * plays every other exactly once and nobody sits out twice in a row. A bye is
 * inserted for an odd count rather than refused - an odd pool is ordinary.
 */
export function roundRobinPairs(count) {
  const seats = [...Array(count).keys()];
  if (seats.length % 2) seats.push(-1);
  const half = seats.length / 2;
  const rounds = [];

  for (let round = 0; round < seats.length - 1; round += 1) {
    const pairs = [];
    for (let i = 0; i < half; i += 1) {
      const a = seats[i];
      const b = seats[seats.length - 1 - i];
      if (a !== -1 && b !== -1) pairs.push(round % 2 ? [b, a] : [a, b]);
    }
    rounds.push(pairs);
    seats.splice(1, 0, seats.pop());
  }

  return rounds;
}

// ------------------------------------------------- the seam onto the desk ---

/*
 * A fixture, as the three graphics want it.
 *
 * The shape and the contract are `graphicPatch`'s, deliberately - see
 * `public/global-schema.js`. Same three-way split of "what is this called on
 * each graphic", same "return only what actually differs, or null", and for the
 * same reason: every push is an SSE frame to every browser source, so a load
 * that rewrites a side nobody changed is a graphic that can flicker on air for
 * nothing.
 *
 * It lives HERE, in the schedule's schema, rather than in the graphics' - the
 * precedent being that `SHARED_FIELDS` sits in `global-schema.js` and names the
 * graphic keys it writes. The source of a value owns the mapping; the three
 * targets should not each grow their own idea of what a fixture is.
 */

/** The three graphics, spelled the way `graphicPatch` spells them. */
export const FIXTURE_TARGETS = ['graphic', 'winner', 'select'];

/**
 * What each graphic calls a team's fields.
 *
 * Only the scoreboard disagrees, and only about one key - it has called its
 * side's name `teamName` since before there was a team library. `applyTeam`
 * writes only the keys the target side actually HAS, so the winner's `region`
 * and the select's `label` need no entry here: one is absent from two of the
 * three sides and the other is never ours to write.
 */
const FIXTURE_RENAMES = { graphic: { name: 'teamName' } };

/**
 * One side of a fixture, copied onto one side of a graphic.
 *
 * COPIED, never linked - the rule `teams.js` states and this file restates at
 * the top. `teamId` travels beside the copy for exactly the reason the pickers
 * send it: so the dashboard can show which library entry a side came from. It
 * is informational, and nothing dereferences it at read time.
 */
const graphicSide = (slot, current, rename) => {
  // Spread first so the result has the target's key set and key ORDER, which is
  // what lets the comparison below be a stringify rather than a field walk.
  const next = applyTeam({ ...current }, slot ?? emptySlot(), rename);
  if ('teamId' in next) next.teamId = String(slot?.teamId ?? '');
  return next;
};

/**
 * The map rows a fixture would put on the winner graphic.
 *
 * A REPLACE, not a merge, and that is the point: the winner graphic always
 * holds exactly `WINNER_MAP_ROWS` rows, so a fixture with two maps played must
 * blank the other three. Merging would leave the last match's third map sitting
 * under this match's first two - last season's score on air, which is the
 * failure the export rules already refuse.
 *
 * `award` does not survive, and cannot: the winner graphic has no way to say
 * "won by forfeit" and reads a result off the two numbers. So a walkover row
 * (`award` with no score) arrives as 0-0 and reads as unplayed. That is a real
 * limitation rather than a bug to chase - the graphic's own `winner` override
 * is the operator's remedy, exactly as it is for a forfeit typed by hand - and
 * it is stated here because the alternative is inventing a 13-0 that no map
 * was played to.
 *
 * @param {object[]} rows    the graphic's current rows - the length is its own
 * @param {object[]} played  the fixture's map rows
 */
export const winnerMapRows = (rows, played) =>
  (rows ?? []).map((row, index) => {
    const from = (played ?? [])[index];
    return from
      ? { ...row, name: from.name, left: from.left, right: from.right }
      : { ...row, name: '', left: 0, right: 0 };
  });

/**
 * The patch one graphic should receive for this fixture, or null.
 *
 * Data keys only - never `anim` and never `seq`. Those carry the cue counter
 * that every animated output keys off, and a fixture load that touched one
 * would replay the entrance on the very next take, which is the exact failure
 * the counter exists to prevent. The shape of the guarantee is that they are
 * not sent rather than that they are sent unchanged: the stores shallow-merge,
 * so a key this never names cannot move.
 *
 * @param {object} fixture  the fixture being loaded
 * @param {string} name     'graphic' | 'winner' | 'select'
 * @param {object} current  that graphic's state right now
 */
export function fixturePatch(fixture, name, current) {
  if (!fixture || !current) return null;
  const patch = {};
  const rename = FIXTURE_RENAMES[name] ?? {};

  for (const half of ['left', 'right']) {
    const target = current[half];
    if (!target || typeof target !== 'object') continue;
    const next = graphicSide(fixture[half], target, rename);
    // Identical key sets in identical order, so this compares values only.
    if (JSON.stringify(next) !== JSON.stringify(target)) patch[half] = next;
  }

  if (name === 'winner' && Array.isArray(current.maps)) {
    const maps = winnerMapRows(current.maps, fixture.maps);
    if (JSON.stringify(maps) !== JSON.stringify(current.maps)) patch.maps = maps;
  }

  return Object.keys(patch).length ? patch : null;
}

/**
 * The map this fixture is being played on, or ''.
 *
 * The current row's name - the first one nobody has finished - and blank
 * whenever the fixture does not name one, which is the ordinary state of a
 * match that has not started. Blank is a REFUSAL to speak rather than an
 * instruction to clear, and the caller must treat it that way: `/api/game`
 * learned this the expensive way, where a bare `scene` event carrying no map
 * still counted as the feed having spoken and reverted a map an operator had
 * just picked by hand.
 */
export function fixtureMapName(fixture) {
  const index = currentMapIndex(fixture);
  if (index === -1) return '';
  return String(fixture?.maps?.[index]?.name ?? '').trim();
}

/**
 * Which map row a result should be reported into.
 *
 * The first unfinished row, or - once every row that exists is played - the
 * next one along. `maps` is only as long as what has been recorded, so a
 * fixture nobody has touched has no rows at all and `currentMapIndex` answers
 * -1; that is "map 1", not "nowhere". Capped at the series length, so a Bo3
 * whose three maps are played answers -1 and the caller refuses rather than
 * growing a fourth row the sanitiser would silently slice off again.
 */
export function nextMapIndex(fixture) {
  const open = currentMapIndex(fixture);
  const index = open === -1 ? (fixture?.maps ?? []).length : open;
  return index < (fixture?.bestOf ?? 0) ? index : -1;
}

// ------------------------------------------------------------ the bracket ---

/**
 * Where every fixture of a bracket sits, in abstract grid units.
 *
 * ## Arithmetic, never measurement
 *
 * The Schedule sub-page lives behind a sub-tab, and a hidden element measures
 * ZERO - `shell.js` fires no event when one opens, so a layout that asked the
 * DOM how big anything was would lay the whole bracket on top of itself and
 * only on the first paint. Every number here is computed from `round`, `slot`
 * and the EDGES, and the renderer's only job is to multiply by a card size.
 *
 * Units, not pixels, for the same reason the schema has no `WINNER_MAP_ROWS`
 * in it: a column width is a decision about a dashboard panel, not a fact
 * about a competition. `column` counts columns and `row` counts card heights,
 * and both may be fractional - a match sits at row 1.5 when it is centred
 * between two feeders.
 *
 * ## A match is centred between the matches that FEED it
 *
 * Not `2^(round-1) * (slot + 0.5)`, which is the formula every bracket drawing
 * starts with and which is only right for a full power-of-two single
 * elimination. This model lets an operator build a lower bracket in the order
 * they actually build one, leave byes as empty slots, and wire any fixture to
 * any earlier one - so the edges are the truth about what feeds what, and the
 * arithmetic follows them. A fixture nobody feeds takes the next free row,
 * which is what makes a first round lay out evenly with no special case.
 *
 * ## Overlaps are resolved, not hoped away
 *
 * Averaging can put two fixtures of one column on the same row - three matches
 * feeding two, a half-wired bracket mid-build. After the pass, each column is
 * sorted and pushed apart to a minimum of one row, which preserves the order
 * the operator sees and guarantees nothing is drawn underneath anything else.
 *
 * @returns {{columns: number, rows: number, nodes: object[], links: object[]}}
 */
export function bracketLayout(schedule, stageId) {
  const all = (schedule?.fixtures ?? []).filter((fixture) => fixture.stageId === stageId);
  const placed = new Map();
  const nodes = [];

  let bandTop = 0;
  let widest = 0;

  /*
   * The three halves as three BANDS, stacked.
   *
   * Upper above lower is how a double elimination is drawn everywhere, and the
   * grand final belongs to the right of both rather than inside either - which
   * is why it is laid out last, against the width the other two ended up
   * needing. A single elimination has only `upper` and the bands cost nothing.
   */
  for (const half of BRACKET_HALVES) {
    const mine = all.filter((fixture) => fixture.bracket === half);
    if (!mine.length) continue;

    const rounds = [...new Set(mine.map((fixture) => fixture.round))].sort((a, b) => a - b);
    // The grand final sits after everything else, however many rounds it has
    // (a bracket reset is two). Everything else starts at the left edge.
    const columnBase = half === 'final' ? widest : 0;
    /*
     * ...and VERTICALLY it centres on the whole drawing rather than taking the
     * next free row, because it belongs to neither band. Laid out below the
     * lower bracket it would hang off the bottom corner, which is not where
     * anybody has ever drawn a grand final.
     */
    const centre = half === 'final' ? Math.max(0, bandTop - 2) / 2 : 0;
    let bandRows = 0;

    for (const [index, round] of rounds.entries()) {
      const inRound = mine
        .filter((fixture) => fixture.round === round)
        .sort((a, b) => a.slot - b.slot || a.order - b.order);

      /*
       * Free rows are counted per COLUMN, not per band.
       *
       * Two fixtures only collide if they share a column, so a column starts
       * again at the top of its band. Counting across the band instead draws an
       * unwired bracket as a staircase - four fixtures at rows 0-3 and the next
       * round beginning at row 4 - which is what an operator sees in the moment
       * between generating a bracket and wiring it up.
       */
      let nextFreeRow = 0;

      const wanted = inRound.map((fixture) => {
        /*
         * Only sources in the SAME half place a fixture.
         *
         * A lower-bracket match is fed by the LOSERS of the upper bracket, so
         * averaging against every source would drag the whole lower band up
         * into the upper one - measured, and it put the upper and lower finals
         * on the same cell. A band lays itself out; edges arriving from another
         * band are still drawn, they just do not decide where anything sits.
         */
        const sources = edgesOf(fixture)
          .map((id) => placed.get(id))
          .filter((at) => at && at.half === half);
        const row = sources.length
          ? sources.reduce((sum, source) => sum + source.row, 0) / sources.length
          : half === 'final'
            ? centre
            : bandTop + nextFreeRow++;
        return { fixture, row };
      });

      // One column at a time: sorted, then pushed apart. Order is preserved,
      // so a nudge never reshuffles what the operator laid out.
      wanted.sort((a, b) => a.row - b.row);
      let floor = -Infinity;
      for (const entry of wanted) {
        entry.row = Math.max(entry.row, floor);
        floor = entry.row + 1;
        const at = { column: columnBase + index, row: entry.row, half };
        placed.set(entry.fixture.id, at);
        nodes.push({ id: entry.fixture.id, fixture: entry.fixture, ...at });
        bandRows = Math.max(bandRows, entry.row + 1);
        widest = Math.max(widest, at.column + 1);
      }
    }

    // A blank row between bands, so upper and lower do not touch. The grand
    // final shares the space rather than opening a band of its own.
    if (half !== 'final') bandTop = bandRows + 1;
  }

  /*
   * The links, as coordinate pairs rather than ids.
   *
   * The renderer draws elbows and should not have to look anything up; and an
   * edge whose source is not in this stage is dropped here rather than drawn
   * to nowhere.
   */
  const links = [];
  for (const node of nodes) {
    for (const side of ['left', 'right']) {
      const id = node.fixture[side]?.source?.fixtureId;
      const from = id ? placed.get(id) : null;
      if (!from) continue;
      links.push({
        from: { column: from.column, row: from.row },
        to: { column: node.column, row: node.row },
        take: node.fixture[side].source.take,
        side,
      });
    }
  }

  return {
    columns: widest,
    rows: nodes.reduce((most, node) => Math.max(most, node.row + 1), 0),
    nodes,
    links,
  };
}
