/**
 * The head-to-head graphic: two orgs, full screen, before a match.
 *
 * A sixth graphic and the simplest of them - two crests, two names, and a VS.
 * Like the lineup it holds a COPY of each team rather than a reference, so
 * nothing dereferences an id while it paints.
 *
 * ---------------------------------------------------------------------------
 * Where the backdrop comes from
 * ---------------------------------------------------------------------------
 *
 * The team's own `banner` when it has one, and the graphic's style image when
 * it does not. Team first, and the order matters rather than being a
 * preference: key art belongs to the ORG and should follow them into every
 * matchup without being re-picked, while a show that has not photographed
 * anybody still needs the graphic to look deliberate rather than empty.
 *
 * So `backdropFor` is one function both sides call, and the fallback is a
 * property of the graphic rather than a hardcoded image - which is what lets an
 * operator set the house look once and forget about it.
 */

const text = (value, max) =>
  typeof value === 'string' ? value.slice(0, max).replace(/[\x00-\x1f\x7f]/g, '').trim() : '';

const whole = (value, min, max, fallback = min) => {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
};

/*
 * How far the type and the crests may be scaled.
 *
 * ONE range for both, because they are the same kind of control and two would
 * be two numbers to keep in step for no gain an operator can see. 0.5 at the
 * bottom is a half-size crest, which is the case this exists for - a wordmark
 * that fills its box while a shield floats in the middle of one. 1.6 at the
 * top is where a name plate stops fitting inside the half it is welded to.
 *
 * A `scale` and NOT a `ratio`: `ratio()` caps at 1 because everything it
 * guards is a proportion, and a multiplier run through it would silently clamp
 * every enlargement to "no change" while the slider claimed otherwise.
 */
export const H2H_SCALE_MIN = 0.5;
export const H2H_SCALE_MAX = 1.6;
export const H2H_SCALE_STEP = 0.05;

const scale = (value, fallback, min = H2H_SCALE_MIN, max = H2H_SCALE_MAX) => {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed * 100) / 100));
};

const side = (input) => {
  const source = input && typeof input === 'object' ? input : {};
  return {
    teamId: text(source.teamId, 64),
    teamName: text(source.teamName, 32),
    shortName: text(source.shortName, 8),
    logo: text(source.logo, 500),
    banner: text(source.banner, 500),
    colour: text(source.colour, 24),
  };
};

import { brandHex } from './brand.js';

export const DEFAULT_HEADTOHEAD = {
  version: 1,
  left: side({}),
  right: side({}),
  // The line between them. A field rather than a hardcoded "VS" because a
  // grand final is not the same words as a group stage.
  divider: 'VS',
  heading: '',
  eventLogo: '',
  /*
   * The house backdrop, used for a team that has none of its own. One image
   * rather than two, so the graphic reads as one design with two halves of it
   * filled in by whoever is playing.
   */
  /*
   * The trim: the VS divider and the two rules either side of it. Blank means
   * the EVENT's accent. `--plate` is deliberately NOT driven from here - it is
   * a fill behind a team's name rather than a rule, and colouring a surface
   * with the trim would make the two halves of the graphic read as one block.
   */
  accent: '',
  styleBackdrop: '',
  // Whether the org colour tints its half. Off by default: a team with no
  // colour of its own would otherwise wear the fallback red, which on a
  // head-to-head reads as a side rather than as a brand.
  tint: false,

  /*
   * ----------------------------------------------------------------- size --
   *
   * This graphic had no style fields at all beyond its colours: the three type
   * sizes were literals in `headtohead.css`, so a show whose org names are
   * long - or whose crests are wordmarks rather than shields - had no answer
   * but to edit a stylesheet.
   *
   * TWO controls, because they are two different problems. `textScale` moves
   * the name plate, the divider and the heading TOGETHER: they were chosen in
   * proportion to each other and three separate numbers would let that drift,
   * which is the argument the winner's `bandGap` already makes. `logoScale` is
   * about the artwork a team supplied, and a wordmark and a shield want
   * opposite corrections at the same type size.
   *
   * 1 is exactly what the sizes have always been, so an upgrade changes
   * nothing on air. The lineup wants the same pair next; it is done here in a
   * way the lineup can copy.
   */
  textScale: 1,
  logoScale: 1,
  anim: { visible: false, cue: 0 },
};

export function sanitiseHeadToHead(input, fallback = DEFAULT_HEADTOHEAD) {
  const source = input && typeof input === 'object' ? input : {};
  const base = fallback ?? DEFAULT_HEADTOHEAD;

  return {
    version: 1,
    left: side(source.left ?? base.left),
    right: side(source.right ?? base.right),
    divider: text(source.divider ?? base.divider, 16),
    heading: text(source.heading ?? base.heading, 40),
    eventLogo: text(source.eventLogo ?? base.eventLogo, 500),
    /*
     * Blank passes through as blank, which is what makes inheriting sayable.
     *
     * An ABSENT key preserves (the `??`); a present-but-unparseable one lands
     * on blank, which is to say "inherit the event's" rather than "keep the
     * junk". That is the same thing the bracket's colours do - see 27c in
     * bracket-graphic-e2e - and it is the only honest answer on a route that
     * REPLACES: there is no previous value to fall back to, because the caller
     * sent the whole state. The dashboard cannot produce junk here anyway; its
     * control is an <input type="color">.
     */
    accent: brandHex(source.accent ?? base.accent, ''),
    styleBackdrop: text(source.styleBackdrop ?? base.styleBackdrop, 500),
    tint: typeof source.tint === 'boolean' ? source.tint : (base.tint ?? false),
    textScale: scale(source.textScale ?? base.textScale, base.textScale ?? 1),
    logoScale: scale(source.logoScale ?? base.logoScale, base.logoScale ?? 1),
    anim: {
      visible: typeof source.anim?.visible === 'boolean' ? source.anim.visible : (base.anim?.visible ?? false),
      cue: whole(source.anim?.cue ?? base.anim?.cue, 0, 1_000_000, 0),
    },
  };
}

/** A team record -> one half of the graphic. */
export function halfFromTeam(team) {
  if (!team) return side({});
  return side({
    teamId: team.id,
    teamName: team.name,
    shortName: team.shortName,
    logo: team.logo,
    banner: team.banner,
    colour: team.colour,
  });
}

/**
 * The image behind one half: the team's own, then the graphic's, then nothing.
 *
 * One function rather than the same `||` written twice in the output page and
 * once in the dashboard preview - which is how the two come to disagree about
 * whether a blank string counts.
 */
export const backdropFor = (half, styleBackdrop) => String(half?.banner || styleBackdrop || '');

/**
 * A fixture -> both halves, for the Load button.
 *
 * Takes the fixture's own copies rather than looking teams up: a fixture
 * already carries a copy of each side, which is the whole point of copy-not-
 * link, and re-resolving them through the library would reintroduce the
 * dereference this design exists to avoid. The cost is that a team renamed
 * since the fixture was made arrives under its old name - which is correct,
 * because that is what the schedule says the match is.
 */
export function headToHeadFromFixture(fixture) {
  if (!fixture) return null;
  return { left: side({ ...fixture.left, teamName: fixture.left?.name }), right: side({ ...fixture.right, teamName: fixture.right?.name }) };
}
