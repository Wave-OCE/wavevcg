/**
 * The seam between the schedule and the desk: the two show-day presses.
 *
 * Port 8179. 8178 is schedule-e2e.
 *
 * The assertions that matter, and why each one is here rather than being
 * obvious:
 *
 *   - a load lands on PREVIEW and air does not move. The whole feature is
 *     worthless if it does not, and the failure is on a stream.
 *   - a load never moves a cue counter. `anim.cue` / `seq.cue` are what the
 *     output pages key their entrances off, so a load that bumped one would
 *     replay every entrance on the following take - the exact thing the
 *     counter exists to prevent.
 *   - a second load pushes NOTHING. The movement gate, which is the
 *     `/api/game` scar generalised.
 *   - a fixture naming no map leaves Global alone. Same scar, the other half:
 *     a write nobody made must not count as having spoken.
 *   - the winner's map rows are REPLACED, not merged, so last match's third map
 *     cannot sit under this match's first two.
 *   - a report reads PREVIEW, not air. Mid-map air is the previous map's score,
 *     so reading it would file the wrong result and be right often enough to be
 *     trusted.
 *   - a session key reaches neither, which asserts KEYED_ROUTES rather than a
 *     check in the route: there is deliberately none, and adding '/api/fixture'
 *     to that list turns those assertions red.
 *
 *   node tools/tests/fixture-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8179;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-fixture-e2e-'));

let passed = 0;
let failed = 0;
const ok = (name, condition, detail = '') => {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const env = {
  ...process.env,
  PORT: String(PORT),
  STATE_DIR: STATE,
  ADMIN_USERNAME: 'boss',
  ADMIN_PASSWORD: 'a-long-enough-password',
  TRACKER_ENABLED: 'false',
  HENRIK_API_KEY: '',
  RIOT_API_KEY: '',
  RIOT_ACCOUNT_KEY: '',
};

const server = spawn(process.execPath, ['server.js'], { cwd: PROJECT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (c) => (log += c));
server.stderr.on('data', (c) => (log += c));

const ready = async () => {
  for (let i = 0; i < 80; i += 1) {
    try {
      await fetch(`${BASE}/api/auth/state`);
      return true;
    } catch {
      await wait(250);
    }
  }
  return false;
};

function agent() {
  let cookie = '';
  return async (p, options = {}) => {
    const response = await fetch(`${BASE}${p}`, {
      ...options,
      headers: { ...(options.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) },
    });
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const pair = line.split(';')[0];
      if (pair.startsWith('rl_session=')) cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: response.status, text, json };
  };
}

const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

try {
  if (!(await ready())) throw new Error(`server never came up:\n${log}`);

  const boss = agent();
  const view = agent();
  const outsider = agent();
  await boss('/api/auth/login', json({ username: 'boss', password: 'a-long-enough-password' }));
  await boss('/api/admin/users', json({ action: 'create', username: 'watcher', password: 'another-long-password' }));
  await boss('/api/admin/users', json({ action: 'create', username: 'nobody', password: 'a-third-long-password' }));
  const users = (await boss('/api/admin/users')).json.users;
  const watcherId = users.find((u) => u.username === 'watcher').id;
  await view('/api/auth/login', json({ username: 'watcher', password: 'another-long-password' }));
  await outsider('/api/auth/login', json({ username: 'nobody', password: 'a-third-long-password' }));

  const cup = (await boss('/api/tournaments', json({ action: 'create', name: 'Seam Cup' }))).json.tournament;
  await boss('/api/tournaments', json({ action: 'member', id: cup.id, userId: watcherId, level: 'viewer' }));

  /*
   * Read ONCE, and pinned against a UUID before anything asserts on it.
   *
   * A negative assertion against an `undefined` key searches for the string
   * "undefined" and passes while testing nothing - which is exactly how a
   * previously green assertion in tournament-e2e turned out to be vacuous.
   */
  const cupKey = cup.productions[0].sessionKey;
  ok('1. the tournament minted a real key', /^[0-9a-f-]{36}$/.test(cupKey ?? ''), cupKey);

  const here = (p) => `${p}${p.includes('?') ? '&' : '?'}session=${cup.id}`;

  await boss(here('/api/schedule'), json({ action: 'stage.save', stage: { name: 'Playoffs', kind: 'bracket', bestOf: 3 } }));
  await boss(
    here('/api/schedule'),
    json({
      action: 'fixture.save',
      fixture: {
        id: 'sf1',
        stageId: 'playoffs',
        bestOf: 3,
        left: { name: 'Sentinels', shortName: 'SEN', region: 'Americas', colour: '#c9424f', teamId: 'sen' },
        right: { name: 'LOUD', shortName: 'LLL', region: 'BR', teamId: 'loud' },
        // Deliberately NOT Ascent. Ascent is DEFAULT_GLOBAL's map, and an
        // assertion that the map "synced" to the value it already held is the
        // vacuous shape globalsync-e2e shipped once already.
        maps: [{ name: 'Split', left: 0, right: 0 }],
      },
    }),
  );
  // A fixture that names no map at all, for the other half of the gate.
  await boss(
    here('/api/schedule'),
    json({
      action: 'fixture.save',
      fixture: { id: 'sf2', stageId: 'playoffs', bestOf: 3, left: { name: 'Fnatic', shortName: 'FNC' }, right: { name: 'Paper Rex', shortName: 'PRX' } },
    }),
  );
  // And one with nobody in it yet, which is an ordinary state of a bracket.
  await boss(here('/api/schedule'), json({ action: 'fixture.save', fixture: { id: 'final', stageId: 'playoffs', bestOf: 5 } }));
  // One reserved for the `?bus=` block below. Its own, because that block FILES
  // a result, and a block that quietly consumes a map slot another assertion is
  // counting on is the kind of coupling that reports as somebody else's bug.
  await boss(
    here('/api/schedule'),
    json({ action: 'fixture.save', fixture: { id: 'busfix', stageId: 'playoffs', bestOf: 3, left: { name: 'Karmine Corp', shortName: 'KC' }, right: { name: 'Team Heretics', shortName: 'TH' } } }),
  );

  // ------------------------------------------------------------ the load ---

  /*
   * Stale rows on the winner graphic first, so the REPLACE below is tested
   * against something. Rows 2-5 have to be non-blank going in or "they are
   * blank afterwards" proves nothing at all.
   */
  const winnerBefore = (await boss(here('/api/winner?bus=preview'))).json.state;
  await boss(
    here('/api/winner?bus=preview'),
    json({
      state: {
        ...winnerBefore,
        maps: winnerBefore.maps.map((row, i) => ({ ...row, name: `Stale ${i + 1}`, left: 13, right: i })),
      },
    }),
  );
  const staleRows = (await boss(here('/api/winner?bus=preview'))).json.state.maps;
  ok('2. the winner graphic really is carrying stale rows first', staleRows.every((row) => row.name.startsWith('Stale')), JSON.stringify(staleRows.map((r) => r.name)));

  const airBefore = (await boss(here('/api/graphic'))).json.state;
  const cueBefore = {
    graphic: (await boss(here('/api/graphic?bus=preview'))).json.state.anim.cue,
    winner: (await boss(here('/api/winner?bus=preview'))).json.state.seq.cue,
    select: (await boss(here('/api/select?bus=preview'))).json.state.anim.cue,
  };

  let r = await boss(here('/api/fixture'), json({ action: 'load', id: 'sf1' }));
  ok('3. an editor can load a fixture', r.status === 200, r.text.slice(0, 200));
  ok('4. ...and it reports which graphics moved', JSON.stringify(r.json.pushed) === '["graphic","winner","select"]', JSON.stringify(r.json?.pushed));
  ok('5. ...and names the fixture it loaded', r.json.label === 'Sentinels vs LOUD', r.json?.label);
  ok('6. ...and says the map it set', r.json.map === 'Split', r.json?.map);

  const prev = (await boss(here('/api/graphic?bus=preview'))).json.state;
  ok('7. the preview scoreboard took the left team', prev.left.teamName === 'Sentinels', prev.left.teamName);
  ok('8. ...and the right', prev.right.teamName === 'LOUD', prev.right.teamName);
  ok('9. ...and the library link, for the picker to show', prev.left.teamId === 'sen', prev.left.teamId);
  // The scoreboard side has no shortName/region/colour, and applyTeam writes
  // only keys the target HAS - so a load must not have grown it any.
  ok('10. ...and grew no key the scoreboard does not have', !('shortName' in prev.left) && !('region' in prev.left), Object.keys(prev.left).join(','));

  const air = (await boss(here('/api/graphic'))).json.state;
  ok('11. AIR did not move', air.left.teamName === airBefore.left.teamName && air.right.teamName === airBefore.right.teamName, `${air.left.teamName}/${air.right.teamName}`);
  ok('12. ...and specifically does not carry the fixture', air.left.teamName !== 'Sentinels', air.left.teamName);

  const winnerPrev = (await boss(here('/api/winner?bus=preview'))).json.state;
  ok('13. the winner graphic took the teams with their tricodes', winnerPrev.left.shortName === 'SEN' && winnerPrev.right.shortName === 'LLL', `${winnerPrev.left.shortName}/${winnerPrev.right.shortName}`);
  ok('14. ...and the region, which only it has a slot for', winnerPrev.left.region === 'Americas', winnerPrev.left.region);
  ok('15. the fixture\'s map row landed', winnerPrev.maps[0].name === 'Split', winnerPrev.maps[0]?.name);
  /*
   * THE ONE THAT MATTERS on this graphic. A merge would leave rows 2-5 saying
   * "Stale" - last match's scores sitting under this match's first map, on a
   * splash that goes to air at the end of a series.
   */
  ok('16. ...and the stale rows were REPLACED, not merged', winnerPrev.maps.slice(1).every((row) => row.name === '' && row.left === 0 && row.right === 0), JSON.stringify(winnerPrev.maps.map((r) => r.name)));

  const selectPrev = (await boss(here('/api/select?bus=preview'))).json.state;
  ok('17. agent select took the teams', selectPrev.left.name === 'Sentinels', selectPrev.left.name);
  ok('18. ...and kept its own side labels, which are not a fixture\'s business', selectPrev.left.label === 'DEF' && selectPrev.left.side === 'defence', `${selectPrev.left.label}/${selectPrev.left.side}`);

  ok('19. the cue counters did not move - scoreboard', (await boss(here('/api/graphic?bus=preview'))).json.state.anim.cue === cueBefore.graphic);
  ok('20. ...winner', (await boss(here('/api/winner?bus=preview'))).json.state.seq.cue === cueBefore.winner);
  ok('21. ...agent select', (await boss(here('/api/select?bus=preview'))).json.state.anim.cue === cueBefore.select);

  ok('22. the map reached Global', (await boss(here('/api/global'))).json.state.mapName === 'Split', (await boss(here('/api/global'))).json.state?.mapName);
  ok('23. ...and the one-way sync carried it to the scoreboard', prev.map === 'Split', prev.map);

  // The movement gate. Pressing Load twice is the ordinary way to reach this.
  r = await boss(here('/api/fixture'), json({ action: 'load', id: 'sf1' }));
  ok('24. loading the same fixture again pushes nothing', r.status === 200 && r.json.pushed.length === 0, JSON.stringify(r.json?.pushed));
  ok('25. ...and sets no map', r.json.map === '', r.json?.map);

  /*
   * The other half of the gate, and the `/api/game` scar restated: a fixture
   * that names no map must not blank the one an operator has set. Loading sf2
   * moves the teams and leaves Global exactly where it was.
   */
  r = await boss(here('/api/fixture'), json({ action: 'load', id: 'sf2' }));
  ok('26. a fixture naming no map still loads its teams', r.json.pushed.length === 3, JSON.stringify(r.json?.pushed));
  ok('27. ...and reports setting no map', r.json.map === '', r.json?.map);
  ok('28. ...and leaves the operator\'s map alone', (await boss(here('/api/global'))).json.state.mapName === 'Split', (await boss(here('/api/global'))).json.state?.mapName);

  // An empty fixture is an ordinary state of a bracket, and loading it says so
  // rather than leaving the previous match's teams up under a new label.
  r = await boss(here('/api/fixture'), json({ action: 'load', id: 'final' }));
  ok('29. loading a fixture with nobody in it blanks the sides', (await boss(here('/api/graphic?bus=preview'))).json.state.left.teamName === '', (await boss(here('/api/graphic?bus=preview'))).json.state?.left?.teamName);

  r = await boss(here('/api/fixture'), json({ action: 'load', id: 'no-such-thing' }));
  ok('30. loading a fixture that is not there is refused', r.status === 400, String(r.status));
  ok('31. ...and says it may have been removed', /removed/i.test(r.json?.error?.hint ?? ''), r.json?.error?.hint);

  // ---------------------------------------------------------- the report ---

  // Back onto sf1, then put a real score on the PREVIEW board.
  await boss(here('/api/fixture'), json({ action: 'load', id: 'sf1' }));
  const board = (await boss(here('/api/graphic?bus=preview'))).json.state;
  await boss(
    here('/api/graphic?bus=preview'),
    json({ state: { ...board, left: { ...board.left, roundsWon: 13 }, right: { ...board.right, roundsWon: 6 } } }),
  );
  /*
   * And a DIFFERENT score on air, so "it read preview" is a real claim rather
   * than a coincidence of the two agreeing. Mid-map this is exactly the shape
   * of the mistake: air is the previous map's final score.
   *
   * `?bus=program` spelled out, because a WRITE that says nothing stages - the
   * deliberate asymmetry in `busFor`. Without it this second write lands on
   * preview too, silently overwrites the score above, and the assertion below
   * "fails" against correct code. It did exactly that once here.
   */
  await boss(
    here('/api/graphic?bus=program'),
    json({ state: { ...board, map: 'Icebox', left: { ...board.left, roundsWon: 2 }, right: { ...board.right, roundsWon: 13 } } }),
  );
  ok('31b. air really is carrying a different score first', (await boss(here('/api/graphic'))).json.state.left.roundsWon === 2, String((await boss(here('/api/graphic'))).json.state?.left?.roundsWon));

  r = await boss(here('/api/fixture'), json({ action: 'report', id: 'sf1' }));
  ok('32. a result is reported', r.status === 200, r.text.slice(0, 200));
  ok('33. ...into the first unplayed map, with no index given', r.json.index === 0, String(r.json?.index));
  ok('34. ...reading PREVIEW and not air', r.json.map.left === 13 && r.json.map.right === 6, JSON.stringify(r.json?.map));
  ok('35. ...taking the map name from the board it read', r.json.map.name === 'Split', r.json?.map?.name);

  const filed = r.json.schedule.fixtures.find((f) => f.id === 'sf1');
  ok('36. the fixture holds the result', filed.maps[0].left === 13 && filed.maps[0].right === 6, JSON.stringify(filed?.maps?.[0]));
  ok('37. ...and the series score follows from it', filed.maps.filter((m) => m.left > m.right).length === 1);

  // The next one goes to map 2 rather than overwriting map 1.
  const board2 = (await boss(here('/api/graphic?bus=preview'))).json.state;
  await boss(here('/api/global'), json({ state: { ...(await boss(here('/api/global'))).json.state, mapName: 'Lotus' } }));
  await boss(
    here('/api/graphic?bus=preview'),
    json({ state: { ...board2, map: 'Lotus', left: { ...board2.left, roundsWon: 9 }, right: { ...board2.right, roundsWon: 13 } } }),
  );
  r = await boss(here('/api/fixture'), json({ action: 'report', id: 'sf1' }));
  ok('38. the next report goes to the next map', r.json.index === 1, String(r.json?.index));
  ok('39. ...and does not disturb the first', r.json.schedule.fixtures.find((f) => f.id === 'sf1').maps[0].name === 'Split');
  ok('40. ...so the series reads 1-1', JSON.stringify(r.json.schedule.fixtures.find((f) => f.id === 'sf1').maps.map((m) => `${m.left}-${m.right}`)) === '["13-6","9-13"]', JSON.stringify(r.json.schedule.fixtures.find((f) => f.id === 'sf1').maps));

  // An explicit index is taken literally, so map 1 can be corrected later.
  const board3 = (await boss(here('/api/graphic?bus=preview'))).json.state;
  await boss(
    here('/api/graphic?bus=preview'),
    json({ state: { ...board3, map: 'Split', left: { ...board3.left, roundsWon: 13 }, right: { ...board3.right, roundsWon: 11 } } }),
  );
  r = await boss(here('/api/fixture'), json({ action: 'report', id: 'sf1', index: 0 }));
  ok('41. an explicit index corrects the map it names', r.json.schedule.fixtures.find((f) => f.id === 'sf1').maps[0].right === 11, JSON.stringify(r.json.schedule.fixtures.find((f) => f.id === 'sf1').maps[0]));
  ok('42. ...and leaves map 2 alone', r.json.schedule.fixtures.find((f) => f.id === 'sf1').maps[1].right === 13);

  r = await boss(here('/api/fixture'), json({ action: 'report', id: 'sf1', index: 9 }));
  ok('43. a map the series does not have is refused', r.status === 400, String(r.status));
  ok('44. ...and says how long the series is', /best of 3/i.test(r.json?.error?.message ?? ''), r.json?.error?.message);

  r = await boss(here('/api/fixture'), json({ action: 'report', id: 'sf1', index: 'banana' }));
  ok('45. a map number that is not a number is refused', r.status === 400 && /not a map number/i.test(r.json?.error?.message ?? ''), r.json?.error?.message);

  // A 0-0 board is what a map nobody has played looks like.
  const board4 = (await boss(here('/api/graphic?bus=preview'))).json.state;
  await boss(
    here('/api/graphic?bus=preview'),
    json({ state: { ...board4, left: { ...board4.left, roundsWon: 0 }, right: { ...board4.right, roundsWon: 0 } } }),
  );
  r = await boss(here('/api/fixture'), json({ action: 'report', id: 'sf1', index: 2 }));
  ok('46. a 0-0 board is refused', r.status === 400 && /0-0/.test(r.json?.error?.message ?? ''), r.json?.error?.message);

  /*
   * A nameless row would count toward the series score in the table and be
   * skipped by `activeMaps` on the winner splash - two places disagreeing with
   * nothing failing, which is the shape this codebase refuses.
   */
  const board5 = (await boss(here('/api/graphic?bus=preview'))).json.state;
  await boss(
    here('/api/graphic?bus=preview'),
    json({ state: { ...board5, map: '', left: { ...board5.left, roundsWon: 13 }, right: { ...board5.right, roundsWon: 4 } } }),
  );
  r = await boss(here('/api/fixture'), json({ action: 'report', id: 'sf1', index: 2 }));
  ok('47. a board that does not say which map is refused', r.status === 400 && /which map/i.test(r.json?.error?.message ?? ''), r.json?.error?.message);
  ok('48. ...and points at where to set it', /Global/.test(r.json?.error?.hint ?? ''), r.json?.error?.hint);

  /*
   * `?bus=` is IRRELEVANT on this route, and that is asserted rather than left
   * to be read off the handler.
   *
   * `handleFixtureAction` never consults `params` - it stages, always, and
   * reads preview, always. But `handlePost` has `writeBus` in hand two lines
   * above the call, so a future refactor that threads it in would silently
   * change which board gets filed and which one gets written, with nothing
   * failing. These two pin the decision, not the implementation.
   */
  const boardBus = (await boss(here('/api/graphic?bus=preview'))).json.state;
  await boss(
    here('/api/graphic?bus=preview'),
    json({ state: { ...boardBus, map: 'Breeze', left: { ...boardBus.left, roundsWon: 13 }, right: { ...boardBus.right, roundsWon: 1 } } }),
  );
  await boss(
    here('/api/graphic?bus=program'),
    json({ state: { ...boardBus, map: 'Abyss', left: { ...boardBus.left, roundsWon: 5 }, right: { ...boardBus.right, roundsWon: 13 } } }),
  );
  const airBus = (await boss(here('/api/graphic'))).json.state;
  ok('48b. air and preview really do differ first', airBus.map === 'Abyss' && airBus.left.roundsWon === 5, `${airBus.map} ${airBus.left.roundsWon}`);

  r = await boss(here('/api/fixture?bus=program'), json({ action: 'load', id: 'busfix' }));
  ok('48c. a load asking for program still stages', r.status === 200 && (await boss(here('/api/graphic?bus=preview'))).json.state.left.teamName === 'Karmine Corp', r.text.slice(0, 160));
  ok('48d. ...and air still did not move', (await boss(here('/api/graphic'))).json.state.left.teamName === airBus.left.teamName, (await boss(here('/api/graphic'))).json.state?.left?.teamName);

  // Preview kept Breeze 13-1 through the load (a load moves teams, not scores).
  r = await boss(here('/api/fixture?bus=program'), json({ action: 'report', id: 'busfix' }));
  ok('48e. a report asking for program still reads PREVIEW', r.json?.map?.name === 'Breeze' && r.json?.map?.left === 13, JSON.stringify(r.json?.map ?? r.json?.error));

  r = await boss(here('/api/fixture'), json({ action: 'wat' }));
  ok('49. an unknown fixture action is a 400', r.status === 400, String(r.status));
  ok('50. ...and lists the real ones', /load, report/.test(r.json?.error?.hint ?? ''), r.json?.error?.hint);

  // -------------------------------------------------------------- the gate ---

  r = await view(here('/api/fixture'), json({ action: 'load', id: 'sf1' }));
  ok('51. a viewer cannot load a fixture onto the graphics', r.status === 403, String(r.status));
  r = await view(here('/api/fixture'), json({ action: 'report', id: 'sf1' }));
  ok('52. ...nor report one', r.status === 403, String(r.status));

  r = await outsider(here('/api/fixture'), json({ action: 'load', id: 'sf1' }));
  ok('53. a non-member cannot reach it at all', r.status === 403, String(r.status));

  /*
   * KEYED_ROUTES, asserted as a LIST rather than as a check in the route -
   * there is deliberately none. Adding '/api/fixture' to that set turns 54 and
   * 55 red, which is the whole point of it being a list.
   */
  const keyedLoad = await fetch(`${BASE}/api/fixture?key=${encodeURIComponent(cupKey)}`, json({ action: 'load', id: 'sf1' }));
  ok('54. a session key cannot load a fixture', keyedLoad.status === 403, String(keyedLoad.status));
  const keyedReport = await fetch(`${BASE}/api/fixture?key=${encodeURIComponent(cupKey)}`, json({ action: 'report', id: 'sf1' }));
  ok('55. ...nor report one', keyedReport.status === 403, String(keyedReport.status));

  /*
   * A cookie-authenticated write whose Content-Type an HTML form could have set
   * is refused - the CSRF shape every session POST here passes. 415, which is
   * the house status for it (see auth-e2e), and "absent" is one of the shapes a
   * form can produce, which is why a bodiless `fetch` POST had to grow one.
   */
  const noType = await boss(here('/api/fixture'), { method: 'POST', body: JSON.stringify({ action: 'load', id: 'sf1' }) });
  ok('56. a write with no Content-Type is refused', noType.status === 415, String(noType.status));
  const formType = await boss(here('/api/fixture'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'action=load&id=sf1',
  });
  ok('56b. ...and so is a form-shaped one', formType.status === 415, String(formType.status));

  // --------------------------------------------------------- two desks ---

  const desk2 = (await boss('/api/tournaments', json({ action: 'production.create', id: cup.id, name: 'Court 2' }))).json;
  const productions = desk2.tournament?.productions ?? [];
  ok('57. the tournament has two desks', productions.length === 2, String(productions.length));
  const second = productions[1].id;
  const onCourtTwo = (p) => `${p}${p.includes('?') ? '&' : '?'}production=${second}`;

  // The SCHEDULE is shared, so Court 2 can see the same fixtures...
  r = await boss(onCourtTwo('/api/schedule'));
  ok('58. the second desk reads the same schedule', r.json.schedule.fixtures.some((f) => f.id === 'sf1'), String(r.json?.schedule?.fixtures?.length));

  // ...but the GRAPHICS are not.
  const courtOneBefore = (await boss(here('/api/graphic?bus=preview'))).json.state.left.teamName;
  r = await boss(onCourtTwo('/api/fixture'), json({ action: 'load', id: 'sf2' }));
  ok('59. a load on the second desk works', r.status === 200 && r.json.pushed.length > 0, r.text.slice(0, 160));
  ok('60. ...and lands on that desk', (await boss(onCourtTwo('/api/graphic?bus=preview'))).json.state.left.teamName === 'Fnatic', (await boss(onCourtTwo('/api/graphic?bus=preview'))).json.state?.left?.teamName);
  ok('61. ...and NOT on the first', (await boss(here('/api/graphic?bus=preview'))).json.state.left.teamName === courtOneBefore, (await boss(here('/api/graphic?bus=preview'))).json.state?.left?.teamName);

  // And a report from one desk reaches the shared schedule both read.
  const board6 = (await boss(onCourtTwo('/api/graphic?bus=preview'))).json.state;
  await boss(
    onCourtTwo('/api/graphic?bus=preview'),
    json({ state: { ...board6, map: 'Haven', left: { ...board6.left, roundsWon: 13 }, right: { ...board6.right, roundsWon: 3 } } }),
  );
  await boss(onCourtTwo('/api/fixture'), json({ action: 'report', id: 'sf2' }));
  const shared = (await boss(here('/api/schedule'))).json.schedule.fixtures.find((f) => f.id === 'sf2');
  ok('62. a result filed on one desk is on the other desk\'s schedule', shared.maps[0]?.name === 'Haven', JSON.stringify(shared?.maps));

  // ------------------------------------------------------------- the log ---

  /*
   * Both presses leave a trace, like the take and like staging a lobby.
   * `report` is the one that earns it: it overwrites a map row in the
   * COMPETITION record, which every desk of the tournament shares, so without
   * a line there is nothing at all to answer "who filed that" after a show.
   */
  ok('62b. a load is logged', /staged from the schedule/.test(log), 'no load line in the log');
  ok('62c. ...naming who did it', /boss/.test(log), 'no operator named');
  ok('62d. a report is logged', /reported from the scoreboard/.test(log), 'no report line in the log');
  ok('62e. ...with the result it filed', /13-6|13-3|13-1/.test(log), 'no score in the report line');

  ok('63. no session key reached the log', !log.includes(cupKey), 'a key is in the log buffer');
  const buffer = (await boss('/api/admin/logs')).json?.entries ?? [];
  ok('64. ...nor the admin log buffer', !JSON.stringify(buffer).includes(cupKey));
} catch (error) {
  failed += 1;
  console.log(`  FAIL  threw - ${error.message}\n${error.stack}`);
} finally {
  server.kill();
  await wait(300);
  rmSync(STATE, { recursive: true, force: true });
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
