/**
 * The Global tab.
 *
 * Edits the settings that belong to the production rather than to one graphic,
 * and pushes them at whichever graphics are following. The two libraries beside
 * it - teams and player aliases - are still built by the winner and agent select
 * modules; only the panels they build into moved here, which is the whole of
 * what "put the global things in one place" needed to mean.
 *
 * Deliberately has no preview and opens no connection of its own: it rides the
 * one multiplexed /api/events stream through live.js, exactly like the other
 * three modules. Six connections per origin is a cap this dashboard has already
 * hit once.
 */

import { el, grid, help, makeFields, subhead, title } from './fields.js';
import { mediaControl } from './media-field.js';
import { onState } from './live.js';
import { mapDisplayName } from './maps.js';
import { COLOUR_SOURCES, SYNC_FIELDS } from './global-schema.js';
import { account, api } from './session.js';

/**
 * A POST with no body still has to look like one.
 *
 * The server refuses a cookie-authenticated write whose Content-Type is one a
 * cross-site HTML form could have set - that is the CSRF check. These two
 * requests carry nothing but their own URL, so without a declared type they
 * were indistinguishable from exactly the attack the rule exists to stop.
 */
const POST_JSON = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };

const $ = (id) => document.getElementById(id);
const toast = (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: message }));

const host = $('ged-shared');

let state = null;
let catalogue = { maps: [] };

const SAVE_DEBOUNCE_MS = 250;
let saveTimer = null;
let saveGeneration = 0;

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
}

async function save() {
  const generation = ++saveGeneration;
  try {
    const response = await fetch(api('/api/global'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
    if (generation === saveGeneration) state = payload.state;

    // Said out loud, because the whole point of this page is that editing it
    // reaches somewhere else - an operator should see that it landed.
    const pushed = payload.pushed ?? [];
    if (pushed.length) {
      const names = { graphic: 'scoreboard', winner: 'winner', select: 'agent select' };
      toast(`Updated the ${pushed.map((name) => names[name] ?? name).join(', ')}`);
    }
  } catch (error) {
    toast(`Global settings not saved: ${error.message}`);
  }
}

const fields = makeFields(() => state, queueSave);
const { selectField, choiceField, checkField } = fields;

function build() {
  if (!state) return;

  const mapNames = (catalogue.maps ?? []).map((map) => map.name);

  host.replaceChildren(
    title('Shared settings'),

    subhead('The match'),
    grid(2, [selectField('Map', 'mapName', mapNames)]),
    mediaControl(
      'Map image override',
      () => state.mapImage,
      (value) => {
        state.mapImage = value;
        queueSave();
      },
      { placeholder: 'https://... (blank = official splash)' },
    ),
    mediaControl(
      'Event logo',
      () => state.eventLogo,
      (value) => {
        state.eventLogo = value;
        queueSave();
      },
    ),
    help(
      'Set here once and the graphics that are following take it. The agent select webhook writes the map here ' +
        'too, so the game telling you which map it is reaches all three without anybody typing it.',
    ),

    subhead('Team colours'),
    grid(null, [choiceField('Where colours come from', 'colourSource', COLOUR_SOURCES)]),
    help(
      'A team with no colour of its own always wears the colour of the side it is playing. Attack / defence only ' +
        'goes further and puts every team in its side colour whatever they have saved, which is what a scrim or ' +
        'an event with no org branding wants. Only agent select has two live sides, so only it changes.',
    ),

    subhead('What follows this page'),
    grid(null, SYNC_FIELDS.map((entry) => checkField(entry.label, entry.key))),
    help(
      'Switch one off and that setting becomes each graphic’s own again - the value here stops being pushed ' +
        'and whatever a graphic already had stays put. Nothing is ever read back the other way: this page is the ' +
        'one that decides, or two graphics could quietly disagree about which of them won.',
    ),
  );
}

async function start() {
  if (!host) return;

  const [global, assetData] = await Promise.all([
    fetch(api('/api/global')).then((r) => r.json()),
    fetch('/api/valorant-assets')
      .then((r) => (r.ok ? r.json() : { maps: [] }))
      .catch(() => ({ maps: [] })),
  ]);

  state = global.state;
  catalogue = assetData;

  // Resolved again here for the same reason the other pages do it: a map code
  // name written by the feed before the catalogue loaded should still show as
  // the map's real name once it arrives.
  state.mapName = mapDisplayName(catalogue, state.mapName);
  build();

  // Another dashboard, or the game feed, may move any of this.
  //
  // The handler takes the state itself, not an envelope around it: live.js has
  // already unwrapped `.state` off the frame before it calls a listener. This
  // was the only one of thirteen onState call sites that destructured, so
  // `next` was always undefined, `state` became undefined, build() bailed on
  // its own guard, and the next keystroke in any Global control threw inside
  // writePath - where live.js catches and swallows it. The visible symptom was
  // that the Global tab did not follow another dashboard's edits at all.
  onState('global', (next) => {
    if (saveTimer) return; // mid-edit; our own save is about to land
    state = next;
    build();
  });
}

start().catch((error) => toast(`Global settings unavailable: ${error.message}`));

// ------------------------------------------------- tracker.gg login ---

/**
 * Clear the Cloudflare challenge from any browser.
 *
 * The solve has to happen in the server's own Chrome - the clearance is bound
 * to the address and user agent that earned it - so what this offers is a view
 * of that browser, not a local one. The server starts it; every dashboard sees
 * the progress on the shared stream, so two operators cannot both think it is
 * their job.
 */
{
  const startBtn = document.getElementById('tracker-login-start');
  const doneBtn = document.getElementById('tracker-login-done');
  const statusEl = document.getElementById('tracker-login-status');
  const passwordEl = document.getElementById('tracker-login-password');
  const viewEl = document.getElementById('tracker-login-view');

  /*
   * The whole panel goes if the source is off, or if this account may not open
   * a solve.
   *
   * Not merely the button in either case: everything it explains is about
   * something the reader cannot do, and a page carrying three paragraphs on
   * clearing a Cloudflare challenge is a page that costs an operator time to
   * read past. The server refuses both ways regardless - this is the courtesy,
   * not the lock.
   */
  void Promise.all([
    fetch('/api/config').then((response) => (response.ok ? response.json() : null)),
    account(),
  ])
    .then(([config, me]) => {
      const panel = document.getElementById('tracker-login-panel');
      if (panel) panel.hidden = !config?.trackerEnabled || !me?.user?.mayOpenTrackerLogin;
    })
    .catch(() => {});

  if (startBtn) {
    /*
     * Same-origin, so this works over the Cloudflare tunnel as well as on the
     * LAN: gfx.maahir.dev maps to the app's port and nothing else, and a viewer
     * pointing at a second port would simply not resolve from outside.
     *
     * `path` tells noVNC where to open its websocket, which has to carry the
     * same prefix or it would connect to this origin's root. The password is
     * filled in for the operator rather than typed - it exists to keep the
     * viewer off a stray scanner, and making three people copy it by hand
     * mid-broadcast buys nothing.
     */
    const viewerUrl = (password) => {
      const params = new URLSearchParams({
        autoconnect: '1',
        resize: 'scale',
        reconnect: '1',
        path: 'tracker-login/websockify',
      });
      if (password) params.set('password', password);
      return `/tracker-login/vnc.html?${params}`;
    };

    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      try {
        const response = await fetch('/api/tracker/login', POST_JSON);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);

        // The viewer and the password both arrive on the stream, for every
        // dashboard rather than just this one - see the onState below.
      } catch (error) {
        startBtn.disabled = false;
        toast(`Could not start the login: ${error.message}`);
      }
    });

    // The viewer has no window manager, so there is no title bar to close the
    // browser with - this is how a solve ends.
    doneBtn.addEventListener('click', () => {
      fetch('/api/tracker/login/cancel', POST_JSON).catch(() => {});
    });

    onState('trackerLogin', (next) => {
      startBtn.disabled = next.active;
      doneBtn.hidden = !next.active;
      statusEl.className = `save-status${next.phase === 'failed' ? ' failed' : next.active ? ' saving' : ''}`;
      statusEl.textContent = next.message || (next.active ? 'Starting...' : 'Not running');

      // An operator who did not start it gets the viewer and the password too,
      // so whoever is actually at a keyboard can finish the solve.
      if (next.active && next.phase === 'ready' && viewEl.hidden) {
        viewEl.hidden = false;
        viewEl.src = viewerUrl(next.password);
        passwordEl.hidden = false;
        passwordEl.textContent = 'Clear the Cloudflare challenge in the window below, then press Done.';
      }

      if (!next.active) {
        // Torn down server-side the moment the solve ends, so a viewer left
        // pointing at it would just show a dead connection.
        viewEl.hidden = true;
        viewEl.removeAttribute('src');
        passwordEl.hidden = true;
      }
    });
  }
}
