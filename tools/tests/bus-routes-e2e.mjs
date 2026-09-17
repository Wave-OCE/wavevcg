/**
 * The bus on the wire: which store a route answers for, and the take.
 *
 * The thing most worth protecting here is the asymmetry. A read that names no
 * bus gets air, because every URL that existed before this feature means air
 * and must keep meaning it. A write that names no bus stages, because the two
 * ways of being wrong are not comparable - staging by accident is invisible
 * until somebody takes it, airing by accident is on a stream in front of an
 * audience.
 *
 * That is a deliberate wart (the same URL round-trips to different stores
 * depending on the verb) so it is spelled out in assertions rather than left
 * for somebody to discover.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

import { makeTournament, openAsAdmin } from './harness.mjs';

// The checkout this suite lives in, resolved from the suite's own location so
// that moving the tree does not break it.
const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8173;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-busr-'));

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

/** Collect named SSE events for a moment. */
async function collect(url, names, ms, headers = {}) {
  const controller = new AbortController();
  const seen = [];
  const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/event-stream', ...headers } });
  if (!response.ok) throw new Error(`stream ${url} answered ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const name = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (name && data && names.includes(name)) seen.push({ name, data: JSON.parse(data) });
        }
      }
    } catch {
      /* aborted */
    }
  })();
  await wait(ms);
  controller.abort();
  await pump.catch(() => {});
  return seen;
}

try {
  for (let i = 0; i < 80; i += 1) {
    try {
      await fetch(`${BASE}/api/auth/state`);
      break;
    } catch {
      await wait(250);
    }
  }

  /*
   * A key names a TOURNAMENT now, not the person who signed in, so the suite
   * has to make one before it has anything to point an OBS source at. The
   * login response carries no key at all any more.
   *
   * Only one tournament exists on this server, so every cookie-authenticated
   * request below lands on it without saying `?session=` - which is the
   * default a dashboard gets on a first load, and the state the OBS
   * assertions further down are contrasted against.
   */
  const { cookie, key, tournamentId } = await openAsAdmin(BASE, 'boss', 'a-long-enough-password', 'Bus routes');
  const H = { 'Content-Type': 'application/json', Cookie: cookie };

  const get = async (route) => (await (await fetch(`${BASE}${route}`, { headers: { Cookie: cookie } })).json());
  const post = async (route, body) =>
    (await (await fetch(`${BASE}${route}`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json());

  const setMap = async (route, map, qs = '') => {
    const current = (await get(`${route}${qs || '?bus=program'}`)).state;
    return post(`${route}${qs}`, { state: { ...current, map, mapName: map } });
  };

  // ------------------------------------------------- reads default to air ---
  await setMap('/api/graphic', 'ON-AIR-MAP', '?bus=program');
  await setMap('/api/graphic', 'STAGED-MAP', '?bus=preview');

  ok('a read with no bus answers for air', (await get('/api/graphic')).state.map === 'ON-AIR-MAP', (await get('/api/graphic')).state.map);
  ok('?bus=program is the same thing', (await get('/api/graphic?bus=program')).state.map === 'ON-AIR-MAP');
  ok('?bus=preview answers for preview', (await get('/api/graphic?bus=preview')).state.map === 'STAGED-MAP');
  // Nothing must resolve to air except the word itself.
  ok('a misspelt bus reads preview, never air', (await get('/api/graphic?bus=prgoram')).state.map === 'STAGED-MAP');

  // ----------------------------------------------- writes default to preview ---
  const silent = await setMap('/api/graphic', 'WROTE-WITHOUT-SAYING', '');
  ok('A WRITE WITH NO BUS STAGES', silent.bus === 'preview', String(silent.bus));
  ok('and says so in the response', silent.bus === 'preview');
  ok('air is untouched by it', (await get('/api/graphic')).state.map === 'ON-AIR-MAP', (await get('/api/graphic')).state.map);
  ok('preview took it', (await get('/api/graphic?bus=preview')).state.map === 'WROTE-WITHOUT-SAYING');

  const loud = await setMap('/api/graphic', 'DELIBERATELY-AIRED', '?bus=program');
  ok('a write that says program reaches air', loud.bus === 'program' && (await get('/api/graphic')).state.map === 'DELIBERATELY-AIRED');

  // All three graphics, not just the scoreboard.
  for (const [route, field] of [['/api/winner', 'mapName'], ['/api/select', 'mapName']]) {
    await setMap(route, 'AIR', '?bus=program');
    await setMap(route, 'STAGED', '?bus=preview');
    ok(`${route} reads air by default`, (await get(route)).state[field] === 'AIR', (await get(route)).state[field]);
    ok(`${route} reads preview when asked`, (await get(`${route}?bus=preview`)).state[field] === 'STAGED');
  }

  // ---------------------------------------------------------------- streams ---
  {
    const seen = await collect(`${BASE}/api/graphic/events`, ['graphic'], 500, { Cookie: cookie });
    ok('an output stream with no bus carries air', seen[0]?.data?.state?.map === 'DELIBERATELY-AIRED', seen[0]?.data?.state?.map);
  }
  {
    const seen = await collect(`${BASE}/api/graphic/events?bus=preview`, ['graphic'], 500, { Cookie: cookie });
    ok('and ?bus=preview carries preview', seen[0]?.data?.state?.map === 'WROTE-WITHOUT-SAYING', seen[0]?.data?.state?.map);
  }
  {
    // The OBS case: a key, no cookie, no bus - exactly an old browser source.
    const seen = await collect(`${BASE}/api/graphic/events?key=${encodeURIComponent(key)}`, ['graphic'], 500);
    ok('AN OLD OBS URL STILL GETS AIR', seen[0]?.data?.state?.map === 'DELIBERATELY-AIRED', seen[0]?.data?.state?.map);
  }
  {
    const seen = await collect(`${BASE}/api/events`, ['graphic', 'graphicPreview', 'winnerPreview', 'selectPreview'], 600, { Cookie: cookie });
    const air = seen.find((e) => e.name === 'graphic');
    const staged = seen.find((e) => e.name === 'graphicPreview');
    ok('the dashboard stream carries air unqualified', air?.data?.state?.map === 'DELIBERATELY-AIRED', air?.data?.state?.map);
    ok('and preview on its own channel', staged?.data?.state?.map === 'WROTE-WITHOUT-SAYING', staged?.data?.state?.map);
    ok('with a preview channel per graphic', ['graphicPreview', 'winnerPreview', 'selectPreview'].every((n) => seen.some((e) => e.name === n)));
    ok('all on one connection', true); // the single fetch above is the assertion
  }

  // ------------------------------------------------------------- the take ---
  await setMap('/api/graphic', 'READY-TO-GO', '?bus=preview');
  const take = await post('/api/take', { graphic: 'graphics' });
  ok('a take answers', take.action === 'take', JSON.stringify(take).slice(0, 90));
  ok('and moves preview to air', (await get('/api/graphic')).state.map === 'READY-TO-GO', (await get('/api/graphic')).state.map);
  ok('a data-only take does not replay', take.replayed === false, String(take.replayed));
  ok('preview is unchanged by taking from it', (await get('/api/graphic?bus=preview')).state.map === 'READY-TO-GO');

  {
    // A transport change must replay; a fresh graphic is visible, so hide.
    const preview = (await get('/api/graphic?bus=preview')).state;
    await post('/api/graphic?bus=preview', { state: { ...preview, anim: { ...preview.anim, visible: false } } });
    const hid = await post('/api/take', { graphic: 'graphics' });
    ok('a transport change replays on take', hid.replayed === true, String(hid.replayed));
    ok('and air is hidden', (await get('/api/graphic')).state.anim.visible === false);
  }

  for (const graphic of ['winner', 'select']) {
    const r = await post('/api/take', { graphic });
    ok(`${graphic} can be taken too`, r.action === 'take', JSON.stringify(r).slice(0, 80));
  }

  const bad = await fetch(`${BASE}/api/take`, { method: 'POST', headers: H, body: JSON.stringify({ graphic: 'nonsense' }) });
  ok('an unknown graphic is a 400', bad.status === 400, String(bad.status));
  ok('and the error lists the real ones', /graphics/.test((await bad.json())?.error?.hint ?? ''), 'no hint');

  // ------------------------------------------------------------- revert ---
  {
    const air = (await get('/api/graphic')).state;
    await post('/api/graphic?bus=preview', { state: { ...air, map: 'HALF-FINISHED' } });
    ok('preview can be dirtied', (await get('/api/graphic?bus=preview')).state.map === 'HALF-FINISHED');
    const back = await post('/api/take', { graphic: 'graphics', action: 'revert' });
    ok('revert answers', back.action === 'revert');
    ok('and pulls air back over preview', (await get('/api/graphic?bus=preview')).state.map === air.map, (await get('/api/graphic?bus=preview')).state.map);
    ok('leaving air alone', (await get('/api/graphic')).state.map === air.map);
  }

  // --------------------------------------------------------------- the gate ---
  /*
   * The take is the most consequential button in the tool - it is the moment
   * something reaches an audience - so the weak secret must not reach it.
   */
  const keyed = await fetch(`${BASE}/api/take?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graphic: 'graphics' }),
  });
  ok('A SESSION KEY CANNOT TAKE TO AIR', keyed.status === 403, String(keyed.status));

  const anon = await fetch(`${BASE}/api/take`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graphic: 'graphics' }),
  });
  ok('and nor can a stranger', anon.status === 401, String(anon.status));

  // -------------------------------------------- the feed reaches both buses ---
  /*
   * Agent select is the one graphic whose data reaches an audience without a
   * take: a draft is ten picks and a handful of scene changes, and taking once
   * per lock-in is not a workflow. The scoreboard and winner stay gated.
   */
  const game = (event) =>
    fetch(`${BASE}/api/game?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
  const roster = (event) =>
    fetch(`${BASE}/api/roster?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });

  await game({ event: 'scene', data: 'CharacterSelectPersistentLevel' });
  await wait(250);
  ok('a game event reaches air', (await get('/api/select')).state.scene === 'CharacterSelectPersistentLevel', (await get('/api/select')).state.scene);
  ok('AND PREVIEW TOO', (await get('/api/select?bus=preview')).state.scene === 'CharacterSelectPersistentLevel', (await get('/api/select?bus=preview')).state.scene);

  await roster({ eventIndex: 0, name: 'Feed', character: 'Jett', locked: true });
  await wait(250);
  ok('a roster event reaches air', (await get('/api/select')).state.slots[0].character === 'Jett', (await get('/api/select')).state.slots[0].character);
  ok('AND PREVIEW TOO', (await get('/api/select?bus=preview')).state.slots[0].character === 'Jett', (await get('/api/select?bus=preview')).state.slots[0].character);

  /*
   * The reason the event is applied to each bus separately instead of applied
   * once and copied across: preview may be carrying operator edits air has not
   * been given, and copying would throw them away on the very next pick.
   */
  {
    const staged = (await get('/api/select?bus=preview')).state;
    await post('/api/select?bus=preview', { state: { ...staged, left: { ...staged.left, name: 'STAGED ORG' } } });
    ok('an operator edit stages on select', (await get('/api/select?bus=preview')).state.left.name === 'STAGED ORG');

    await roster({ eventIndex: 1, name: 'Second', character: 'Sova' });
    await wait(250);
    ok(
      'A PICK DOES NOT WIPE WHAT WAS STAGED',
      (await get('/api/select?bus=preview')).state.left.name === 'STAGED ORG',
      (await get('/api/select?bus=preview')).state.left.name,
    );
    ok('and the pick landed on preview as well', (await get('/api/select?bus=preview')).state.slots[1].character === 'Sova');
    ok('and on air', (await get('/api/select')).state.slots[1].character === 'Sova');
    ok('while air never got the staged name', (await get('/api/select')).state.left.name !== 'STAGED ORG', (await get('/api/select')).state.left.name);
  }

  // The other two graphics stay gated - the feed is agent select's alone.
  {
    const airMapBefore = (await get('/api/graphic')).state.map;
    await game({ event: 'map', data: 'Icebox' });
    await wait(300);
    ok('a map event stages on the scoreboard', (await get('/api/graphic?bus=preview')).state.map === 'Icebox', (await get('/api/graphic?bus=preview')).state.map);
    ok('AND DOES NOT REACH THE SCOREBOARD ON AIR', (await get('/api/graphic')).state.map === airMapBefore, (await get('/api/graphic')).state.map);
    ok('nor the winner on air', (await get('/api/winner')).state.mapName !== 'Icebox', (await get('/api/winner')).state.mapName);
    ok('but agent select gets it on both, being the feed’s own', (await get('/api/select')).state.mapName === 'Icebox' && (await get('/api/select?bus=preview')).state.mapName === 'Icebox');
  }

  // ------------------------------------------- which production, on the wire ---
  /*
   * `?session=` names a TOURNAMENT now rather than an account, and on a
   * cookie-authenticated request it is the only thing that says which
   * production is being edited. Worth its own assertions here because the
   * failure it guards against is a write landing on the wrong board, which is
   * invisible until somebody takes it to air on a stream that was never meant
   * to carry it.
   *
   * The second tournament is deliberately made LAST. With no `?session=` the
   * server answers for the newest production the account can see, so creating
   * it any earlier would have quietly moved every unqualified request above
   * onto an empty board and proved nothing.
   */
  {
    const airBefore = (await get('/api/graphic')).state.map;
    const second = await makeTournament(BASE, cookie, 'The other production');

    ok(
      'naming this tournament reads the board the suite has been driving',
      (await get(`/api/graphic?session=${tournamentId}`)).state.map === airBefore,
      (await get(`/api/graphic?session=${tournamentId}`)).state.map,
    );

    const other = (await get(`/api/graphic?session=${second.id}&bus=program`)).state;
    await post(`/api/graphic?session=${second.id}&bus=program`, { state: { ...other, map: 'OTHER-PRODUCTION' } });
    ok(
      'the other production takes its own write',
      (await get(`/api/graphic?session=${second.id}`)).state.map === 'OTHER-PRODUCTION',
      (await get(`/api/graphic?session=${second.id}`)).state.map,
    );
    ok(
      "AND THIS PRODUCTION'S AIR NEVER MOVED",
      (await get(`/api/graphic?session=${tournamentId}`)).state.map === airBefore,
      (await get(`/api/graphic?session=${tournamentId}`)).state.map,
    );

    // And the key follows the tournament rather than the person who made it:
    // one account holds both of these, and the OBS source still gets exactly
    // the production whose key it carries.
    const seen = await collect(`${BASE}/api/graphic/events?key=${encodeURIComponent(second.key)}`, ['graphic'], 500);
    ok(
      'an OBS URL carrying the other key renders the other production',
      seen[0]?.data?.state?.map === 'OTHER-PRODUCTION',
      seen[0]?.data?.state?.map,
    );
    ok('no key reached the log', !log.includes(second.key), 'KEY LEAKED');
  }

  // -------------------------------------------------- aliases and the buses ---
  /*
   * THE BUG THIS BLOCK EXISTS FOR, which shipped and was found by hand.
   *
   * handleAliasAction was written when `bundle.select` was a store and kept
   * reading `.state` off it after it became a preview/program PAIR. The
   * throwing getter in buses.js did its job and named the fix - but nothing
   * exercised an alias write, so it threw at an operator instead of at a
   * suite. The symptom was the nastiest shape available: `aliases.save` had
   * already persisted by the time `.state` threw, so the panel showed a 400,
   * the library had changed anyway, and no graphic was re-resolved.
   *
   * So assertion one is simply that the route answers 200. It would have been
   * enough.
   */
  {
    const seat = {
      playerId: 'probe-account-id',
      riotId: 'Probe#0001',
      name: 'Probe',
      agent: 'Jett',
      locked: true,
    };
    // Seat the same player on both buses, so "did the name move" is a question
    // about the alias write rather than about which bus happened to hold them.
    for (const bus of ['preview', 'program']) {
      const current = (await get(`/api/select?bus=${bus}`)).state;
      const slots = current.slots.map((slot, index) => (index === 0 ? { ...slot, ...seat } : slot));
      await post(`/api/select?bus=${bus}`, { state: { ...current, slots } });
    }

    const saved = await post('/api/aliases', { action: 'save', player: { id: seat.playerId, riotId: seat.riotId, alias: 'PROBE' } });
    ok('an alias save answers rather than throwing', Array.isArray(saved?.players), JSON.stringify(saved).slice(0, 160));

    /*
     * Agent select gets BOTH buses, which is the rule its own webhooks already
     * follow: a draft is ten picks, nobody takes once per lock-in, and a name
     * typed mid-draft is wanted on air now.
     */
    ok(
      'the new name reaches agent select on PREVIEW',
      (await get('/api/select?bus=preview')).state.slots[0].name === 'PROBE',
      (await get('/api/select?bus=preview')).state.slots[0].name,
    );
    ok(
      'and on PROGRAM, because a draft is not taken per pick',
      (await get('/api/select?bus=program')).state.slots[0].name === 'PROBE',
      (await get('/api/select?bus=program')).state.slots[0].name,
    );

    /*
     * The scoreboard is the other answer, and deliberately so: it is on air for
     * minutes and is taken on purpose, so an alias edit stages there rather
     * than rewriting a board an audience is reading.
     */
    const board = (await get('/api/graphic?bus=program')).state;
    const row = { playerId: 'probe-account-id', riotId: 'Probe#0001', name: 'Probe' };
    for (const bus of ['preview', 'program']) {
      const current = (await get(`/api/graphic?bus=${bus}`)).state;
      await post(`/api/graphic?bus=${bus}`, {
        state: { ...current, left: { ...current.left, players: [row, ...current.left.players.slice(1)] } },
      });
    }
    await post('/api/aliases', { action: 'save', player: { id: seat.playerId, riotId: seat.riotId, alias: 'BOARD' } });
    ok(
      'a scoreboard name stages on preview',
      (await get('/api/graphic?bus=preview')).state.left.players[0].name === 'BOARD',
      (await get('/api/graphic?bus=preview')).state.left.players[0].name,
    );
    ok(
      'and AIR does not move until somebody takes it',
      (await get('/api/graphic?bus=program')).state.left.players[0].name === 'Probe',
      (await get('/api/graphic?bus=program')).state.left.players[0].name,
    );
    ok('the board fixture was real', board !== null);
  }

  // --------------------------------------------------------------- the log ---
  ok('the take is logged', /taken to program/.test(log), 'no audit line for a take');
  ok('and says whether it replayed', /\(data only\)|\(replayed\)/.test(log), 'no replay detail in the log');
  ok('no session key reached the log', !log.includes(key), 'KEY LEAKED');
} catch (error) {
  fail += 1;
  console.log('THREW', error.stack);
  console.log(log.slice(-1500));
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
