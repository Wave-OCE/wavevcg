/**
 * The event's two colours, and how a graphic gets them.
 *
 * A competition has a look, and until now every graphic held its own copy of
 * it: the winner splash defaulted to one red, the veto board to a gold, the
 * bracket to whatever had been typed into it, and dressing a season meant
 * opening seven panels and pasting the same hex into each. Worse, it meant
 * doing it again for every tournament on the server.
 *
 * So the tournament owns two colours and every graphic INHERITS them.
 *
 * ## Two colours, not one, and they are not interchangeable
 *
 * | | means |
 * | --- | --- |
 * | accent | the TRIM. The thin rule, the eyebrow, the edge. What brands the frame. |
 * | highlight | what WON, what is live, what went through. A state, not a brand. |
 *
 * Keeping them apart is the same distinction the dashboard already draws
 * between `--accent` and `--on-air`, and it is why the tournament has two
 * settings rather than one: an event whose trim is its sponsor's blue still
 * wants the team that just advanced lit in something that reads as "this one".
 * A single colour would make the winner's slot the same colour as the border
 * around it, which is the one thing the highlight exists to avoid.
 *
 * Graphics that draw no distinction use the accent and ignore the highlight.
 * That is correct rather than a gap - most of them have one coloured thing.
 *
 * ## Blank means inherit, and that is the whole mechanism
 *
 * A graphic's own accent field defaults to EMPTY, and empty resolves to the
 * tournament's. Typing a colour into a graphic overrides it for that graphic
 * alone; "Reset to default" clears the field and it inherits again. There is
 * no third state and no "inherit?" checkbox, because a checkbox beside a colour
 * that still shows a value is a control with two ways to say the same thing.
 *
 * INHERITANCE IS LIVE. Change the tournament's accent and every graphic that
 * has not been overridden repaints - including whatever is on air at that
 * moment. That is deliberate and it was the explicit decision: an operator
 * changing the event's colour mid-season means "restyle the show", and a change
 * that needed seven Reset presses to take effect would be a setting that
 * appears not to work. It is the one place in this codebase where a value is
 * LINKED rather than copied, and it earns the exception because a colour is a
 * property of the event rather than a moment in the show - unlike a team name
 * or a score, which are snapshots precisely so a library edit cannot rewrite
 * what an audience is looking at.
 *
 * The cost is stated rather than hidden: a tournament colour typed during a
 * live match changes air immediately, with no take. The Settings panel says so.
 *
 * ## How it reaches an output page
 *
 * Beside the state, never inside it. Every graphic's GET and every SSE frame
 * carries `brand: { accent, highlight }` alongside `state`, and the page
 * resolves with `pick()` below at paint time.
 *
 * Folding the resolved colour INTO the state on the way out was the other
 * option and is wrong in a way that would have taken a while to find: the
 * dashboard reads the same payload, so its colour field would show the
 * inherited value, an operator could no longer tell "inherited" from "set to
 * exactly that", and pressing Save anywhere would write the inherited colour in
 * as an override. The state says what was CHOSEN; the brand says what the event
 * is; the page puts them together.
 *
 * Dependency-free and DOM-free so Node and the browser can both import it.
 */

/**
 * The house colours, used when a tournament has not set its own.
 *
 * `#ff4655` is VALORANT red - already the winner splash's accent default and
 * the veto board's ban colour, so adopting it as the event default leaves an
 * unconfigured install looking exactly as it did.
 *
 * The highlight is the gold the veto board already lit a picked map's edge
 * with. It reads as "this one went through" against every backdrop here, and
 * it is far enough from the accent that the two never look like a mistake.
 */
export const DEFAULT_BRAND = { accent: '#ff4655', highlight: '#c8aa6e' };

export const BRAND_KEYS = Object.keys(DEFAULT_BRAND);

/**
 * `#rgb`, `#rrggbb` or `#rrggbbaa`. The same shape graphics.js accepts, written
 * here as well because this file may not import from the server side.
 */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Clean a colour, or fall back.
 *
 * Blank is NOT cleaned to the fallback - it is a real answer everywhere this is
 * used, and it means "inherit". Only an unparseable value takes the previous
 * one, because a colour that vanishes when you look away is worse than one that
 * is visibly wrong.
 */
export const brandHex = (value, fallback = '') => {
  if (typeof value === 'string' && !value.trim()) return '';
  const candidate = String(value ?? '').trim();
  return HEX.test(candidate) ? candidate.toLowerCase() : fallback;
};

/** The tournament's two colours, cleaned. Blank means "use the house default". */
export function sanitiseBrand(input, fallback = DEFAULT_BRAND) {
  const source = input && typeof input === 'object' ? input : {};
  const base = fallback && typeof fallback === 'object' ? fallback : DEFAULT_BRAND;
  return Object.fromEntries(BRAND_KEYS.map((key) => [key, brandHex(source[key], base[key] ?? '')]));
}

/**
 * What a tournament's colours actually resolve to.
 *
 * Its own, then the house. Never blank on the way out, because the pages call
 * this and then hand the answer straight to CSS - and a blank custom property
 * falls back to whatever the stylesheet declared, which is the per-graphic
 * default this feature exists to retire.
 */
export function brandOf(tournament) {
  const own = tournament?.brand ?? tournament ?? {};
  return Object.fromEntries(BRAND_KEYS.map((key) => [key, brandHex(own[key], '') || DEFAULT_BRAND[key]]));
}

/**
 * The colour a graphic paints: its own override, or the event's.
 *
 * One function, called by the output page AND by the dashboard's preview of the
 * same control, so the two cannot come to disagree about what a blank field
 * means. That has happened here before with `defaultFor` and the symptom was
 * invisible - see the note in CLAUDE.md about two implementations of one rule.
 *
 * @param {string} own    what the graphic's own field holds; blank = inherit
 * @param {object} brand  `{ accent, highlight }` from the wire
 * @param {string} which  which of the two to inherit
 */
export const pick = (own, brand, which = 'accent') =>
  brandHex(own, '') || brandOf(brand)[which] || DEFAULT_BRAND[which];

/**
 * Is this graphic inheriting, or has somebody overridden it?
 *
 * The question the "Reset to default" button is enabled by, and the one the
 * field's placeholder answers. A separate function because "blank" is about to
 * be checked in a dozen dashboards and `!value.trim()` written twelve times is
 * twelve chances to write `!value` and be wrong about `'   '`.
 */
export const inherits = (own) => !brandHex(own, '');
