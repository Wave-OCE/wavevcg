/**
 * The two team splashes: the lineup and the head-to-head.
 *
 * Both hold a COPY of a team rather than a reference, and most of what is worth
 * asserting follows from that: a Load takes a snapshot, editing the library
 * afterwards does not reach a graphic that is already on air, and the operator's
 * own settings survive a Load that only means "now show the other team".
 *
 * Verified by deliberate breaks; each is named in the commit.
 *
 * It is mostly a ROUTE suite and it opens a browser for exactly one thing: the
 * head-to-head's two size handles. Everything else here is a question about
 * state, and a question about state is cheaper and clearer without a Chromium
 * in it - but "does the type actually get bigger" and "does the crest's box
 * still clear the name plate when it does" cannot be asked of a payload at
 * all, and those are the two that regress silently.
 */

const playwright = await import(new URL('../../node_modules/playwright/index.js', import.meta.url).href);
const chromium = playwright.chromium ?? playwright.default.chromium;

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openAsAdmin } from './harness.mjs';
import { LINEUP_FORMATS } from '../../public/lineup-schema.js';

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 8181;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(path.join(tmpdir(), 'rl-teamg-'));

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

/*
 * A crest the page can actually DECODE, and a WORDMARK rather than a shield -
 * wide and short is the shape that shows whether a box is doing anything, and
 * a square one is centred by accident whatever the box does.
 *
 * Short on purpose: a team's logo is sliced at 500 characters on the way in, so
 * a chatty data URI arrives truncated and the broken-image guard hides it.
 */
const LOGO = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="90"><rect width="400" height="90" fill="#8a2030"/><circle cx="45" cy="45" r="30" fill="#fff"/></svg>',
)}`;

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
  const { cookie, key, tournamentId } = await openAsAdmin(BASE, 'boss', 'a-long-enough-password', 'Team Graphics Cup');
  const H = { 'Content-Type': 'application/json', Cookie: cookie };
  const at = (route, extra = '') => `${BASE}${route}?session=${tournamentId}${extra}`;

  const get = async (route, extra = '') => (await (await fetch(at(route, extra), { headers: { Cookie: cookie } })).json());
  const post = async (route, body, extra = '') => {
    const response = await fetch(at(route, extra), { method: 'POST', headers: H, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const PHOTO = '/media/portrait.png';

  const cru = (
    await post('/api/teams', {
      action: 'save',
      team: {
        name: 'Crusaders',
        shortName: 'CRU',
        colour: '#22aa55',
        logo: '/media/cru.png',
        banner: '/media/cru-banner.png',
        playerPhoto: '/media/cru-default.png',
        players: [
          { displayName: 'Blessed', riotId: 'Blessed#0001', photo: PHOTO },
          { displayName: 'Neon', riotId: 'Neon#EU' },
          { displayName: 'Tayo', riotId: 'Tayo#OCE', photo: PHOTO },
          { displayName: '2door', riotId: '2door#AU', photo: PHOTO },
          { displayName: 'Wisp', riotId: 'Wisp#NZ', photo: PHOTO },
          { displayName: 'Sub', riotId: 'Sub#AU', photo: PHOTO },
        ],
      },
    })
  ).body.saved;

  const jail = (
    await post('/api/teams', { action: 'save', team: { name: 'Jail Time', shortName: 'JAIL', logo: '/media/jail.png' } })
  ).body.saved;

  // ------------------------------------------------------------- the fields ---
  eq('1 a team carries a backdrop', cru.banner, '/media/cru-banner.png');
  eq('2 ...and a default player photo', cru.playerPhoto, '/media/cru-default.png');
  eq('3 a player carries a photo', cru.players[0].photo, PHOTO);

  /*
   * An image field is VALIDATED, not merely trimmed, and a player's photo goes
   * through the same rule as a team's logo. They used to differ - the team's was
   * checked and the player's was any string at all - which is two fields holding
   * the same kind of value cleaned by different rules, one of which was
   * "anything".
   */
  const junk = (
    await post('/api/teams', {
      action: 'save',
      team: { id: cru.id, name: 'Crusaders', players: [{ displayName: 'X', riotId: 'X#1', photo: 'javascript:alert(1)' }] },
    })
  ).body.saved;
  eq('4 a photo that is not a URL is refused', junk.players[0].photo, '');

  // Put the roster back.
  await post('/api/teams', {
    action: 'save',
    team: {
      id: cru.id,
      name: 'Crusaders',
      shortName: 'CRU',
      colour: '#22aa55',
      logo: '/media/cru.png',
      banner: '/media/cru-banner.png',
      playerPhoto: '/media/cru-default.png',
      players: [
        { displayName: 'Blessed', riotId: 'Blessed#0001', photo: PHOTO },
        { displayName: 'Neon', riotId: 'Neon#EU' },
        { displayName: 'Tayo', riotId: 'Tayo#OCE', photo: PHOTO },
        { displayName: '2door', riotId: '2door#AU', photo: PHOTO },
        { displayName: 'Wisp', riotId: 'Wisp#NZ', photo: PHOTO },
        { displayName: 'Sub', riotId: 'Sub#AU', photo: PHOTO },
      ],
    },
  });

  // ------------------------------------------------------------- the lineup ---
  let r = await post('/api/lineup', { action: 'load', id: cru.id }, '&bus=preview');
  eq('5 a lineup loads a team', r.status, 200);
  eq('6 ...carrying the org', r.body.state.teamName, 'Crusaders');
  eq('7 ...and its default photo, for anybody without one', r.body.state.defaultPhoto, '/media/cru-default.png');
  /*
   * FIVE, from a squad of six. Trimmed at the point of COPY rather than at
   * paint time: which five appear is a decision the operator makes by ordering
   * the roster, not one the page makes silently while it draws.
   */
  eq('8 ...trimmed to five', r.body.state.players.length, 5);
  eq('9 ...in roster order', r.body.state.players.map((p) => p.name).join(','), 'Blessed,Neon,Tayo,2door,Wisp');

  /*
   * The operator's own settings survive a Load. The format, the heading and the
   * event logo are set once before a show; a Load means "now show the other
   * team" and must not undo them.
   */
  const styled = await post(
    '/api/lineup',
    { state: { ...r.body.state, format: 'names', heading: 'Starting lineup', eventLogo: '/media/event.png' } },
    '&bus=preview',
  );
  eq('10 the format is settable', styled.body.state.format, 'names');
  r = await post('/api/lineup', { action: 'load', id: jail.id }, '&bus=preview');
  eq('11 a second Load swaps the team', r.body.state.teamName, 'Jail Time');
  eq('12 ...and keeps the format', r.body.state.format, 'names');
  eq('13 ...and the heading', r.body.state.heading, 'Starting lineup');
  eq('14 ...and the event logo', r.body.state.eventLogo, '/media/event.png');

  /*
   * A COPY, not a view. Editing the library afterwards must not reach a graphic
   * that may be on air - the rule every other graphic here follows.
   */
  await post('/api/teams', { action: 'save', team: { id: jail.id, name: 'Renamed Mid Show', shortName: 'RMS' } });
  r = await get('/api/lineup', '&bus=preview');
  eq('15 renaming the team does NOT change the loaded graphic', r.state.teamName, 'Jail Time');

  r = await post('/api/lineup', { action: 'load', id: 'nope' }, '&bus=preview');
  eq('16 loading a team that is gone is refused', r.status, 404);

  // -------------------------------------------- a Riot ID never reaches air ---
  /*
   * NOT CARRIED, rather than merely not painted, and that distinction is the
   * whole assertion.
   *
   * A Riot ID is not broadcast information: it is the handle somebody is added
   * by and messaged on, and a full-screen lineup is the easiest frame in a
   * broadcast to pause and read. There used to be a `detailed` format that
   * printed one under every name, and the `names` layout printed one too.
   *
   * A value that is only unpainted is still copied out of the roster on Load,
   * written to lineup.json, and pushed over SSE to every browser source on
   * every keystroke - so the next contributor to render "just to see" puts it
   * on air. 16a asks about the STATE for that reason; an assertion about the
   * page would pass against a graphic one line away from leaking.
   *
   * The roster it was copied from definitely has one - 16c pins that, so this
   * cannot quietly start passing because the fixture stopped carrying Riot IDs.
   */
  await post('/api/lineup', { action: 'load', id: cru.id }, '&bus=preview');
  r = await get('/api/lineup', '&bus=preview');
  ok('16a no player on the lineup carries a Riot ID', !/riotid/i.test(JSON.stringify(r.state)), JSON.stringify(r.state.players?.[0]));
  eq('16b ...and a seat is a name and a photo, nothing else', Object.keys(r.state.players[0] ?? {}).sort().join(','), 'name,photo');
  const roster = (await get('/api/teams')).teams.find((team) => team.id === cru.id);
  ok('16c ...while the roster it was copied FROM still has them', Boolean(roster?.players?.[0]?.riotId), JSON.stringify(roster?.players?.[0]));

  /*
   * The format that printed them is gone, and a state saved carrying it lands
   * somewhere this build can draw. Left to the ordinary unknown-value fallback
   * it would have kept `detailed` for ever, because that fallback returns the
   * PREVIOUS value - which on a saved state is `detailed` itself.
   */
  ok('16d the Riot ID format is not offered any more', !JSON.stringify(LINEUP_FORMATS).includes('detailed'), JSON.stringify(LINEUP_FORMATS.map((f) => f.key)));
  const retired = await post('/api/lineup', { state: { ...r.state, format: 'detailed' } }, '&bus=preview');
  eq('16e ...and a state saved with it lands on photos', retired.body.state.format, 'photos');

  // The tricode is copied in, because the graphic captions the org with it.
  eq('16f the tricode reaches the graphic', retired.body.state.shortName, 'CRU');

  // ------------------------------------------- the trim, and what blank means ---
  /*
   * Both of these graphics had NO colour of their own before this. The lineup
   * carried an `--accent` literal in its stylesheet that nothing could reach -
   * `lineup.js` had zero setProperty calls - so dressing a show meant editing
   * CSS. Head-to-head was the same.
   *
   * What is asserted here is the STATE half: that blank survives a round trip,
   * because blank is what "inherit the tournament's" is spelled as, and a
   * sanitiser that helpfully filled it in with a default would silently make
   * every graphic an override and the whole feature a no-op. The other half -
   * that blank actually resolves to the event's colour on the painted page - is
   * in bracket-graphic-e2e, which has a browser open.
   */
  r = await get('/api/lineup', '&bus=preview');
  eq('16g a lineup starts with no colour of its own', r.state.accent, '');

  let tinted = await post('/api/lineup', { state: { ...r.state, accent: '#00B8D4' } }, '&bus=preview');
  eq('16h ...takes one when the operator sets it', tinted.body.state.accent, '#00b8d4');

  /*
   * Junk lands on BLANK - which is to say "inherit" - rather than being stored.
   *
   * Not "keeps the previous colour", which is what this asserted first and what
   * a hex field on a PATCH route does. This route replaces, so the caller sent
   * the whole state and there is no previous to fall back to. The bracket's
   * colours answer the same way (27c there), and the dashboard cannot produce
   * junk at all: its control is an <input type="color">.
   */
  tinted = await post('/api/lineup', { state: { ...tinted.body.state, accent: 'not-a-colour' } }, '&bus=preview');
  eq('16i ...and refuses junk rather than storing it', tinted.body.state.accent, '');

  tinted = await post('/api/lineup', { state: { ...tinted.body.state, accent: '#ABC' } }, '&bus=preview');
  eq('16i2 ...a three-digit hex is a hex, lowercased', tinted.body.state.accent, '#abc');

  /*
   * BLANK SURVIVES. This is the one that matters: it is what Reset to default
   * writes, and a sanitiser treating empty as "missing, use the default" would
   * make it impossible to go back to inheriting.
   */
  tinted = await post('/api/lineup', { state: { ...tinted.body.state, accent: '' } }, '&bus=preview');
  eq('16j ...and blank is a real answer: it means the EVENT decides', tinted.body.state.accent, '');

  // -------------------------------------------------------- the head to head ---
  r = await post('/api/headtohead', { action: 'side', side: 'left', id: cru.id }, '&bus=preview');
  eq('17 a side takes a team', r.body.state.left.teamName, 'Crusaders');
  eq('18 ...with its backdrop', r.body.state.left.banner, '/media/cru-banner.png');
  r = await post('/api/headtohead', { action: 'side', side: 'right', id: jail.id }, '&bus=preview');
  eq('19 the other side is independent', r.body.state.right.teamName, 'Renamed Mid Show');
  eq('20 ...and the first is untouched', r.body.state.left.teamName, 'Crusaders');

  await post('/api/schedule', { action: 'stage.save', stage: { name: 'Playoffs', kind: 'bracket', bestOf: 3 } });
  const sched = await post('/api/schedule', {
    action: 'fixture.save',
    fixture: { stageId: 'playoffs', bestOf: 3, left: { name: 'Alpha', shortName: 'ALP' }, right: { name: 'Beta', shortName: 'BET' } },
  });
  const fixtureId = sched.body.schedule.fixtures[0].id;

  r = await post('/api/headtohead', { action: 'fixture', id: fixtureId }, '&bus=preview');
  eq('21 a fixture fills both halves', `${r.body.state.left.teamName} v ${r.body.state.right.teamName}`, 'Alpha v Beta');

  // --------------------------------------------------------------- the buses ---
  /*
   * Writes stage, like every other graphic - `busFor` sends an unqualified write
   * to preview, and air must not move until somebody takes it.
   */
  const air = await get('/api/headtohead');
  ok('22 air is untouched by all of that', !air.state.left.teamName, air.state.left.teamName);

  r = await post('/api/take', { graphic: 'headToHead' });
  eq('23 it can be taken', r.status, 200);
  const taken = await get('/api/headtohead');
  eq('24 ...and then air has it', taken.state.left.teamName, 'Alpha');

  /*
   * The CUE. A take that only moved the TEAM must not replay the entrance - an
   * operator swapping a tricode is correcting a mistake, not presenting a new
   * graphic. Only visibility is in `transport`.
   */
  const before = (await get('/api/headtohead')).state.anim.cue;
  await post('/api/headtohead', { action: 'side', side: 'left', id: cru.id }, '&bus=preview');
  await post('/api/take', { graphic: 'headToHead' });
  eq('25 a take that only changed the team does not bump the cue', (await get('/api/headtohead')).state.anim.cue, before);

  const showing = await get('/api/headtohead', '&bus=preview');
  await post('/api/headtohead', { state: { ...showing.state, anim: { ...showing.state.anim, visible: true } } }, '&bus=preview');
  await post('/api/take', { graphic: 'headToHead' });
  ok('26 ...but showing it does', (await get('/api/headtohead')).state.anim.cue !== before, 'cue did not move');

  // ------------------------------------------------------------ the key gate ---
  /*
   * READ-ONLY for a session key, like the other output pages: an OBS browser
   * source carries a key and no cookie. A key must not be able to WRITE one.
   */
  const keyRead = await fetch(`${BASE}/api/lineup?key=${encodeURIComponent(key)}`);
  eq('27 a key may read a lineup, so OBS works', keyRead.status, 200);
  const keyWrite = await fetch(`${BASE}/api/lineup?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'load', id: cru.id }),
  });
  eq('28 ...and may not write one', keyWrite.status, 403);
  const h2hRead = await fetch(`${BASE}/api/headtohead?key=${encodeURIComponent(key)}`);
  eq('29 the same for the head to head', h2hRead.status, 200);

  ok('30 a load is logged', /lineup loaded/.test(log), 'no audit line for a lineup load');
  r = await get('/api/headtohead', '&bus=preview');
  eq('26a the head to head starts with no colour of its own', r.state.accent, '');
  const h2hTint = await post('/api/headtohead', { state: { ...r.state, accent: '#ffcc00' } }, '&bus=preview');
  eq('26b ...and takes one', h2hTint.body.state.accent, '#ffcc00');
  eq(
    '26c ...without disturbing the team colours, which mean something else here',
    JSON.stringify([h2hTint.body.state.left.colour, h2hTint.body.state.right.colour]),
    JSON.stringify([r.state.left.colour, r.state.right.colour]),
  );

  // ======================= the head-to-head's two size handles ============
  /*
   * This graphic had no style fields at all beyond its colours: its three type
   * sizes were literals in `headtohead.css`, so a show whose org names are long
   * - or whose crests are wordmarks rather than shields - had no answer but to
   * edit a stylesheet.
   *
   * THE STATE HALF FIRST, and the assertion that matters is 32b: `ratio()`
   * caps at 1 because everything it guards is a proportion, and a multiplier
   * run through one would clamp every enlargement to "no change" while the
   * slider went on claiming otherwise. A default-sized graphic passes every
   * other assertion here either way.
   */
  r = await get('/api/headtohead', '&bus=preview');
  eq('32 the head to head starts at the size it always was', r.state.textScale, 1);
  eq('32a ...and so do its crests', r.state.logoScale, 1);

  const bigger = await post('/api/headtohead', { state: { ...r.state, textScale: 1.4, logoScale: 1.25 } }, '&bus=preview');
  eq('32b a size ABOVE 1 is kept, which a ratio would have thrown away', bigger.body.state.textScale, 1.4);
  eq('32c ...on either handle', bigger.body.state.logoScale, 1.25);

  const silly = await post('/api/headtohead', { state: { ...r.state, textScale: 9, logoScale: -3 } }, '&bus=preview');
  eq('32d a size past the top of the range is clamped, not obeyed', silly.body.state.textScale, 1.6);
  eq('32e ...and one below the bottom too', silly.body.state.logoScale, 0.5);

  const notANumber = await post('/api/headtohead', { state: { ...r.state, textScale: 'enormous' } }, '&bus=preview');
  eq('32f junk falls back rather than landing as NaN on a live graphic', notANumber.body.state.textScale, 1);

  /*
   * AND THE RENDERED HALF, which is the only place two of these can be asked.
   *
   * `clear` is the gap between the bottom of the crest's box and the top of the
   * name plate. The plate's height scales with its type, so the crest's box has
   * to follow it or turning the type up walks the plate into the crest above -
   * the layout moving because a SETTING changed. Measured at three sizes: the
   * gap is the same number at all three or the two are not tied together.
   */
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const dress = (textScale, logoScale) =>
      fetch(at('/api/headtohead', '&bus=program'), {
        method: 'POST',
        headers: H,
        body: JSON.stringify({
          state: {
            ...r.state,
            left: { ...r.state.left, teamName: 'Crusaders Esports', logo: LOGO },
            right: { ...r.state.right, teamName: 'Jail Time Gaming', logo: LOGO },
            divider: 'VS',
            heading: 'Grand final',
            textScale,
            logoScale,
            anim: { visible: true, cue: 1 },
          },
        }),
      });

    const measure = () =>
      page.evaluate(() => {
        const px = (node, prop) => Math.round(Number.parseFloat(getComputedStyle(node)[prop]) * 10) / 10;
        const plate = document.querySelector('.half-plate');
        const logoBox = document.querySelector('.half-logo');
        const crest = logoBox?.querySelector('img');
        const half = document.querySelector('.half');
        return {
          plate: px(plate, 'fontSize'),
          divider: px(document.querySelector('.divider'), 'fontSize'),
          heading: px(document.querySelector('.heading'), 'fontSize'),
          crest: crest ? Math.round(crest.getBoundingClientRect().width) : 0,
          clear: Math.round(plate.getBoundingClientRect().top - logoBox.getBoundingClientRect().bottom),
          insideHalf: crest ? crest.getBoundingClientRect().right <= half.getBoundingClientRect().right + 1 : false,
          // fitStage owns this one and rewrites it on every resize, so a size
          // handle written there would be wiped by the next resize.
          stage: getComputedStyle(document.getElementById('stage')).transform,
        };
      });

    await dress(1, 1);
    await page.goto(`${BASE}/headtohead.html?key=${encodeURIComponent(key)}&session=${tournamentId}`);
    await page.waitForSelector('.half-plate', { timeout: 8000 });
    await wait(900);
    const at100 = await measure();

    await dress(1.4, 1.4);
    await wait(900);
    const at140 = await measure();

    await dress(0.7, 0.6);
    await wait(900);
    const at70 = await measure();

    /*
     * 1 is exactly what the sizes were before any of this existed, so an
     * upgrade changes nothing on air. Asserted against the literals the
     * stylesheet used to carry rather than against "whatever it renders now",
     * which would pass at any size.
     */
    eq('33 at 100% the type is exactly the size it always was', JSON.stringify([at100.plate, at100.divider, at100.heading]), JSON.stringify([36, 56, 20]));
    ok(
      '33a turning it up moves all three together',
      at140.plate > at100.plate && at140.divider > at100.divider && at140.heading > at100.heading,
      JSON.stringify([at100, at140]),
    );
    ok(
      '33b ...and turning it down moves all three back',
      at70.plate < at100.plate && at70.divider < at100.divider && at70.heading < at100.heading,
      JSON.stringify([at70, at100]),
    );
    /*
     * THE ONE THAT CANNOT BE ASKED OF A PAYLOAD. The plate grows with its type;
     * if the crest's box does not follow, the plate climbs into the crest and
     * the graphic overlaps itself at a setting the operator chose deliberately.
     */
    ok(
      '33c the crest still clears the name plate at every size',
      at140.clear === at100.clear && at70.clear === at100.clear,
      JSON.stringify({ at70: at70.clear, at100: at100.clear, at140: at140.clear }),
    );
    ok('33d the crest itself scales', at140.crest > at100.crest && at70.crest < at100.crest, JSON.stringify([at70.crest, at100.crest, at140.crest]));
    ok('33e ...and stays inside the half it belongs to', at100.insideHalf && at140.insideHalf, JSON.stringify([at100.insideHalf, at140.insideHalf]));
    eq('33f the fit to the OBS canvas is left alone by both handles', at140.stage, 'matrix(1, 0, 0, 1, 0, 0)');
    ok('33g the page raised nothing', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    await browser.close().catch(() => {});
  }

  ok('31 no session key reached the log', !log.includes(key), 'KEY LEAKED');
} catch (error) {
  fail += 1;
  console.log('THREW', error.stack);
  console.log(log.slice(-1500));
} finally {
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
