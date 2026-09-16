/**
 * Accounts, passwords and login sessions.
 *
 * Node built-ins only, like the rest of this project - `scrypt` is in the
 * standard library and is a password hash rather than a general-purpose digest,
 * which is the whole requirement. Nothing here needs a package.
 *
 * Two stores, deliberately separate files:
 *
 *   users.json     accounts. Changes rarely, and losing it loses everybody.
 *   sessions.json  who is currently logged in. Disposable, but persisted anyway
 *                  so restarting the server mid-broadcast does not sign every
 *                  operator out at the worst possible moment.
 *
 * Three distinct secrets, and it is worth keeping them apart in your head:
 *
 *   password      what a person types. Only ever stored as a scrypt hash.
 *   login token   the cookie. Identifies a browser as a logged-in person.
 *   session key   the UUID in an OBS URL and a webhook URL. Identifies a
 *                 GRAPHICS session, not a person, and is deliberately weaker:
 *                 it is pasted into OBS and into a game client, so it is going
 *                 to end up in config files and screen shares. It grants no
 *                 access to the dashboard, only to the output pages and the
 *                 webhooks for one session.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import { can, capabilitiesFor, sanitiseCapabilities } from './public/capability-schema.js';

export { CAPABILITY_FIELDS, CAPABILITY_KEYS, can } from './public/capability-schema.js';

const scrypt = promisify(scryptCb);

/*
 * Deliberately above the Node default (N=16384). This is a small deployment
 * where logins are rare and human-paced, so ~100ms of CPU per attempt is free
 * to us and expensive to somebody working through a word list.
 */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };
const SALT_BYTES = 16;

export const ROLES = ['admin', 'user'];
export const GRANTS = ['editor', 'viewer'];

/** How long a login lasts without being used. Long enough to survive an event. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const now = () => Date.now();

// ------------------------------------------------------------- passwords ---

export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const derived = await scrypt(String(password), salt, SCRYPT.keylen, SCRYPT);
  return { salt, hash: derived.toString('hex') };
}

/**
 * What an account with no password is compared against.
 *
 * At module scope because there are two callers now and an inline copy in each
 * would drift. The hash is the right length by construction, so a comparison
 * against it reaches `timingSafeEqual` rather than bailing out early on length.
 */
const DECOY = { salt: 'decoy', hash: '00'.repeat(SCRYPT.keylen) };

/**
 * Compared in constant time, and never short-circuited on length.
 *
 * A plain `===` on hex strings leaks how much of the hash matched through how
 * long the comparison took. It is a small leak and this is a small deployment,
 * but the fix is one function call.
 *
 * An account can now have no password at all - one that signs in through
 * Discord - and that must not be visible from outside. `if (!salt || !hash)
 * return false` answered in microseconds where a real account takes ~100ms of
 * scrypt, so a stopwatch told you which accounts have a password door and which
 * do not. Absent credentials now cost a full scrypt against the decoy and the
 * answer is forced false afterwards.
 */
export async function verifyPassword(password, { salt, hash }) {
  const usable = Boolean(salt && hash);
  const target = usable ? { salt, hash } : DECOY;

  const derived = await scrypt(String(password), target.salt, SCRYPT.keylen, SCRYPT);
  const stored = Buffer.from(String(target.hash), 'hex');
  if (stored.length !== derived.length) return false;

  // Evaluated before the return rather than short-circuited into it, so the
  // work is the same either way.
  const match = timingSafeEqual(stored, derived);
  return usable && match;
}

/**
 * The rules a password has to clear.
 *
 * Length only. Composition rules ("one capital, one symbol") push people toward
 * `Password1!` and are not what makes a password hard to guess; a floor of
 * twelve characters is.
 */
export const PASSWORD_MIN = 12;

export function passwordProblem(password) {
  const value = String(password ?? '');
  if (value.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (value.length > 200) return 'Password must be shorter than 200 characters.';
  return null;
}

const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/i;

/**
 * A Discord id, which is a snowflake: decimal digits, currently 17-19 of them,
 * bounded here at 15-20 to leave room in both directions.
 *
 * Matched rather than cleaned, and never run through `text()`. `text` slices to
 * a maximum length before it trims, so a 40-digit value would come back as a
 * 32-digit one that still looks like a perfectly good id - a silent truncation
 * that could collide with somebody real. A value either is a snowflake or it is
 * not linked at all.
 */
const SNOWFLAKE = /^[0-9]{15,20}$/;

export const isSnowflake = (value) => SNOWFLAKE.test(String(value ?? ''));

export function usernameProblem(username) {
  const value = String(username ?? '').trim();
  if (!USERNAME.test(value)) {
    return 'Username must be 2-32 characters: letters, numbers, dot, dash or underscore.';
  }
  return null;
}

// ----------------------------------------------------------------- users ---

const text = (value, fallback = '', max = 200) =>
  value === null || value === undefined
    ? fallback
    : String(value).slice(0, max).replace(/[\u0000-\u001f]/g, '').trim();

/**
 * One account.
 *
 * `grants` maps another user's id to what they may do with THIS user's graphics
 * session. Held on the owner rather than on the grantee so that revoking is one
 * write to one record, and so deleting an account cannot leave permissions to
 * a session that no longer exists.
 */
function cleanUser(input) {
  const source = input ?? {};
  const grants = {};
  for (const [id, level] of Object.entries(source.grants ?? {})) {
    if (GRANTS.includes(level)) grants[text(id, '', 64)] = level;
  }

  /*
   * The legacy read, and it gets exactly one chance to run.
   *
   * This function is an allowlist - see the note further down - so anything it
   * does not name is dropped on the next load and erased on the next write.
   * Every record written before capabilities existed carries `trackerLogin` at
   * the top level and no `capabilities` at all, and the FIRST login after this
   * deploys is the moment that record gets rewritten.
   *
   * So if this fallback were missing, or landed a commit later than the field
   * it feeds, every account's tracker permission would be cleared silently: no
   * error, nothing in the log, and afterwards no way to tell which accounts had
   * held it. Reading the old field beside the new one costs nothing, and it is
   * not a thing that can be got wrong twice.
   *
   * An explicit `capabilities.trackerLogin: false` still wins over a stale
   * top-level `true`, because the new field is the one somebody edited.
   */
  const capabilities = sanitiseCapabilities(source.capabilities, {
    trackerLogin: source.trackerLogin === true,
  });

  return {
    id: text(source.id, '', 64),
    username: text(source.username, '', 32),
    salt: text(source.salt, '', 64),
    hash: text(source.hash, '', 256),
    role: ROLES.includes(source.role) ? source.role : 'user',
    // The UUID that appears in OBS and webhook URLs for this user's session.
    sessionKey: text(source.sessionKey, '', 64) || randomUUID(),

    /*
     * The Companion control channel's key, and deliberately NOT the session key.
     *
     * The session key is the weak one on purpose - it is typed into OBS
     * configuration, it sits in a browser source URL, and it gets read out over
     * screen shares. What it opens is bounded by KEYED_ROUTES, and the comment
     * on that list says what the bound is for: "A key shows a graphic and feeds
     * it a lobby; it does not operate the desk."
     *
     * A control channel operates the desk. Show, hide, next, swap, reset - it
     * is the desk. So reusing the session key would not have been adding a
     * route to a list, it would have been deleting the sentence, and every OBS
     * URL already in a config file somewhere would have quietly become a remote
     * control for a live broadcast.
     *
     * Hence a second key with the same strength and a different blast radius.
     * It never appears in a URL a browser loads, never in a browser source,
     * and rotates on its own - so leaking one does not leak the other, and
     * fixing one does not take the graphics off air.
     *
     * Blank until somebody asks for one, which is the opposite of sessionKey
     * directly above. Deliberate, and the same rule the trackerLogin flag
     * below follows: a *feature* that arrives switched off on upgrade is a
     * nasty surprise, a *permission* that arrives switched on because a field
     * was absent is a worse one. Every account minting a live remote control
     * for its own broadcast on first load - one nobody asked for, nobody knows
     * exists, and which sits in users.json being valid forever - is the second
     * kind. So the socket refuses every account until one is minted, and the
     * feature is genuinely inert on a server where nobody uses Companion.
     */
    controlKey: text(source.controlKey, '', 64),
    disabled: source.disabled === true,
    /*
     * Per-account permissions. Defined in public/capability-schema.js, which
     * carries the reasoning: permissions default closed, the opposite of the
     * server switches in settings-schema.js, and `adminImplied` is stated per
     * capability rather than inherited.
     *
     * This used to be a single `trackerLogin` boolean right here. It stayed one
     * field for a year and adding a second would have meant a fifth edit in a
     * fifth file, so the shape moved into a schema the way every other field in
     * this project already had.
     */
    capabilities,

    /*
     * The old name for capabilities.trackerLogin, mirrored rather than dropped.
     *
     * Kept for one season, and it buys two things. A build that predates the
     * schema still reads this tree correctly, so the change is reversible by
     * deploying backwards rather than by restoring a backup. And any call site
     * the migration missed keeps working instead of reading undefined and
     * quietly denying somebody a permission they hold.
     *
     * It is a MIRROR, never a second source of truth: it is written from
     * `capabilities` and never read back into it except by the legacy read
     * above. Retire it once nothing reads it - which is a grep, not a guess.
     */
    trackerLogin: capabilities.trackerLogin === true,

    /*
     * The Discord identity, when there is one.
     *
     * `discordId` is the join key and the only stable one: Discord usernames
     * can be changed and a released handle can be claimed by somebody else, so
     * matching on a name would be an account-takeover primitive. `discordTag`
     * exists to be shown to a person and is never matched on.
     *
     * Note this whole object is an allowlist - anything not named here is
     * dropped on the next load and erased on the next write - so a field added
     * to users.json by hand does not survive, and a field added to the Discord
     * flow must be added here or it will vanish the first time anybody logs in.
     */
    discordId: isSnowflake(source.discordId) ? String(source.discordId) : '',
    discordTag: text(source.discordTag, '', 64),
    discordLinkedAt: Number.isFinite(source.discordLinkedAt) ? source.discordLinkedAt : 0,

    /*
     * Did the Discord admin role make this account an administrator?
     *
     * Permission-default-off, and it exists so that losing the role can only
     * ever demote somebody the role promoted. One mistyped character in
     * DISCORD_ROLE_ADMIN matches nobody, and without this flag that typo would
     * demote every administrator in turn as they signed in - the server
     * converging on a single admin chosen by arrival order.
     */
    discordRole: source.discordRole === true,

    createdAt: Number.isFinite(source.createdAt) ? source.createdAt : now(),
    lastLoginAt: Number.isFinite(source.lastLoginAt) ? source.lastLoginAt : 0,
    grants,
  };
}

/**
 * Can this account be signed into at all?
 *
 * A password, a Discord link, or both. An account with neither is a record
 * nobody can use - which matters because an administrator like that would
 * otherwise satisfy the last-admin lock while being no administrator at all.
 */
export const hasCredential = (user) => Boolean((user?.salt && user?.hash) || user?.discordId);

/**
 * May this account open a tracker.gg login session?
 *
 * Now one capability among several rather than a rule of its own, but kept as a
 * named function because four enforcement sites call it and a name says what it
 * guards where `can(user, 'trackerLogin')` would only say how. The admin bypass
 * moved with it: it is `adminImplied: true` in the schema, stated there with the
 * argument for why it applies to this one and not to the others.
 */
export const canOpenTrackerLogin = (user) => can(user, 'trackerLogin');

/** What may be sent to a browser. Never the hash, never the salt. */
export const publicUser = (user, { includeKey = false, includeControlKey = false } = {}) => ({
  id: user.id,
  username: user.username,
  role: user.role,
  disabled: user.disabled,
  createdAt: user.createdAt,
  lastLoginAt: user.lastLoginAt,
  grants: { ...user.grants },

  /*
   * The stored flags and what they work out to. The admin panel edits the
   * first; every other page wants the second, and computing it in three places
   * is how two of them end up disagreeing.
   *
   * `may` is the resolved answer, so it already has adminImplied folded in - a
   * page asking "do I get the Tournament section" reads `may.manageTournaments`
   * and never has to know that a role can stand in for a flag.
   */
  capabilities: { ...user.capabilities },
  may: capabilitiesFor(user),

  // The single-permission spelling of the two above, kept for one season
  // alongside the mirror in cleanUser. Same retirement: a grep, not a guess.
  trackerLogin: user.trackerLogin === true,
  mayOpenTrackerLogin: canOpenTrackerLogin(user),

  /*
   * Which doors this account has. The dashboard needs it to know whether to
   * offer "turn off my password", and the admin list needs it to show that an
   * account signs in through Discord.
   */
  hasPassword: Boolean(user.salt && user.hash),

  /*
   * The snowflake rides with the session key rather than with the handle.
   *
   * The handle and the date are display, and the admin list wants them. The id
   * is not a credential - it is public on Discord - but it is the value that
   * decides which account a sign-in resolves to, and the one screen where a
   * lookalike handle would be spotted is the admin list, so it goes there too.
   */
  discord: user.discordId
    ? { tag: user.discordTag, linkedAt: user.discordLinkedAt, fromRole: user.discordRole === true, id: user.discordId }
    : null,

  ...(includeKey ? { sessionKey: user.sessionKey } : {}),

  /*
   * Whether a control key exists, always - the value itself, only when asked.
   *
   * Its own option rather than riding on `includeKey`, because the two travel
   * to different places. `includeKey` is what puts the session key into the
   * session list, so that somebody granted editor access can configure OBS
   * against a colleague's production. A control key must not follow it there:
   * a grant can be revoked in one write, and a token that had already been
   * copied into a stream deck would outlive the revoke.
   *
   * The boolean is safe everywhere and is what the Account panel renders from.
   */
  hasControlKey: Boolean(user.controlKey),
  ...(includeControlKey ? { controlKey: user.controlKey } : {}),
});

export function makeUserStore(filePath) {
  /** @type {ReturnType<typeof cleanUser>[]} */
  let users = [];
  let writeChain = Promise.resolve();

  function persist() {
    const snapshot = JSON.stringify(users, null, 2);
    writeChain = writeChain
      .then(() => mkdir(path.dirname(filePath), { recursive: true }))
      .then(() => writeFile(filePath, snapshot, 'utf8'))
      .catch((error) => console.warn(`  users not saved: ${error.message}`));
    return writeChain;
  }

  const byName = (username) => {
    const wanted = String(username ?? '').trim().toLowerCase();
    return users.find((user) => user.username.toLowerCase() === wanted) ?? null;
  };

  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (!Array.isArray(parsed)) return false;
        users = parsed.map(cleanUser).filter((user) => user.id && user.username);
        return true;
      } catch {
        return false;
      }
    },

    get count() {
      return users.length;
    },

    list: () => users.map((user) => ({ ...user })),
    byId: (id) => users.find((user) => user.id === String(id)) ?? null,
    byName,
    bySessionKey: (key) => users.find((user) => user.sessionKey === String(key)) ?? null,
    /*
     * The empty-string guard is the whole point of this being its own function.
     *
     * Most accounts have no control key, so `controlKey` is `''` on most
     * records - and `find(user => user.controlKey === '')` matches the first
     * of them. Without this line, a request with `?key=` and nothing after it
     * would authenticate as somebody, and which somebody would depend on the
     * order of users.json.
     */
    byControlKey: (key) => (String(key ?? '') ? (users.find((user) => user.controlKey === String(key)) ?? null) : null),

    /**
     * The Companion control channel's key, and why it was refused.
     *
     * Two separate namespaces of UUID now sit next to each other on the Account
     * panel, and the failure they produce is identical from the far end: a
     * socket that will not open. So this is the one lookup that reports which
     * mistake was made, because "you used the other key" is unguessable from
     * outside and obvious from in here.
     *
     * The hint never contains the value it was given. It says which *kind* of
     * key arrived, which is a fact about the caller's configuration and not a
     * secret, and it goes into a log buffer that is rendered in a browser.
     *
     * @returns {{owner: object|null, hint?: string}}
     */
    resolveControlKey(key) {
      const wanted = String(key ?? '');
      if (!wanted) return { owner: null, hint: 'No control key was sent.' };

      // Never matches a blank field on an account that has not minted one.
      const owner = users.find((user) => user.controlKey && user.controlKey === wanted);
      if (owner) return { owner };

      // The near miss, named. Both are UUIDs on the same panel.
      if (users.some((user) => user.sessionKey === wanted)) {
        return {
          owner: null,
          hint:
            'That is the OBS session key, not the control key. They are different on purpose - ' +
            'copy the one from the Companion panel on the Account tab.',
        };
      }
      return { owner: null, hint: 'That control key matches no account. It may have been rotated.' };
    },

    /**
     * The account a Discord identity signs into.
     *
     * Deliberately not `find`, which is the shape every other lookup here uses.
     * `find` resolves a duplicate silently to whichever record happens to be
     * first in the array, and this is the one lookup where a duplicate would
     * mean two people's accounts answering to one identity. If users.json ever
     * holds two, the honest answer is to refuse the sign-in and say so, rather
     * than to pick one and be right half the time.
     *
     * The empty string is not an identity: an unlinked account has
     * `discordId: ''`, and a lookup for '' must not match all of them.
     */
    byDiscordId(id) {
      const wanted = String(id ?? '');
      if (!isSnowflake(wanted)) return null;

      const found = users.filter((user) => user.discordId === wanted);
      if (found.length > 1) {
        console.warn(`  two accounts claim the same Discord id - refusing to guess between them`);
        return null;
      }
      return found[0] ?? null;
    },

    async create({ username, password, role = 'user' }) {
      const nameProblem = usernameProblem(username);
      if (nameProblem) throw new Error(nameProblem);
      const passProblem = passwordProblem(password);
      if (passProblem) throw new Error(passProblem);
      if (byName(username)) throw new Error('That username is taken.');

      const { salt, hash } = await hashPassword(password);
      const user = cleanUser({
        id: randomUUID(),
        username: String(username).trim(),
        salt,
        hash,
        role: ROLES.includes(role) ? role : 'user',
        sessionKey: randomUUID(),
        createdAt: now(),
      });
      users.push(user);
      await persist();
      return { ...user };
    },

    /**
     * An account for somebody who has just proved a Discord identity.
     *
     * A sibling of `create` rather than a flag on it, deliberately. `create`'s
     * twelve-character password floor is what protects the password door, and a
     * `skipPassword: true` parameter is a thing a later caller passes by
     * accident. Two functions cannot be confused for one another.
     *
     * ALWAYS lands `role: 'user'`, with no parameter to say otherwise. The
     * Discord admin role promotes an account that already exists, on a
     * subsequent sign-in - it never creates one. Otherwise deleting an
     * administrator would not remove them: they would click the button and be
     * re-created as an administrator, and the delete would read as though it
     * had worked.
     *
     * There is NO await between the uniqueness checks and the push. `create`
     * has one - it hashes a password in between - so two concurrent creates for
     * the same name both pass the check. That needs two admins typing at once
     * today; with just-in-time provisioning it is reachable by a double-click
     * or a link scanner, and the result would be two accounts and two state
     * directories for one person.
     */
    async createFromDiscord({ username, discordId, discordTag = '' }) {
      const nameProblem = usernameProblem(username);
      if (nameProblem) throw new Error(nameProblem);
      if (!isSnowflake(discordId)) throw new Error('That is not a Discord account id.');

      // Everything from here to the push is synchronous, and must stay so.
      if (byName(username)) throw new Error('That username is taken.');
      if (users.some((user) => user.discordId === String(discordId))) {
        throw new Error('That Discord account is already linked to an account here.');
      }

      const user = cleanUser({
        id: randomUUID(),
        username: String(username).trim(),
        salt: '',
        hash: '',
        role: 'user',
        sessionKey: randomUUID(),
        discordId: String(discordId),
        discordTag,
        discordLinkedAt: now(),
        createdAt: now(),
      });
      users.push(user);

      await persist();
      return { ...user };
    },

    /**
     * Stamp a sign-in that did not go through `verify`.
     *
     * The second writer of `lastLoginAt` - `verify` is the first. The Discord
     * path never calls `verify`, because there is no password to check, so
     * without this an account that only ever signs in through Discord would
     * show "never" in the admin list for ever.
     */
    async noteSignIn(id) {
      const user = users.find((entry) => entry.id === String(id));
      if (!user) throw new Error('No such user.');
      user.lastLoginAt = now();
      await persist();
      return { ...user };
    },

    /**
     * Returns the user on success and null on every kind of failure.
     *
     * One answer for "no such account", "wrong password" and "disabled", because
     * three different answers tell somebody guessing which usernames are real.
     * The scrypt work is done even when the username is unknown, so the reply
     * does not come back measurably faster for one that is not.
     */
    async verify(username, password) {
      const user = byName(username);
      const target = user ?? DECOY;
      const ok = await verifyPassword(password, target);
      if (!user || !ok || user.disabled) return null;
      user.lastLoginAt = now();
      persist();
      return { ...user };
    },

    async update(id, changes) {
      const user = users.find((entry) => entry.id === String(id));
      if (!user) throw new Error('No such user.');

      if (changes.username !== undefined) {
        const problem = usernameProblem(changes.username);
        if (problem) throw new Error(problem);
        const clash = byName(changes.username);
        if (clash && clash.id !== user.id) throw new Error('That username is taken.');
        user.username = String(changes.username).trim();
      }
      if (changes.password !== undefined) {
        const problem = passwordProblem(changes.password);
        if (problem) throw new Error(problem);
        const { salt, hash } = await hashPassword(changes.password);
        user.salt = salt;
        user.hash = hash;
      }
      if (changes.role !== undefined && ROLES.includes(changes.role)) user.role = changes.role;
      if (changes.disabled !== undefined) user.disabled = changes.disabled === true;
      /*
       * Capabilities, as a patch rather than a replacement.
       *
       * The admin panel sends only what it toggled, so an absent key must mean
       * "leave it alone" and never "turn it off" - otherwise editing one
       * permission silently clears every other one the account holds.
       * sanitiseCapabilities takes the current set as its fallback for exactly
       * that, and it still cannot turn anything on by omission.
       *
       * The `trackerLogin` branch below is the old single-permission spelling.
       * Both write through `capabilities`, so there is one source of truth
       * whichever shape the caller sends - a second branch assigning the mirror
       * directly is how the two would drift.
       */
      if (changes.capabilities !== undefined) {
        user.capabilities = sanitiseCapabilities(changes.capabilities, user.capabilities);
      }
      if (changes.trackerLogin !== undefined) {
        user.capabilities = sanitiseCapabilities(
          { trackerLogin: changes.trackerLogin === true },
          user.capabilities,
        );
      }
      user.trackerLogin = user.capabilities.trackerLogin === true;

      /*
       * The Discord link, as one atomic change.
       *
       * `{ id, tag }` links, `null` unlinks, and the three stored fields move
       * together or not at all. Three separate branches would let a caller
       * write an id with no date, or clear the handle while leaving the link -
       * states the sign-in flow can never produce and nothing else knows how to
       * read.
       */
      if (changes.discord !== undefined) {
        if (changes.discord === null) {
          user.discordId = '';
          user.discordTag = '';
          user.discordLinkedAt = 0;
          // A link that no longer exists cannot be why somebody is an admin.
          user.discordRole = false;
        } else {
          const wanted = String(changes.discord.id ?? '');
          if (!isSnowflake(wanted)) throw new Error('That is not a Discord account id.');

          // Checked the same way a username clash is, and for the same reason:
          // two accounts answering to one identity is the one state byDiscordId
          // cannot resolve.
          const clash = users.find((entry) => entry.discordId === wanted && entry.id !== user.id);
          if (clash) throw new Error('That Discord account is already linked to an account here.');

          user.discordId = wanted;
          user.discordTag = text(changes.discord.tag, '', 64);
          user.discordLinkedAt = now();
        }
      }

      /*
       * Take the password door off an account, leaving Discord as the only way
       * in. Applied after the link above, so linking and clearing in one call
       * works and the check below sees the new link rather than the old one.
       */
      if (changes.clearPassword === true) {
        if (changes.password !== undefined) throw new Error('Set a password or clear it, not both.');
        if (!user.discordId) throw new Error('That account would have no way to sign in at all.');
        user.salt = '';
        user.hash = '';
      }

      /*
       * Refresh the displayed handle, without touching the link.
       *
       * Separate from the atomic branch above on purpose: that one stamps
       * `discordLinkedAt`, and a sign-in is not a linking. Reusing it to keep
       * the handle current would move the "linked on" date every time somebody
       * signed in. Ignored for an unlinked account, so it cannot fabricate half
       * a link.
       */
      if (changes.discordTag !== undefined && user.discordId) {
        user.discordTag = text(changes.discordTag, '', 64);
      }

      if (changes.discordRole !== undefined) user.discordRole = changes.discordRole === true;

      await persist();
      return { ...user };
    },

    /** A leaked OBS link is fixed here: every old URL stops working at once. */
    async rotateSessionKey(id) {
      const user = users.find((entry) => entry.id === String(id));
      if (!user) throw new Error('No such user.');
      user.sessionKey = randomUUID();
      await persist();
      return user.sessionKey;
    },

    /**
     * The control key, rotated on its own.
     *
     * Separate from rotateSessionKey and not folded into it, which is the point
     * of having two keys at all: rotating this one drops the stream deck and
     * leaves every browser source untouched, and rotating that one re-points
     * OBS and leaves the stream deck running. A single "rotate my keys" would
     * take the graphics off air to fix a control channel.
     */
    async rotateControlKey(id) {
      const user = users.find((entry) => entry.id === String(id));
      if (!user) throw new Error('No such user.');
      user.controlKey = randomUUID();
      await persist();
      return user.controlKey;
    },

    /**
     * Take the control key away entirely.
     *
     * Not the same as rotating it, and worth its own verb: rotating issues a
     * new credential, and an operator who has stopped using Companion wants
     * there to be no credential. Blank is the state a fresh account is in, so
     * this genuinely returns the door to shut rather than fitting a new lock.
     */
    async clearControlKey(id) {
      const user = users.find((entry) => entry.id === String(id));
      if (!user) throw new Error('No such user.');
      user.controlKey = '';
      await persist();
      return true;
    },

    async setGrant(ownerId, granteeId, level) {
      const owner = users.find((entry) => entry.id === String(ownerId));
      if (!owner) throw new Error('No such user.');
      if (String(ownerId) === String(granteeId)) throw new Error('You already have your own graphics.');
      if (level && !GRANTS.includes(level)) throw new Error('Unknown permission.');
      if (!users.some((entry) => entry.id === String(granteeId))) throw new Error('No such user.');

      if (level) owner.grants[String(granteeId)] = level;
      else delete owner.grants[String(granteeId)];

      await persist();
      return { ...owner };
    },

    async remove(id) {
      const before = users.length;
      users = users.filter((entry) => entry.id !== String(id));
      // Nobody keeps a grant to a session that no longer exists.
      for (const user of users) delete user.grants[String(id)];
      if (users.length !== before) await persist();
      return users.length !== before;
    },
  };
}

// -------------------------------------------------------------- sessions ---

/**
 * What a browser may do with a given graphics session.
 *
 * Admins are deliberately NOT given editor rights over everybody's graphics.
 * Being able to administer accounts is not the same as being able to take over
 * a live broadcast, and an admin who wants to operate somebody's graphics can
 * be granted it like anyone else. What admins can do is see that the session
 * exists, in the admin panel.
 *
 * @returns {'owner'|'editor'|'viewer'|null}
 */
export function accessLevel(user, owner) {
  if (!user || !owner) return null;
  if (user.id === owner.id) return 'owner';
  return owner.grants?.[user.id] ?? null;
}

export const canEdit = (level) => level === 'owner' || level === 'editor';
export const canView = (level) => level === 'owner' || level === 'editor' || level === 'viewer';

/**
 * How many administrators are left, and how many of them can still get in.
 *
 * Lives here rather than inline in the admin route because it is about to have
 * a second caller. It was an expression inside one closure, consulted by two
 * cases of one switch - which reads as a rule but is not one: any new write
 * that changes a role or a credential simply would not see it, and would walk
 * past the lock without anything to notice.
 *
 * `enabled` is the existing rule. There is no route that makes an administrator
 * except the admin route itself, so a server with none is a server that has to
 * be repaired from a shell.
 *
 * `withPassword` is the second count, and it exists because an account can now
 * have no password at all. An administrator whose only credential is an
 * external one is an administrator who is locked out the moment that external
 * thing is misconfigured - a rotated secret, a deleted app, a role removed by
 * somebody tidying up. The password door is what makes "the server stays usable
 * with Discord switched off" true rather than merely intended.
 */
export const adminCounts = (list) => {
  const live = list.filter((user) => user.role === 'admin' && !user.disabled);
  return {
    /*
     * Only administrators who can actually get in. An account with no password
     * and no Discord link is an administrator on paper and nothing in practice,
     * and counting it would hold the locked door open on a server that has no
     * working administrator at all.
     */
    enabled: live.filter(hasCredential).length,
    withPassword: live.filter((user) => user.salt && user.hash).length,
  };
};

export function makeSessionStore(filePath) {
  /** @type {Map<string, {userId: string, createdAt: number, lastSeen: number}>} */
  let sessions = new Map();
  let writeChain = Promise.resolve();
  let dirty = false;

  function persist() {
    const snapshot = JSON.stringify([...sessions.entries()], null, 2);
    writeChain = writeChain
      .then(() => mkdir(path.dirname(filePath), { recursive: true }))
      .then(() => writeFile(filePath, snapshot, 'utf8'))
      .catch((error) => console.warn(`  sessions not saved: ${error.message}`));
    return writeChain;
  }

  function sweep() {
    const cutoff = now() - SESSION_TTL_MS;
    let removed = 0;
    for (const [token, entry] of sessions) {
      if (entry.lastSeen < cutoff) {
        sessions.delete(token);
        removed += 1;
      }
    }
    if (removed) persist();
    return removed;
  }

  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (!Array.isArray(parsed)) return false;
        sessions = new Map(parsed.filter((entry) => Array.isArray(entry) && entry.length === 2));
        sweep();
        return true;
      } catch {
        return false;
      }
    },

    get count() {
      return sessions.size;
    },

    create(userId) {
      // 256 bits. This is the only thing standing between a stranger and the
      // dashboard, so it is not a place to be clever about length.
      const token = randomBytes(32).toString('hex');
      sessions.set(token, { userId: String(userId), createdAt: now(), lastSeen: now() });
      persist();
      return token;
    },

    /**
     * The userId behind a token, or null.
     *
     * `lastSeen` is written in memory on every hit but only flushed to disk
     * occasionally: this runs on every request including the SSE reconnects, and
     * a disk write per request would be absurd for a field whose only job is to
     * expire a token in thirty days.
     */
    userIdFor(token) {
      const entry = sessions.get(String(token ?? ''));
      if (!entry) return null;
      if (entry.lastSeen < now() - SESSION_TTL_MS) {
        sessions.delete(String(token));
        persist();
        return null;
      }
      entry.lastSeen = now();
      dirty = true;
      return entry.userId;
    },

    destroy(token) {
      if (sessions.delete(String(token ?? ''))) persist();
    },

    /** Every login for one account, for "sign out everywhere" and for deletion. */
    destroyFor(userId) {
      let removed = 0;
      for (const [token, entry] of sessions) {
        if (entry.userId === String(userId)) {
          sessions.delete(token);
          removed += 1;
        }
      }
      if (removed) persist();
      return removed;
    },

    flush() {
      if (!dirty) return;
      dirty = false;
      persist();
    },

    sweep,
  };
}
