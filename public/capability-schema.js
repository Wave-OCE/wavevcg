/**
 * Per-account permissions.
 *
 * Defined once here and imported by both sides, like every other field in this
 * project: the server sanitises against this list, the admin panel renders from
 * it, and adding a permission is one entry rather than four edits that drift
 * apart. `user.trackerLogin` was that fourth edit for a year, and it is the
 * shape this generalises.
 *
 * ## What belongs here, and what does not
 *
 * A capability answers "may this ACCOUNT do this at all, anywhere on this
 * server". It is not how access to one production is decided - that is a
 * membership level on the workspace (`owner` / `editor` / `viewer`), held on
 * the thing being shared, and `canEdit` is still the single gate every write
 * route passes through.
 *
 * The distinction is easy to lose and expensive to get wrong. "May edit this
 * event's team library" is NOT a capability: it is `editor` on that event, and
 * modelling it as an account flag would mean a person who may edit one
 * tournament's teams may edit every tournament's teams. What IS a capability is
 * "may start a tournament at all" - a fact about the person and the machine,
 * true or false before any particular event exists.
 *
 * The test: if the answer could differ between two productions the same person
 * works on, it is a level, not a capability.
 *
 * ## Permissions default closed
 *
 * The opposite of `settings-schema.js`, and the asymmetry is deliberate. A
 * *feature* switch that is missing reads as its default, because a feature
 * arriving switched off on every server that upgrades is a nasty surprise. A
 * *permission* that is missing reads as false, because a permission arriving
 * switched ON because a field was absent is a worse one.
 *
 * Which is why there is no `default` key in this file and no code that reads
 * one. A capability with a default is one careless `default: true` away from
 * granting itself on every account in `users.json`, and nothing would fail.
 * `sanitiseCapabilities` below is a separate function from `sanitiseSettings`
 * for the same reason: one of them must never learn the other's habit.
 *
 * ## adminImplied
 *
 * Whether `role === 'admin'` satisfies this capability without the flag.
 *
 * It defaults to false and is stated per entry, so the choice is made once by
 * whoever adds a capability rather than inherited by accident. That matters
 * because `auth.js` says three separate times that administering accounts and
 * taking over a live broadcast are different powers, and `accessLevel` never
 * consults `role`. A blanket admin bypass would delete that sentence quietly:
 * the day "operate this event" became a capability, every server administrator
 * would silently acquire the ability to take a live broadcast, with nothing
 * failing and nothing visible to the owner.
 *
 * So: true for things that are about the MACHINE, where somebody must always be
 * able to act. False for anything that touches somebody's production.
 */

export const CAPABILITY_FIELDS = [
  {
    key: 'trackerLogin',
    /*
     * `label` is the verb phrase a confirmation reads, so it is lower case and
     * starts with a verb: "Let alex open a tracker.gg login?". `short` is what
     * fits on a button, in a row that has already overflowed its panel once -
     * see the admin-row note in CLAUDE.md.
     */
    label: 'open a tracker.gg login',
    short: 'Tracker login',
    /*
     * True, and the justification is narrow enough to be worth restating rather
     * than generalising: an admin can set their own flag on the Admin tab in
     * two clicks, so refusing them is theatre - and it guarantees the server can
     * never reach a state where nobody is able to clear a Cloudflare challenge.
     *
     * Neither half of that argument transfers to anything below.
     */
    adminImplied: true,
    help:
      'Opens an interactive keyboard and mouse on a real browser running on this machine, ' +
      'served over noVNC, so a Cloudflare challenge can be solved by hand. The clearance is ' +
      'saved to the shared browser profile and reused by everyone afterwards. Only the person ' +
      'who started a solve, and administrators, are told the password or may cancel it.',
    off: 'The tracker.gg login panel is hidden, and the three routes behind it are refused.',
  },
  {
    key: 'manageTournaments',
    label: 'create and manage tournaments',
    short: 'Tournaments',
    /*
     * False. An administrator who needs a tournament is granted one visibly,
     * like anybody else - see the adminImplied note in the header.
     */
    adminImplied: false,
    help:
      'Creates events, edits their settings, and decides who else may work on them. It does ' +
      'not grant access to any existing event: that is a membership on the event itself, ' +
      'given by its owner. Somebody without this can still operate every event they have ' +
      'been added to.',
    off: 'The Tournament section is hidden, and the routes that create or change an event are refused.',
  },
];

export const CAPABILITY_KEYS = CAPABILITY_FIELDS.map((field) => field.key);

const FIELD_BY_KEY = new Map(CAPABILITY_FIELDS.map((field) => [field.key, field]));

/** Every capability off. Not exported as a mutable object - callers get a copy. */
export const noCapabilities = () => Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false]));

/**
 * Read a stored capability set.
 *
 * Deliberately NOT `sanitiseSettings`. That one falls back to a default when a
 * value is absent, which is right for a feature and wrong for a permission -
 * see the header. Here, absent is false and anything that is not exactly `true`
 * is false, so a half-written record, a hand edit, or a string `"true"` from a
 * form all fail closed.
 *
 * `fallback` is what an absent key means when a caller is applying a PATCH
 * rather than reading from disk - the admin panel sends only what it changed.
 * It still cannot turn anything on by omission; it only preserves.
 */
export function sanitiseCapabilities(source, fallback = null) {
  const from = source && typeof source === 'object' ? source : {};
  const base = fallback && typeof fallback === 'object' ? fallback : {};
  return Object.fromEntries(
    CAPABILITY_KEYS.map((key) => [
      key,
      key in from ? from[key] === true : base[key] === true,
    ]),
  );
}

/**
 * Does this account hold this capability?
 *
 * The one place the question is answered, so that no route re-derives it - the
 * mistake `publicUser` already guards against by sending the computed answer
 * beside the stored flag rather than letting three pages work it out.
 *
 * An unknown key is false. A capability that has been removed from the schema,
 * or misspelled at a call site, must not read as held: the failure of a typo
 * should be a locked door, not an open one.
 */
export function can(user, key) {
  if (!user) return false;
  const field = FIELD_BY_KEY.get(key);
  if (!field) return false;
  if (field.adminImplied && user.role === 'admin') return true;
  return user.capabilities?.[key] === true;
}

/** Every capability, resolved for this account. For `publicUser`. */
export const capabilitiesFor = (user) =>
  Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, can(user, key)]));
