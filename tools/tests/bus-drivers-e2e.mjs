/**
 * Which automatic behaviours each bus runs, and the preview rehearsal.
 *
 * The split is the point:
 *
 *   auto-hide      program only. A staged graphic that vanished eight seconds
 *                  after the operator brought it up to check it is a bug.
 *   auto-advance   program only, unless a rehearsal is running. Preview is
 *                  manual so somebody can actually look at a scene.
 *   the clock      both. It is not an on-air behaviour, it is the state
 *                  telling the truth about itself, and the dashboard reads
 *                  preview.
 *
 * Everything here is timed, so the fixtures wind every duration right down and
 * the waits are generous - a driver that fires late still fires, and this suite
 * is about which bus moved rather than about how fast.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

// The checkout this suite lives in, resolved from the suite's own location so
// that moving the tree does not break it.
const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8174;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-busd-'));

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
  await login.json();
  const H = { 'Content-Type': 'application/json', Cookie: cookie };

  const get = async (route, bus) => (await (await fetch(`${BASE}${route}?bus=${bus}`, { headers: { Cookie: cookie } })).json()).state;
  const put = async (route, bus, patch) => {
    const current = await get(route, bus);
    const r = await fetch(`${BASE}${route}?bus=${bus}`, { method: 'POST', headers: H, body: JSON.stringify({ state: { ...current, ...patch } }) });
    return (await r.json()).state;
  };
  const post = async (route, body) =>
    (await (await fetch(`${BASE}${route}`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json());

  /** Wind the sequence timings down so a whole run takes well under a second. */
  const FAST_SEQ = {
    inMs: 10,
    outMs: 10,
    stageMs: 10,
    staggerMs: 0,
    openStaggerMs: 0,
    mapHoldMs: 60,
    winnerHoldMs: 60,
    scoreHoldMs: 60,
  };
  const FAST_ANIM = { durationMs: 10, outDurationMs: 10, staggerMs: 0, delayMs: 0, holdMs: 120 };

  // ============================================================ auto-hide ===
  for (const bus of ['program', 'preview']) {
    await put('/api/graphic', bus, { anim: { ...(await get('/api/graphic', bus)).anim, ...FAST_ANIM, visible: false } });
  }
  await wait(400);

  // A cue is what arms it, so flip visible with a fresh cue on each bus.
  for (const bus of ['program', 'preview']) {
    const anim = (await get('/api/graphic', bus)).anim;
    await put('/api/graphic', bus, { anim: { ...anim, visible: true, cue: anim.cue + 1 } });
  }
  ok('both buses start visible', (await get('/api/graphic', 'program')).anim.visible && (await get('/api/graphic', 'preview')).anim.visible);

  await wait(900);
  ok('AUTO-HIDE TOOK AIR DOWN', (await get('/api/graphic', 'program')).anim.visible === false, 'air stayed up');
  ok('and left preview alone', (await get('/api/graphic', 'preview')).anim.visible === true, 'preview auto-hid, which it must not');

  // ========================================================= auto-advance ===
  for (const bus of ['program', 'preview']) {
    const seq = (await get('/api/winner', bus)).seq;
    await put('/api/winner', bus, { seq: { ...seq, ...FAST_SEQ, autoAdvance: true, exitAtEnd: false, active: false, stage: 0 } });
  }
  await wait(200);

  // Activate both, the same way the transport does.
  for (const bus of ['program', 'preview']) {
    const seq = (await get('/api/winner', bus)).seq;
    await put('/api/winner', bus, { seq: { ...seq, active: true, stage: 0, restart: true, cue: seq.cue + 1 } });
  }
  ok('both sequences start at scene 1', (await get('/api/winner', 'program')).seq.stage === 0 && (await get('/api/winner', 'preview')).seq.stage === 0);

  await wait(900);
  const airSeq = (await get('/api/winner', 'program')).seq;
  const prevSeq = (await get('/api/winner', 'preview')).seq;
  ok('AIR AUTO-ADVANCED', airSeq.stage > 0, `still on scene ${airSeq.stage + 1}`);
  ok('PREVIEW DID NOT', prevSeq.stage === 0, `preview walked to scene ${prevSeq.stage + 1} on its own`);
  ok('even with autoAdvance set on it', prevSeq.autoAdvance === true, 'fixture did not keep autoAdvance on');
  ok('and preview is still up to be looked at', prevSeq.active === true);

  // ============================================================ rehearsal ===
  {
    const before = (await get('/api/winner', 'program')).seq.stage;
    const started = await post('/api/rehearse', { graphic: 'winner', run: true });
    ok('a rehearsal starts', started.running === true, JSON.stringify(started).slice(0, 80));
    ok('and puts preview back at scene 1', started.state.seq.stage === 0 && started.state.seq.active === true);

    await wait(900);
    const rehearsed = (await get('/api/winner', 'preview')).seq;
    ok('PREVIEW NOW ADVANCES ON ITS OWN', rehearsed.stage > 0, `stuck on scene ${rehearsed.stage + 1}`);
    ok('and air was not touched by the rehearsal', (await get('/api/winner', 'program')).seq.stage === before, 'a rehearsal moved air');

    const stopped = await post('/api/rehearse', { graphic: 'winner', run: false });
    ok('a rehearsal stops', stopped.running === false);
    const held = (await get('/api/winner', 'preview')).seq.stage;
    await wait(700);
    ok('and preview holds where it was', (await get('/api/winner', 'preview')).seq.stage === held, 'kept advancing after stop');

    // Only the winner has a sequence to rehearse.
    const bad = await fetch(`${BASE}/api/rehearse`, { method: 'POST', headers: H, body: JSON.stringify({ graphic: 'graphics' }) });
    ok('rehearsing anything else is refused', bad.status === 400, String(bad.status));
  }

  // ---- a rehearsal must not cross to air on a take ----
  {
    await post('/api/rehearse', { graphic: 'winner', run: true });
    await wait(150);
    const taken = await post('/api/take', { graphic: 'winner' });
    const air = await get('/api/winner', 'program');
    ok('a take during a rehearsal still works', taken.action === 'take');
    ok('AND CARRIES NO REHEARSAL FLAG TO AIR', !('rehearse' in air.seq) && !('rehearsal' in air), Object.keys(air.seq).join(','));
    await post('/api/rehearse', { graphic: 'winner', run: false });
  }

  // ================================================================ clock ===
  /*
   * The one driver both buses get. A preview whose clock still said "running"
   * forty minutes after the draft would be wrong on the dashboard.
   */
  for (const bus of ['program', 'preview']) {
    const state = await get('/api/select', bus);
    // 1000 is the floor sanitiseTimer clamps to - asking for less silently
    // gets a one second clock, which is how this suite first "failed".
    await put('/api/select', bus, {
      timer: { running: true, startedAt: Date.now(), durationMs: 1000, filled: false, stoppedAt: 0 },
    });
    ok(`${bus} clock starts`, (await get('/api/select', bus)).timer.running === true);
  }

  await wait(1800);
  ok('THE AIR CLOCK EXPIRED', (await get('/api/select', 'program')).timer.running === false, 'air clock still running');
  ok('AND SO DID PREVIEW’S', (await get('/api/select', 'preview')).timer.running === false, 'preview clock never expired');
  ok('both are marked finished', (await get('/api/select', 'program')).timer.filled && (await get('/api/select', 'preview')).timer.filled);

  // ============================================================== the log ===
  /*
   * The air log is the production's record of what an audience saw. A preview
   * driver writing into it would be a lie by omission.
   */
  const airLines = log.split('\n').filter((line) => / air /.test(line));
  ok('air still logs what it does', airLines.length > 0, 'no air lines at all');
  ok('the clock was logged once, not twice', airLines.filter((l) => /clock started/.test(l)).length === 1, String(airLines.filter((l) => /clock started/.test(l)).length));
  ok('the sequence was logged for air', airLines.some((l) => /winner sequence/.test(l)));
  ok('and the scoreboard', airLines.some((l) => /scoreboard/.test(l)));
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
