/**
 * The standings graphic.
 *
 * Like the bracket, most of what matters is about the SNAPSHOT: this graphic
 * holds the TABLES `stageTables` answered with rather than a competition, so
 * the questions are whether the table matches what the Schedule page would
 * draw, whether a schedule edit can move what is on air (it must not), and
 * whether the graphic ever puts teams in an order the table refuses to have.
 *
 * It opens a browser for the three things a payload cannot answer: whether the
 * fit reaches the element, whether sixteen pools actually stay on the frame,
 * and whether a long org name pushes the columns. Each of those regresses
 * silently - every state assertion stays green while the board paints wrong.
 *
 * Verified by deliberate breaks; each is named in the commit.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openAsAdmin } from './harness.mjs';
import { standings as standingsOf, stageTables } from '../../public/schedule-schema.js';
import { bracketAutoFit } from '../../public/bracket-graphic-schema.js';
import {
  STANDINGS_AUTO_MAX,
  STANDINGS_FRAME,
  STANDINGS_METRICS,
  standingsAutoFit,
  standingsIsStale,
  standingsLayout,
  standingsThrough,
} from '../../public/standings-schema.js';

const playwright = await import(new URL('../../node_modules/playwright/index.js', import.meta.url).href);
const chromium = playwright.chromium ?? playwright.default.chromium;

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8184;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-stand-'));

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

const server = spawn(process.execPath, ['server.js'], {
  cwd: PROJECT,
  env: {
    ...process.env,
    PORT: String(PORT),
    STATE_DIR: STATE,
    ADMIN_USERNAME: 'boss',
    ADMIN_PASSWORD: 'a-long-enough-password',
    TRACKER_ENABLED: 'false',
    HENRIK_API_KEY: '',
    RIOT_ACCOUNT_KEY: '',
    RIOT_API_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (c) => (log += c));
server.stderr.on('data', (c) => (log += c));
let browser = null;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 80; i += 1) {
  try {
    await fetch(`${BASE}/api/auth/state`);
    break;
  } catch {
    await wait(250);
  }
}

try {
  const { cookie, key, tournamentId } = await openAsAdmin(BASE, 'boss', 'a-long-enough-password', 'Standings Cup');
  const H = { 'Content-Type': 'application/json', Cookie: cookie };
  const at = (route, extra = '') => `${BASE}${route}?session=${tournamentId}${extra}`;
  const get = async (route, extra = '') => (await (await fetch(at(route, extra), { headers: { Cookie: cookie } })).json());
  const post = async (route, body, extra = '') => {
    const response = await fetch(at(route, extra), { method: 'POST', headers: H, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const T = (name, short) => ({ name, shortName: short });
  /* A Bo1 that really was played. 13-x, never 13-13, or the fixture is undecided. */
  const bo1 = (leftWon) => [{ name: 'Ascent', left: leftWon ? 13 : 8, right: leftWon ? 8 : 13 }];
  const save = (fixture) => post('/api/schedule', { action: 'fixture.save', fixture });

  /*
   * TWO POOLS, and one of them deliberately holds a TIE.
   *
   * Group A: Alpha and Beta each beat Gamma, and do not play each other - so
   * they finish on one win apiece and SHARE second... no: they share FIRST, on
   * 1-0 and 1-0, with Gamma on 0-2. Ranks come out 1, 1, 3. That is the shape
   * the qualification cut has to be honest about.
   */
  await post('/api/schedule', {
    action: 'stage.save',
    stage: { name: 'Group stage', kind: 'group', bestOf: 1, groups: [{ name: 'Group A' }, { name: 'Group B' }] },
  });
  const stage = (await get('/api/schedule')).schedule.stages.find((entry) => entry.name === 'Group stage');
  const [groupA, groupB] = stage.groups;

  await save({ id: 'a1', stageId: stage.id, group: groupA.id, round: 1, slot: 0, bestOf: 1, left: T('Alpha', 'ALP'), right: T('Gamma', 'GAM'), maps: bo1(true) });
  await save({ id: 'a2', stageId: stage.id, group: groupA.id, round: 1, slot: 1, bestOf: 1, left: T('Beta', 'BET'), right: T('Gamma', 'GAM'), maps: bo1(true) });
  await save({ id: 'b1', stageId: stage.id, group: groupB.id, round: 1, slot: 0, bestOf: 1, left: T('Delta', 'DEL'), right: T('Epsilon', 'EPS'), maps: bo1(true) });

  // ============================================================== the load ==
  const loaded = await post('/api/standings', { action: 'load', id: stage.id }, '&bus=preview');
  eq('1 a group stage loads', loaded.status, 200);
  const board = loaded.body.state;
  eq('2 it lands on PREVIEW', loaded.body.bus, 'preview');
  eq('3 one table per group', board.groups.length, 2);
  eq('3a ...named as the groups are', board.groups.map((entry) => entry.name).join('|'), 'Group A|Group B');

  /*
   * THE TABLE IS THE ONE THE SCHEDULE PAGE DRAWS.
   *
   * The assertion that justifies the whole design: both come from `standings`,
   * so there is one implementation of who is second. A second one on the server
   * would be one refactor from a table on the desk that does not match the one
   * on air, with nothing failing.
   */
  const doc = (await get('/api/schedule')).schedule;
  const direct = stageTables(doc, doc.stages.find((entry) => entry.id === stage.id));
  eq(
    '4 the board is exactly what stageTables answered',
    JSON.stringify(board.groups.map((entry) => entry.rows.map((line) => [line.name, line.rank, line.won, line.lost]))),
    JSON.stringify(direct.map((entry) => entry.table.map((line) => [line.name, line.rank, line.won, line.lost]))),
  );

  const a = board.groups[0].rows;
  eq('5 everybody in the pool is seated', a.length, 3);
  eq('5a ...ranked, with the tie SHARED', a.map((line) => line.rank).join(','), '1,1,3');

  /*
   * `played` IS NOT IN A ROW, and this is the pin on that decision.
   *
   * `standings` computes one; the snapshot drops it, because a VALORANT match
   * has no draw and a void or unfinished one counts for neither side - so
   * played is won + lost, always, and a P column can never disagree with the
   * two beside it. Asserted against the schedule's own number rather than
   * against arithmetic repeated here, or it would only be testing itself.
   */
  const raw = standingsOf(doc, stage.id, groupA.id);
  ok('6 a row carries no played count', !('played' in a[0]), JSON.stringify(Object.keys(a[0])));
  ok(
    '6a ...because wins plus losses already is it',
    raw.every((line) => line.played === line.won + line.lost),
    JSON.stringify(raw.map((line) => [line.played, line.won, line.lost])),
  );
  ok('6b ...and no team id goes into the snapshot', !('teamId' in a[0]), JSON.stringify(Object.keys(a[0])));

  // ==================================================== the qualification ===
  /*
   * MARKED BY RANK, NOT BY ROW, and it is the whole reason this field is
   * counted the way it is. With 1, 1, 3 and a cut of ONE, both leaders are
   * marked - marking the first ROW would pick one of two teams the table
   * cannot separate, which is precisely the order it refuses to have.
   */
  const cut = { ...board, qualify: 1 };
  eq('7 a cut of one marks BOTH teams tied at the top', a.filter((line) => standingsThrough(cut, line)).length, 2);
  eq('7a ...and not the team below them', Number(standingsThrough(cut, a[2])), 0);
  eq('8 a cut of zero marks nobody', a.filter((line) => standingsThrough({ ...board, qualify: 0 }, line)).length, 0);

  // ========================================================== the geometry ==
  /*
   * ARITHMETIC, with no browser in it. The grid shape is the one that leaves
   * the tables biggest, so the assertion is not "four pools go two by two" -
   * that would pass against a hard-coded table of counts - it is that NO OTHER
   * SHAPE fits bigger.
   */
  const pools = (count, rows) => ({
    layout: 'all',
    groups: Array.from({ length: count }, (_, i) => ({
      id: `g${i}`,
      name: `Group ${i}`,
      rows: Array.from({ length: rows }, (_, r) => ({ name: `T${r}`, rank: r + 1 })),
    })),
  });

  const four = standingsLayout(pools(4, 4));
  eq('9 four pools of four go two by two', `${four.cols}x${four.rows}`, '2x2');
  /*
   * ...and it is the WIDEST shape that still fits at full size. Three and four
   * across do not: they are 2152 and 2888 pixels of table in the 1728 the frame
   * gives them, so they would have to be drawn at 0.80 and 0.60.
   */
  ok('9a ...at its own design size or better', four.scale >= 1, `scale ${four.scale}`);
  {
    const { tableW, gapX } = STANDINGS_METRICS;
    const availW = 1920 - STANDINGS_FRAME.left - STANDINGS_FRAME.right;
    ok(
      '9b ...three across being too wide to fit at all',
      3 * tableW + 2 * gapX > availW,
      `${3 * tableW + 2 * gapX} into ${availW}`,
    );
  }
  eq('10 one pool is one table', `${standingsLayout(pools(1, 4)).cols}x${standingsLayout(pools(1, 4)).rows}`, '1x1');

  /*
   * TWO POOLS GO SIDE BY SIDE, and this is the assertion that makes the shape
   * rule a decision rather than an accident.
   *
   * The first version of `standingsLayout` maximised the SCALE, and on this
   * exact case it stacked them into a column - two short tables leave height to
   * spare, so one 1020px-wide table is arithmetically larger than two 816px
   * ones, by two per cent. A group stage is two pools played at the same time
   * and every broadcast draws them side by side. So the assertion states BOTH
   * halves: the shape that is chosen, and that the rejected shape really would
   * have been bigger - without the second half this passes against the rule it
   * was written to replace.
   */
  const pair = standingsLayout(pools(2, 4));
  eq('10a two pools go side by side', `${pair.cols}x${pair.rows}`, '2x1');
  {
    const { tableW, gapY } = STANDINGS_METRICS;
    const tall = STANDINGS_METRICS.nameH + STANDINGS_METRICS.headH + 4 * STANDINGS_METRICS.rowH;
    const stacked = Math.min((1920 - 192) / tableW, (1080 - 264) / (2 * tall + gapY));
    ok(
      '10b ...although stacking them would have been bigger',
      standingsAutoFit(stacked) > pair.scale,
      `stacked ${standingsAutoFit(stacked)} vs side by side ${pair.scale}`,
    );
  }

  /*
   * ONE GROUP AT A TIME IS AN INDEX, NOT A FILTER - so the layout is worked out
   * from the pool being SHOWN rather than from all of them, and the board is
   * drawn as though that were the only table there is.
   */
  const oneOfFour = standingsLayout({ ...pools(4, 4), layout: 'one', group: 2 });
  eq('11 one at a time draws a single table', `${oneOfFour.cols}x${oneOfFour.rows}`, '1x1');
  ok('11a ...and therefore bigger than the same pool in a grid', oneOfFour.scale > four.scale, `${oneOfFour.scale} vs ${four.scale}`);

  /*
   * THE FIT MAY SHRINK, and this is the deliberate difference from the
   * bracket's. Asserted BESIDE `bracketAutoFit` on the same numbers, because
   * "this one goes below 1" is only a decision if the other one does not -
   * otherwise it is an accident nobody chose.
   */
  const many = standingsLayout(pools(16, 4));
  ok('12 sixteen pools are shrunk to fit', many.scale < 1, `scale ${many.scale}`);
  eq(
    '12a ...where the bracket would refuse to shrink at all',
    bracketAutoFit({ drawW: many.width, drawH: many.height, availW: 1728, availH: 816 }),
    1,
  );
  /*
   * FLOORED, NEVER ROUNDED - and the first version of this assertion could not
   * tell the two apart. It asked whether the scale lands on the 0.05 grid,
   * which ROUNDING also does, so a break swapping `floor` for `round` passed
   * it. What flooring is FOR is that the painted board can only ever land
   * inside the space the fit came from, so that is what this asks now: at
   * sixteen pools, rounding takes 0.598 up to 0.60 and paints 1733 pixels into
   * 1728 of room - off the end of the space by a rounding error, with nothing
   * else failing.
   */
  ok('12b the fit is on the 0.05 grid', Math.abs(many.scale * 20 - Math.round(many.scale * 20)) < 1e-9, String(many.scale));
  {
    const availW = 1920 - STANDINGS_FRAME.left - STANDINGS_FRAME.right;
    const availH = 1080 - STANDINGS_FRAME.top - STANDINGS_FRAME.bottom;
    ok(
      '12b1 ...and floored, so the painted board fits the space it was measured against',
      many.width * many.scale <= availW + 1e-9 && many.height * many.scale <= availH + 1e-9,
      `${Math.round(many.width * many.scale)}x${Math.round(many.height * many.scale)} into ${availW}x${availH}`,
    );
  }
  eq('12c a tiny board is capped rather than blown up', standingsAutoFit(9), STANDINGS_AUTO_MAX);

  // ============================================================ the refusals
  /*
   * The bracket stage is given MATCHES first, and that is not decoration.
   *
   * Without them the refusal below still answers 400 - but for the OTHER
   * reason, "no teams to show", so deleting the `stageHasTable` guard entirely
   * leaves the status assertion green. That is the shape the veto suite's
   * assertion 33 turned out to have. With two played fixtures in it this stage
   * would draw a perfectly good-looking table, and the only thing standing
   * between it and the graphic is the guard.
   */
  await post('/api/schedule', { action: 'stage.save', stage: { name: 'Playoffs', kind: 'bracket', bestOf: 1 } });
  await save({ id: 'k1', stageId: 'playoffs', round: 1, slot: 0, bracket: 'upper', bestOf: 1, left: T('Alpha', 'ALP'), right: T('Beta', 'BET'), maps: bo1(true) });
  await save({ id: 'k2', stageId: 'playoffs', round: 1, slot: 1, bracket: 'upper', bestOf: 1, left: T('Delta', 'DEL'), right: T('Gamma', 'GAM'), maps: bo1(true) });
  const knockout = await post('/api/standings', { action: 'load', id: 'playoffs' }, '&bus=preview');
  eq('13 a BRACKET stage is refused', knockout.status, 400);
  ok("13a ...for being a bracket, not for being empty", /no table/i.test(knockout.body?.error?.message ?? ''), JSON.stringify(knockout.body));
  ok(
    '13b ...although it would have drawn a table happily enough',
    standingsOf((await get('/api/schedule')).schedule, 'playoffs').length === 4,
    'the guard is the only thing refusing it',
  );

  await post('/api/schedule', { action: 'stage.save', stage: { name: 'Empty pool', kind: 'roundrobin', bestOf: 1 } });
  const bare = await post('/api/standings', { action: 'load', id: 'empty-pool' }, '&bus=preview');
  eq('14 a stage with no matches is refused rather than drawn blank', bare.status, 400);

  eq('15 a stage nobody has is a 404', (await post('/api/standings', { action: 'load', id: 'nope' }, '&bus=preview')).status, 404);

  // =========================================================== walking pools
  const stepped = await post('/api/standings', { action: 'group', to: 1 }, '&bus=preview');
  eq('16 the group index moves', stepped.body.state.group, 1);
  /*
   * CLAMPED TO THE POOLS THAT EXIST. An index past the end leaves an operator
   * pressing Next with nothing happening and no way to tell a broken graphic
   * from a finished one - the same note the bracket's reveal carries.
   */
  eq('16a ...and cannot run off the end', (await post('/api/standings', { action: 'group', to: 9 }, '&bus=preview')).body.state.group, 1);
  eq('16b ...nor below the first', (await post('/api/standings', { action: 'group', to: -4 }, '&bus=preview')).body.state.group, 0);
  const bump = await post('/api/standings', { action: 'group' }, '&bus=preview');
  eq('16c a bare step is the next one along', bump.body.state.group, 1);

  // ======================================================= what Load keeps ==
  await post(
    '/api/standings',
    { state: { ...bump.body.state, heading: 'GROUP STAGE', qualify: 2, showRounds: true, eventLogo: '/media/x.png' } },
    '&bus=preview',
  );
  const again = await post('/api/standings', { action: 'load', id: stage.id }, '&bus=preview');
  eq('17 a second Load keeps the operator\'s heading', again.body.state.heading, 'GROUP STAGE');
  eq('17a ...the qualification cut', again.body.state.qualify, 2);
  eq('17b ...the columns', again.body.state.showRounds, true);
  eq('17c ...and the event logo', again.body.state.eventLogo, '/media/x.png');
  /*
   * AND LEAVES THE POOL WHERE IT IS. An operator pressing Load to catch up with
   * a result filed behind them means "the numbers have moved", not "go back to
   * Group A" - which on a board that is on air would jump the pool under a
   * caster mid-sentence.
   */
  eq('17d ...and does not jump back to the first pool', again.body.state.group, 1);

  // ================================================== the copy is a copy ====
  const before = JSON.stringify(again.body.state.groups);
  await save({ id: 'a1', stageId: stage.id, group: groupA.id, round: 1, slot: 0, bestOf: 1, left: T('Alpha Renamed', 'ALP'), right: T('Gamma', 'GAM'), maps: bo1(true) });
  const untouched = (await get('/api/standings', '&bus=preview')).state;
  eq('18 renaming a team does NOT change what is loaded', JSON.stringify(untouched.groups), before);
  ok(
    '18a ...and the board knows it has gone stale',
    standingsIsStale(untouched, {
      stageId: stage.id,
      groups: stageTables(
        (await get('/api/schedule')).schedule,
        (await get('/api/schedule')).schedule.stages.find((entry) => entry.id === stage.id),
      ).map((entry) => ({ id: entry.id, name: entry.name, rows: entry.table })),
    }),
    'stale badge did not light',
  );
  ok(
    '18b ...and a board loaded from a DIFFERENT stage is not called stale',
    !standingsIsStale({ ...untouched, stageId: 'somewhere-else' }, { stageId: stage.id, groups: [] }),
    'wrong stage compared',
  );

  // =============================================================== the take =
  await post('/api/standings', { action: 'load', id: stage.id }, '&bus=preview');
  /*
   * WALKING THE POOLS IS NOT A TRANSPORT PRESS. `group` is deliberately out of
   * `transport` in buses.js: stepping to the next pool animates that pool in,
   * and bumping the cue would fly the whole board on again every time - both
   * the failure the counter exists to prevent and, here, a worse-looking one,
   * because changing what is on the board IS the gesture.
   *
   * THE TWO BUSES ARE SYNCED FIRST, and without that this assertion proves
   * nothing: program has never been taken to at this point, so its index is 0
   * and preview's is 0, and putting `group` into `transport` changes no answer
   * because the two already agree. A break doing exactly that passed. Take
   * once, step the pool on preview alone, then take again.
   */
  await post('/api/take', { graphic: 'standings' });
  const air = (await get('/api/standings')).state;
  const airBefore = air.anim.cue;
  // The OTHER pool, whichever the sync above happened to leave on air.
  const other = air.group === 0 ? 1 : 0;
  const pooled = await post('/api/standings', { action: 'group', to: other }, '&bus=preview');
  eq('19 the two buses now differ by a pool', `${pooled.body.state.group}/${air.group}`, `${other}/${air.group}`);
  ok('19a ...which is the whole point of the assertion below', pooled.body.state.group !== air.group, 'buses agree');
  const dataOnly = await post('/api/take', { graphic: 'standings' });
  eq('19b a take that only walked the pools does not replay', dataOnly.body.replayed, false);
  eq('19c ...and leaves the cue alone', (await get('/api/standings')).state.anim.cue, airBefore);
  eq('19d ...while the pool itself does cross', (await get('/api/standings')).state.group, other);

  const shown = (await get('/api/standings', '&bus=preview')).state;
  await post('/api/standings', { state: { ...shown, anim: { ...shown.anim, visible: true } } }, '&bus=preview');
  const showIt = await post('/api/take', { graphic: 'standings' });
  eq('20 a take that puts it up DOES replay', showIt.body.replayed, true);
  eq('20a ...and the cue moved', (await get('/api/standings')).state.anim.cue, (airBefore + 1) % 1_000_000);

  // ============================================================== the page ==
  /*
   * At the size OBS renders it. `fitStage` scales #stage by
   * min(innerWidth/1920, innerHeight/1080), so a 1920x1080 viewport makes that
   * factor exactly 1 and every number below is in stage pixels.
   */
  {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', (event) => errors.push(String(event)));
    page.on('console', (event) => {
      if (event.type() === 'error') errors.push(event.text());
    });

    const pageUrl = (bus) => `${BASE}/standings.html?key=${encodeURIComponent(key)}${bus ? `&bus=${bus}` : ''}`;

    const measure = async () => {
      await page.waitForFunction(() => document.querySelectorAll('.row').length > 0, null, { timeout: 15000 });
      await wait(300);
      return page.evaluate(() => {
        const box = (node) => {
          const r = node.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) };
        };
        const grid = document.getElementById('tables');
        const rows = [...document.querySelectorAll('.row:not(.is-head)')];
        return {
          transform: getComputedStyle(grid).transform,
          origin: getComputedStyle(grid).transformOrigin,
          gridBox: box(grid),
          tables: [...document.querySelectorAll('.table')].map(box),
          names: [...document.querySelectorAll('.table-name')].map((n) => n.textContent),
          rows: rows.length,
          through: rows.filter((n) => n.classList.contains('is-through')).length,
          heads: [...(document.querySelector('.table .is-head')?.querySelectorAll('.cell-stat') ?? [])].map(
            (n) => n.textContent,
          ),
          firstRow: rows[0] ? box(rows[0]) : null,
          /*
           * Every row of the FIRST table, named. Measuring `rows[0]` was the
           * first version and it was measuring the wrong row: a table is sorted
           * by wins and then by name, so renaming a team to something long
           * moves it down the table and the assertion went on reading a short
           * one. Whatever the columns do, they must do it to every row.
           */
          firstTable: [...(document.querySelector('.table')?.querySelectorAll('.row:not(.is-head)') ?? [])].map(
            (r) => {
              const nameEl = r.querySelector('.cell-name');
              return {
                name: nameEl.textContent,
                clipped: nameEl.scrollWidth > nameEl.clientWidth + 1,
                stat: box(r.querySelector('.cell-stat:last-child')).right,
                nameRight: box(nameEl).right,
                teamRight: box(r.querySelector('.cell-team')).right,
              };
            },
          ),
        };
      });
    };

    const put = (patch) =>
      get('/api/standings', '&bus=preview').then((current) =>
        post('/api/standings', { state: { ...current.state, ...patch } }, '&bus=preview'),
      );

    /*
     * The event logo is cleared first. Assertion 17c put a URL there to prove a
     * Load keeps one, and nothing serves it - so the page would fetch it, get a
     * 404 and log a console error, which `30` would then report as the page
     * having thrown. The broken-image guard is doing its job; the suite was
     * asking the wrong question of it.
     */
    await put({ layout: 'all', group: 0, qualify: 1, showRounds: false, eventLogo: '', anim: { visible: true, cue: 1 } });
    await page.goto(pageUrl('preview'));
    const both = await measure();

    eq('21 both pools are painted', both.tables.length, 2);
    eq('21a ...named', both.names.join('|'), 'GROUP A|GROUP B');
    // Three in group A and two in group B - the pools are deliberately uneven,
    // so a table that quietly took its row count from the first one is caught.
    eq('21b ...with a row per team', both.rows, 5);
    /*
     * THE CUT, ON SCREEN, AND BY RANK. Group A is 1, 1, 3 and group B is 1, 2,
     * so a cut of one marks three rows - two in A and one in B. A graphic
     * marking the top ROW of each would mark two, and would be choosing between
     * two teams the table cannot separate.
     */
    eq('22 the cut marks by RANK, so a tie at the top marks both', both.through, 3);

    eq('23 the columns are the ones switched on', both.heads.join('|'), 'W-L|MAPS');

    /*
     * THE FIT REACHES THE ELEMENT.
     *
     * The factor is arithmetic and is asserted as arithmetic above - and that
     * proves nothing about the page. Delete the line that writes the transform
     * and every state assertion in this file stays green while the board paints
     * at 1.0 for ever. This is the same shape the bracket's own suite found.
     */
    ok('24 the grid is actually transformed', both.transform !== 'none', both.transform);
    eq('24a ...about its top left, which is what the centring assumes', both.origin, '0px 0px');

    /*
     * AND THE BOARD STAYS ON THE FRAME. This is what "the fit may shrink" buys
     * and it is the claim the bracket cannot make - measured at SIXTEEN pools,
     * which is the most a stage can hold.
     */
    const bottom = both.tables.reduce((low, t) => Math.max(low, t.bottom), 0);
    const right = both.tables.reduce((edge, t) => Math.max(edge, t.right), 0);
    ok('25 nothing is painted off the bottom of the frame', bottom <= 1080, `bottom ${bottom}`);
    ok('25a ...nor off the side', right <= 1920, `right ${right}`);

    /*
     * A LONG ORG NAME MUST NOT PUSH THE COLUMNS.
     *
     * A grid item is `min-width: auto` by default, which is its CONTENT - so
     * without `min-width: 0` a long name widens the team column and shoves the
     * stat columns off the end of a table whose width the fit has already
     * committed to. Measured as the same number at both name lengths, which is
     * the tie that a break reports as two different edges.
     */
    const short = both.firstTable[0].stat;
    /*
     * The round column goes ON for this, which is what makes the case real: it
     * takes the name down to 316 design pixels, and 32 characters - the most
     * the sanitiser will store - does not fit in it. `clipped` is asserted
     * below rather than assumed, because a name that happens to fit would make
     * every measurement here agree for the wrong reason.
     */
    await put({ showRounds: true });
    await save({
      id: 'a1',
      stageId: stage.id,
      group: groupA.id,
      round: 1,
      slot: 0,
      bestOf: 1,
      left: T('Extraordinarily Long Org Naming', 'ALP'),
      right: T('Gamma', 'GAM'),
      maps: bo1(true),
    });
    await post('/api/standings', { action: 'load', id: stage.id }, '&bus=preview');
    await wait(400);
    const long = await measure();
    const wide = long.firstTable.find((line) => /EXTRAORDINARILY/.test(line.name));
    ok('26pre the long name really is too big for its column', Boolean(wide?.clipped), JSON.stringify(long.firstTable.map((l) => [l.name, l.clipped])));
    ok(
      '26 a long org name does not move the stat columns',
      long.firstTable.every((line) => line.stat === short),
      JSON.stringify(long.firstTable.map((line) => [line.name, line.stat])) + ` vs ${short}`,
    );
    ok('26a ...and the table is the width it was', long.tables[0].w === both.tables[0].w, `${long.tables[0].w} vs ${both.tables[0].w}`);
    /*
     * TWO DIFFERENT FAILURES, and 26 above can only see one of them.
     *
     * The guard on the CELL holds the grid track open, and without it the stat
     * columns move 192px right - that is 26. The guards on the SPAN inside it
     * do something else entirely: without them the name does not widen
     * anything, it paints OUT THROUGH THE SIDE of its cell and across the
     * numbers, and every box on the row still reports the size it asked for.
     * Breaks removing each in turn found that the span's two guards are
     * redundant with one another, so only removing both bites - which is what
     * this asks about.
     */
    ok(
      '26b ...and stays inside the cell it was given, over the numbers being the other failure',
      wide.nameRight <= wide.teamRight + 1,
      `name ends at ${wide.nameRight}, cell at ${wide.teamRight}`,
    );

    // ------------------------------------------------- one pool at a time ---
    await put({ layout: 'one', group: 0 });
    await wait(400);
    const solo = await measure();
    eq('27 one at a time paints a single table', solo.tables.length, 1);
    eq('27a ...the one the index names', solo.names.join('|'), 'GROUP A');
    ok('27b ...drawn bigger than it was in the grid', solo.tables[0].w > both.tables[0].w, `${solo.tables[0].w} vs ${both.tables[0].w}`);
    /*
     * HUNG FROM THE TOP, whatever is on it - which a screenshot is what caught.
     *
     * The board was centred both ways at first, the way the bracket's sheet is,
     * and on ONE short table that left 200 pixels of nothing between the header
     * and the first row: the graphic read as having failed to load its top
     * half. Four pools fill the frame and hid it completely, which is why every
     * measurement in this suite was green.
     */
    eq('27c the board hangs from the same line however much is on it', solo.gridBox.y, both.gridBox.y);
    ok('27d ...and is still centred across the frame', Math.abs(solo.gridBox.x + solo.gridBox.w / 2 - 960) <= 1, JSON.stringify(solo.gridBox));

    await put({ group: 1 });
    await wait(400);
    const next = await measure();
    eq('28 stepping shows the next pool', next.names.join('|'), 'GROUP B');
    eq('28a ...in the same table element, repainted', next.tables.length, 1);

    // SIXTEEN POOLS, which is the most a stage can hold, and the case the
    // shrinking fit exists for.
    const sixteen = (await get('/api/standings', '&bus=preview')).state;
    await post(
      '/api/standings',
      {
        state: {
          ...sixteen,
          layout: 'all',
          groups: Array.from({ length: 16 }, (_, i) => ({
            id: `p${i}`,
            name: `Pool ${i + 1}`,
            rows: Array.from({ length: 4 }, (_, r) => ({ name: `Team ${r}`, shortName: 'T', rank: r + 1, won: 3 - r, lost: r })),
          })),
        },
      },
      '&bus=preview',
    );
    await wait(400);
    const full = await measure();
    eq('29 sixteen pools all paint', full.tables.length, 16);
    const deep = full.tables.reduce((low, t) => Math.max(low, t.bottom), 0);
    const far = full.tables.reduce((edge, t) => Math.max(edge, t.right), 0);
    ok('29a ...and none of them leaves the frame', deep <= 1080 && far <= 1920, `bottom ${deep}, right ${far}`);
    ok('29b ...which needed the fit to go below 1', full.transform !== 'none', full.transform);

    ok('30 the page threw nothing', errors.length === 0, errors.join(' | '));
  }

  // ------------------------------------------------------------ the gate ---
  const keyRead = await fetch(`${BASE}/api/standings?key=${encodeURIComponent(key)}`);
  eq('31 a key may read it, so OBS works', keyRead.status, 200);
  const keyWrite = await fetch(`${BASE}/api/standings?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'load', id: 'group-stage' }),
  });
  eq('32 ...and may not write it', keyWrite.status, 403);

  ok('33 a load is logged', /standings loaded/.test(log), 'no audit line');
  ok('34 no session key reached the log', !log.includes(key), 'KEY LEAKED');
} catch (error) {
  fail += 1;
  console.log('THREW', error.stack);
  console.log(log.slice(-1500));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await wait(600);
  server.kill('SIGKILL');
  try {
    rmSync(STATE, { recursive: true, force: true });
  } catch {
    /* windows */
  }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
