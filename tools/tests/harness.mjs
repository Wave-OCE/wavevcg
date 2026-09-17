/**
 * The bit of setup every suite needs now, written once.
 *
 * Before the cutover a suite logged in and the login response handed back a
 * session key, because a production was an account and every account had one.
 * A person has no key any more: a key names a tournament, so a suite has to
 * make one before it has anything to point OBS at.
 *
 * That is not a wrapper around a changed field - it is the new first-run
 * experience, and a suite that skips it is testing a state no operator is ever
 * in. Hence a shared helper rather than the same six lines in eighteen files:
 * when this setup changes again, it changes once.
 */

const json = (cookie, body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
});

/** Sign in and keep the cookie. Returns { cookie, user }. */
export async function signIn(base, username, password) {
  const response = await fetch(`${base}/api/auth/login`, json('', { username, password }));
  const cookie = (response.headers.getSetCookie?.() ?? []).map((line) => line.split(';')[0]).join('; ');
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`sign-in failed for ${username}: ${payload?.error?.message ?? response.status}`);
  return { cookie, user: payload.user };
}

/**
 * Make a tournament and return what a suite needs to drive it.
 *
 * The caller must hold `manageTournaments`. The administrator created from
 * ADMIN_USERNAME has it from the bootstrap; anybody else has to be granted it -
 * see grantCapability below, which is what a suite wanting a SECOND production
 * needs.
 */
export async function makeTournament(base, cookie, name = 'Test tournament') {
  const response = await fetch(`${base}/api/tournaments`, json(cookie, { action: 'create', name }));
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new Error(`could not create "${name}": ${payload?.error?.message ?? response.status}`);
  }
  const tournament = payload.tournament;
  /*
   * The key belongs to a PRODUCTION now, not to the tournament. Every suite
   * asks the harness rather than the record for exactly this reason - one
   * place to follow the model when it moves.
   */
  const desk = tournament.productions[0];
  return { id: tournament.id, key: desk.sessionKey, production: desk.id, desk, tournament };
}

/** Grant a capability. Needs an administrator's cookie. */
export async function grantCapability(base, adminCookie, userId, capability) {
  const response = await fetch(
    `${base}/api/admin/users`,
    json(adminCookie, { action: 'update', id: userId, capabilities: { [capability]: true } }),
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(`could not grant ${capability}: ${payload?.error?.message ?? response.status}`);
  }
}

/** Put somebody on a tournament at a level. Needs an owner's cookie. */
export async function addMember(base, ownerCookie, tournamentId, userId, level) {
  const response = await fetch(
    `${base}/api/tournaments`,
    json(ownerCookie, { action: 'member', id: tournamentId, userId, level }),
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new Error(`could not add member: ${payload?.error?.message ?? response.status}`);
  }
  return payload.tournament;
}

/** Make an account. Needs an administrator's cookie. Returns the public user. */
export async function makeAccount(base, adminCookie, username, password) {
  const response = await fetch(
    `${base}/api/admin/users`,
    json(adminCookie, { action: 'create', username, password }),
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new Error(`could not create ${username}: ${payload?.error?.message ?? response.status}`);
  }
  return payload.created ?? payload.users?.find((u) => u.username === username);
}

/**
 * The whole of the usual opening move: sign in as the admin, make a tournament.
 *
 * Most suites want exactly this and nothing more, so it is one call rather than
 * three - and a suite that needs something different builds it from the pieces
 * above rather than from a flag on this.
 */
export async function openAsAdmin(base, username, password, name = 'Test tournament') {
  const { cookie, user } = await signIn(base, username, password);
  const { id, key, tournament } = await makeTournament(base, cookie, name);
  return { cookie, user, tournamentId: id, key, tournament };
}
