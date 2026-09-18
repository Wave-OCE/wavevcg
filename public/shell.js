/**
 * The rail, the sub-tab strips, and the page heading.
 *
 * Presentation only. Nothing here changes what a button does - every real tab
 * button still carries .tab and data-tab, and dashboard.js still collects them
 * with the same querySelectorAll it always used. This module only decides which
 * of them are on screen, which rail item looks current, and what the heading
 * says.
 *
 * All the rail items but one ARE tab buttons. That is deliberate: it means
 * dashboard.js wires them for free, and account.js still finds
 * .tab[data-tab="admin"] to hide from non-administrators. Graphics is the one
 * exception - it names three panels rather than one, so it is a plain button
 * and the mapping below is the whole cost of that.
 *
 * ---------------------------------------------------------------------------
 * Two kinds of strip, which look identical and are not
 * ---------------------------------------------------------------------------
 *
 * Graphics' three entries are three separate PANELS, so its strip is three real
 * tabs and dashboard.js switches them. Global and Tournament are each ONE panel
 * holding several sections, so their strips switch sections inside it and this
 * file does the work. Hence .tab against .subtab: a strip that looks the same
 * to an operator and is wired somewhere completely different.
 */

const $ = (id) => document.getElementById(id);

/** Which rail item lights up for a given tab. */
/*
 * Which rail group owns each screen.
 *
 * Graphics was one section holding three screens and is now THREE, because
 * seven in one strip is a strip that wraps at narrow widths and that nobody can
 * scan. The split is by what the graphic is ABOUT rather than by when it was
 * built: a match, a team, or the draw.
 */
const SECTION_OF = {
  lookup: 'lookup',
  setup: 'setup',
  graphic: 'match',
  winner: 'match',
  select: 'match',
  lineup: 'team',
  headToHead: 'team',
  vetoBoard: 'team',
  global: 'global',
  tournament: 'tournament',
  account: 'account',
  admin: 'admin',
};

/**
 * Each group's screens, and the one it opens on.
 *
 * `lastOf` remembers where you were per group, which is what makes a rail item
 * one click rather than two for the screen you were actually using. It was one
 * variable for the single Graphics group; three groups means a map, and keeping
 * the memory per group is the whole reason the split is tolerable.
 */
const GROUP_TABS = {
  match: ['graphic', 'winner', 'select'],
  team: ['lineup', 'headToHead', 'vetoBoard'],
};
const lastOf = { match: 'graphic', team: 'lineup' };

/**
 * The heading, per tab.
 *
 * The sub-line is the one place on the page that says what the screen is FOR,
 * and an operator reads it once and never again - so it is worth the words.
 */
const PAGE = {
  lookup: ['Match lookup', 'Find a finished game and send it to a graphic'],
  setup: ['Match setup', 'Stage the lobby for GStack to collect'],
  graphic: ['Post match', 'The end-of-map scoreboard'],
  winner: ['Winner splash', 'The end-of-series sequence'],
  select: ['Agent select', 'The draft strip'],
  lineup: ['Team lineup', 'A squad, full screen'],
  headToHead: ['Head to head', 'Two orgs before a match'],
  vetoBoard: ['Map veto', 'The bans and picks, on air'],
  global: ['Global', 'Settings and libraries shared by every graphic'],
  tournament: ['Tournament', 'The competition, and who may work on it'],
  account: ['Account', 'Your keys, your sessions, and who may reach them'],
  admin: ['Admin', 'Server-wide switches, accounts and the log'],
};

const railItems = [...document.querySelectorAll('.rail-item')];
const strips = [...document.querySelectorAll('.subtabs')];
const pageTitle = $('page-title');
const pageSub = $('page-sub');

// --------------------------------------------------------------- painting ---

function paint(tab) {
  const section = SECTION_OF[tab];
  if (!section) return;
  if (GROUP_TABS[section]?.includes(tab)) lastOf[section] = tab;

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
  const group = item.dataset.section;
  if (!group || !GROUP_TABS[group]) continue;
  // Click the real tab rather than duplicating what it does. Everything
  // downstream of a tab press - the lazy preview load, the body class, the
  // app-tab event - then happens exactly once, in the one place it is written.
  item.addEventListener('click', () => {
    document.querySelector(`.tab[data-tab="${lastOf[group]}"]`)?.click();
  });
}

// ----------------------------------------------------------- sub-views ---

/*
 * A strip that switches SECTIONS inside one panel, as opposed to Graphics'
 * strip, which switches between three real tabs. Global was the only one; the
 * Tournament page is the second, so the machinery is a loop over a table rather
 * than a copy.
 *
 * The section switch toggles a CLASS rather than `hidden`, because the
 * dashboards own `hidden` on some of these panels - global-dashboard.js hides
 * the tracker panel when the server has tracker.gg off, and
 * tournament-dashboard.js hides its panels when there is no tournament to show.
 * Two owners for one attribute is a race; a class and an attribute compose, and
 * either one hiding is enough.
 */
const SUBVIEWS = [
  { section: 'global', panels: '#tab-global .editor-grid > .panel', first: 'ged-shared' },
  { section: 'tournament', panels: '#tab-tournament .editor-grid > .panel', first: 'tou-settings' },
];

for (const { section, panels, first } of SUBVIEWS) {
  const strip = document.querySelector(`.subtabs[data-for="${section}"]`);
  const found = [...document.querySelectorAll(panels)];
  if (!strip || !found.length) continue;

  const show = (view) => {
    for (const panel of found) panel.classList.toggle('is-off-view', panel.id !== view);
    for (const button of strip.querySelectorAll('.subtab')) {
      button.setAttribute('aria-selected', String(button.dataset.view === view));
    }
  };
  for (const button of strip.querySelectorAll('.subtab')) {
    button.addEventListener('click', () => show(button.dataset.view));
  }
  show(first);

  /*
   * A sub-tab for a panel the account may not open would be a button that
   * reveals nothing. The dashboards decide that asynchronously, after a fetch,
   * so watch the panel rather than racing it.
   */
  for (const button of strip.querySelectorAll('.subtab')) {
    const panel = $(button.dataset.view);
    if (!panel) continue;
    const sync = () => {
      button.hidden = panel.hidden;
      // Never strand the operator on a tab that just disappeared.
      if (panel.hidden && button.getAttribute('aria-selected') === 'true') show(first);
    };
    new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
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

// ---------------------------------------------------- graphics: the cards ---

/*
 * Which settings cards are on screen, per graphic.
 *
 * The three graphics tabs carried four or five editor cards each, all open at
 * once, and an operator scrolled past the ones they were not using to reach the
 * one they were. These bars group them: Data / Animation / Style and so on, one
 * group at a time.
 *
 * What it never touches is the transport. The toolbar, the cue bar and the take
 * bar all sit ABOVE the preview and stay put, so nothing an operator needs
 * mid-map can end up behind a click. Only the editors below the preview group.
 *
 * Hiding is safe here in a way it would not be everywhere: the only thing these
 * tabs measure is the preview iframe, which is never in a group. A card that is
 * shut is still bound and still live - it is a card without a seat, not a card
 * that stopped working.
 *
 * The choice is remembered per graphic, because it is per graphic that it
 * matters: you live in Data during a match and in Style before one, and the
 * winner splash's answer has nothing to do with the scoreboard's.
 */
const CARDS_KEY = 'vct.cards.';

function showCardGroup(tab, group) {
  const bar = document.querySelector(`.card-tabs[data-cards="${tab}"]`);
  const grid = document.querySelector(`.editor-grid[data-cards="${tab}"]`);
  if (!bar || !grid) return;

  let shown = 0;
  for (const panel of grid.querySelectorAll(':scope > .panel')) {
    const off = panel.dataset.group !== group;
    panel.classList.toggle('is-off-view', off);
    if (!off) shown += 1;
  }
  for (const button of bar.querySelectorAll('.card-tab')) {
    button.setAttribute('aria-selected', String(button.dataset.group === group));
  }

  // How many survived, so one card does not stretch itself across three
  // columns' worth of window. CSS reads it; see .editor-grid[data-visible].
  grid.dataset.visible = String(Math.min(shown, 3));

  try {
    localStorage.setItem(CARDS_KEY + tab, group);
  } catch {
    // Same as the rail: a browser with storage denied still gets working tabs.
  }
}

for (const bar of document.querySelectorAll('.card-tabs')) {
  const tab = bar.dataset.cards;
  const groups = [...bar.querySelectorAll('.card-tab')].map((b) => b.dataset.group);

  for (const button of bar.querySelectorAll('.card-tab')) {
    button.addEventListener('click', () => showCardGroup(tab, button.dataset.group));
  }

  // A remembered group that no longer exists (a group renamed, a card moved)
  // would leave every card shut and the bar pointing at nothing.
  let start = groups[0];
  try {
    const saved = localStorage.getItem(CARDS_KEY + tab);
    if (saved && groups.includes(saved)) start = saved;
  } catch {
    start = groups[0];
  }
  showCardGroup(tab, start);
}
