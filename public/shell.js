/**
 * The rail, the sub-tab strips, and the page heading.
 *
 * Presentation only. Nothing here changes what a button does - every real tab
 * button still carries .tab and data-tab, and dashboard.js still collects them
 * with the same querySelectorAll it always used. This module only decides which
 * of them are on screen, which rail item looks current, and what the heading
 * says.
 *
 * Four of the five rail items ARE tab buttons. That is deliberate: it means
 * dashboard.js wires them for free, and account.js still finds
 * .tab[data-tab="admin"] to hide from non-administrators. Graphics is the one
 * exception - it names three panels rather than one, so it is a plain button
 * and the mapping below is the whole cost of that.
 *
 * ---------------------------------------------------------------------------
 * Why Global's strip is a different kind of thing
 * ---------------------------------------------------------------------------
 *
 * Graphics' three entries are three panels, so its strip is three real tabs.
 * Global is ONE panel holding four sections, so its strip switches sections
 * inside it. Those two look identical and are not, hence .tab against .subtab.
 *
 * The section switch toggles a CLASS rather than `hidden`, because
 * global-dashboard.js owns `hidden` on the tracker panel - it hides it when the
 * server has tracker.gg off or the account lacks the permission. Two owners for
 * one attribute is a race; a class and an attribute compose, and either one
 * hiding is enough.
 */

const $ = (id) => document.getElementById(id);

/** Which rail item lights up for a given tab. */
const SECTION_OF = {
  lookup: 'lookup',
  graphic: 'graphics',
  winner: 'graphics',
  select: 'graphics',
  global: 'global',
  account: 'account',
  admin: 'admin',
};

/**
 * The heading, per tab.
 *
 * The sub-line is the one place on the page that says what the screen is FOR,
 * and an operator reads it once and never again - so it is worth the words.
 */
const PAGE = {
  lookup: ['Match lookup', 'Find a finished game and send it to a graphic'],
  graphic: ['Post match', 'The end-of-map scoreboard'],
  winner: ['Winner splash', 'The end-of-series sequence'],
  select: ['Agent select', 'The draft strip'],
  global: ['Global', 'Settings and libraries shared by every graphic'],
  account: ['Account', 'Your keys, your sessions, and who may reach them'],
  admin: ['Admin', 'Server-wide switches, accounts and the log'],
};

/** Opening Graphics from the rail returns to whichever of its three you left. */
const GRAPHICS_TABS = ['graphic', 'winner', 'select'];
let lastGraphicsTab = 'graphic';

const railItems = [...document.querySelectorAll('.rail-item')];
const strips = [...document.querySelectorAll('.subtabs')];
const pageTitle = $('page-title');
const pageSub = $('page-sub');

// --------------------------------------------------------------- painting ---

function paint(tab) {
  const section = SECTION_OF[tab];
  if (!section) return;
  if (GRAPHICS_TABS.includes(tab)) lastGraphicsTab = tab;

  for (const item of railItems) {
    const owns = item.dataset.section ?? SECTION_OF[item.dataset.tab];
    item.classList.toggle('is-current', owns === section);
    // The group button is not a tab, so nothing else would ever mark it.
    if (item.dataset.section) item.setAttribute('aria-selected', String(owns === section));
  }

  for (const strip of strips) strip.hidden = strip.dataset.for !== section;

  const [title, sub] = PAGE[tab] ?? [];
  if (title && pageTitle) pageTitle.textContent = title;
  if (sub && pageSub) pageSub.textContent = sub;
}

// A tab change is announced by dashboard.js, which is the only thing that knows
// one happened - it owns the panels. Listening beats re-implementing it.
window.addEventListener('app-tab', (event) => paint(event.detail));

// dashboard.js never calls showTab at startup; the opening state is whatever
// index.html marked, so read it rather than assume it.
paint(document.querySelector('.tab[aria-selected="true"]')?.dataset.tab ?? 'lookup');

// ------------------------------------------------------------ rail: group ---

for (const item of railItems) {
  if (item.dataset.section !== 'graphics') continue;
  // Click the real tab rather than duplicating what it does. Everything
  // downstream of a tab press - the lazy preview load, the body class, the
  // app-tab event - then happens exactly once, in the one place it is written.
  item.addEventListener('click', () => {
    document.querySelector(`.tab[data-tab="${lastGraphicsTab}"]`)?.click();
  });
}

// ----------------------------------------------------- global's sub-views ---

const globalStrip = document.querySelector('.subtabs[data-for="global"]');
const globalPanels = [...document.querySelectorAll('#tab-global .editor-grid > .panel')];

function showGlobalView(view) {
  for (const panel of globalPanels) panel.classList.toggle('is-off-view', panel.id !== view);
  for (const button of globalStrip?.querySelectorAll('.subtab') ?? []) {
    button.setAttribute('aria-selected', String(button.dataset.view === view));
  }
}

if (globalStrip) {
  for (const button of globalStrip.querySelectorAll('.subtab')) {
    button.addEventListener('click', () => showGlobalView(button.dataset.view));
  }
  showGlobalView('ged-shared');

  /*
   * A sub-tab for a panel the account may not open would be a button that
   * reveals nothing. global-dashboard.js decides that asynchronously, after a
   * fetch, so watch the panel rather than racing it.
   */
  const tracker = $('tracker-login-panel');
  const trackerTab = globalStrip.querySelector('.subtab[data-view="tracker-login-panel"]');
  if (tracker && trackerTab) {
    const sync = () => {
      trackerTab.hidden = tracker.hidden;
      // Never strand the operator on a tab that just disappeared.
      if (tracker.hidden && trackerTab.getAttribute('aria-selected') === 'true') showGlobalView('ged-shared');
    };
    new MutationObserver(sync).observe(tracker, { attributes: true, attributeFilter: ['hidden'] });
    sync();
  }
}

// -------------------------------------------------------- rail: collapsed ---

/*
 * Collapsing is a preference, not state - it belongs to this browser and this
 * operator, never to the session. localStorage rather than the server for the
 * same reason the preview iframes are lazy: it is nobody else's business.
 */
const RAIL_KEY = 'vct.rail.collapsed';
const railToggle = $('rail-toggle');

function setCollapsed(collapsed) {
  document.body.classList.toggle('rail-collapsed', collapsed);
  railToggle?.setAttribute('aria-expanded', String(!collapsed));
  try {
    localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0');
  } catch {
    // A browser with storage denied still gets a working rail, just a forgetful one.
  }
}

let startCollapsed = false;
try {
  startCollapsed = localStorage.getItem(RAIL_KEY) === '1';
} catch {
  startCollapsed = false;
}
setCollapsed(startCollapsed);

railToggle?.addEventListener('click', () => setCollapsed(!document.body.classList.contains('rail-collapsed')));

