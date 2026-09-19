/**
 * The bracket graphic.
 *
 * What is worth asserting here is almost entirely about the SNAPSHOT: this
 * graphic holds a drawing rather than a competition, so the questions are
 * whether the drawing matches what the Schedule page would draw, whether a
 * schedule edit can move what is on air (it must not), and whether the reveal
 * counts rounds rather than matches.
 *
 * Verified by deliberate breaks; each is named in the commit.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openAsAdmin } from './harness.mjs';
import { bracketLayout } from '../../public/schedule-schema.js';
import {
  BRACKET_AUTO_MAX,
  BRACKET_SCALE_MAX,
  BRACKET_SCALE_MIN,
  DEFAULT_BRACKET_GRAPHIC,
  bracketAutoFit,
  bracketChampion,
  bracketDrawScale,
} from '../../public/bracket-graphic-schema.js';

/*
 * The one suite here that opens the graphic.
 *
 * Every other assertion in this file is about the SNAPSHOT and needs no page -
 * which was fine until the sheet gained a size. A factor is arithmetic and is
 * asserted as arithmetic below, but "the factor reaches the element" is not:
 * delete the line that writes the transform and every state assertion in this
 * file stays green while the graphic paints at exactly the size it always did.
 * That is the vacuous-assertion shape, so the last block renders the real page
 * at 1920x1080 and measures what is painted.
 */
const playwright = await import(new URL('../../node_modules/playwright/index.js', import.meta.url).href);
const chromium = playwright.chromium ?? playwright.default.chromium;

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8182;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-brkg-'));

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}`);

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
  const { cookie, key, tournamentId } = await openAsAdmin(BASE, 'boss', 'a-long-enough-password', 'Bracket Cup');
  const H = { 'Content-Type': 'application/json', Cookie: cookie };
  const at = (route, extra = '') => `${BASE}${route}?session=${tournamentId}${extra}`;
  const get = async (route, extra = '') => (await (await fetch(at(route, extra), { headers: { Cookie: cookie } })).json());
  const post = async (route, body, extra = '') => {
    const response = await fetch(at(route, extra), { method: 'POST', headers: H, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const T = (name, short) => ({ name, shortName: short });
  /*
   * Written out rather than generated. A Bo3 needs two map WINS and a map
   * cannot be 13-13 - a generated fixture produced exactly that and the
   * quarter-final came out undecided, which is the sort of thing that makes a
   * suite assert against a state nobody meant to build.
   */
  const bo3 = (leftWins) =>
    leftWins === 2
      ? [{ name: 'Ascent', left: 13, right: 7 }, { name: 'Bind', left: 13, right: 9 }]
      : [{ name: 'Ascent', left: 7, right: 13 }, { name: 'Bind', left: 9, right: 13 }];

  const save = (fixture) => post('/api/schedule', { action: 'fixture.save', fixture });

  await post('/api/schedule', { action: 'stage.save', stage: { name: 'Playoffs', kind: 'bracket', bestOf: 3 } });

  const quarters = [
    ['qf1', T('Sentinels', 'SI'), T('Crusaders', 'CRU'), 0],
    ['qf2', T('Arcane', 'ARC'), T('Zero GC', 'ZOGC'), 2],
    ['qf3', T('Aim Labs', 'AIM'), T('Wooden Box', 'WB'), 0],
    ['qf4', T('Zenith', 'ZO'), T('Jail Time', 'JAIL'), 0],
  ];
  for (let i = 0; i < quarters.length; i += 1) {
    const [id, left, right, wins] = quarters[i];
    await save({ id, stageId: 'playoffs', round: 1, slot: i, bracket: 'upper', bestOf: 3, left, right, maps: bo3(wins) });
  }

  /*
   * The later rounds get their EDGES first and their results second, which is
   * the operator's real order and the only one the schedule allows:
   * propagation refuses to rewrite a fixture that has already been played, so
   * one save carrying both an edge and a 2-0 is correctly refused.
   */
  const semis = [
    ['sf1', 'qf1', 'qf2', 2],
    ['sf2', 'qf3', 'qf4', 0],
  ];
  for (let i = 0; i < semis.length; i += 1) {
    const [id, a, b] = semis[i];
    await save({
      id,
      stageId: 'playoffs',
      round: 2,
      slot: i,
      bracket: 'upper',
      bestOf: 3,
      left: { source: { fixtureId: a, take: 'winner' } },
      right: { source: { fixtureId: b, take: 'winner' } },
    });
  }
  await save({
    id: 'gf',
    stageId: 'playoffs',
    round: 3,
    slot: 0,
    bracket: 'upper',
    bestOf: 3,
    left: { source: { fixtureId: 'sf1', take: 'winner' } },
    right: { source: { fixtureId: 'sf2', take: 'winner' } },
  });

  let sched = await get('/api/schedule');
  const byId = Object.fromEntries(sched.schedule.fixtures.map((f) => [f.id, f]));
  eq('1 the draw propagated into the semi-finals', byId.sf1.left.name, 'Crusaders');
  for (const [id, , , wins] of semis) await save({ ...byId[id], maps: bo3(wins) });
  sched = await get('/api/schedule');
  await save({ ...sched.schedule.fixtures.find((f) => f.id === 'gf'), maps: bo3(2) });

  // ------------------------------------------------------------- the load ---
  let r = await post('/api/bracket', { action: 'load', id: 'playoffs' }, '&bus=preview');
  eq('2 a stage loads', r.status, 200);
  const drawn = r.body.state;
  eq('3 ...as three rounds', drawn.columns, 3);
  eq('4 ...and seven matches', drawn.nodes.length, 7);
  eq('5 ...with six edges', drawn.links.length, 6);

  /*
   * THE ONE THAT JUSTIFIES THE WHOLE DESIGN: the graphic's drawing is the same
   * one the Schedule page computes, because both come from bracketLayout. A
   * second implementation of the geometry is one refactor away from a board on
   * the desk that does not match the board on air, with nothing failing.
   */
  const fresh = await get('/api/schedule');
  const layout = bracketLayout(fresh.schedule, 'playoffs');
  eq(
    '6 the graphic draws exactly what the Schedule page would',
    JSON.stringify(drawn.nodes.map((n) => [n.id, n.column, n.row])),
    JSON.stringify(layout.nodes.map((n) => [n.id, n.column, n.row])),
  );

  /*
   * Teams are RESOLVED into the snapshot - the output page never dereferences
   * anything while it paints.
   */
  const qf1 = drawn.nodes.find((n) => n.id === 'qf1');
  eq('7 a node carries its teams by name', `${qf1.left.shortName}/${qf1.right.shortName}`, 'SI/CRU');
  eq('8 ...and their map score', `${qf1.left.score}-${qf1.right.score}`, '0-2');
  eq('9 ...and who won', qf1.winner, 'right');

  /*
   * An edge is LIVE only where somebody actually progressed. A line pulsing
   * toward an empty slot tells an audience about a result that does not exist.
   */
  eq('10 every edge of a finished bracket is live', drawn.links.filter((l) => l.live).length, 6);
  eq('11 the champion falls out of the drawing', bracketChampion(drawn)?.shortName, 'CRU');

  /*
   * AND THE OTHER DIRECTION, which is the half that makes assertion 10 mean
   * anything.
   *
   * Its first version only counted live edges on a FINISHED bracket, where all
   * six are - so hard-coding `live: true` passed it. Found by breaking it on
   * purpose. An unplayed round is the case the flow exists to exclude: a line
   * pulsing toward an empty slot tells an audience about a result that does not
   * exist.
   */
  {
    await post('/api/schedule', { action: 'stage.save', stage: { name: 'Undecided', kind: 'bracket', bestOf: 3 } });
    await save({ id: 'uq1', stageId: 'undecided', round: 1, slot: 0, bracket: 'upper', bestOf: 3, left: T('Alpha', 'ALP'), right: T('Beta', 'BET') });
    await save({ id: 'uq2', stageId: 'undecided', round: 1, slot: 1, bracket: 'upper', bestOf: 3, left: T('Gamma', 'GAM'), right: T('Delta', 'DEL') });
    await save({
      id: 'usf',
      stageId: 'undecided',
      round: 2,
      slot: 0,
      bracket: 'upper',
      bestOf: 3,
      left: { source: { fixtureId: 'uq1', take: 'winner' } },
      right: { source: { fixtureId: 'uq2', take: 'winner' } },
    });

    const half = await post('/api/bracket', { action: 'load', id: 'undecided' }, '&bus=preview');
    eq('11b an unplayed bracket still draws its edges', half.body.state.links.length, 2);
    eq('11c ...and NONE of them is live', half.body.state.links.filter((l) => l.live).length, 0);
    eq('11d ...and it has no champion', bracketChampion(half.body.state), null);

    // One result, and exactly one edge comes alive.
    const now = await get('/api/schedule');
    await save({ ...now.schedule.fixtures.find((f) => f.id === 'uq1'), maps: bo3(2) });
    const oneDone = await post('/api/bracket', { action: 'load', id: 'undecided' }, '&bus=preview');
    eq('11e filing one result lights exactly one edge', oneDone.body.state.links.filter((l) => l.live).length, 1);

    // Back to the finished bracket for everything below.
    await post('/api/bracket', { action: 'load', id: 'playoffs' }, '&bus=preview');
  }

  // ------------------------------------------------------------ the reveal ---
  eq('12 a fresh load reveals nothing', drawn.reveal, 0);
  r = await post('/api/bracket', { action: 'reveal' }, '&bus=preview');
  eq('13 reveal counts ROUNDS, not matches', r.body.state.reveal, 1);
  r = await post('/api/bracket', { action: 'reveal', to: 99 }, '&bus=preview');
  eq('14 ...and is clamped to the rounds that exist', r.body.state.reveal, 3);
  r = await post('/api/bracket', { action: 'reveal', to: -5 }, '&bus=preview');
  eq('15 ...and never below nothing', r.body.state.reveal, 0);

  // ---------------------------------------------------- the operator's work ---
  const styled = await post(
    '/api/bracket',
    {
      state: {
        ...r.body.state,
        heading: 'Playoffs',
        flow: false,
        eventLogo: '/media/event.png',
        winner: { show: true, heading: 'CHAMPIONS', label: '', image: '', footer: 'WINNER' },
      },
    },
    '&bus=preview',
  );
  eq('16 the winner panel is settable', styled.body.state.winner.heading, 'CHAMPIONS');
  eq('17 the flow can be switched off', styled.body.state.flow, false);

  r = await post('/api/bracket', { action: 'load', id: 'playoffs' }, '&bus=preview');
  eq('18 a second Load keeps the winner panel wording', r.body.state.winner.heading, 'CHAMPIONS');
  eq('19 ...and the flow switch', r.body.state.flow, false);
  eq('20 ...and the event logo', r.body.state.eventLogo, '/media/event.png');

  /*
   * A COPY, not a view. This is the graphic most likely to be up while somebody
   * is filing results behind it, so a schedule edit reaching air would be the
   * worst version of the failure copy-not-link exists to prevent.
   */
  await post('/api/take', { graphic: 'bracket' });
  const onAir = await get('/api/bracket');
  eq('21 it can be taken', onAir.state.nodes.length, 7);

  await save({ ...(await get('/api/schedule')).schedule.fixtures.find((f) => f.id === 'qf1'), left: T('RENAMED', 'REN') });
  const after = await get('/api/bracket');
  const stillSI = after.state.nodes.find((n) => n.id === 'qf1');
  eq('22 renaming a team does NOT change what is on air', stillSI.left.shortName, 'SI');

  r = await post('/api/bracket', { action: 'load', id: 'nope' }, '&bus=preview');
  eq('23 loading a stage that is gone is refused', r.status, 404);

  await post('/api/schedule', { action: 'stage.save', stage: { name: 'Empty', kind: 'bracket', bestOf: 3 } });
  r = await post('/api/bracket', { action: 'load', id: 'empty' }, '&bus=preview');
  eq('24 a stage with no matches is refused rather than drawn blank', r.status, 400);

  // ------------------------------------------------------------ the cue ---
  /*
   * Revealing a round must NOT replay the entrance - only visibility is in
   * `transport`, so a take that moved the reveal leaves the cue alone.
   */
  const cueBefore = (await get('/api/bracket')).state.anim.cue;
  await post('/api/bracket', { action: 'reveal', to: 2 }, '&bus=preview');
  await post('/api/take', { graphic: 'bracket' });
  eq('25 a take that only revealed a round does not bump the cue', (await get('/api/bracket')).state.anim.cue, cueBefore);

  const shown = await get('/api/bracket', '&bus=preview');
  await post('/api/bracket', { state: { ...shown.state, anim: { ...shown.state.anim, visible: true } } }, '&bus=preview');
  await post('/api/take', { graphic: 'bracket' });
  ok('26 ...but showing it does', (await get('/api/bracket')).state.anim.cue !== cueBefore, 'cue did not move');

  // --------------------------------------------------------- the colours ---
  /*
   * Two colours the operator owns, and BLANK is a real answer.
   *
   * Blank means "whatever the stylesheet says", so the built-in look lives in
   * one place - the CSS - rather than being duplicated into the schema as a
   * default that then has to be kept in step with it. A plain text field would
   * have stored the empty string and the page would have painted black.
   */
  {
    let c = await post('/api/bracket', { state: { ...(await get('/api/bracket', '&bus=preview')).state, accent: '#C8AA6E', trim: '#c9424f' } }, '&bus=preview');
    eq('27a the highlight colour is stored, lowercased', c.body.state.accent, '#c8aa6e');
    eq('27b ...and the trim beside it', c.body.state.trim, '#c9424f');

    c = await post('/api/bracket', { state: { ...c.body.state, accent: 'rebeccapurple' } }, '&bus=preview');
    eq('27c a colour that is not a hex is refused rather than stored', c.body.state.accent, '');

    c = await post('/api/bracket', { state: { ...c.body.state, accent: '#abc' } }, '&bus=preview');
    eq('27d a three-digit hex is a hex', c.body.state.accent, '#abc');

    c = await post('/api/bracket', { state: { ...c.body.state, accent: '', trim: '' } }, '&bus=preview');
    ok('27e blank survives, because unset is a state', c.body.state.accent === '' && c.body.state.trim === '');

    /*
     * And they survive a Load, like the rest of the operator's work - the
     * colours are set once before a season and a Load means "the draw moved".
     */
    await post('/api/bracket', { state: { ...c.body.state, accent: '#112233' } }, '&bus=preview');
    const reloaded = await post('/api/bracket', { action: 'load', id: 'playoffs' }, '&bus=preview');
    eq('27f the colours survive a Load', reloaded.body.state.accent, '#112233');

    /* The winner panel's default wording is the reference board's: the same
     * line above and below the crest, which is what `footer` is for. */
    eq('27g the panel says the placing top and bottom by default', DEFAULT_BRACKET_GRAPHIC.winner.footer, '1ST PLACE');
    eq('27h ...and adds nothing else unless asked', DEFAULT_BRACKET_GRAPHIC.winner.heading, '');
  }

  // ------------------------------------------------------------- the size ---
  /*
   * How big the sheet is drawn, which is arithmetic and therefore asserted as
   * arithmetic - no browser, no measurement, the same reason `bracketLayout`
   * itself is unit-tested in schedule-model rather than in a page.
   *
   * The numbers below are the real ones: a draw is `columns * 300 - 76` wide
   * and `rows * 92 - 18` tall, the frame gives it 1776x792 with no winner panel
   * and 1408x792 with one.
   */
  {
    const size = (columns, rows) => ({ drawW: columns * 300 - 76, drawH: rows * 92 - 18 });
    const room = (panel) => ({ availW: 1920 - 72 - (panel ? 320 + 72 + 48 : 72), availH: 1080 - 168 - 120 });
    const fitFor = (columns, rows, panel = false) => bracketAutoFit({ ...size(columns, rows), ...room(panel) });

    eq('26a a four-team draw is grown, and capped rather than fitted', fitFor(2, 2), BRACKET_AUTO_MAX);
    eq('26b an eight-team draw is fitted rather than capped', fitFor(3, 4), 2.15);
    eq('26c ...and the winner panel takes room, so the same draw is fitted smaller', fitFor(3, 4, true), 1.7);
    eq('26d a sixteen-team draw barely grows', fitFor(4, 8), 1.1);

    /*
     * A draw that does not fit is left exactly as it is drawn today.
     *
     * Deliberate, and the deliberate half is `Math.max(1, ...)`: a 32-team
     * sheet wants 0.54 to fit the frame, and silently shrinking a bracket that
     * is already going to air is a change nobody asked for. `drawScale` reaches
     * down to 0.6 so an operator has a handle. Delete the max() and this goes
     * red rather than quietly changing what a large show looks like.
     */
    eq('26e a draw too big for the frame is not shrunk', fitFor(5, 16), 1);
    eq('26f ...nor is a double elimination', fitFor(6, 13), 1);

    /*
     * THE ONE THAT IS NOT A ROUND NUMBER, and the reason it is here.
     *
     * Four columns of six rows fits at 1.4831. ROUNDING that to the 0.05 grid
     * gives 1.50, which paints 534 * 1.5 = 801px into the 792px the frame has -
     * off the bottom edge, by a rounding error, with nothing failing and
     * nothing measuring it. Flooring gives 1.45 and can only ever land inside
     * the fit. Swap the Math.floor for Math.round and both of these go red.
     */
    eq('26g the factor is FLOORED to the grid, never rounded', fitFor(4, 6), 1.45);
    const awkward = size(4, 6);
    ok(
      '26h ...so what is painted always fits the room it was measured against',
      fitFor(4, 6) * awkward.drawH <= room(false).availH,
      `${fitFor(4, 6) * awkward.drawH} into ${room(false).availH}`,
    );

    // Degenerate shapes answer 1 rather than Infinity or NaN - an empty board
    // is an ordinary state, it is what every graphic holds before a Load.
    eq('26i nothing loaded is not a division by zero', bracketAutoFit({ ...size(0, 0), ...room(false) }), 1);

    // --- and what the operator's own number does to it ---
    const eight = { ...size(3, 4), ...room(false) };
    eq('26j the operator multiplies the fit rather than replacing it', bracketDrawScale({ autoSize: true, drawScale: 1.2 }, eight), 2.58);
    eq('26k ...and switching the fit off hands them the number itself', bracketDrawScale({ autoSize: false, drawScale: 0.6 }, eight), 0.6);
    eq('26l a state that says nothing is the size every bracket was drawn at', bracketDrawScale({ autoSize: false }, eight), 1);
    /*
     * Two maxima multiply out to 5.5, which is a transform nobody asked for on
     * a graphic that is on air. Bounded rather than trusted.
     */
    eq('26m the product is bounded', bracketDrawScale({ autoSize: true, drawScale: BRACKET_SCALE_MAX }, { ...size(2, 2), ...room(false) }), 3);

    // --- the fields reach the store, and default to what a show already has ---
    eq('26n the fit is on by default', DEFAULT_BRACKET_GRAPHIC.autoSize, true);
    eq('26o ...and the operator adjustment starts at no adjustment', DEFAULT_BRACKET_GRAPHIC.drawScale, 1);

    let z = await post('/api/bracket', { state: { ...(await get('/api/bracket', '&bus=preview')).state, autoSize: false, drawScale: 1.35 } }, '&bus=preview');
    eq('26p the switch is stored', z.body.state.autoSize, false);
    eq('26q ...and so is the size', z.body.state.drawScale, 1.35);

    z = await post('/api/bracket', { state: { ...z.body.state, drawScale: 99 } }, '&bus=preview');
    eq('26r a size past the slider is clamped, not stored', z.body.state.drawScale, BRACKET_SCALE_MAX);
    z = await post('/api/bracket', { state: { ...z.body.state, drawScale: 'enormous' } }, '&bus=preview');
    eq('26s ...and junk falls back rather than painting NaN', z.body.state.drawScale, 1);
    z = await post('/api/bracket', { state: { ...z.body.state, drawScale: 0.01 } }, '&bus=preview');
    eq('26t ...and the floor holds at the other end', z.body.state.drawScale, BRACKET_SCALE_MIN);

    /*
     * And it survives a Load, like the colours - the size is set once for a
     * show and a Load means "the draw moved", not "start again".
     */
    await post('/api/bracket', { state: { ...z.body.state, autoSize: false, drawScale: 1.5 } }, '&bus=preview');
    const after = await post('/api/bracket', { action: 'load', id: 'playoffs' }, '&bus=preview');
    eq('26u the size survives a Load', after.body.state.drawScale, 1.5);
    eq('26v ...and so does the switch', after.body.state.autoSize, false);

    // Put it back, so the browser block below measures the shipped default.
    await post('/api/bracket', { state: { ...after.body.state, autoSize: true, drawScale: 1 } }, '&bus=preview');
  }

  // ---------------------------------------------------- the painted sheet ---
  /*
   * The graphic itself, at the size OBS renders it.
   *
   * `fitStage` scales #stage by min(innerWidth/1920, innerHeight/1080), so a
   * 1920x1080 viewport makes that factor exactly 1 and every number measured
   * below is in stage pixels - no second conversion to get wrong.
   */
  {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', (event) => errors.push(String(event)));

    const pageUrl = (bus) => `${BASE}/bracket.html?key=${encodeURIComponent(key)}${bus ? `&bus=${bus}` : ''}`;

    /** What is actually on the frame, once the stream has delivered a state. */
    const measure = async () => {
      await page.waitForFunction(() => document.querySelectorAll('.node').length > 0, null, { timeout: 15000 });
      await wait(250);
      return page.evaluate(() => {
        const box = (node) => {
          const r = node.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        };
        const drawEl = document.getElementById('draw');
        const nodes = [...document.querySelectorAll('.node')].map(box);
        const rects = nodes.map((n) => ({ ...n, right: n.x + n.w, bottom: n.y + n.h }));
        return {
          stage: getComputedStyle(document.getElementById('stage')).transform,
          transform: getComputedStyle(drawEl).transform,
          /*
           * The DECLARATION, dug out of the stylesheet, not the computed value.
           *
           * This assertion was written against getComputedStyle first and was
           * VACUOUS: #draw has no width or height of its own, so its box is 0x0
           * and the default `50% 50%` computes to `0px 0px` - byte-identical to
           * the value being asserted. Deleting the rule left it green. What is
           * worth pinning is that the safeguard is WRITTEN DOWN, because its
           * whole job is to survive somebody giving #draw a size later, and
           * only the rule itself can answer that.
           */
          origin: [...document.styleSheets]
            .flatMap((sheet) => {
              // The webfont sheet is cross-origin and THROWS on .cssRules -
              // not a value that `?? []` catches, which is how this took the
              // whole measurement down the first time.
              try {
                return [...sheet.cssRules];
              } catch {
                return [];
              }
            })
            .filter((rule) => rule.selectorText === '#draw')
            .map((rule) => rule.style.transformOrigin)
            .join(''),
          node: nodes[0],
          count: nodes.length,
          // The two that decide whether it is ON the frame at all.
          left: Math.min(...rects.map((n) => n.x)),
          top: Math.min(...rects.map((n) => n.y)),
          right: Math.max(...rects.map((n) => n.right)),
          bottom: Math.max(...rects.map((n) => n.bottom)),
          panel: (() => {
            const w = document.querySelector('.winner');
            const r = w.getBoundingClientRect();
            return { x: Math.round(r.x), shown: w.classList.contains('is-shown') };
          })(),
        };
      });
    };

    /*
     * This block says what state it starts in rather than inheriting it.
     *
     * Everything revealed, because an unrevealed node is still in the DOM at
     * translateX(-14px) and would measure 14px to the left of where it lives.
     * Visible, so the measurements are of a graphic that is actually up. And
     * the winner panel explicitly OFF - it was left on by the block above, and
     * a panel takes 440px of the frame, so the first measurement here silently
     * became the fitted-against-a-panel case and the assertion under it read as
     * the code being wrong. The same trap as the remembered settings group in
     * ui-e2e: a suite that walks through states has to say which one it is in.
     */
    await post('/api/bracket', { action: 'reveal', to: 99 }, '&bus=preview');
    const lit = await get('/api/bracket', '&bus=preview');
    await post(
      '/api/bracket',
      {
        state: {
          ...lit.state,
          winner: { ...lit.state.winner, show: false },
          autoSize: true,
          drawScale: 1,
          anim: { ...lit.state.anim, visible: true },
        },
      },
      '&bus=preview',
    );
    await page.goto(pageUrl('preview'));
    const grown = await measure();

    eq('31 the stage is 1:1 at 1920x1080, so these numbers are stage pixels', grown.stage, 'matrix(1, 0, 0, 1, 0, 0)');
    // 'left top' rather than 'top left': the CSSOM normalises the pair to
    // x-then-y when it reads the rule back.
    eq('32 the draw is DECLARED to scale from its top left corner', grown.origin, 'left top');
    /*
     * Three columns and four rows with no winner panel, and a node is 224 wide.
     * Asserted as the NUMBER rather than as "bigger than 224", because "bigger"
     * passes at 1.01 and the whole point is that a small sheet reads from
     * across a room.
     *
     * 824 x 390 of ink into 1776 x 792 of room fits at 2.03, floored to the
     * 0.05 grid as 2.00, and 224 * 2 = 448. The 390 is 4 rows of 92 less the
     * air under the last one PLUS the 40px band the ROUND HEADINGS take - which
     * is what turns the height into the binding constraint here. It used to be
     * the width, at 2.15.
     */
    eq('33 a small bracket is painted BIGGER than it was drawn', grown.node.w, 448);
    eq('34 ...by the factor the arithmetic asked for', grown.transform, 'matrix(2, 0, 0, 2, 0, 0)');

    /*
     * AND THE HEADINGS ARE REALLY IN THE ARITHMETIC.
     *
     * 33 and 34 alone cannot tell "the labels take room" from "the labels are
     * drawn on top of the top row" - both paint at some factor and neither
     * fails. Turning them off has to give the old number back exactly: 792/372
     * stops binding, the width does at 2.155, and it floors to 2.15. If the
     * band were being ignored the two measurements would be identical.
     */
    const headed = await get('/api/bracket', '&bus=preview');
    await post('/api/bracket', { state: { ...headed.state, showRoundLabels: false } }, '&bus=preview');
    await wait(400);
    const bare = await measure();
    eq('34a with the round headings off the sheet gets that room back', bare.transform, 'matrix(2.15, 0, 0, 2.15, 0, 0)');
    eq('34b ...and paints at the size it did before they existed', bare.node.w, 482);
    ok(
      '34c ...which is the assertion proving the band is reserved rather than drawn over',
      bare.node.w !== grown.node.w,
      `${bare.node.w} vs ${grown.node.w}`,
    );
    await post('/api/bracket', { state: { ...headed.state, showRoundLabels: true } }, '&bus=preview');
    await wait(400);

    /*
     * And it is still ON the frame. This is the assertion that a magnified
     * sheet most plausibly fails, because placeDraw's Math.max(0, ...) pins an
     * oversized draw to the corner and lets it run off the edge silently.
     */
    ok('35 ...and every node is inside the frame', grown.left >= 0 && grown.top >= 0 && grown.right <= 1920 && grown.bottom <= 1080, JSON.stringify(grown));

    /*
     * The winner panel takes room, so the sheet re-fits when it appears rather
     * than growing underneath it. Centring against the panel is the existing
     * behaviour; what is new is that the FACTOR has to fall as well, and a fit
     * computed against the whole frame would leave the two overlapping.
     */
    const before = await get('/api/bracket', '&bus=preview');
    await post('/api/bracket', { state: { ...before.state, winner: { ...before.state.winner, show: true } } }, '&bus=preview');
    await wait(400);
    const withPanel = await measure();
    eq('36 the winner panel re-fits the sheet smaller', withPanel.transform, 'matrix(1.7, 0, 0, 1.7, 0, 0)');
    ok('37 ...and the sheet does not run under the panel', withPanel.panel.shown && withPanel.right <= withPanel.panel.x, `draw ends ${withPanel.right}, panel starts ${withPanel.panel.x}`);

    // --- the operator's own number reaches the frame -------------------------
    const mid = await get('/api/bracket', '&bus=preview');
    await post('/api/bracket', { state: { ...mid.state, autoSize: false, drawScale: 1 } }, '&bus=preview');
    await wait(400);
    const plain = await measure();
    eq('38 the fit switched off is exactly the size it always was', plain.node.w, 224);
    eq('39 ...and writes no transform at all rather than scale(1)', plain.transform, 'none');

    await post('/api/bracket', { state: { ...mid.state, autoSize: false, drawScale: 1.5 } }, '&bus=preview');
    await wait(400);
    const manual = await measure();
    eq('40 the operator size reaches the frame', manual.node.w, 336);

    /*
     * The furniture does NOT scale with the sheet, and that is the reason the
     * transform is on #draw rather than on .board: the header and the winner
     * panel are the show's, not the draw's.
     */
    const furniture = await page.evaluate(() => ({
      stageName: getComputedStyle(document.querySelector('.head-stage')).fontSize,
      panelW: Math.round(document.querySelector('.winner').getBoundingClientRect().width),
    }));
    eq('41 the stage name does not grow with the sheet', furniture.stageName, '40px');
    eq('42 ...nor does the winner panel', furniture.panelW, 320);

    // =========================== the event's colours, and the names that lie ===
    /*
     * THE TRAP, stated as a test.
     *
     * This graphic's field called `accent` is its HIGHLIGHT - the slot of
     * whoever went through, the flow along the edges - and `trim` is its
     * ACCENT, the corner marks on the winner panel. The schema's own comment
     * has always said so; the field names predate the word "highlight"
     * existing in this codebase.
     *
     * So the EVENT's accent has to land on `--trim` and the EVENT's highlight
     * on `--slot-won`, which reads like a mistake in the source and is the
     * opposite of one. Swapped, the tournament's trim colour paints the winning
     * team's slot while the frame wears the highlight: it looks deliberate, it
     * is wrong on every bracket on the server, and nothing fails.
     *
     * TWO DIFFERENT COLOURS, deliberately. With one colour for both the
     * assertion passes whichever way round the mapping is, which is exactly the
     * shape of test that lets this bug back in.
     */
    /*
     * BLANKED FIRST, and the reason is a mistake this block made on its first
     * run: assertion 27f above leaves the graphic's own accent set, so
     * measuring inheritance without clearing it measured an OVERRIDE. Worse,
     * the colour it leaves behind was the same one this block had chosen for
     * the tournament, so the numbers agreed and three assertions failed
     * pointing at the wrong thing entirely. Blank means inherit; a suite about
     * inheriting has to start from blank and say so.
     */
    const cleared = (await post('/api/bracket', { state: { ...(await get('/api/bracket', '&bus=preview')).state, accent: '', trim: '' } }, '&bus=preview')).body.state;
    ok('43a the graphic is left with no colours of its own', cleared.accent === '' && cleared.trim === '', JSON.stringify(cleared));

    await fetch(`${BASE}/api/tournaments`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ action: 'update', id: tournamentId, fields: { accent: '#0d1a2b', highlight: '#ab12cd' } }),
    });
    await wait(900);

    const colours = () =>
      page.evaluate(() => {
        const board = document.getElementById('board');
        const read = (name) => getComputedStyle(board).getPropertyValue(name).trim();
        return { trim: read('--trim'), won: read('--slot-won'), flow: read('--flow'), accent: read('--accent') };
      });

    const inherited = await colours();
    eq('44 the event ACCENT lands on the frame, not the winner', inherited.trim, '#0d1a2b');
    eq('45 the event HIGHLIGHT lands on the slot that went through', inherited.won, '#ab12cd');
    eq('46 ...and on the flow along its edges', inherited.flow, '#ab12cd');

    /*
     * And an override still wins. The graphic's own value is what the operator
     * typed; the event's is only what they get for typing nothing.
     */
    const now = (await get('/api/bracket', '&bus=preview')).state;
    await post('/api/bracket', { state: { ...now, trim: '#ff00ff' } }, '&bus=preview');
    await wait(700);
    const overridden = await colours();
    eq('47 a trim set on the graphic beats the event', overridden.trim, '#ff00ff');
    eq('48 ...and leaves the highlight still inheriting', overridden.won, '#ab12cd');

    // ================================ what each round and each band is called ==
    /*
     * Names, not positions. `roundName` used to answer "Upper round 2" - where
     * a round SITS - and this graphic had nothing at all, so a sheet on air
     * never said which round anything was.
     *
     * Derived from where each round sits in its half and COPIED IN at Load,
     * like everything else in this drawing: the output page must not know what
     * a stage is, let alone how a round gets its name.
     */
    const headings = () =>
      page.evaluate(() => {
        const box = (node) => {
          const r = node.getBoundingClientRect();
          return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) };
        };
        const rounds = [...document.querySelectorAll('.round-label')];
        return {
          rounds: rounds.map((n) => n.textContent),
          shown: rounds.filter((n) => n.classList.contains('is-shown')).map((n) => n.textContent),
          boxes: rounds.map(box),
          bands: [...document.querySelectorAll('.band-label')].map((n) => n.textContent),
          bandBoxes: [...document.querySelectorAll('.band-label')].map(box),
          nodeLeft: Math.min(...[...document.querySelectorAll('.node')].map((n) => n.getBoundingClientRect().left)),
          drawRight: Math.max(...[...document.querySelectorAll('.node')].map((n) => n.getBoundingClientRect().right)),
        };
      });

    const solo = (await get('/api/bracket', '&bus=preview')).state;
    await post(
      '/api/bracket',
      { state: { ...solo, reveal: solo.columns, showRoundLabels: true, showBandLabels: true, autoSize: true, drawScale: 1 } },
      '&bus=preview',
    );
    await page.goto(pageUrl('preview'));
    await measure();
    const named = await headings();

    eq('49 a single elimination names its rounds from the end', named.rounds.join(' | '), 'QUARTER-FINALS | SEMI-FINALS | FINAL');
    /*
     * AND NAMES NO BAND. Upper above lower is the universal convention, so a
     * draw with one band has nothing to disambiguate - which is the answer to
     * the question CLAUDE.md has had open since this graphic was built, and the
     * reason the switch defaults off. Asserted with the switch ON, so it is the
     * DRAWING refusing rather than the operator.
     */
    eq('50 ...and names no band, even asked to', named.bands.length, 0);

    /*
     * A heading arrives with the round it names. A word over a column of empty
     * boxes announces a round nobody has revealed - the same thing the veto
     * board's cross was doing before it was made to wait for its ban.
     */
    await post('/api/bracket', { state: { ...solo, reveal: 1, showRoundLabels: true } }, '&bus=preview');
    await wait(500);
    const walking = await headings();
    eq('51 a heading waits for its own round', walking.shown.join(','), 'QUARTER-FINALS');
    eq('51a ...while the rest are drawn and held back', walking.rounds.length, 3);

    // ---------------------------------------------- a DOUBLE elimination ----
    /*
     * The first time this graphic has been drawn from one, which is the other
     * question CLAUDE.md has had open - and the one that made the overlap
     * below visible.
     */
    await post('/api/schedule', { action: 'stage.save', stage: { name: 'Double', kind: 'bracket', bestOf: 3 } });
    await save({ id: 'd-u1', stageId: 'double', round: 1, slot: 0, bracket: 'upper', bestOf: 3, left: T('Alpha', 'ALP'), right: T('Beta', 'BET') });
    await save({ id: 'd-u2', stageId: 'double', round: 1, slot: 1, bracket: 'upper', bestOf: 3, left: T('Gamma', 'GAM'), right: T('Delta', 'DEL') });
    await save({
      id: 'd-uf',
      stageId: 'double',
      round: 2,
      slot: 0,
      bracket: 'upper',
      bestOf: 3,
      left: { source: { fixtureId: 'd-u1', take: 'winner' } },
      right: { source: { fixtureId: 'd-u2', take: 'winner' } },
    });
    await save({
      id: 'd-l1',
      stageId: 'double',
      round: 1,
      slot: 0,
      bracket: 'lower',
      bestOf: 3,
      left: { source: { fixtureId: 'd-u1', take: 'loser' } },
      right: { source: { fixtureId: 'd-u2', take: 'loser' } },
    });
    await save({
      id: 'd-gf',
      stageId: 'double',
      round: 1,
      slot: 0,
      bracket: 'final',
      bestOf: 5,
      left: { source: { fixtureId: 'd-uf', take: 'winner' } },
      right: { source: { fixtureId: 'd-l1', take: 'winner' } },
    });

    const dbl = await post('/api/bracket', { action: 'load', id: 'double' }, '&bus=preview');
    eq('52 a double elimination loads', dbl.status, 200);
    await post(
      '/api/bracket',
      {
        state: {
          ...dbl.body.state,
          reveal: dbl.body.state.columns,
          showRoundLabels: true,
          showBandLabels: true,
          winner: { ...dbl.body.state.winner, show: false },
          autoSize: true,
          drawScale: 1,
        },
      },
      '&bus=preview',
    );
    await page.goto(pageUrl('preview'));
    await measure();
    const both = await headings();

    eq(
      '53 a double elimination says which band each round is in',
      both.rounds.join(' | '),
      'UPPER SEMI-FINALS | UPPER FINAL | LOWER FINAL | GRAND FINAL',
    );
    /*
     * THE ONE A SCREENSHOT CAUGHT AND NO STATE ASSERTION COULD.
     *
     * Upper round 1 and lower round 1 are both COLUMN 0 - the lower bracket
     * starts underneath the upper one, not to the right of it - so one heading
     * per column painted the two on top of each other and the sheet read
     * "UPPEQUAR TERD 1NALS". Every payload was correct throughout.
     *
     * Asked of the PAINTED boxes rather than of the rows in the state, because
     * a row that is right and an offset that is wrong look identical to the
     * state and identical to each other on screen.
     */
    const overlaps = both.boxes.filter((a, i) =>
      both.boxes.some(
        (b, j) => j !== i && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom,
      ),
    );
    eq('54 no two round headings are painted on top of each other', overlaps.length, 0);

    eq('55 the two bands are named', both.bands.join(' | '), 'UPPER BRACKET | LOWER BRACKET');
    /*
     * And the grand final is NOT one. It is a single match, its column heading
     * already says "Grand final", and a second copy down the side of it landed
     * in the same gutter as the upper bracket's - two words overlapping where
     * there should have been one.
     */
    ok('55a ...and the grand final is not a band', !both.bands.some((name) => /GRAND/.test(name)), both.bands.join(' | '));

    /*
     * A band name COSTS THE SHEET NOTHING. It hangs into the 72px margin
     * `#draw` already sits inside, because taking sheet width for it made a
     * five-column draw run 46px further under the winner panel - the one
     * collision this graphic already has a standing note about.
     */
    ok('56 a band name hangs left of the sheet', Math.max(...both.bandBoxes.map((b) => b.right)) <= both.nodeLeft + 1, JSON.stringify([both.bandBoxes, both.nodeLeft]));
    ok('56a ...and is still on the frame', Math.min(...both.bandBoxes.map((b) => b.left)) >= 0, JSON.stringify(both.bandBoxes));

    /*
     * AN OVERRIDE REACHES THE DRAWING, and it is resolved at Load like every
     * other thing in here - the output page is handed words, never a rule for
     * making them.
     */
    const stageNow = (await (await fetch(at('/api/schedule'), { headers: { Cookie: cookie } })).json()).schedule.stages.find(
      (entry) => entry.id === 'double',
    );
    await post('/api/schedule', {
      action: 'stage.save',
      stage: { ...stageNow, roundLabels: { 'final/1': 'THE DECIDER' } },
    });
    const relabelled = await post('/api/bracket', { action: 'load', id: 'double' }, '&bus=preview');
    ok(
      '57 a name typed on the stage reaches the drawing',
      (relabelled.body.state.rounds ?? []).some((entry) => entry.label === 'THE DECIDER'),
      JSON.stringify(relabelled.body.state.rounds),
    );
    ok(
      '57a ...and leaves every other round on its derived name',
      (relabelled.body.state.rounds ?? []).some((entry) => entry.label === 'Upper final'),
      JSON.stringify(relabelled.body.state.rounds),
    );

    ok('43 the page threw nothing', errors.length === 0, errors.join(' | '));
  }

  // ------------------------------------------------------------ the gate ---
  const keyRead = await fetch(`${BASE}/api/bracket?key=${encodeURIComponent(key)}`);
  eq('27 a key may read it, so OBS works', keyRead.status, 200);
  const keyWrite = await fetch(`${BASE}/api/bracket?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'load', id: 'playoffs' }),
  });
  eq('28 ...and may not write it', keyWrite.status, 403);

  ok('29 a load is logged', /bracket loaded/.test(log), 'no audit line');
  ok('30 no session key reached the log', !log.includes(key), 'KEY LEAKED');
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
