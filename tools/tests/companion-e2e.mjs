/**
 * The Bitfocus Companion control channel, end to end against a real server.
 *
 * What matters, in rough order of what would hurt most if it broke:
 *
 *   - The control key is NOT the session key. A session key must not open this,
 *     and the refusal must say which key was wrong.
 *   - An op is the same store write the dashboard button makes, so the graphic
 *     actually moves - asserted by reading the state back over HTTP.
 *   - Updates are targeted: a winner op sends winner keys and nothing else.
 *   - Ordinary editing is silent. This is the cue-counter lesson: a control
 *     channel that repainted on every keystroke would be useless.
 *   - One TOURNAMENT's channel never sees another's graphics. A control key
 *     names a production, not a person, so the isolation that matters is
 *     between productions - two people on the same tournament are supposed to
 *     drive the same desk.
 *   - Rotating the key drops the socket that the old key opened.
 *   - No secret reaches the log.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect } from 'node:net';

import { fileURLToPath } from 'node:url';

import { makeTournament, signIn } from './harness.mjs';

// The checkout this suite lives in, resolved from the suite's own location so
// that moving the tree does not break it.
const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8163;
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/api/companion`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-comp-'));

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
};

const server = spawn(process.execPath, ['server.js'], {
  cwd: PROJECT,
  env: {
    ...process.env,
    PORT: String(PORT),
    STATE_DIR: STATE,
    ADMIN_USERNAME: 'boss',
    ADMIN_PASSWORD: 'a-long-enough-password',
    TRACKER_ENABLED: 'false',
    LOG_LEVEL: 'info',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (c) => (log += c));
server.stderr.on('data', (c) => (log += c));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A client that keeps every message, so a test can wait for one that matches
 * rather than for "the next one" - which is racy the moment the server sends
 * an unsolicited push.
 */
function open(key) {
  const socket = new WebSocket(`${WS}?key=${encodeURIComponent(key)}`);
  const seen = [];
  const waiters = [];
  let closed = null;

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    seen.push(message);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  });
  socket.addEventListener('close', (event) => {
    closed = { code: event.code, reason: event.reason };
    for (const waiter of waiters.splice(0)) waiter.resolve(null);
  });

  return {
    socket,
    seen,
    get closed() {
      return closed;
    },
    ready: new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve(true));
      socket.addEventListener('error', () => reject(new Error('socket failed to open')));
    }),
    send: (data) => socket.send(typeof data === 'string' ? data : JSON.stringify(data)),
    /** Anything already seen that matches, or the next one that does. */
    next(predicate, ms = 2500) {
      const found = seen.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at !== -1) waiters.splice(at, 1);
          resolve(null);
        }, ms);
      });
    },
    /** Drop what has been seen, so a later `next` cannot match an old message. */
    clear: () => seen.splice(0),
    close: () => socket.close(),
  };
}

/** The raw handshake, for the cases where it must be refused with a status. */
function handshake(query, extraHeaders = '') {
  return new Promise((resolve) => {
    const socket = connect(PORT, '127.0.0.1', () => {
      socket.write(
        `GET /api/companion${query} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${PORT}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          extraHeaders +
          '\r\n',
      );
    });
    /*
     * Wait for the BODY, not just the headers.
     *
     * The refusal message is the body, and it routinely arrives in a second TCP
     * segment - so resolving on the blank line after the headers made every
     * assertion about the wording pass or fail on timing. Content-Length says
     * how much there is to wait for.
     */
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
      const split = data.indexOf('\r\n\r\n');
      if (split === -1) return;
      const length = Number(/content-length: (\d+)/i.exec(data.slice(0, split))?.[1] ?? 0);
      if (data.length - (split + 4) < length) return; // body still in flight
      socket.destroy();
      resolve(data);
    });
    socket.on('error', () => resolve(data));
    socket.on('close', () => resolve(data));
    setTimeout(() => {
      socket.destroy();
      resolve(data);
    }, 2500);
  });
}

const statusOf = (raw) => Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0);

try {
  for (let i = 0; i < 80; i += 1) {
    try {
      await fetch(`${BASE}/api/auth/state`);
      break;
    } catch {
      await wait(250);
    }
  }

  // --------------------------------------------------------- productions ---
  /*
   * Both keys belong to a TOURNAMENT now, so one has to exist before there is
   * anything to point either a browser source or a stream deck at. A person
   * carries neither key.
   */
  const { cookie } = await signIn(BASE, 'boss', 'a-long-enough-password');
  const first = await makeTournament(BASE, cookie, 'Companion');
  const sessionKey = first.key;

  const JSON_POST = { 'Content-Type': 'application/json', Cookie: cookie };

  /*
   * Every dashboard-side read and write says which production it means.
   *
   * Without `?session=` the server picks the newest tournament this account can
   * see, and this suite makes a second one half way through - so a bare URL
   * would quietly start answering about the other production from that point
   * on, and the isolation assertions would be reading the board they were
   * meant to be proving untouched.
   */
  const on = (tournamentId, pathAndQuery) =>
    `${BASE}${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}session=${encodeURIComponent(tournamentId)}`;

  /** A tournament as its owner sees it, which is where hasControlKey lives. */
  const tournamentNow = async (id) => {
    const payload = await (await fetch(`${BASE}/api/tournaments`, { headers: { Cookie: cookie } })).json();
    return payload.tournaments.find((t) => t.id === id);
  };

  /** Mint, re-mint or withdraw a tournament's control key. Owner-only. */
  const controlKeyFor = async (id, mode) =>
    (
      await fetch(`${BASE}/api/tournaments`, {
        method: 'POST',
        headers: JSON_POST,
        body: JSON.stringify({ action: 'control-key', id, ...(mode ? { mode } : {}) }),
      })
    ).json();

  // ------------------------------------------------------- default closed ---
  const before = await tournamentNow(first.id);
  ok('a tournament starts with no control key', before.hasControlKey === false, JSON.stringify(before.hasControlKey));
  ok('and the value is not sent either', !before.controlKey, 'a key existed before it was asked for');

  const blank = await handshake('?key=');
  ok('an empty key is refused', statusOf(blank) === 401, String(statusOf(blank)));

  const noKeyYet = await handshake(`?key=${sessionKey}`);
  ok(
    'a session key does not open the control channel',
    statusOf(noKeyYet) === 403,
    String(statusOf(noKeyYet)),
  );
  ok(
    'and the refusal names which key was wrong',
    /session key/i.test(noKeyYet) && /control key/i.test(noKeyYet),
    noKeyYet.split('\r\n\r\n')[1] ?? '',
  );

  // ------------------------------------------------------------ minting ---
  const minted = await controlKeyFor(first.id);
  const controlKey = minted.controlKey;
  ok('minting returns a control key', Boolean(controlKey) && controlKey.length > 20, String(controlKey));
  ok('which is not the session key', controlKey !== sessionKey, 'THE TWO KEYS ARE THE SAME');
  ok('and the tournament now reports having one', (await tournamentNow(first.id)).hasControlKey === true);

  const junk = await handshake('?key=not-a-real-key-at-all');
  ok('a key that names nobody is refused', statusOf(junk) === 403, String(statusOf(junk)));

  // ---------------------------------------------------------- connecting ---
  const a = open(controlKey);
  await a.ready;
  ok('a control key opens the channel', a.socket.readyState === WebSocket.OPEN);

  const hello = await a.next((m) => m.type === 'hello');
  ok('the server says hello first', Boolean(hello), JSON.stringify(a.seen[0]));
  ok('and names a protocol version', hello?.protocol === 1, String(hello?.protocol));
  // The channel belongs to a production, so what it names is the tournament -
  // which is also the thing an operator with two decks needs told apart.
  ok('and names the production', hello?.session === 'Companion', String(hello?.session));

  /*
   * State on connect is load-bearing, not a nicety: Companion's module blanks
   * every variable each time it reconnects, so a channel that only spoke on
   * change would leave every button dark until somebody pressed something.
   */
  for (const graphic of ['scoreboard', 'winner', 'select']) {
    ok(
      `${graphic} state arrives unprompted on connect`,
      Boolean(await a.next((m) => m.type === 'state' && m.graphic === graphic)),
      'no snapshot',
    );
  }

  // -------------------------------------------------------- the scoreboard ---
  /*
   * PREVIEW. Since the preview/program split a Companion op stages - `take` is
   * the only one that reaches an audience - so this is where an op's effect
   * shows up, and the *Air readers below are how the suite checks it did not
   * leak.
   */
  const graphicState = async () =>
    (await (await fetch(on(first.id, '/api/graphic?bus=preview'), { headers: { Cookie: cookie } })).json()).state;
  const graphicAir = async () =>
    (await (await fetch(on(first.id, '/api/graphic?bus=program'), { headers: { Cookie: cookie } })).json()).state;
  const winnerAir = async () =>
    (await (await fetch(on(first.id, '/api/winner?bus=program'), { headers: { Cookie: cookie } })).json()).state;

  a.clear();
  a.send('scoreboard.show');
  const shown = await a.next((m) => m.type === 'state' && m.graphic === 'scoreboard');
  ok('a bare string op is accepted', Boolean(shown), 'no answer');
  ok('and reports the scoreboard on air', shown?.scoreboard_visible === true, JSON.stringify(shown?.scoreboard_visible));
  ok('with a 1/0 twin for the feedback comparison', shown?.scoreboard_visible_n === 1, String(shown?.scoreboard_visible_n));
  ok('the graphic really moved', (await graphicState()).anim.visible === true, 'store not written');
  ok('and an ok acknowledges the press', Boolean(await a.next((m) => m.type === 'ok' && m.op === 'show')));

  /*
   * Targeting, which was the explicit requirement: an op on one graphic must
   * not repaint the others.
   */
  const strays = a.seen.filter((m) => m.type === 'state' && m.graphic !== 'scoreboard');
  ok('nothing else was sent', strays.length === 0, strays.map((m) => m.graphic).join(', '));
  const keys = Object.keys(shown ?? {}).filter((k) => k.startsWith('winner_') || k.startsWith('select_'));
  ok('and the message carries no other graphic’s keys', keys.length === 0, keys.join(', '));

  a.clear();
  a.send('scoreboard.toggle');
  await a.next((m) => m.type === 'ok');
  ok('toggle takes it off again', (await graphicState()).anim.visible === false);

  a.clear();
  a.send('scoreboard.toggle');
  await a.next((m) => m.type === 'ok');
  ok('and back on', (await graphicState()).anim.visible === true);

  // Trailing CRLF: Companion's send action appends it by default.
  a.clear();
  a.send('scoreboard.hide\r\n');
  await a.next((m) => m.type === 'ok');
  ok('a trailing CRLF is tolerated', (await graphicState()).anim.visible === false, 'CRLF broke the op');

  // ---- swap sides / swap names, which are the post-match buttons ----
  await fetch(on(first.id, '/api/graphic?bus=preview'), {
    method: 'POST',
    headers: JSON_POST,
    body: JSON.stringify({
      state: {
        ...(await graphicState()),
        left: { ...(await graphicState()).left, teamName: 'ALPHA', roundsWon: 13 },
        right: { ...(await graphicState()).right, teamName: 'BETA', roundsWon: 7 },
      },
    }),
  });

  a.clear();
  a.send('scoreboard.swap');
  await a.next((m) => m.type === 'ok');
  const swapped = await graphicState();
  ok('swap sides moves the names', swapped.left.teamName === 'BETA' && swapped.right.teamName === 'ALPHA', `${swapped.left.teamName}/${swapped.right.teamName}`);
  ok('and takes the scores with them', swapped.left.roundsWon === 7 && swapped.right.roundsWon === 13, `${swapped.left.roundsWon}-${swapped.right.roundsWon}`);

  a.clear();
  a.send('scoreboard.swapNames');
  await a.next((m) => m.type === 'ok');
  const named = await graphicState();
  ok('swap names moves the names back', named.left.teamName === 'ALPHA' && named.right.teamName === 'BETA', `${named.left.teamName}/${named.right.teamName}`);
  ok('and leaves the scores where they were', named.left.roundsWon === 7 && named.right.roundsWon === 13, `${named.left.roundsWon}-${named.right.roundsWon}`);

  // An alias, and a separator that is not a dot.
  a.clear();
  a.send('scoreboard/sides');
  ok('an alias with a slash separator works', Boolean(await a.next((m) => m.type === 'ok' && m.op === 'swap')), 'alias refused');

  // ---- sort ----
  const withPlayers = await graphicState();
  withPlayers.left.players[0] = { ...withPlayers.left.players[0], name: 'low', acs: 100 };
  withPlayers.left.players[1] = { ...withPlayers.left.players[1], name: 'high', acs: 300 };
  await fetch(on(first.id, '/api/graphic?bus=preview'), { method: 'POST', headers: JSON_POST, body: JSON.stringify({ state: withPlayers }) });

  a.clear();
  a.send('scoreboard.sort');
  await a.next((m) => m.type === 'ok');
  ok('sort puts the top ACS first', (await graphicState()).left.players[0].name === 'high', (await graphicState()).left.players[0].name);

  // ------------------------------------------------------------- silence ---
  /*
   * The cue-counter lesson, enforced. Editing a field the buttons cannot show
   * must produce no traffic at all, or a stream deck spends the broadcast
   * redrawing while somebody types.
   */
  a.clear();
  const quiet = await graphicState();
  await fetch(on(first.id, '/api/graphic?bus=preview'), {
    method: 'POST',
    headers: JSON_POST,
    body: JSON.stringify({ state: { ...quiet, preset: { ...quiet.preset, panelOpacity: 0.42 } } }),
  });
  await wait(400);
  ok('an edit the buttons cannot show sends nothing', a.seen.length === 0, JSON.stringify(a.seen.map((m) => m.graphic)));

  a.clear();
  const loud = await graphicAir();
  await fetch(on(first.id, '/api/graphic?bus=program'), {
    method: 'POST',
    headers: JSON_POST,
    body: JSON.stringify({ state: { ...loud, left: { ...loud.left, teamName: 'RENAMED' } } }),
  });
  const renamed = await a.next((m) => m.type === 'state' && m.scoreboard_left === 'RENAMED');
  ok('but a change a button shows does arrive', Boolean(renamed), 'no push for a visible change');

  // And the staged half moves on its own, which is the new thing a button can
  // watch: something is waiting, without knowing or caring what.
  /*
   * Start from a clean slate. Earlier blocks have staged things, so the lamp is
   * already lit - and a projection that does not CHANGE is not pushed, which
   * would make the assertion below wait for a message that never comes and
   * report a working lamp as broken.
   */
  a.clear();
  a.send('scoreboard.take');
  await a.next((m) => m.type === 'state' && m.scoreboard_staged_n === 0);

  a.clear();
  const toStage = await graphicState();
  await fetch(on(first.id, '/api/graphic?bus=preview'), {
    method: 'POST',
    headers: JSON_POST,
    body: JSON.stringify({ state: { ...toStage, map: 'A-STAGED-MAP' } }),
  });
  ok('staging lights the staged lamp', Boolean(await a.next((m) => m.type === 'state' && m.scoreboard_staged_n === 1)), 'lamp never lit');
  a.clear();
  a.send('scoreboard.take');
  ok('and taking puts it out again', Boolean(await a.next((m) => m.type === 'state' && m.scoreboard_staged_n === 0)), 'lamp stayed lit');
  ok('with the map now on air', (await graphicAir()).map === 'A-STAGED-MAP', (await graphicAir()).map);

  // -------------------------------------------------------------- winner ---
  const winnerState = async () =>
    (await (await fetch(on(first.id, '/api/winner?bus=preview'), { headers: { Cookie: cookie } })).json()).state;

  // Auto-advance would walk the stage out from under the assertions.
  const w0 = await winnerState();
  await fetch(on(first.id, '/api/winner?bus=preview'), {
    method: 'POST',
    headers: JSON_POST,
    body: JSON.stringify({ state: { ...w0, seq: { ...w0.seq, autoAdvance: false } } }),
  });

  a.clear();
  a.send('winner.next');
  const refused = await a.next((m) => m.type === 'error');
  ok('next is refused while the sequence is off air', Boolean(refused), 'not refused');
  ok('and says why in words', /not on air/i.test(refused?.message ?? ''), refused?.message);
  ok('the refusal does not close the socket', a.socket.readyState === WebSocket.OPEN);

  a.clear();
  a.send({ op: 'winner.activate', id: 'abc' });
  const active = await a.next((m) => m.type === 'state' && m.graphic === 'winner');
  ok('activate answers', Boolean(active), 'no state after activate');
  /*
   * The unqualified names are AIR - here, on the SSE channels and on the HTTP
   * routes. So activate does not move them; it stages. This is the feature, and
   * it is the assertion that would catch it quietly going back to driving air.
   */
  ok('ACTIVATE DOES NOT PUT IT ON AIR', active?.winner_active === false, String(active?.winner_active));
  ok('but preview holds scene 1', active?.winner_preview_scene === 1, String(active?.winner_preview_scene));
  ok('and says so as a legend', active?.winner_preview_air === 'SCENE 1', String(active?.winner_preview_air));
  ok('and the staged lamp is lit', active?.winner_staged_n === 1, String(active?.winner_staged_n));
  ok('the server agrees preview is up', (await winnerState()).seq.active === true);
  ok('and that air is not', (await winnerAir()).seq.active === false);
  ok('and the id is echoed for correlation', (await a.next((m) => m.type === 'ok'))?.id === 'abc');

  a.clear();
  a.send('winner.take');
  const aired = await a.next((m) => m.type === 'state' && m.winner_active === true);
  ok('TAKE PUTS IT ON AIR', Boolean(aired), 'take did not reach air');
  ok('at scene 1, one-based', aired?.winner_scene === 1, String(aired?.winner_scene));
  ok('and the legend follows', aired?.winner_air === 'SCENE 1', String(aired?.winner_air));
  ok('back is not available on the first scene', aired?.winner_can_prev === false, String(aired?.winner_can_prev));
  ok('next is', aired?.winner_can_next === true, String(aired?.winner_can_next));
  ok('and nothing is staged any more', aired?.winner_staged_n === 0, String(aired?.winner_staged_n));
  ok('the ok says which bus the op used', (await a.next((m) => m.type === 'ok' && m.op === 'take'))?.bus === 'preview');

  a.clear();
  a.send('winner.next');
  const scene2 = await a.next((m) => m.type === 'state' && m.winner_preview_scene === 2);
  ok('next advances preview a scene', Boolean(scene2), 'did not advance');
  ok('and the server agrees', (await winnerState()).seq.stage === 1, String((await winnerState()).seq.stage));
  ok('WHILE AIR STAYS ON SCENE 1', (await winnerAir()).seq.stage === 0, String((await winnerAir()).seq.stage));

  a.clear();
  a.send('winner.take');
  const onTwo = await a.next((m) => m.type === 'state' && m.winner_scene === 2);
  ok('and the take carries the scene across', Boolean(onTwo), 'scene did not reach air');
  ok('now back is available', onTwo?.winner_can_prev === true);
  ok('and the scene is named', onTwo?.winner_scene_label?.length > 0, String(onTwo?.winner_scene_label));

  a.clear();
  a.send('winner.prev');
  ok('prev goes back on preview', Boolean(await a.next((m) => m.type === 'state' && m.winner_preview_scene === 1)), 'did not go back');

  a.clear();
  a.send({ op: 'winner.stage', value: 3 });
  const cut = await a.next((m) => m.type === 'state' && m.winner_preview_scene === 3);
  ok('stage cuts straight to a scene', Boolean(cut), 'no cut');

  a.clear();
  a.send('winner.take');
  const lastScene = await a.next((m) => m.type === 'state' && m.winner_scene === 3);
  ok('and the take follows', Boolean(lastScene), 'not aired');
  ok('and there is no next from the last one', lastScene?.winner_can_next === false, String(lastScene?.winner_can_next));

  a.clear();
  a.send('winner.next');
  ok('which is refused', Boolean(await a.next((m) => m.type === 'error')), 'not refused at the end');

  a.clear();
  a.send('winner.stop');
  await a.next((m) => m.type === 'ok');
  ok('stop takes preview off', (await winnerState()).seq.active === false);
  a.clear();
  a.send('winner.take');
  ok('and the take clears air', Boolean(await a.next((m) => m.type === 'state' && m.winner_active === false)));

  // A cue must have moved for the output pages to react at all.
  const cueBefore = (await winnerState()).seq.cue;
  a.clear();
  a.send('winner.activate');
  await a.next((m) => m.type === 'ok');
  ok('every transport press bumps the cue', (await winnerState()).seq.cue !== cueBefore, 'cue did not move');

  // ---------------------------------------------------------- agent select ---
  const selectState = async () =>
    (await (await fetch(on(first.id, '/api/select?bus=preview'), { headers: { Cookie: cookie } })).json()).state;

  a.clear();
  a.send('select.show');
  const sShown = await a.next((m) => m.type === 'state' && m.graphic === 'select');
  ok('select.show stages the strip', sShown?.select_preview_air === 'UP', String(sShown?.select_preview_air));
  ok('and reports an empty board', sShown?.select_progress === '0/10', String(sShown?.select_progress));
  a.clear();
  a.send('select.take');
  ok('and the take puts it up', Boolean(await a.next((m) => m.type === 'state' && m.select_visible === true)), 'never reached air');

  /*
   * The other half of the requirement: data arriving from the game client,
   * with nobody pressing anything.
   */
  a.clear();
  await fetch(`${BASE}/api/roster?key=${encodeURIComponent(sessionKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventIndex: 0, name: 'TenZ', character: 'Jett', locked: true }),
  });
  const picked = await a.next((m) => m.type === 'state' && m.graphic === 'select' && m.select_picked === 1);
  ok('a roster event reaches the channel unprompted', Boolean(picked), 'no push from the webhook');
  ok('and names the agent in that seat', picked?.select_slot1_agent === 'Jett', String(picked?.select_slot1_agent));
  ok('and the player', picked?.select_slot1_name === 'TenZ', String(picked?.select_slot1_name));
  ok('and that they locked in', picked?.select_slot1_locked_n === 1, String(picked?.select_slot1_locked_n));
  ok('the winner was not repainted for it', !a.seen.some((m) => m.type === 'state' && m.graphic === 'winner'), 'stray winner push');

  a.clear();
  a.send('select.clockStart');
  await a.next((m) => m.type === 'ok');
  ok('the clock starts on preview', (await selectState()).timer.running === true, 'preview clock did not start');
  a.clear();
  a.send('select.take');
  const running = await a.next((m) => m.type === 'state' && m.select_clock_running === true);
  ok('and the take carries it to air', Boolean(running), 'clock never reached air');
  ok('and reports seconds left', running?.select_clock_remaining > 0, String(running?.select_clock_remaining));
  ok('as a legend too', /^\d+:\d\d$/.test(running?.select_clock ?? ''), String(running?.select_clock));

  // The one thing here that changes with nobody writing anything.
  a.clear();
  const tick = await a.next((m) => m.type === 'state' && m.reason === 'clock', 2500);
  ok('the countdown ticks on its own', Boolean(tick), 'no tick while the clock ran');

  a.clear();
  a.send('select.clockEnd');
  await a.next((m) => m.type === 'ok');
  ok('and can be ended', (await selectState()).timer.running === false);
  a.send('select.take');
  await a.next((m) => m.type === 'state' && m.select_clock_running === false);
  a.clear();
  a.send('select.clockEnd');
  ok('ending a stopped clock is refused', Boolean(await a.next((m) => m.type === 'error')), 'not refused');

  a.clear();
  a.send('select.swap');
  await a.next((m) => m.type === 'ok');
  ok('swap flips the sides', (await selectState()).swap === true);

  a.clear();
  a.send('select.clear');
  await a.next((m) => m.type === 'ok');
  const cleared = await selectState();
  ok('clear empties the board', cleared.slots.every((s) => !s.character), 'a card survived');
  ok('and forgets the game id', cleared.gameId === '', cleared.gameId);

  // ------------------------------------------------------------ protocol ---
  a.clear();
  a.send('ping');
  ok('ping is answered', Boolean(await a.next((m) => m.type === 'pong')));

  a.clear();
  a.send('ops');
  const ops = await a.next((m) => m.type === 'ops');
  ok('the socket can list what it does', Boolean(ops), 'no catalogue');
  ok('for all three graphics', ['scoreboard', 'winner', 'select'].every((g) => Array.isArray(ops?.graphics?.[g])), JSON.stringify(Object.keys(ops?.graphics ?? {})));

  a.clear();
  a.send('winner.nonsense');
  const unknown = await a.next((m) => m.type === 'error');
  ok('an unknown op is an error, not a disconnect', Boolean(unknown) && a.socket.readyState === WebSocket.OPEN);
  ok('and points at the catalogue', /ops/.test(unknown?.message ?? ''), unknown?.message);

  a.clear();
  a.send('next');
  ok('an op with no graphic is refused', Boolean(await a.next((m) => m.type === 'error')), 'ambiguous op accepted');

  a.clear();
  a.send('{not json');
  ok('a malformed message is an error, not a disconnect', Boolean(await a.next((m) => m.type === 'error')) && a.socket.readyState === WebSocket.OPEN);

  /*
   * Companion's optional keepalive sends a one-byte BINARY frame. Refusing it
   * would disconnect the operator every few seconds, so it must be ignored.
   */
  a.clear();
  a.socket.send(new Uint8Array([0x00]));
  await wait(300);
  ok('a stray binary frame does not close the socket', a.socket.readyState === WebSocket.OPEN, 'binary killed the channel');
  a.send('ping');
  ok('and the channel still works after one', Boolean(await a.next((m) => m.type === 'pong')));

  a.clear();
  a.send({ op: 'state', graphic: 'winner' });
  const asked = await a.next((m) => m.type === 'state' && m.graphic === 'winner');
  ok('a snapshot can be asked for', Boolean(asked), 'no snapshot on request');
  ok('and only that graphic comes back', !a.seen.some((m) => m.type === 'state' && m.graphic !== 'winner'), 'sent more than asked');

  // ----------------------------------------------------------- isolation ---
  /*
   * A second PRODUCTION, not a second person.
   *
   * What has to hold is that two desks driving two competitions never see each
   * other, and a production is a tournament now - so two accounts sharing one
   * tournament would be the wrong shape entirely: they are supposed to see the
   * same board. One owner with two tournaments is both the real operator case
   * and the one where a leak would actually be a leak.
   */
  const secondTournament = await makeTournament(BASE, cookie, 'Somebody else');
  const second = await controlKeyFor(secondTournament.id);
  const b = open(second.controlKey);
  await b.ready;
  await b.next((m) => m.type === 'hello');
  ok('a second production gets its own channel', b.socket.readyState === WebSocket.OPEN);

  /*
   * Wait for all three of B's own connect snapshots before clearing.
   *
   * Clearing on `hello` alone is a race - the snapshots follow in the same
   * tick and land just after - and the symptom is this isolation check failing
   * on a stray `state` that is B's own board. Waiting for the third makes the
   * next assertion mean what it says.
   */
  for (const graphic of ['scoreboard', 'winner', 'select']) {
    await b.next((m) => m.type === 'state' && m.graphic === graphic);
  }

  // The first production's scoreboard says RENAMED by now; B's says nothing of
  // the sort.
  const bOwnBoard = b.seen.find((m) => m.type === 'state' && m.graphic === 'scoreboard');
  ok('and its own board is not the first production’s', bOwnBoard?.scoreboard_left !== 'RENAMED', String(bOwnBoard?.scoreboard_left));

  b.clear();
  a.clear();
  a.send('scoreboard.show');
  await a.next((m) => m.type === 'ok');
  await wait(400);
  ok(
    'one production’s press never reaches another’s channel',
    !b.seen.some((m) => m.type === 'state'),
    JSON.stringify(b.seen.map((m) => `${m.type}:${m.graphic ?? ''}`)),
  );
  // Content, not just traffic - the check that would survive a rewrite of when
  // pushes happen.
  ok(
    'and no message on it has ever carried the other production’s data',
    !JSON.stringify(b.seen).includes('RENAMED'),
    'CROSS-TENANT LEAK',
  );

  b.clear();
  b.send('scoreboard.hide');
  await b.next((m) => m.type === 'ok');
  ok('and the two graphics are different', (await graphicState()).anim.visible === true, 'the second production moved the first’s graphic');

  // -------------------------------------------------------- key rotation ---
  const held = a.socket;
  const rotated = await controlKeyFor(first.id);
  await wait(600);
  ok('rotating the key drops the channel it opened', held.readyState === WebSocket.CLOSED || Boolean(a.closed), String(held.readyState));

  const stale = await handshake(`?key=${controlKey}`);
  ok('and the old key no longer opens one', statusOf(stale) === 403, String(statusOf(stale)));
  ok('the other production is untouched', b.socket.readyState === WebSocket.OPEN, 'rotation dropped somebody else');

  // ---- withdrawing it entirely ----
  const fresh = rotated.controlKey;
  ok('the rotation handed back a different key', Boolean(fresh) && fresh !== controlKey, 'rotation reissued the same key');
  await controlKeyFor(first.id, 'clear');
  ok('withdrawing leaves no key', (await tournamentNow(first.id)).hasControlKey === false);
  const withdrawn = await handshake(`?key=${fresh}`);
  ok('and the withdrawn key is refused', statusOf(withdrawn) === 403, String(withdrawn));

  // ------------------------------------------------------- cross-site ---
  const bKey = second.controlKey;
  const foreign = await handshake(`?key=${bKey}`, 'Origin: http://evil.example\r\n');
  ok('an upgrade from another site is refused', statusOf(foreign) === 403, String(statusOf(foreign)));

  // --------------------------------------------------------- the switch ---
  await fetch(`${BASE}/api/admin/settings`, {
    method: 'POST',
    headers: JSON_POST,
    body: JSON.stringify({ settings: { companion: false } }),
  });
  await wait(500);
  ok('switching it off drops the open channels', b.socket.readyState !== WebSocket.OPEN || Boolean(b.closed), String(b.socket.readyState));

  const off = await handshake(`?key=${bKey}`);
  ok('and the route answers as though it is gone', statusOf(off) === 404, String(statusOf(off)));

  await fetch(`${BASE}/api/admin/settings`, {
    method: 'POST',
    headers: JSON_POST,
    body: JSON.stringify({ settings: { companion: true } }),
  });
  await wait(300);
  const back = open(bKey);
  await back.ready.catch(() => {});
  ok('switching it back on reopens the door', back.socket.readyState === WebSocket.OPEN);
  back.close();

  // ------------------------------------------------------------- the log ---
  ok('no control key reached the log', !log.includes(controlKey) && !log.includes(bKey), 'CONTROL KEY LEAKED TO LOG');
  ok('no session key reached the log', !log.includes(sessionKey), 'SESSION KEY LEAKED TO LOG');
  ok('no password reached the log', !log.includes('a-long-enough-password'), 'PASSWORD LEAKED');
  ok('but the operations were logged', /companion.*scoreboard\.show/s.test(log), 'no audit trail of the presses');
} catch (error) {
  fail += 1;
  console.log('THREW', error.stack);
  console.log(log.slice(-2000));
} finally {
  server.kill('SIGKILL');
  await wait(400);
  try {
    rmSync(STATE, { recursive: true, force: true });
  } catch {
    /* windows */
  }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
