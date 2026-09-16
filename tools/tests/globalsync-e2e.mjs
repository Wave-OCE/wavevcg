/**
 * The Global tab's one-way sync, and the line between it and an operator.
 *
 * The rule is that Global owns the shared fields and the graphics follow while
 * their sync is on; a graphic never pushes back. That is deliberate and this
 * suite protects it.
 *
 * What it also protects is the other half, which is where the bug was: a
 * webhook event that changes nothing must not count as Global having spoken.
 * `/api/game` pushed on every event, so a bare `scene` event - no map in it at
 * all - silently reverted a map an operator had just picked on the winner tab,
 * and the background splash with it. The client posts those constantly, so the
 * edit came back a second later with nothing anywhere to say why.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

// The checkout this suite lives in, resolved from the suite's own location so
// that moving the tree does not break it.
const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8169;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-gsync-'));

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
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (c) => (log += c));
server.stderr.on('data', (c) => (log += c));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; i < 80; i += 1) {
    try {
      await fetch(`${BASE}/api/auth/state`);
      break;
    } catch {
      await wait(250);
    }
  }

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'a-long-enough-password' }),
  });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((l) => l.split(';')[0]).join('; ');
  const key = (await login.json()).user.sessionKey;
  const H = { 'Content-Type': 'application/json', Cookie: cookie };

  const read = async (route, bus = 'preview') =>
    (await (await fetch(`${BASE}${route}?bus=${bus}`, { headers: { Cookie: cookie } })).json()).state;

  /*
   * PREVIEW, since stage 4 of the preview/program split. Global is staged data
   * like anything else an operator types - a map set there must not appear on
   * air before somebody takes it - so pushGlobal lands on preview and this
   * suite follows it there. `global` itself is not a bus; it has one copy.
   */
  const winner = () => read('/api/winner');
  const graphic = () => read('/api/graphic');
  const select = () => read('/api/select');
  const selectAir = () => read('/api/select', 'program');
  const global = () => read('/api/global', 'program');

  /*
   * Explicitly air. A POST that names no bus stages now - see busFor in
   * server.js - and this suite is about what the feed does to what an operator
   * has put on air, so it has to say which it means.
   */
  const write = async (route, patch, bus = 'preview') => {
    const current = await read(route, bus);
    const response = await fetch(`${BASE}${route}?bus=${bus}`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ state: { ...current, ...patch } }),
    });
    const body = await response.json();
    if (body.bus && body.bus !== bus) throw new Error(`write went to ${body.bus}, asked for ${bus}`);
    return body;
  };

  /** Global is not a bus - one copy, written plainly. */
  const writeGlobal = async (patch) => {
    const current = await read('/api/global', 'program');
    const r = await fetch(`${BASE}/api/global`, { method: 'POST', headers: H, body: JSON.stringify({ state: { ...current, ...patch } }) });
    return r.json();
  };

  /** One game-client event, exactly as the webhook takes them. */
  const game = (event) =>
    fetch(`${BASE}/api/game?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });

  // ------------------------------------------- the sync still does its job ---
  await writeGlobal({ mapName: 'Haven', syncMap: true });
  await wait(150);
  ok('Global pushes its map to the winner', (await winner()).mapName === 'Haven', (await winner()).mapName);
  ok('and to the scoreboard', (await graphic()).map === 'Haven', (await graphic()).map);
  ok('and to agent select', (await select()).mapName === 'Haven', (await select()).mapName);
  ok('but NOT to air, which is what the take is for', (await selectAir()).mapName !== 'Haven', (await selectAir()).mapName);

  // The feed telling everybody the map is the whole reason a shared field
  // exists, so it has to keep working.
  await game({ event: 'map', data: 'Icebox' });
  await wait(200);
  ok('a map event from the game moves the shared map', (await global()).mapName === 'Icebox', (await global()).mapName);
  ok('and reaches the winner', (await winner()).mapName === 'Icebox', (await winner()).mapName);
  ok('and the scoreboard', (await graphic()).map === 'Icebox', (await graphic()).map);
  ok('and agent select', (await select()).mapName === 'Icebox', (await select()).mapName);

  // A code name, which is what the client actually sends.
  await game({ event: 'map', data: 'Bonsai' });
  await wait(200);
  ok('a map code name resolves to the real name', (await global()).mapName === 'Split', (await global()).mapName);
  ok('and reaches the winner', (await winner()).mapName === 'Split', (await winner()).mapName);

  // ------------------------------- an event that changed nothing changes nothing ---
  /*
   * The regression. An operator picks the map that was just played on the
   * winner tab; the client is still posting scene events for the next lobby.
   */
  await write('/api/winner', { mapName: 'Lotus' });
  ok('the operator can set the winner map', (await winner()).mapName === 'Lotus', (await winner()).mapName);

  await game({ event: 'scene', data: 'MainMenu' });
  await wait(200);
  ok(
    'A SCENE EVENT DOES NOT REVERT THE OPERATOR’S MAP',
    (await winner()).mapName === 'Lotus',
    (await winner()).mapName,
  );

  await game({ event: 'scene', data: 'CharacterSelectPersistentLevel' });
  await wait(200);
  ok('nor does entering agent select', (await winner()).mapName === 'Lotus', (await winner()).mapName);

  // Ten of them, which is what a real lobby produces.
  for (let i = 0; i < 10; i += 1) await game({ event: 'scene', data: 'MainMenu' });
  await wait(300);
  ok('nor do ten of them', (await winner()).mapName === 'Lotus', (await winner()).mapName);

  // The same map arriving again is not news either.
  await game({ event: 'map', data: 'Split' });
  await wait(200);
  ok(
    'a map event repeating the map already shared does not revert it',
    (await winner()).mapName === 'Lotus',
    (await winner()).mapName,
  );

  // A roster event never pushed, and still must not.
  await fetch(`${BASE}/api/roster?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventIndex: 0, name: 'someone', character: 'Jett' }),
  });
  await wait(200);
  ok('a roster event leaves the map alone', (await winner()).mapName === 'Lotus', (await winner()).mapName);

  // ------------------------------------------ but a real change still wins ---
  /*
   * The other side of the line: this is the documented behaviour, not a bug.
   * A genuinely new map from the feed is Global speaking, and the graphics
   * follow - including over an operator's edit.
   */
  await game({ event: 'map', data: 'Breeze' });
  await wait(200);
  ok('a genuinely new map still takes the winner with it', (await winner()).mapName === 'Breeze', (await winner()).mapName);

  // And so does the Global tab itself.
  await write('/api/winner', { mapName: 'Haven' });
  await writeGlobal({ mapName: 'Pearl' });
  await wait(200);
  ok('saving Global still overwrites a graphic', (await winner()).mapName === 'Pearl', (await winner()).mapName);

  // ------------------------------------------------------ the sync switch ---
  await writeGlobal({ syncMap: false });
  await write('/api/winner', { mapName: 'Sunset' });
  await game({ event: 'map', data: 'Abyss' });
  await wait(250);
  ok('with the sync off the feed does not touch the winner', (await winner()).mapName === 'Sunset', (await winner()).mapName);
  ok('though the shared value still moves', (await global()).mapName === 'Abyss', (await global()).mapName);
  // Air, not preview. With the sync off nothing is pushed anywhere, but the
  // game webhook writes agent select's own bus directly - that graphic is the
  // feed's, and its picks reach an audience without a take.
  ok('but agent select on AIR still has it, being the feed’s own graphic', (await selectAir()).mapName === 'Abyss', (await selectAir()).mapName);

  await writeGlobal({ syncMap: true, mapName: 'Fracture' });
  await wait(200);
  ok('turning it back on resumes the sync', (await winner()).mapName === 'Fracture', (await winner()).mapName);

  // --------------------------------------------- the image follows the name ---
  /*
   * The reported symptom was the background, not the field. The winner page
   * resolves its splash from the map name when there is no override, so the
   * name sticking is what makes the picture right.
   */
  const w = await winner();
  ok('no image override is set by any of this', w.mapImage === '', w.mapImage);
  ok('and the splash is on', w.style.showMapSplash === true, String(w.style.showMapSplash));

  const assets = await (await fetch(`${BASE}/api/valorant-assets`)).json();
  const splashFor = (name) => assets.maps.find((m) => m.name.toLowerCase() === name.toLowerCase())?.splash ?? '';
  ok('the catalogue has a splash for the synced map', Boolean(splashFor(w.mapName)), w.mapName);

  await write('/api/winner', { mapName: 'Lotus' });
  await game({ event: 'scene', data: 'MainMenu' });
  await wait(200);
  const held = await winner();
  ok('an operator’s map survives, so its splash does too', held.mapName === 'Lotus' && Boolean(splashFor(held.mapName)), held.mapName);
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
