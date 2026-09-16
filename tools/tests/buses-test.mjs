/**
 * The preview/program pair and the take between them.
 *
 * Not an e2e: `makeBus` takes a path resolver and nothing else, so this drives
 * it directly against a temp directory. No server, no port, no browser - which
 * means it can assert on things a running system hides, like exactly what is
 * written to disk and exactly what the cue counter does.
 *
 * The cue is most of what is being checked here. Copying preview's counter
 * across would be the obvious implementation and it is wrong in two directions
 * at once: it can move program's counter backwards (program runs the automatic
 * drivers and drifts ahead on its own), and it replays the entrance on a take
 * that only fixed a typo. See the header in buses.js.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { makeBus, busName, CUE_WRAP } = await import(
  new URL('../../buses.js', import.meta.url).href
);

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
};

const dirs = [];
const freshDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rl-bus-'));
  dirs.push(dir);
  return dir;
};
const busIn = (dir, kind = 'graphics') => makeBus(kind, (file) => path.join(dir, file));
const settle = () => new Promise((r) => setTimeout(r, 60));

try {
  // ------------------------------------------------------------ bus names ---
  ok('program resolves', busName('program') === 'program');
  ok('preview resolves', busName('preview') === 'preview');
  // Anything unrecognised must land on preview. The failure modes are not
  // symmetric: a typo that shows preview is a confused operator, a typo that
  // writes air is a broadcast incident.
  ok('an unknown bus name is preview, never air', busName('prgoram') === 'preview', busName('prgoram'));
  ok('an empty bus name is preview', busName('') === 'preview');
  ok('a missing bus name is preview', busName(undefined) === 'preview');

  // ------------------------------------------------------------- a fresh dir ---
  {
    const dir = freshDir();
    const bus = busIn(dir);
    const result = await bus.load();
    ok('a brand new session restores nothing', result.program === false && result.preview === false);
    ok('and reports the preview as seeded', result.seeded === true);
    ok('both buses start equal', bus.preview.state.map === bus.program.state.map, `${bus.preview.state.map}/${bus.program.state.map}`);
  }

  // ------------------------------------------------- the upgrade migration ---
  /*
   * The case that matters on the day this ships: a state directory that has
   * only graphic.json, currently on air.
   */
  {
    const dir = freshDir();
    const seed = busIn(dir);
    await seed.load();
    seed.program.replace({ ...seed.program.state, map: 'Icebox', left: { ...seed.program.state.left, teamName: 'ON AIR NOW' } });
    await seed.flush();
    rmSync(path.join(dir, 'graphic.preview.json'), { force: true });
    ok('the fixture leaves only the program file', existsSync(path.join(dir, 'graphic.json')) && !existsSync(path.join(dir, 'graphic.preview.json')));

    const upgraded = busIn(dir);
    const result = await upgraded.load();
    ok('upgrading finds the program file', result.program === true);
    ok('and seeds the preview', result.seeded === true);
    ok('AIR IS UNTOUCHED BY THE UPGRADE', upgraded.program.state.left.teamName === 'ON AIR NOW', upgraded.program.state.left.teamName);
    ok('and preview starts as a copy of it', upgraded.preview.state.left.teamName === 'ON AIR NOW', upgraded.preview.state.left.teamName);
    ok('so the first take changes nothing', upgraded.take().replayed === false);

    // A second open must not re-seed over staged work.
    upgraded.preview.replace({ ...upgraded.preview.state, map: 'Lotus' });
    await upgraded.flush();
    const reopened = busIn(dir);
    const second = await reopened.load();
    ok('reopening does not re-seed', second.seeded === false);
    ok('and staged work survives a restart', reopened.preview.state.map === 'Lotus', reopened.preview.state.map);
    ok('while air still holds its own', reopened.program.state.map === 'Icebox', reopened.program.state.map);
  }

  // ------------------------------------------------------------ two files ---
  {
    const dir = freshDir();
    const bus = busIn(dir);
    await bus.load();
    bus.preview.replace({ ...bus.preview.state, map: 'Split' });
    bus.program.replace({ ...bus.program.state, map: 'Haven' });
    await bus.flush();
    await settle();

    ok('program keeps the original file name', existsSync(path.join(dir, 'graphic.json')));
    ok('and preview gets its own', existsSync(path.join(dir, 'graphic.preview.json')));
    const onAir = JSON.parse(readFileSync(path.join(dir, 'graphic.json'), 'utf8'));
    const staged = JSON.parse(readFileSync(path.join(dir, 'graphic.preview.json'), 'utf8'));
    ok('the two files really differ on disk', onAir.map === 'Haven' && staged.map === 'Split', `${onAir.map}/${staged.map}`);
  }

  // ---------------------------------------------------------- independence ---
  {
    const dir = freshDir();
    const bus = busIn(dir);
    await bus.load();

    bus.preview.replace({ ...bus.preview.state, map: 'Pearl' });
    ok('editing preview leaves air alone', bus.program.state.map !== 'Pearl', bus.program.state.map);

    bus.program.replace({ ...bus.program.state, map: 'Abyss' });
    ok('and editing air leaves preview alone', bus.preview.state.map === 'Pearl', bus.preview.state.map);

    ok('of() hands back the right store', bus.of('preview') === bus.preview && bus.of('program') === bus.program);
    ok('and an unknown name hands back preview', bus.of('nonsense') === bus.preview);
  }

  // -------------------------------------------------------------- the take ---
  {
    const dir = freshDir();
    const bus = busIn(dir);
    await bus.load();

    // ---- data only: must NOT replay ----
    const cueBefore = bus.program.state.anim.cue;
    bus.preview.replace({ ...bus.preview.state, left: { ...bus.preview.state.left, teamName: 'FIXED TYPO' } });
    const dataTake = bus.take();
    ok('a take carries the data across', bus.program.state.left.teamName === 'FIXED TYPO', bus.program.state.left.teamName);
    ok('A DATA-ONLY TAKE DOES NOT REPLAY THE ENTRANCE', dataTake.replayed === false);
    ok('and leaves the cue counter where it was', bus.program.state.anim.cue === cueBefore, `${cueBefore} -> ${bus.program.state.anim.cue}`);

    /*
     * ---- transport: must replay ----
     *
     * Hiding, not showing. A fresh graphic defaults to visible:true, so
     * "set preview visible and take" compares true against true, changes
     * nothing and proves nothing - the assertion passed for the wrong reason
     * the first time this was written.
     */
    ok('the fixture really is visible to begin with', bus.preview.state.anim.visible === true);
    bus.preview.replace({ ...bus.preview.state, anim: { ...bus.preview.state.anim, visible: false } });
    const hideTake = bus.take();
    ok('hiding on preview and taking does replay', hideTake.replayed === true);
    ok('and bumps air’s cue by exactly one', bus.program.state.anim.cue === (cueBefore + 1) % CUE_WRAP, String(bus.program.state.anim.cue));
    ok('and air is now hidden', bus.program.state.anim.visible === false);

    bus.preview.replace({ ...bus.preview.state, anim: { ...bus.preview.state.anim, visible: true } });
    const showTake = bus.take();
    ok('showing it again also replays', showTake.replayed === true);
    ok('and bumps the cue a second time', bus.program.state.anim.cue === (cueBefore + 2) % CUE_WRAP, String(bus.program.state.anim.cue));
    ok('and air is visible again', bus.program.state.anim.visible === true);

    // ---- taking the same thing twice is not a transport change ----
    const steady = bus.program.state.anim.cue;
    const again = bus.take();
    ok('taking the same state twice does not replay', again.replayed === false);
    ok('and does not move the cue', bus.program.state.anim.cue === steady, String(bus.program.state.anim.cue));
  }

  // ------------------------------------------- preview's counter is ignored ---
  /*
   * The regression this design exists to prevent. Program runs the automatic
   * drivers, so its counter climbs on its own; preview's does not. A take that
   * copied preview's counter could hand air a LOWER number, which an output
   * page reads as a change and replays on.
   */
  {
    const dir = freshDir();
    const bus = busIn(dir);
    await bus.load();

    // Air has been up a while: auto-hide and re-shows have run its counter up.
    bus.program.replace({ ...bus.program.state, anim: { ...bus.program.state.anim, cue: 900, visible: true } });
    // Preview has barely been touched.
    bus.preview.replace({ ...bus.preview.state, anim: { ...bus.preview.state.anim, cue: 2, visible: true }, map: 'Sunset' });

    const result = bus.take();
    ok('a take never copies preview’s counter', bus.program.state.anim.cue !== 2, String(bus.program.state.anim.cue));
    ok('AIR’S COUNTER NEVER GOES BACKWARDS', bus.program.state.anim.cue >= 900, String(bus.program.state.anim.cue));
    ok('and a data-only take from behind still does not replay', result.replayed === false);
    ok('while the data did cross', bus.program.state.map === 'Sunset', bus.program.state.map);
  }

  // ------------------------------------------------------ the winner's seq ---
  {
    const dir = freshDir();
    const bus = busIn(dir, 'winner');
    await bus.load();
    const start = bus.program.state.seq.cue;

    bus.preview.replace({ ...bus.preview.state, mapName: 'Bind' });
    ok('a winner data take does not replay', bus.take().replayed === false);
    ok('and the map crossed', bus.program.state.mapName === 'Bind', bus.program.state.mapName);

    bus.preview.replace({ ...bus.preview.state, seq: { ...bus.preview.state.seq, active: true, stage: 0, restart: true } });
    ok('activating on preview and taking replays', bus.take().replayed === true);
    ok('and air is on scene 1', bus.program.state.seq.stage === 0 && bus.program.state.seq.active === true);

    // Stepping a scene is a transport move, which is the whole point of next.
    bus.preview.replace({ ...bus.preview.state, seq: { ...bus.preview.state.seq, stage: 1, restart: false } });
    ok('stepping a scene on preview and taking replays', bus.take().replayed === true);
    ok('and air followed to scene 2', bus.program.state.seq.stage === 1, String(bus.program.state.seq.stage));
    ok('with the counter having moved twice', bus.program.state.seq.cue === (start + 2) % CUE_WRAP, String(bus.program.state.seq.cue));

    // `restart` is carried separately from stage: arriving at scene 1 and
    // stepping back to it are different gestures.
    bus.preview.replace({ ...bus.preview.state, seq: { ...bus.preview.state.seq, stage: 0, restart: true } });
    ok('restart counts as a transport change of its own', bus.take().replayed === true);
  }

  // --------------------------------------------------------------- revert ---
  {
    const dir = freshDir();
    const bus = busIn(dir);
    await bus.load();
    bus.program.replace({ ...bus.program.state, map: 'Fracture', anim: { ...bus.program.state.anim, cue: 55 } });
    bus.preview.replace({ ...bus.preview.state, map: 'HALF FINISHED' });

    bus.revert();
    ok('revert brings air back into preview', bus.preview.state.map === 'Fracture', bus.preview.state.map);
    ok('and does not touch air', bus.program.state.map === 'Fracture');
    ok('taking straight after a revert is a no-op', bus.take().replayed === false);
  }

  // ---------------------------------------------- the old API fails loudly ---
  /*
   * A call site missed by the migration must not read `undefined` and quietly
   * write a graphic nobody is watching.
   */
  {
    const bus = busIn(freshDir());
    for (const member of ['state', 'revision', 'replace', 'patch', 'reset', 'subscribe']) {
      let threw = '';
      try {
        void bus[member];
      } catch (error) {
        threw = error.message;
      }
      ok(`reaching for the old .${member} throws`, Boolean(threw), 'silently undefined');
      if (member === 'state') ok('and the message names the fix', /\.preview|\.program/.test(threw), threw);
    }
    // The two the bus genuinely answers for. If these threw, flushSession and
    // the session registry would be broken and nothing would say so until a
    // restart lost somebody's state.
    ok('but load() still works', typeof bus.load === 'function');
    ok('and flush() still works', typeof bus.flush === 'function');
  }
} catch (error) {
  fail += 1;
  console.log('THREW', error.stack);
} finally {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows */
    }
  }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
