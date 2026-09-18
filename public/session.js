/**
 * Which production this page is looking at.
 *
 * The server now keeps a separate set of graphics per account, so every request
 * has to say which one it means. There are exactly two ways to say it, and they
 * are for two different kinds of client:
 *
 *   ?session=<id>   a dashboard, signed in, looking at somebody else's
 *                   production because they shared it. Rides on the login
 *                   cookie - the id says which, the cookie says who.
 *   ?key=<key>      an OBS browser source or a game-client webhook. There is no
 *                   person and no cookie; the key is the whole credential. It
 *                   opens the output pages and the webhooks and nothing
 *                   else, because it ends up written into OBS configuration and
 *                   read out over screen shares.
 *
 * Both live in the page's own URL rather than in storage, so a browser source
 * points at one production for ever, a shared dashboard survives a reload, and
 * the three preview iframes inherit the target from the page that framed them.
 */

const params = new URLSearchParams(location.search);

/** The OBS/webhook key this page was opened with, if any. */
export const SESSION_KEY = params.get('key') ?? '';

/** The session id this page was told to look at, if any. */
export const SESSION_ID = params.get('session') ?? '';

/**
 * Which DESK of that tournament, if the page was told.
 *
 * A production id is a UUID and therefore globally unique, so this alone names
 * the tournament too - which is why the picker writes only this and the server
 * does not need both. `?session=` stays and still means a tournament, resolving
 * to its first desk, so every URL written before productions existed keeps
 * meaning what it meant.
 */
export const PRODUCTION_ID = params.get('production') ?? '';

/**
 * Which bus this page renders: what is on air, or what is being staged.
 *
 * Defaults to PROGRAM, and that default is the whole compatibility story. An
 * OBS browser source saved before this feature existed says
 * `/post-match.html?key=...` and knows nothing about buses - it has to keep
 * showing exactly what it always did, which is air. The dashboard's preview
 * iframes are the ones that opt in, by asking for `?bus=preview`.
 *
 * Note this is the opposite default to a *write*, where saying nothing stages
 * rather than airs. The two are chosen by what the mistake costs: a forgotten
 * bus on a read shows air to somebody who wanted preview, a forgotten bus on a
 * write puts something in front of an audience.
 */
export const PAGE_BUS = params.get('bus') === 'preview' ? 'preview' : 'program';

/**
 * A same-origin URL carrying whichever of the two this page holds.
 *
 * Never both: a key already names a session, and sending an id beside it would
 * invite the question of which wins. The server reads the key first.
 */
export function api(path, bus) {
  const url = new URL(path, location.origin);
  if (SESSION_KEY) url.searchParams.set('key', SESSION_KEY);
  // The desk wins where both are present, because it is the more specific of
  // the two and a key already names one. Sending both would invite the question
  // of which the server reads.
  else if (PRODUCTION_ID) url.searchParams.set('production', PRODUCTION_ID);
  else if (SESSION_ID) url.searchParams.set('session', SESSION_ID);
  // Always spelled out when it is given, never inferred here. A caller that
  // cares about the bus is a caller that should be readable as caring.
  if (bus) url.searchParams.set('bus', bus);
  return url.pathname + url.search;
}

/** The same, as a string a person is meant to read and copy into OBS. */
export function outputUrl(page, key) {
  return `${location.origin}${page}${key ? `?key=${encodeURIComponent(key)}` : ''}`;
}

/**
 * Point the whole dashboard at a different production.
 *
 * A reload rather than a re-fetch, and deliberately so: every module holds its
 * own copy of a state, the three preview iframes hold three more, and the live
 * stream is subscribed per event name at first use. Rebuilding all of that in
 * place is a great deal of machinery to get subtly wrong, in exchange for
 * saving an operator half a second between shows.
 */
/*
 * Where the operator was, carried across the one reload a switch costs.
 *
 * Switching tournament is a navigation - see the note on switchTo below for why
 * that is right - and a navigation lands on whatever tab index.html marks,
 * which is the lookup page. So an operator who pressed "New tournament" on the
 * Tournament page arrived back on a different page entirely, and one who
 * switched tournaments mid-show lost their place. The data was correct and the
 * ergonomics were worse than the bug.
 *
 * sessionStorage rather than localStorage, and cleared on the way out: this is
 * "carry me across THIS reload", not a preference. A manual refresh must still
 * land where index.html says, because that is what somebody reloading a stuck
 * page expects, and a tab restored from a week ago is a surprise rather than a
 * convenience.
 */
const PLACE_KEY = 'vct.place.next';

const keepPlace = () => {
  try {
    const here = document.querySelector('.tab[aria-selected="true"]')?.dataset.tab;
    if (here) sessionStorage.setItem(PLACE_KEY, here);
  } catch {
    // Storage denied still gets a working switch, just a forgetful one - the
    // same call the rail's collapse makes.
  }
};

/** The tab a switch asked to return to, read once and consumed. */
export function takePlace() {
  try {
    const tab = sessionStorage.getItem(PLACE_KEY) ?? '';
    sessionStorage.removeItem(PLACE_KEY);
    return tab;
  } catch {
    return '';
  }
}

export function switchTo(sessionId) {
  keepPlace();
  const url = new URL(location.href);
  if (sessionId) url.searchParams.set('session', sessionId);
  else url.searchParams.delete('session');
  /*
   * A tournament change clears the desk.
   *
   * Otherwise the page would carry Court 2's production id onto a different
   * competition, where it names nothing - and `contextFor` falls back to the
   * named tournament's first desk, so the picker would say "Court 2" while the
   * graphics were Main's. Clearing it lands on the first desk, which is what
   * the tournament picker alone can honestly promise.
   */
  url.searchParams.delete('production');
  location.assign(url);
}

/** Point the dashboard at a different DESK of the tournament it is already on. */
export function switchDesk(productionId) {
  keepPlace();
  const url = new URL(location.href);
  if (productionId) url.searchParams.set('production', productionId);
  else url.searchParams.delete('production');
  // The desk is the more specific of the two and names its tournament, so the
  // looser parameter goes rather than sitting there disagreeing with it.
  url.searchParams.delete('session');
  location.assign(url);
}

/**
 * The signed-in account, fetched once and shared.
 *
 * Four dashboard modules want the same three facts - who am I, what is my
 * session key, and which productions can I reach - and four requests for them
 * would be three too many on a page whose whole connection budget is six.
 *
 * Resolves to null on an output page: those carry a key rather than a login, so
 * the request is a 401 and there is nothing to ask about.
 */
let accountPromise = null;

export function account() {
  accountPromise ??= fetch('/api/account/me')
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  return accountPromise;
}

/**
 * Forget the cached account - after a key rotation, a grant change, or a new
 * desk - and tell the rest of the page it moved.
 *
 * The event is why this is here rather than three modules each clearing their
 * own copy. `account.js` paints the topbar, and the topbar is where the
 * tournament and production selectors live - so a desk added on the Tournament
 * page has to reach a module that was not involved in adding it. Without the
 * event the new production appeared in the list on the Settings panel and in no
 * selector anywhere, until a reload.
 *
 * Same shape as `teams-changed`: one owner for the data, one notification, and
 * nothing holding a second copy it has to remember to clear.
 */
export function refreshAccount() {
  accountPromise = null;
  const pending = account();
  pending.then((data) => window.dispatchEvent(new CustomEvent('account-changed', { detail: data })));
  return pending;
}

/**
 * The key to put in an OBS URL for whatever this dashboard is looking at.
 *
 * Your own key when you are on your own production; the owner's when you are
 * operating one that was shared with you - the browser source has to reach
 * *their* graphics, and OBS has no login of its own to say so.
 */
export async function targetKey() {
  const data = await account();
  if (!data) return '';
  /*
   * The key belongs to the TOURNAMENT this page is looking at.
   *
   * This used to fall back to `data.user.sessionKey` when no session was named,
   * because a production was an account and your own key was always the right
   * answer. There is no such fallback now - a person has no key of their own,
   * and inventing one would hand OBS a URL that resolves to nothing.
   *
   * With no `?session=` the server picks a default tournament, and the list
   * below is in the same order, so the first entry is that same one. An account
   * on no tournament gets '', and the panels that show an OBS URL say so rather
   * than printing a blank.
   */
  const list = data.sessions ?? [];

  /*
   * A key belongs to a DESK, so a page looking at one has to ask for that one.
   *
   * The server puts the current desk's key at the top level of each session
   * entry as well - it knows which production resolved the request - so the
   * lookup below is what makes an explicit `?production=` right rather than
   * merely consistent: without it, opening Court 2 and copying the OBS URL
   * would hand out Court 1's key, and the browser source would show the wrong
   * match with nothing wrong on screen to say so.
   */
  if (PRODUCTION_ID) {
    for (const entry of list) {
      const desk = (entry.productions ?? []).find((production) => production.id === PRODUCTION_ID);
      if (desk) return desk.sessionKey ?? '';
    }
    return '';
  }

  const wanted = SESSION_ID ? list.find((entry) => entry.id === SESSION_ID) : list[0];
  return wanted?.sessionKey ?? '';
}

/**
 * An in-page link (a preview iframe, an "open in a tab") for the target.
 *
 * `bus` is what makes the dashboard's iframes show the staged copy while the
 * OBS URL beside them, which carries no bus, keeps showing air. An output page
 * reads it back out of its own URL - see PAGE_BUS - because there is no
 * cross-document call anywhere in this dashboard.
 */
export function pageUrl(page, bus) {
  const url = new URL(page, location.origin);
  if (SESSION_ID) url.searchParams.set('session', SESSION_ID);
  if (bus) url.searchParams.set('bus', bus);
  return url.pathname + url.search;
}
