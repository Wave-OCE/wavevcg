/**
 * The Overwolf lobby staging board, end to end against a real server.
 *
 * What matters: the hook takes what Shots Fired actually posts, the board it
 * writes is not on air, the export serves only what an operator staged, the
 * swap is the operator's, and one production's lobby never reaches another's.
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
const PORT = 8171;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-lobby-'));

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

/** Exactly what Shots Fired posts for an indexed roster event. */
const roster = (index, name, character, teammate) => ({
  gameId: 21640,
  feature: 'match_info',
  event: 'roster',
  category: 'match_info',
  eventIndex: index,
  data: JSON.stringify({ name, player_id: `pid-${index}`, character, rank: 21, local: false, teammate }),
});

/** And for the on-screen order, whose payload is not JSON. */
const order = (side, raw) => ({
  gameId: 21640,
  feature: 'match_info',
  event: `ui_team_order_${side}`,
  category: 'match_info',
  eventIndex: null,
  data: raw,
});

async function collect(url, eventName, ms, after = async () => {}, headers = {}) {
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
          if (name === eventName && data) seen.push(JSON.parse(data));
        }
      }
    } catch {
      /* aborted */
    }
  })();

  await wait(250);
  await after();
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
   * The key belongs to a tournament, so one has to exist before a game client
   * has anything to post a lobby to. An account carries no key at all now.
   */
  const { cookie, tournamentId, key } = await openAsAdmin(BASE, 'boss', 'a-long-enough-password', 'Lobby');

  /*
   * Every signed-in read and write names the production it means. Without
   * `?session=` the server opens the newest tournament this account can see,
   * and the isolation check below makes a second one - so a bare URL would
   * start answering about that one instead.
   */
  const on = (pathAndQuery) =>
    `${BASE}${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}session=${encodeURIComponent(tournamentId)}`;

  const hook = (body, k = key) =>
    fetch(`${BASE}/api/lobby?key=${encodeURIComponent(k)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const control = (action) =>
    fetch(on('/api/lobby/control'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ action }),
    });

  const exported = async (k = key) => (await fetch(`${BASE}/api/gstack?key=${encodeURIComponent(k)}`)).json();

  // ------------------------------------------------------------ the gate ---
  const noKey = await fetch(`${BASE}/api/lobby`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(roster(0, 'A#A', 'Sarge', true)),
  });
  ok('hook without a key is refused', noKey.status === 401, String(noKey.status));
  ok('and tells a game client to add one', /key=/.test((await noKey.json()).error?.message ?? ''));

  const badKey = await hook(roster(0, 'A#A', 'Sarge', true), 'not-a-real-key');
  ok('a key naming nobody is refused', badKey.status === 401 || badKey.status === 404, String(badKey.status));

  // The one that matters: a key must not be able to stage.
  const keyedStage = await fetch(`${BASE}/api/lobby/control?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'stage' }),
  });
  ok('a key cannot reach the control route', keyedStage.status === 403, String(keyedStage.status));
  ok('and is told the key is the wrong credential', /output pages|webhook/i.test((await keyedStage.json()).error?.message ?? ''));

  const noCookie = await fetch(`${BASE}/api/lobby/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'stage' }),
  });
  ok('control without a session is refused', noCookie.status === 401, String(noCookie.status));

  const formShaped = await fetch(`${BASE}/api/lobby/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: 'action=stage',
  });
  ok('a form-shaped control post is refused (CSRF)', formShaped.status === 415, String(formShaped.status));

  // ---------------------------------------------------------- body shapes ---
  ok('single event accepted', (await hook(roster(0, 'A1#AAA', 'Sarge', true))).status === 200);
  const many = await hook([
    roster(1, 'A2#AAA', 'Wraith', true),
    roster(2, 'A3#AAA', 'BountyHunter', true),
    roster(5, 'B1#BBB', 'Thorne', false),
    roster(6, 'B2#BBB', 'Sprinter', false),
  ]);
  ok('an array is accepted', many.status === 200, String(many.status));
  ok('and reports how many landed', (await many.json()).applied === 4);

  const wrapped = await hook({ events: [roster(7, 'B3#BBB', 'Wushu', false)] });
  ok('{events:[]} is accepted', (await wrapped.json()).applied === 1);

  const offBoard = await hook(roster(17, 'X#X', 'Sarge', true));
  ok('an index off the board applies nothing', (await offBoard.json()).applied === 0);

  const foreign = await hook({ event: 'kill', eventIndex: 0, data: '{"name":"X#X"}' });
  ok('an event that is not ours applies nothing', (await foreign.json()).applied === 0);

  const ordered = await hook(order('allies', '{1:"Omen",2:"Brimstone",3:"Fade"}'));
  ok('the non-JSON order payload is accepted', (await ordered.json()).applied === 1);
  await hook(order('enemies', '{1:"Sage",2:"Neon"}'));

  // ------------------------------------------------ nothing is on air yet ---
  const select = await (await fetch(on('/api/select'), { headers: { Cookie: cookie } })).json();
  ok(
    'the lobby feed did not touch agent select',
    (select.state?.slots ?? []).every((slot) => !slot.riotId),
    JSON.stringify(select.state?.slots?.slice(0, 2)),
  );

  const beforeStage = await exported();
  ok('the export is empty before staging', beforeStage.attackers.length === 0 && beforeStage.defenders.length === 0);
  ok('and says so rather than 404ing', beforeStage.staged === false);
  ok('and still carries the shape GStack parses', 'attackerTeam' in beforeStage && 'bestOf' in beforeStage);

  // ----------------------------------------------------------- staging ---
  const staged = await control('stage');
  ok('stage succeeds', staged.status === 200, String(staged.status));

  const afterStage = await exported();
  ok('the export now has the allies side', afterStage.attackers.length === 3, JSON.stringify(afterStage.attackers));
  ok('and the enemies side', afterStage.defenders.length === 2, JSON.stringify(afterStage.defenders));
  ok('it reports itself staged', afterStage.staged === true);

  // The UI order decides the seats, not the roster index.
  ok(
    'the on-screen order is what the export uses',
    afterStage.attackers.map((p) => p.player).join(',') === 'A2#AAA,A1#AAA,A3#AAA',
    afterStage.attackers.map((p) => p.player).join(','),
  );

  ok(
    'every player carries GStack field names',
    afterStage.attackers.every((p) => 'displayName' in p && 'lockedAgentCharacterId' in p),
  );

  // The catalogue is a network fetch, so assert what is true either way.
  const cat = await (await fetch(on('/api/valorant-assets'), { headers: { Cookie: cookie } })).json();
  const haveCatalogue = Boolean(cat?.agents?.length);
  if (haveCatalogue) {
    ok(
      'agents resolve to uuids when the catalogue is up',
      afterStage.attackers.every((p) => /^[0-9a-f-]{36}$/i.test(p.lockedAgentCharacterId)),
      JSON.stringify(afterStage.attackers.map((p) => p.lockedAgentCharacterId)),
    );
  } else {
    ok(
      'no uuid is invented when the catalogue is down',
      afterStage.attackers.every((p) => p.lockedAgentCharacterId === ''),
    );
    ok('and the names still go out', afterStage.attackers.every((p) => p.displayName));
  }

  // --------------------------------------------- staged, not incoming ---
  await hook(roster(3, 'A4#AAA', 'Clay', true));
  const afterLate = await exported();
  ok(
    'a post after staging does not move the export',
    afterLate.attackers.length === 3,
    JSON.stringify(afterLate.attackers.map((p) => p.player)),
  );
  await control('stage');
  ok('until it is staged again', (await exported()).attackers.length === 3);

  // ------------------------------------------------------------- swap ---
  const before = await exported();
  await control('swap');
  const swapped = await exported();
  ok(
    'swap exchanges the two sides',
    swapped.attackers.map((p) => p.player).join(',') === before.defenders.map((p) => p.player).join(','),
    swapped.attackers.map((p) => p.player).join(','),
  );
  await control('swap');
  ok('and swaps back', (await exported()).attackers.map((p) => p.player).join(',') === before.attackers.map((p) => p.player).join(','));

  // ------------------------------------------------------------ clear ---
  await control('clear');
  const cleared = await exported();
  ok('clear empties the export', cleared.attackers.length === 0 && cleared.defenders.length === 0);
  ok('and drops the staged board too', cleared.staged === false);

  const badAction = await control('explode');
  ok('an unknown action is refused with 400', badAction.status === 400, String(badAction.status));
  ok('and lists the ones that work', /stage/.test((await badAction.json()).error?.hint ?? ''));

  // ------------------------------------------------------------- SSE ---
  const frames = await collect(on('/api/events'), 'lobby', 700, async () => {
    await hook(roster(0, 'Live#AAA', 'Sarge', true));
  }, { Cookie: cookie });
  ok('the lobby channel replays on connect', frames.length >= 1, String(frames.length));
  ok(
    'and delivers the post live',
    frames.some((f) => (f.state?.incoming?.seats ?? []).some((s) => s.riotId === 'Live#AAA')),
    JSON.stringify(frames.at(-1)?.state?.incoming?.seats?.[0]),
  );

  // ---------------------------------------------- production isolation ---
  /*
   * A second TOURNAMENT, not a second account.
   *
   * What must not leak is one competition's lobby into another's export, and a
   * production is a tournament now - two operators on the same tournament are
   * meant to see the same board, so making the second one an account would
   * have tested the opposite of the requirement.
   */
  const second = await makeTournament(BASE, cookie, 'Somebody else');
  const key2 = second.key;
  ok('a second production was made for the isolation check', Boolean(key2), JSON.stringify(second));
  ok('and it has its own key', Boolean(key2) && key2 !== key);

  await hook(roster(0, 'Theirs#ZZZ', 'Sarge', true), key2);
  const mine = await exported();
  ok("one production's lobby does not reach another's export", !JSON.stringify(mine).includes('Theirs#ZZZ'));

  // ------------------------------------------------------- the log ---
  ok('no session key reached the log', !log.includes(key), 'key found in stdout');
  ok('no control key or password reached the log', !log.includes('a-long-enough-password'));
} catch (error) {
  fail += 1;
  console.log('  THREW ', error.stack ?? error.message);
} finally {
  server.kill();
  await wait(300);
  rmSync(STATE, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\n--- server log ---\n' + log.split('\n').slice(-40).join('\n'));
}
process.exit(fail ? 1 : 0);
