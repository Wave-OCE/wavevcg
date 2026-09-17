/**
 * Account, access and administration.
 *
 * Three jobs that share one fetch of /api/account/me, which is why they are one
 * module rather than three:
 *
 *   the topbar   who is signed in, and whose production is on screen
 *   Account tab  your password, your OBS key, and who you have let in
 *   Admin tab    other people's accounts - admins only
 *
 * Nothing here writes a graphic, so it has no state to keep in step and no
 * stream to subscribe to. Everything is a request and a repaint.
 */

import { el, help, subhead } from './fields.js';
import { modalFoot, modalOpen, modalTitle, openModal } from './modal.js';
import { SETTING_FIELDS } from './settings-schema.js';
import { CAPABILITY_FIELDS } from './capability-schema.js';
import { COMPANION_GRAPHICS, companionVariables } from './companion-schema.js';
import { PRODUCTION_ID, SESSION_ID, account, refreshAccount, switchDesk, switchTo } from './session.js';

const $ = (id) => document.getElementById(id);
const toast = (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: message }));

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The Discord mark, drawn rather than fetched.
 *
 * Inline SVG with `fill="currentColor"`, so it takes the colour of whatever it
 * sits beside and needs no rule of its own beyond a size. Deliberately not an
 * image, an icon font or a CDN sprite: this dashboard has to render on a
 * machine with no network - that is most of the point of a local broadcast tool
 * - and an icon that resolves to a broken-image glyph mid-show is worse than no
 * icon at all.
 *
 * `el()` from fields.js cannot make this: it calls createElement, and an SVG
 * child built that way is an unknown HTML element that never paints.
 */
export function discordMark(title = 'Signs in with Discord') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'discord-mark');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', title);

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute(
    'd',
    'M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.198.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z',
  );

  svg.append(path);
  return svg;
}

const els = {
  whoami: $('whoami'),
  whoamiUser: $('whoami-user'),
  target: $('session-target'),
  desk: $('desk-target'),
  deskWrap: $('desk-target-wrap'),
  adminTab: document.querySelector('.tab[data-tab="admin"]'),

  facts: $('account-facts'),
  current: $('acc-current'),
  fresh: $('acc-new'),
  again: $('acc-again'),
  savePassword: $('acc-save'),
  note: $('acc-note'),

  key: $('acc-key'),
  copyKey: $('acc-copy-key'),
  rotate: $('acc-rotate'),

  companionPanel: $('acc-companion-panel'),
  companionIntro: $('acc-companion-intro'),
  companionOff: $('acc-companion-off'),
  companionOn: $('acc-companion-on'),
  companionUrl: $('acc-companion-url'),
  companionCopy: $('acc-companion-copy'),
  companionNew: $('acc-companion-new'),
  companionClear: $('acc-companion-clear'),
  companionOps: $('acc-companion-ops'),
  companionVars: $('acc-companion-vars'),
  grants: $('acc-grants'),

  discordPanel: $('acc-discord-panel'),
  discordFacts: $('acc-discord-facts'),
  discordLink: $('acc-discord-link'),
  discordUnlink: $('acc-discord-unlink'),
  discordNoPass: $('acc-discord-nopass'),
  discordHelp: $('acc-discord-help'),

  admUsername: $('adm-username'),
  admPassword: $('adm-password'),
  admIsAdmin: $('adm-admin'),
  admCreate: $('adm-create'),
  admNote: $('adm-note'),
  admUsers: $('adm-users'),
  admSettings: $('adm-settings'),
  admHealth: $('adm-health'),
  admRefresh: $('adm-refresh'),

  logView: $('adm-log'),
  logLevel: $('adm-log-level'),
  logFollow: $('adm-log-follow'),
  logFilter: $('adm-log-filter'),
  logCount: $('adm-log-count'),
  logCopy: $('adm-log-copy'),
};

let me = null;

/** Every write on this tab is the same shape, so the error handling is written once. */
async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new Error(payload?.error?.message ?? `Request failed (HTTP ${response.status}).`);
  }
  return payload;
}

const when = (stamp) => (stamp ? new Date(stamp).toLocaleString() : 'never');

function facts(target, rows) {
  target.replaceChildren(
    ...rows.flatMap(([label, value]) => [el('dt', null, {}, label), el('dd', null, {}, String(value))]),
  );
}

// ---------------------------------------------------------------- topbar ---

/**
 * The production selector, and the warning that goes with it.
 *
 * An operator running their own show sees one entry and nothing else changes.
 * The moment they are looking at somebody else's, the whole page gets a border
 * and the strip says whose - because the failure this prevents is putting a
 * graphic on the wrong stream, and that is not a mistake a dropdown alone
 * stops somebody making.
 */
function paintTopbar() {
  if (!me) return;

  /*
   * With no ?session= the server opens a default tournament, and this list is
   * in the same order - so the first entry IS that default, and the selector
   * shows what the page is actually looking at rather than nothing.
   */
  const current = SESSION_ID || me.sessions[0]?.id || '';
  els.target.replaceChildren(
    ...me.sessions.map((entry) =>
      el(
        'option',
        null,
        { value: entry.id, selected: entry.id === current ? 'selected' : null },
        `${entry.name}${entry.archived ? ' - archived' : ''} - ${entry.level}`,
      ),
    ),
  );

  const mine = me.sessions.find((entry) => entry.id === current);

  /*
   * The desks of the tournament on screen.
   *
   * Shown only when there is more than one, like the tournament selector above
   * it - a competition running a single stream should not be asked to choose
   * between one thing. The moment somebody adds Court 2 it appears, on every
   * page, because which desk you are on decides which graphics every tab is
   * editing.
   */
  const desks = mine?.productions ?? [];
  const here = PRODUCTION_ID || desks[0]?.id || '';
  els.desk.replaceChildren(
    ...desks.map((desk) =>
      el('option', null, { value: desk.id, selected: desk.id === here ? 'selected' : null }, desk.name || 'Untitled production'),
    ),
  );
  els.deskWrap.hidden = desks.length < 2;

  /*
   * The on-air safety cue, redefined - and this needs a human decision, so it
   * is flagged in the handover rather than quietly settled here.
   *
   * It used to mean "the production on screen is not mine", computed as
   * `current !== me.user.id`. Nobody owns a production any more, so that test
   * has no meaning: taken literally everybody is a guest all the time, the
   * border becomes permanent, and a warning that is always on stops being read
   * - which loses the one cue on this dashboard that stops somebody airing a
   * graphic on the wrong stream.
   *
   * The nearest honest reading is kept: you are a guest on a tournament you do
   * not own. An owner running their own competition sees a clean page, and
   * anybody operating somebody else's sees the border, which is the behaviour
   * the cue was built for.
   */
  const guest = Boolean(mine) && mine.level !== 'owner';
  // replaceChildren rather than textContent, because a text assignment cannot
  // carry the mark beside the name. textContent still reads as the username, so
  // anything asserting on it is unaffected.
  els.whoamiUser.replaceChildren(
    document.createTextNode(`${me.user.username}${me.user.role === 'admin' ? ' - admin' : ''}`),
    ...(me.user.discord ? [discordMark(`Signs in with Discord as ${me.user.discord.tag}`)] : []),
  );
  els.whoami.hidden = false;
  // Only worth a selector when there is somewhere to go.
  els.target.parentElement.hidden = me.sessions.length < 2;
  document.body.classList.toggle('is-guest', guest);
  document.body.dataset.guestNote = guest ? `${mine.level} on ${mine.name}` : '';

  paintNoTournament(mine);

  if (els.adminTab) els.adminTab.hidden = me.user.role !== 'admin';
}

/**
 * Say so when there is nothing on screen to be looking at.
 *
 * Two states rather than one, because they are answered by different people.
 * Being on no tournament at all is either "make one" or "ask somebody to add
 * you", depending on a permission; having a `?session=` that resolves to
 * nothing is a stale link or an access that was revoked, and the fix is to pick
 * one of the tournaments this account IS on.
 *
 * Deliberately not an error. A brand new account is on no tournament, which is
 * the ordinary first minute of using this - so it reads as "here is what to do
 * next" rather than as something having gone wrong.
 */
function paintNoTournament(mine) {
  const banner = document.getElementById('no-tournament');
  if (!banner) return;

  if (mine) {
    banner.hidden = true;
    banner.textContent = '';
    document.body.classList.remove('is-adrift');
    return;
  }

  banner.textContent = me.sessions.length
    ? 'That tournament is not available to this account any more. Pick another from the Tournament selector above - ' +
      'until you do, the graphics, teams and schedule on this page belong to nothing.'
    : /*
       * One message for both halves of "what do I do about it", because this
       * page cannot tell them apart: whether this account may CREATE a
       * tournament is `mayCreate` on /api/tournaments, which the Tournament
       * page reads and this one does not. Guessing from the role would give an
       * operator who holds manageTournaments the wrong advice - and the page
       * that knows is one click away and named in the sentence.
       */
      'No tournament yet. Nothing on this dashboard is connected to a competition until one exists - open ' +
      'Tournament to make one, or ask an owner to add this account to theirs.';
  banner.hidden = false;
  // A whole-page cue as well as a line of text, for the same reason .is-guest
  // is one: the panels an operator is actually looking at are further down.
  document.body.classList.add('is-adrift');
}

/*
 * Another module refreshed the account - a desk added on the Tournament page,
 * say. The selectors up here have to follow, and this module was not involved
 * in the change that caused it.
 */
window.addEventListener('account-changed', (event) => {
  if (!event.detail) return;
  me = event.detail;
  paintTopbar();
});

els.desk.addEventListener('change', () => {
  switchDesk(els.desk.value);
});

els.target.addEventListener('change', () => {
  // Your own session is the plain URL, not ?session=<your id>: a bookmark that
  // names you is one that breaks when it is shared with a colleague.
  switchTo(els.target.value === me.user.id ? '' : els.target.value);
});

// --------------------------------------------------------------- account ---

function paintAccount() {
  if (!me) return;

  facts(els.facts, [
    ['Username', me.user.username],
    ['Role', me.user.role === 'admin' ? 'Administrator' : 'Operator'],
    ['Account made', when(me.user.createdAt)],
    ['Last signed in', when(me.user.lastLoginAt)],
  ]);

  /*
   * The key of the tournament on screen, not of this account.
   *
   * An account has no key any more. Somebody on no tournament gets a line
   * saying so rather than a blank box, because a blank box beside a "copy"
   * button reads as a bug.
   */
  const here = me.sessions.find((entry) => entry.id === (SESSION_ID || me.sessions[0]?.id));
  els.key.textContent = here?.sessionKey ?? (me.sessions.length ? 'view-only - no key' : 'no tournament yet');
  els.note.textContent = `Passwords must be at least ${me.passwordMin} characters.`;
  paintGrants();
  paintDiscord();
  paintCompanion();
}

/**
 * The Companion panel.
 *
 * The two tables are built once and never rebuilt - they come from the schema,
 * not from the account - so only the key half repaints.
 */
let companionTablesBuilt = false;

/**
 * The control key of the tournament on screen, as far as this page knows it.
 *
 * Two fields rather than one, because the server hands the key itself back only
 * from the mint that made it - it is not in the tournament list, deliberately,
 * so that a value which operates the desk does not ride along in a fetch every
 * page load makes. So `has` survives a reload and `value` does not, and the
 * panel says so rather than showing an empty URL.
 */
let companionKey = { id: '', has: false, value: '' };

/** Which tournament the Account tab is talking about. The same one the key row shows. */
const hereTournament = () => SESSION_ID || me?.sessions[0]?.id || '';

/**
 * Ask which tournament holds a control key.
 *
 * `/api/account/me` cannot answer this any more: a key belongs to a production,
 * not to a person, and `sessions` carries only what every member may see.
 */
async function loadCompanion() {
  const id = hereTournament();
  if (!id) {
    companionKey = { id: '', has: false, value: '' };
    return;
  }
  try {
    const payload = await (await fetch('/api/tournaments')).json();
    const found = (payload.tournaments ?? []).find((entry) => entry.id === id);
    /*
     * The control key belongs to a PRODUCTION, so the flag that says whether
     * one exists is on the desk rather than the tournament. This panel shows
     * the first desk, which is the one a single-stream tournament will only
     * ever have; the Tournament page is where a second one is picked.
     */
    const desk = found?.productions?.[0];
    // A mint earlier in this page's life still holds the value; a reload does not.
    companionKey = {
      id,
      has: Boolean(desk?.hasControlKey),
      value: companionKey.id === id ? companionKey.value : '',
    };
  } catch {
    /* leave what we had; the panel is readable either way */
  }
}

function paintCompanion() {
  if (!els.companionPanel) return;

  const enabled = me.companion?.enabled !== false;
  const has = companionKey.has;

  els.companionIntro.textContent = enabled
    ? 'Drive the transport from a stream deck, and light the buttons up with what is actually on air. ' +
      'This uses its own key, not the OBS one - so removing it stops the stream deck without touching a browser source.'
    : 'An administrator has switched the control channel off on this server, so this key will not connect. ' +
      'It is kept, and starts working again the moment the switch goes back on.';

  /*
   * A key that exists but is not in hand shows the buttons and no URL.
   *
   * Reloading the page loses the value - the server only ever hands it back
   * once, from the mint - so the URL block is hidden and Copy with it, because
   * a Copy button beside a dash copies a dash.
   */
  const inHand = has && Boolean(companionKey.value);
  els.companionOff.hidden = has;
  els.companionOn.hidden = !inHand;
  els.companionCopy.hidden = !inHand;
  els.companionClear.hidden = !has;
  els.companionNew.textContent = has ? 'Replace the key' : 'Create a control key';

  if (has && !inHand) {
    els.companionIntro.textContent =
      'This tournament has a control key. It is only shown once, when it is made - if you no longer ' +
      'have it, replace it below and re-paste the new URL into Companion.';
  }

  if (inHand) {
    /*
     * Built from the page's own location rather than a value from the server.
     * The dashboard is already open on the address that works from here -
     * through a tunnel, over a LAN, or on localhost - and a server that tried
     * to name itself would be guessing at which of those the operator meant.
     */
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const path = me.companion?.path ?? '/api/companion';
    els.companionUrl.textContent = `${scheme}://${window.location.host}${path}?key=${companionKey.value}`;
  }

  if (!companionTablesBuilt) {
    companionTablesBuilt = true;
    buildCompanionTables();
  }
}

/**
 * Both reference tables, straight out of the shared schema.
 *
 * Note `el()` takes TEXT as its fourth argument, not children - so every row
 * is assembled with append rather than built in one call.
 */
function buildCompanionTables() {
  const opBlocks = [];
  const varBlocks = [];

  const codeCell = (text) => {
    const td = el('td');
    td.append(el('code', null, {}, text));
    return td;
  };

  const table = (rows) => {
    const body = el('tbody');
    body.append(...rows);
    const node = el('table', 'companion-table');
    node.append(body);
    return node;
  };

  for (const graphic of COMPANION_GRAPHICS) {
    const opRows = graphic.ops.map((op) => {
      const row = el('tr', op.danger ? 'is-danger' : null);
      row.append(codeCell(`${graphic.key}.${op.key}${op.arg ? `  (+ ${op.arg})` : ''}`), el('td', null, {}, op.help));
      return row;
    });
    opBlocks.push(
      el('h3', 'companion-heading', {}, graphic.label),
      el('p', 'field-help', {}, graphic.note),
      table(opRows),
    );

    const varRows = companionVariables(graphic.key)
      // The 1/0 twins would double the table and say nothing new. The note
      // above it explains them once; listing thirty of them would bury the
      // names somebody actually has to read.
      .filter((field) => field.kind !== 'lampNumber')
      .map((field) => {
        const row = el('tr');
        row.append(
          codeCell(field.key),
          el('td', null, {}, field.kind === 'lamp' ? `${field.label}  -  also ${field.key}_n as 1/0` : field.label),
        );
        return row;
      });
    varBlocks.push(el('h3', 'companion-heading', {}, graphic.label), table(varRows));
  }

  els.companionOps.replaceChildren(...opBlocks);
  els.companionVars.replaceChildren(...varBlocks);
}

/**
 * The Discord panel on the Account tab.
 *
 * Hidden outright when the server has none configured. The help line is the
 * place requirement 6 is actually explained to the person it affects: the role
 * is read when you sign in, so losing it stops the next sign-in rather than
 * this one.
 */
function paintDiscord() {
  if (!els.discordPanel) return;

  const on = Boolean(discordServer);
  els.discordPanel.hidden = !on;
  if (!on) return;

  const linked = me.user.discord;
  facts(els.discordFacts, [
    ['Signs in with', [me.user.hasPassword ? 'Password' : null, linked ? 'Discord' : null].filter(Boolean).join(' and ') || 'nothing'],
    ['Discord account', linked ? linked.tag || linked.id : 'not linked'],
    ...(linked ? [['Linked on', when(linked.linkedAt)]] : []),
  ]);

  els.discordLink.hidden = Boolean(linked);
  els.discordUnlink.hidden = !linked || !me.user.hasPassword;
  els.discordNoPass.hidden = !linked || !me.user.hasPassword;

  els.discordHelp.textContent = linked
    ? `Your ${discordServer.role} role is checked when you sign in. Losing it stops the next sign-in; it does not end this one.`
    : `Link your Discord account and you can sign in with it, as long as you hold ${discordServer.role}.`;
}

/**
 * The access list.
 *
 * One row per other account, each a three-way choice rather than an add/remove
 * pair - "no access, viewer, editor" is the whole of what can be true, and a
 * list of everyone makes revoking as easy to find as granting. With one account
 * on the server there is nobody to show, and saying so is better than an empty
 * box.
 */
/**
 * Sharing moved to the Tournament page, and this panel says so.
 *
 * Access used to be a grant on YOUR account - you let somebody into your
 * graphics - so it belonged beside your password. It is now membership of a
 * tournament, decided by that tournament's owner, so it belongs on the page
 * that describes the tournament. Leaving a second control here would have meant
 * two places that disagree about who may operate a show.
 *
 * The panel is left in place with a pointer rather than deleted outright: an
 * operator who knows where this lived deserves to be told where it went, not to
 * find a section quietly missing.
 */
function paintGrants() {
  els.grants.replaceChildren(
    el(
      'p',
      'field-help',
      {},
      'Access is per tournament now. Open the Tournament page and use its Access tab - ' +
        'whoever owns a tournament decides who may work on it.',
    ),
  );
}

els.savePassword.addEventListener('click', async () => {
  if (els.fresh.value !== els.again.value) {
    els.note.textContent = 'The two new passwords do not match.';
    return;
  }

  els.savePassword.disabled = true;
  try {
    await post('/api/account/password', { current: els.current.value, password: els.fresh.value });
    els.current.value = els.fresh.value = els.again.value = '';
    // The server ends every other login for this account and re-issues this
    // one, so the page carries on working and every other browser does not.
    els.note.textContent = 'Password changed. Any other browser signed in as you has been signed out.';
    toast('Password changed');
  } catch (error) {
    els.note.textContent = error.message;
  } finally {
    els.savePassword.disabled = false;
  }
});

els.copyKey.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.key.textContent);
    toast('Key copied');
  } catch {
    toast('Could not reach the clipboard - select the key and copy it by hand');
  }
});

els.rotate.addEventListener('click', async () => {
  const warning =
    'Make a new key?\n\nEvery OBS browser source and both webhook URLs stop working until you re-copy them. Do not do this mid-show.';
  if (!window.confirm(warning)) return;

  try {
    const id = SESSION_ID || me.sessions[0]?.id;
    if (!id) throw new Error('There is no tournament to re-key.');
    const payload = await post('/api/tournaments', { action: 'rotate-key', id });
    // The key is a desk's. This panel operates the first one - see the note on
    // companionKey above.
    els.key.textContent = payload.tournament.productions[0].sessionKey;
    await refreshAccount();
    toast('New key made - re-copy the OBS and webhook URLs');
  } catch (error) {
    toast(error.message);
  }
});

els.companionCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.companionUrl.textContent);
    toast('Companion URL copied');
  } catch {
    toast('Could not reach the clipboard - select the URL and copy it by hand');
  }
});

/*
 * Minting and withdrawing are owner-only actions on the TOURNAMENT, not on the
 * account - a control key drives one production's desk, and an account no
 * longer has one at all. So both buttons name the tournament the page is
 * looking at, the same one the OBS key row above shows.
 */
els.companionNew.addEventListener('click', async () => {
  // Only warns when there is something to break. Making a first key breaks
  // nothing, and a confirmation on it would just be noise.
  if (companionKey.has) {
    const warning =
      'Replace the control key?\n\nAny stream deck using the old one stops working at once, and disconnects now. Your OBS sources are not affected.';
    if (!window.confirm(warning)) return;
  }

  try {
    const id = hereTournament();
    if (!id) throw new Error('There is no tournament to make a key for.');
    const payload = await post('/api/tournaments', { action: 'control-key', id });
    companionKey = { id, has: Boolean(payload.tournament?.productions?.[0]?.hasControlKey), value: payload.controlKey ?? '' };
    paintCompanion();
    toast('Control key ready - paste the URL into Companion');
  } catch (error) {
    toast(error.message);
  }
});

els.companionClear.addEventListener('click', async () => {
  if (!window.confirm('Remove the control key?\n\nAnything connected now is disconnected, and nothing can drive these graphics remotely until you make a new one.')) return;

  try {
    const id = hereTournament();
    if (!id) throw new Error('There is no tournament to remove a key from.');
    const payload = await post('/api/tournaments', { action: 'control-key', id, mode: 'clear' });
    companionKey = { id, has: Boolean(payload.tournament?.productions?.[0]?.hasControlKey), value: '' };
    paintCompanion();
    toast('Control key removed');
  } catch (error) {
    toast(error.message);
  }
});

// ----------------------------------------------------------------- admin ---

async function loadAdmin() {
  if (me?.user.role !== 'admin') return;

  try {
    const [userData, health, settingData] = await Promise.all([
      fetch('/api/admin/users').then((r) => r.json()),
      fetch('/api/admin/health').then((r) => r.json()),
      fetch('/api/admin/settings').then((r) => r.json()),
    ]);
    paintUsers(userData.users ?? []);
    paintHealth(health);
    paintSettings(settingData);
    // Handed back so an open account modal can re-read the account it is
    // showing. Without it a toggle would have to close the dialog to see its
    // own effect, and granting three permissions would be three round trips
    // through the list.
    return userData.users ?? [];
  } catch (error) {
    els.admNote.textContent = `Could not load: ${error.message}`;
    return null;
  }
}

/**
 * The server switches, rendered from SETTING_FIELDS.
 *
 * Three states, not two. A switch whose requirement the environment does not
 * provide is shown off and disabled with the reason underneath - because
 * "somebody turned this off" and "this server cannot do it" send an
 * administrator to two completely different places, and a greyed-out checkbox
 * on its own says neither.
 */
function paintSettings({ settings, available }) {
  els.admSettings.replaceChildren(
    ...SETTING_FIELDS.map((entry) => {
      const usable = !entry.requires || available?.[entry.requires] !== false;
      const on = Boolean(settings[entry.key]) && usable;

      const box = el('input', null, { type: 'checkbox', id: `set-${entry.key}` });
      box.checked = on;
      box.disabled = !usable;

      const row = el('div', `setting-row${usable ? '' : ' is-off'}`);
      const label = el('label', 'setting-head', { for: `set-${entry.key}` });
      label.append(box, el('span', 'setting-label', {}, entry.label));
      row.append(label, el('p', 'field-help', {}, entry.help));

      const state = el('p', 'setting-state');
      const say = () => {
        state.textContent = !usable ? entry.missing : box.checked ? 'On.' : entry.off;
        row.classList.toggle('is-off', !usable || !box.checked);
      };
      say();
      row.append(state);

      box.addEventListener('change', async () => {
        box.disabled = true;
        try {
          const payload = await post('/api/admin/settings', { settings: { [entry.key]: box.checked } });
          box.checked = Boolean(payload.settings[entry.key]);
          say();
          toast(`${entry.label} ${box.checked ? 'on' : 'off'}`);
          // The switches change what the lookup tab may offer, and that tab read
          // its config once at boot. Reloading is blunt but it is also the only
          // thing that cannot leave half the page believing the old answer.
          if (window.confirm('Setting saved. Reload the dashboard so every tab picks it up?')) location.reload();
        } catch (error) {
          box.checked = !box.checked;
          say();
          toast(error.message);
        } finally {
          box.disabled = false;
        }
      });

      return row;
    }),
  );
}

function paintHealth(health) {
  const hours = Math.floor(health.uptimeSec / 3600);
  const minutes = Math.floor((health.uptimeSec % 3600) / 60);

  facts(els.admHealth, [
    ['Up for', hours ? `${hours}h ${minutes}m` : `${minutes}m`],
    ['Node', health.node],
    ['Accounts', health.accounts],
    ['Open logins', health.logins],
    ['Live productions', `${health.openSessions}${health.openSessions ? ` (${health.liveSessions.length} loaded)` : ''}`],
    ['Open streams', health.streams],
    ['Memory', `${health.rssMb} MB resident, ${health.heapMb} MB heap`],
    ['Listening on', `${health.host}:${health.port}`],
    ['Cookie', health.cookieSecure ? 'HTTPS only' : 'sent over plain HTTP too'],
    ['HenrikDev key', health.providers.henrik ? 'loaded' : 'missing'],
    ['Riot key', health.providers.riot ? 'loaded' : 'missing'],
    [
      'tracker.gg',
      !health.tracker.available
        ? 'not available on this server'
        : !health.tracker.enabled
          ? 'switched off'
          : health.tracker.loginActive
            ? `login running (${health.tracker.loginPhase}) - ${health.tracker.startedBy || 'unknown'}`
            : health.tracker.browserOpen
              ? 'ready, browser open'
              : 'ready, browser not started',
    ],
    ['Post-match watch', health.watch ? 'enabled' : 'switched off'],
  ]);
}

function paintUsers(list) {
  els.admUsers.replaceChildren(
    ...list.map((user) => {
      const row = el('div', `admin-row${user.disabled ? ' is-off' : ''}`);
      row.append(
        el('span', 'admin-name', {}, user.username),
        el('span', 'admin-meta', {}, user.role === 'admin' ? 'Administrator' : 'Operator'),
        el('span', 'admin-meta', {}, user.live ? 'production loaded' : `last in ${when(user.lastLoginAt)}`),
      );

      /*
       * How this account gets in, which is the fact this panel exists to act
       * on. The handle is shown because it is what a person recognises, and the
       * snowflake sits in the tooltip because the handle is the part that can
       * be changed and re-claimed - so the id is the only way to tell a
       * colleague from somebody who took their old name.
       */
      if (user.discord) {
        const mark = el('span', 'admin-meta admin-discord', {
          title: `Discord id ${user.discord.id}${user.hasPassword ? '' : ' - no password'}`,
        });
        mark.append(discordMark(), document.createTextNode(user.discord.tag || 'Discord'));
        row.append(mark);
      } else if (!user.hasPassword) {
        row.append(el('span', 'admin-meta is-warn', {}, 'no way to sign in'));
      }

      const manage = el('button', 'btn btn-small', { type: 'button' }, 'Manage');
      manage.addEventListener('click', () => openAccount(user));
      row.append(manage);
      return row;
    }),
  );
}

/**
 * One account, in a modal.
 *
 * The row used to carry every action: Disable, Make admin, one button per
 * capability, Unlink Discord, Sign out, Delete. That grew with the schema -
 * `CAPABILITY_FIELDS` is built from a list, so adding a permission adds a
 * button to every row - and it had already pushed Delete out through the side
 * of its panel on an administrator who also held the tracker permission. The
 * note in CLAUDE.md about a flex row not reporting its own overflow is that
 * bug; letting the row wrap fixed the symptom.
 *
 * This fixes the cause. A row is now a name and a Manage button, so it cannot
 * grow with the schema at all, and the actions sit in a dialog where there is
 * room to say what each one does. Two things come free and both matter more
 * than the layout:
 *
 *   Delete is no longer one row away from the next account's Delete. It is
 *   behind a deliberate second step, under the name of the account you are
 *   looking at.
 *
 *   Each action can carry its consequence in words beside it rather than only
 *   in a confirm() that appears after the click - which is the wrong moment to
 *   learn that deleting somebody does not stop them signing back in.
 */
function openAccount(account) {
  if (modalOpen()) return;

  let dialog = null;
  let user = account;
  const body = el('div', 'rl-modal-body');

  /**
   * Do it, then show what it did.
   *
   * Most of these actions STAY OPEN and repaint, because granting three
   * permissions to one person is one visit rather than three. `closes` is for
   * the two that end the conversation - deleting the account, and unlinking the
   * identity the dialog is describing.
   *
   * The repaint re-reads the account from the reloaded list rather than
   * patching the local copy: the server is what decides what a write actually
   * did, and `may` is computed from the role as well as the grant, so guessing
   * it here would be a second implementation of `adminImplied`.
   */
  const act = async (label, patch, confirmText, { closes = false } = {}) => {
    if (confirmText && !window.confirm(confirmText)) return;
    try {
      await post('/api/admin/users', { id: user.id, ...patch });
      const list = await loadAdmin();
      toast(label);
      if (closes) {
        dialog?.close();
        return;
      }
      const fresh = list?.find((entry) => entry.id === user.id);
      if (!fresh) {
        dialog?.close();
        return;
      }
      user = fresh;
      paint();
    } catch (error) {
      // The last-admin lock and the last-password-holder lock both answer here.
      // Neither is a failure, so the dialog stays open and says so.
      toast(error.message);
    }
  };

  function paint() {
  const disable = el('button', 'btn btn-small', { type: 'button' }, user.disabled ? 'Enable' : 'Disable');
      disable.addEventListener('click', () =>
        act(
          user.disabled ? `${user.username} enabled` : `${user.username} disabled`,
          { action: 'update', disabled: !user.disabled },
          user.disabled ? null : `Disable ${user.username}? They are signed out immediately and their OBS key stops working.`,
        ),
      );

      const promote = el('button', 'btn btn-small', { type: 'button' }, user.role === 'admin' ? 'Make operator' : 'Make admin');
      promote.addEventListener('click', () =>
        act(`${user.username} is now ${user.role === 'admin' ? 'an operator' : 'an administrator'}`, {
          action: 'update',
          role: user.role === 'admin' ? 'user' : 'admin',
        }),
      );

      /*
       * One button per capability, built from the schema rather than written
       * out. The tracker.gg permission used to be hand-written here and was the
       * only one; a second would have meant a second copy of this block, and
       * that is how the button, the sanitiser and the server check drift apart.
       *
       * A capability implied by the role shows what it is rather than offering
       * a toggle that would do nothing - the button reads "(admin)" and is
       * disabled, which is the existing behaviour generalised.
       *
       * Only turning one ON asks for confirmation. Taking a permission away is
       * the safe direction and does not need a dialog in front of it.
       */
      const capabilities = CAPABILITY_FIELDS.map((field) => {
        const held = user.capabilities?.[field.key] === true;
        const byRole = field.adminImplied && user.role === 'admin';
        const resolved = user.may?.[field.key] === true;

        const button = el(
          'button',
          `btn btn-small${resolved ? ' is-active' : ''}`,
          { type: 'button', title: field.help },
          byRole ? `${field.short} (admin)` : `${field.short} ${held ? 'on' : 'off'}`,
        );
        button.disabled = byRole;
        button.addEventListener('click', () =>
          act(
            `${user.username} ${held ? 'can no longer' : 'can now'} ${field.label}`,
            { action: 'update', capabilities: { [field.key]: !held } },
            held ? null : `Let ${user.username} ${field.label}?\n\n${field.help}`,
          ),
        );
        return button;
      });

      const signOut = el('button', 'btn btn-small', { type: 'button' }, 'Sign out');
      signOut.addEventListener('click', () => act(`${user.username} signed out everywhere`, { action: 'sign-out' }));

      /*
       * Unlink, and deliberately no "link".
       *
       * Attaching a Discord identity to somebody else's account has no honest
       * use and is a straightforward impersonation: the recovery path for a
       * locked-out operator is to set them a password, which they find out
       * about the moment they use it. This button is for the other direction -
       * somebody lost their Discord account and needs it detached.
       */
      const unlink = el('button', 'btn btn-small', { type: 'button' }, 'Unlink Discord');
      unlink.addEventListener('click', () =>
        act(
          `Discord unlinked from ${user.username}`,
          { action: 'unlink-discord' },
          `Unlink ${user.username}'s Discord account?\n\nThey are signed out, and they will need their password to get back in.`,
          { closes: true },
        ),
      );

      const remove = el('button', 'btn btn-small btn-danger', { type: 'button' }, 'Delete');
      remove.addEventListener('click', () =>
        act(
          `${user.username} deleted`,
          { action: 'delete' },
          /*
           * Says what Delete is, because it is not what it looks like when
           * Discord can create accounts. Deleting removes the DATA; it does not
           * remove the person, who still holds the role and can sign straight
           * back in with an empty production. Taking the role away in Discord
           * is the eviction. Saying so here is the whole fix - the button was
           * never going to be able to do it.
           */
          `Delete ${user.username}?\n\nTheir graphics, presets, teams and player aliases are deleted with them. This cannot be undone.` +
            (user.discord
              ? `\n\nThis does NOT stop them signing in again: they still hold the Discord role, and a new empty account would be made for them. Remove the role in Discord, or use Disable.`
              : ''),
          { closes: true },
        ),
      );

  body.replaceChildren(
    modalTitle(user.username, user.role === 'admin' ? 'Administrator' : 'Operator'),
    help(
      user.discord
        ? `Signs in with Discord as ${user.discord.tag || 'a linked account'}${user.hasPassword ? ' and with a password' : ' and has no password'}.`
        : user.hasPassword
          ? 'Signs in with a password.'
          : 'Has no way to sign in at all - set them a password or link Discord.',
    ),
    subhead('Account'),
    wrapRow([disable, promote, signOut]),
    subhead('Permissions'),
    help(
      'Permissions default closed and are never implied by having an account. One marked (admin) comes with the ' +
        'role rather than being granted here.',
    ),
    wrapRow(capabilities),
    ...(user.discord ? [subhead('Discord'), wrapRow([unlink])] : []),
  );

  foot.replaceChildren(...modalFoot({ danger: remove, cancel: close }).childNodes);
  }

  const close = el('button', 'btn btn-ghost', { type: 'button' }, 'Close');
  close.addEventListener('click', () => dialog?.close());

  /*
   * The footer is built once and refilled, because `remove` is rebuilt by every
   * paint (it closes over the account as it now stands) while `close` never
   * changes - and a footer replaced wholesale would take the button the pointer
   * is over with it.
   */
  const foot = el('div', 'rl-modal-foot');
  paint();

  dialog = openModal({ body, foot });
}

/** A row of buttons that wraps rather than growing past its dialog. */
function wrapRow(children) {
  const node = el('div', 'rl-modal-row');
  node.append(...children.filter(Boolean));
  return node;
}

els.admCreate.addEventListener('click', async () => {
  els.admCreate.disabled = true;
  try {
    await post('/api/admin/users', {
      action: 'create',
      username: els.admUsername.value,
      password: els.admPassword.value,
      role: els.admIsAdmin.checked ? 'admin' : 'user',
    });
    els.admUsername.value = els.admPassword.value = '';
    els.admIsAdmin.checked = false;
    els.admNote.textContent = '';
    await loadAdmin();
    // Their name has to appear in your own access list without a reload, or
    // the obvious next move - sharing a production with the person you just
    // made an account for - does not work.
    me = (await refreshAccount()) ?? me;
    paintGrants();
    toast('Account created');
  } catch (error) {
    els.admNote.textContent = error.message;
  } finally {
    els.admCreate.disabled = false;
  }
});

els.admRefresh.addEventListener('click', () => void loadAdmin());

// ------------------------------------------------------------------- log ---

/**
 * The log panel.
 *
 * Polled rather than streamed, deliberately. A browser allows six connections
 * to an origin and this dashboard has already deadlocked itself once by
 * spending them; a fourth event stream for a panel somebody looks at twice a
 * month is not the place to spend the fifth. Three seconds is fast enough to
 * watch something go wrong in real time.
 *
 * `cursor` is a sequence number, so each poll asks only for what it has not
 * seen - two lines can share a millisecond, and a clock can go backwards.
 */
let logCursor = 0;
let logLines = [];
let logTimer = null;

const LOG_MAX = 500;

const logLine = (entry) => {
  const at = new Date(entry.at).toISOString().slice(11, 19);
  const meta = entry.meta ? ` ${JSON.stringify(entry.meta)}` : '';
  return `${at} ${entry.level.toUpperCase().padEnd(5)} ${entry.tag.padEnd(9)} ${entry.message}${meta}`;
};

function paintLog() {
  const wanted = els.logFilter.value.trim().toLowerCase();
  const shown = wanted ? logLines.filter((line) => line.toLowerCase().includes(wanted)) : logLines;

  els.logView.textContent = shown.join('\n');
  els.logCount.textContent = `${shown.length}${wanted ? ` of ${logLines.length}` : ''} lines`;

  // Only when it is already at the bottom, or reading anything above it becomes
  // impossible the moment a line arrives.
  if (els.logFollow.checked) els.logView.scrollTop = els.logView.scrollHeight;
}

async function pollLog() {
  if (me?.user.role !== 'admin') return;

  try {
    const payload = await fetch(`/api/admin/logs?since=${logCursor}&limit=500`).then((r) => r.json());
    logCursor = payload.cursor ?? logCursor;

    if (payload.entries?.length) {
      // The server hands them back newest first, which is right for a listing
      // and wrong for a log - a log reads downwards.
      logLines.push(...payload.entries.slice().reverse().map(logLine));
      if (logLines.length > LOG_MAX) logLines = logLines.slice(-LOG_MAX);
      paintLog();
    }

    if (payload.levels && !els.logLevel.options.length) {
      els.logLevel.replaceChildren(
        ...payload.levels.map((name) =>
          el('option', null, { value: name, selected: name === payload.level ? 'selected' : null }, name),
        ),
      );
      els.logLevel.value = payload.level;
    }
  } catch {
    // A poll that fails is not worth a toast every three seconds.
  }
}

els.logLevel.addEventListener('change', async () => {
  try {
    await post('/api/admin/logs', { level: els.logLevel.value });
    toast(`Logging at ${els.logLevel.value}`);
  } catch (error) {
    toast(error.message);
  }
});

els.logFilter.addEventListener('input', paintLog);

els.logCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.logView.textContent);
    toast('Log copied');
  } catch {
    toast('Could not reach the clipboard - select the text and copy it by hand');
  }
});

// Loaded when the tab is opened rather than at boot: health is a snapshot and a
// stale one is worse than none, and the whole panel is irrelevant to the
// operator who never opens it.
window.addEventListener('app-tab', (event) => {
  const here = event.detail === 'admin';
  if (here) void loadAdmin();

  // Polled only while the tab is open. A request every three seconds for a
  // panel nobody is looking at is a request every three seconds for nothing,
  // and this dashboard's connection budget is six.
  clearInterval(logTimer);
  logTimer = null;
  if (!here) return;

  void pollLog();
  logTimer = setInterval(() => void pollLog(), 3000);
});

// ------------------------------------------------------------------ boot ---

// Signing out is a POST, so it cannot be a plain link - and it must clear the
// server's record of the token, not only the cookie.
document.addEventListener('click', async (event) => {
  if (!event.target.closest('#whoami-user')) return;
  if (!window.confirm('Sign out?')) return;
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  location.assign('/login.html');
});

// ------------------------------------------------------- the discord panel ---

/**
 * Whether this server offers Discord at all, and what the role is called.
 *
 * From /api/auth/state, which is the one route that answers before a login and
 * is where the login page reads the same fact. It carries a role NAME and
 * nothing else - no client id, no guild id, no role id.
 */
let discordServer = null;

els.discordLink?.addEventListener('click', async () => {
  els.discordLink.disabled = true;
  try {
    // A POST decides it - so the CSRF check applies - and the navigation that
    // follows carries only the opaque signed cookie the POST set.
    const { authorize } = await post('/api/account/discord/link', {});
    location.assign(authorize);
  } catch (error) {
    toast(error.message);
    els.discordLink.disabled = false;
  }
});

els.discordUnlink?.addEventListener('click', async () => {
  if (!window.confirm('Unlink your Discord account?\n\nYou will sign in with your password from now on.')) return;
  try {
    await post('/api/account/discord/unlink', {});
    me = (await refreshAccount()) ?? me;
    paintTopbar();
    paintAccount();
    toast('Discord unlinked');
  } catch (error) {
    toast(error.message);
  }
});

els.discordNoPass?.addEventListener('click', async () => {
  const current = window.prompt('Turn off your password?\n\nDiscord becomes the only way you can sign in.\n\nType your current password to confirm:');
  if (!current) return;
  try {
    await post('/api/account/password', { current, clearPassword: true });
    me = (await refreshAccount()) ?? me;
    paintTopbar();
    paintAccount();
    toast('Your password is off - sign in with Discord from now on');
  } catch (error) {
    toast(error.message);
  }
});

void fetch('/api/auth/state')
  .then((response) => (response.ok ? response.json() : null))
  .then((payload) => {
    discordServer = payload?.discord ?? null;
    if (me) paintAccount();
  })
  .catch(() => {});

void account().then(async (data) => {
  if (!data) return; // not signed in; the server has already redirected
  me = data;
  paintTopbar();
  paintAccount();
  // Whether this production holds a control key is a second fetch, because it
  // is a fact about the tournament rather than about the account. The panel
  // paints twice rather than blocking the whole tab on it.
  await loadCompanion();
  paintCompanion();
});
