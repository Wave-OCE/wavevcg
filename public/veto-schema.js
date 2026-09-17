/**
 * The map veto: what one IS, and the order it happens in.
 *
 * Shared by Node and the browser like every other schema here, and by one more
 * thing besides - the public pages a team captain opens, which run this same
 * file and therefore cannot disagree with the server about whose turn it is.
 *
 * ---------------------------------------------------------------------------
 * The order is a TEMPLATE, not something an operator builds
 * ---------------------------------------------------------------------------
 *
 * A rulebook decides it, and for VALORANT the rulebook is the same one
 * everywhere: for a Bo3, ban - ban - pick - pick - ban - ban, and whatever
 * survives is the decider. So `TEMPLATES` below is the whole of it and there is
 * no sequence editor, which is a deliberate refusal rather than a gap.
 *
 * It is worth writing down why, because two of the reference graphics this was
 * built from appear to disagree about the order and do not. One shows the seven
 * steps in the order they happened; the other groups the four bans together and
 * then the picks, which is a LAYOUT decision about a full-screen board. The
 * sequence underneath is identical. Grouping is a property of the graphic and
 * must never reach back into the record - if it did, the board would be
 * evidence of an order nobody actually played.
 *
 * ---------------------------------------------------------------------------
 * Who picks the side
 * ---------------------------------------------------------------------------
 *
 * Not fixed, because this genuinely does vary: the ordinary rule is that the
 * team who did NOT pick the map chooses which side to start on, and some
 * rulebooks give it to the picker. `sideRule` carries that, and the decider -
 * which nobody picked - names a team outright.
 */

import { TEAM_KEYS } from './teams.js';

/** How many maps get played. The label is what the dashboard shows. */
export const VETO_FORMATS = [
  { key: 'bo1', label: 'Best of 1', maps: 1 },
  { key: 'bo3', label: 'Best of 3', maps: 3 },
  { key: 'bo5', label: 'Best of 5', maps: 5 },
];

export const VETO_FORMAT_KEYS = VETO_FORMATS.map((entry) => entry.key);

/**
 * The step order per format, as [kind, who].
 *
 * `who` is 'a' or 'b' - the FIRST and SECOND team, which is what "team A" means
 * on the setup panel. Which real org holds each seat is the operator's choice
 * and is usually decided by a coin toss, so it is a property of the veto rather
 * than of this table.
 *
 * Every template is seven steps because a VALORANT map pool is seven. A pool
 * with a different count still works - `buildSteps` stops banning when there is
 * nothing left to ban - but the templates are written for the real one.
 */
export const TEMPLATES = {
  bo1: [
    ['ban', 'a'],
    ['ban', 'b'],
    ['ban', 'a'],
    ['ban', 'b'],
    ['ban', 'a'],
    ['ban', 'b'],
    ['decider', ''],
  ],
  // The one the reference graphics show: two bans, two picks, two bans, and
  // whatever is left is the third map.
  bo3: [
    ['ban', 'a'],
    ['ban', 'b'],
    ['pick', 'a'],
    ['pick', 'b'],
    ['ban', 'a'],
    ['ban', 'b'],
    ['decider', ''],
  ],
  bo5: [
    ['ban', 'a'],
    ['ban', 'b'],
    ['pick', 'a'],
    ['pick', 'b'],
    ['pick', 'a'],
    ['pick', 'b'],
    ['decider', ''],
  ],
};

/** Who chooses attack or defence on a map somebody picked. */
export const SIDE_RULES = [
  { key: 'opponent', label: 'The other team chooses side' },
  { key: 'picker', label: 'The team who picked chooses side' },
];

export const VETO_SIDES = ['attack', 'defence'];

/** The three links a veto hands out, and what each one may do. */
export const VETO_ROLES = ['a', 'b', 'referee'];

const text = (value, max) =>
  typeof value === 'string' ? value.slice(0, max).replace(/[\x00-\x1f\x7f]/g, '').trim() : '';

const teamCopy = (input) => {
  const source = input && typeof input === 'object' ? input : {};
  const out = {};
  // The team's own keys and nothing else - a veto carries a COPY for the same
  // reason a fixture does: dereferencing an id at render time is the one
  // failure this codebase has actually shipped.
  for (const key of TEAM_KEYS) out[key] = text(source[key], 200);
  out.teamId = text(source.teamId, 64);
  return out;
};

/**
 * One step of the sequence.
 *
 * `map` is blank until somebody answers it, which is what makes `at` derivable
 * rather than stored - see `currentStep`. Nothing here records a timestamp: a
 * veto is a sequence, and "when" is the log's job.
 */
const emptyStep = (kind, who) => ({ kind, who, map: '', side: '', sideBy: '' });

/**
 * Who chooses the side on this step, given the rule.
 *
 * The decider belongs to neither team - nobody picked it - so it carries the
 * choice made on the setup panel instead. A ban has no side at all.
 */
export function sideChooser(step, { sideRule, deciderSideBy }) {
  if (step.kind === 'ban') return '';
  if (step.kind === 'decider') return deciderSideBy === 'b' ? 'b' : 'a';
  if (sideRule === 'picker') return step.who;
  return step.who === 'a' ? 'b' : 'a';
}

/**
 * The steps for a format, trimmed to what a pool can actually answer.
 *
 * A seven-map template against a five-map pool would leave two steps that can
 * never be completed, and a veto that cannot finish is worse than one that is
 * short: the graphic would sit waiting for a ban nobody can make. So the bans
 * are dropped from the END of the ban phase rather than the sequence being
 * invented from scratch, and the decider always survives.
 */
export function buildSteps(format, poolSize) {
  const template = TEMPLATES[format] ?? TEMPLATES.bo3;
  const steps = template.map(([kind, who]) => emptyStep(kind, who));
  const needed = steps.length;
  if (!Number.isFinite(poolSize) || poolSize >= needed) return steps;

  // Drop bans, latest first, until the sequence fits the pool. Picks and the
  // decider are what the format IS; a Bo3 with one pick is not a Bo3.
  const out = [...steps];
  for (let i = out.length - 1; i >= 0 && out.length > poolSize; i -= 1) {
    if (out[i].kind === 'ban') out.splice(i, 1);
  }
  return out;
}

/** The maps nobody has banned or picked yet. */
export function remainingMaps(veto) {
  const taken = new Set((veto?.steps ?? []).map((step) => step.map).filter(Boolean));
  return (veto?.pool ?? []).filter((map) => !taken.has(map));
}

/**
 * The step waiting to be answered, or null when it is done.
 *
 * Derived rather than stored, which is the schedule's rule applied again: a
 * stored index and a list of answered steps are two facts that can disagree,
 * and the one that would be wrong is the one the public pages act on.
 */
export function currentStep(veto) {
  const steps = veto?.steps ?? [];
  const at = steps.findIndex((step) => !step.map);
  return at === -1 ? null : { ...steps[at], at };
}

/** Whose turn it is: 'a', 'b', or '' when it is nobody's. */
export function turnOf(veto) {
  const step = currentStep(veto);
  if (!step) return '';
  // The decider is nobody's turn - it falls out. The referee confirms it, and
  // the side that goes with it is the only real decision left.
  return step.kind === 'decider' ? '' : step.who;
}

export const vetoComplete = (veto) => currentStep(veto) === null;

/**
 * The maps that will actually be played, in order.
 *
 * Bans are not maps of the series, so they are dropped - which is the whole
 * difference between this and `steps`, and the thing a graphic in "grouped"
 * layout is showing when it puts the picks together.
 */
export function playedMaps(veto) {
  return (veto?.steps ?? [])
    .filter((step) => step.kind !== 'ban' && step.map)
    .map((step) => ({ name: step.map, side: step.side, sideBy: step.sideBy, kind: step.kind }));
}

/**
 * Clean one veto record.
 *
 * Strict about shape and forgiving about content, like every sanitiser here.
 * The two things it will NOT do are invent a step and accept a map that is not
 * in the pool - the first would make the record disagree with the format, and
 * the second is how a captain's page with a stale pool bans a map nobody
 * offered.
 */
export function sanitiseVeto(input, { id } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const format = VETO_FORMAT_KEYS.includes(source.format) ? source.format : 'bo3';
  const pool = [...new Set((Array.isArray(source.pool) ? source.pool : []).map((map) => text(map, 40)).filter(Boolean))].slice(0, 20);

  const wanted = buildSteps(format, pool.length);
  const given = Array.isArray(source.steps) ? source.steps : [];
  const seen = new Set();

  const steps = wanted.map((step, index) => {
    const from = given[index] && typeof given[index] === 'object' ? given[index] : {};
    // A map only counts if it is in the pool and has not already been used.
    // Both halves matter: the first stops a stale page banning something that
    // is not on offer, the second stops one map filling two steps.
    let map = text(from.map, 40);
    if (!pool.includes(map) || seen.has(map)) map = '';
    if (map) seen.add(map);
    return {
      ...step,
      map,
      side: VETO_SIDES.includes(from.side) ? from.side : '',
      sideBy: ['a', 'b'].includes(from.sideBy) ? from.sideBy : '',
    };
  });

  return {
    id: text(source.id ?? id, 64) || text(id, 64),
    name: text(source.name, 80),
    format,
    // Blank means this veto is not attached to a match in the schedule, which
    // is the ordinary case - a showmatch, a scrim, a decider nobody drew.
    fixtureId: text(source.fixtureId, 64),
    sideRule: SIDE_RULES.some((rule) => rule.key === source.sideRule) ? source.sideRule : 'opponent',
    deciderSideBy: source.deciderSideBy === 'b' ? 'b' : 'a',
    a: teamCopy(source.a),
    b: teamCopy(source.b),
    pool,
    steps,
    createdAt: Number.isFinite(source.createdAt) ? source.createdAt : 0,
  };
}

/**
 * The whole document: one pool for the tournament, and the vetoes under it.
 *
 * The pool lives here rather than on each veto because it is a fact about the
 * SEASON - a pool re-picked before every match is a pool somebody gets wrong
 * sixty seconds before a match. Each veto still stores the pool it was created
 * with, so a map rotating out mid-tournament does not rewrite history.
 */
export const DEFAULT_VETO_DOC = { version: 1, pool: [], vetoes: [] };

export function sanitiseVetoDoc(input) {
  const source = input && typeof input === 'object' ? input : {};
  const pool = [...new Set((Array.isArray(source.pool) ? source.pool : []).map((map) => text(map, 40)).filter(Boolean))].slice(0, 20);
  const vetoes = (Array.isArray(source.vetoes) ? source.vetoes : [])
    .map((entry) => sanitiseVeto(entry))
    .filter((entry) => entry.id)
    .slice(0, 200);

  return { version: 1, pool, vetoes };
}

/**
 * What a captain's page is allowed to see.
 *
 * NEVER the tokens - not even their own, which they already have in the URL
 * they opened. A page that echoes a credential back is a page that puts it in a
 * screenshot, and the whole point of three separate links is that the referee's
 * one does more than a captain's.
 */
export function publicView(veto, role) {
  const step = currentStep(veto);
  return {
    id: veto.id,
    name: veto.name,
    format: veto.format,
    sideRule: veto.sideRule,
    a: veto.a,
    b: veto.b,
    pool: veto.pool,
    steps: veto.steps,
    remaining: remainingMaps(veto),
    complete: vetoComplete(veto),
    turn: turnOf(veto),
    step,
    // So the page can say "waiting for them" rather than "waiting", and can
    // grey its own buttons without a second round trip.
    you: role,
    yours: role === 'referee' || (step ? turnOf(veto) === role : false),
  };
}
