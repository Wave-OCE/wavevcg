/**
 * Winner graphic dashboard - drives the end-of-map sequence.
 *
 * Structurally a sibling of dashboard.js: editors write into a local copy of the
 * state and POST it (debounced), the server pushes it back out over SSE, and the
 * preview iframe is the real output page rather than a re-implementation of it.
 *
 * What is different is that this graphic has a *position*, not just an on/off,
 * so the transport bar has five buttons instead of three and the server owns
 * where in the sequence things are. Everything here does is ask.
 *
 * The team library lives on this tab because this is the graphic that needs it
 * most, but it is not owned by it - the scoreboard's side editors read the same
 * list, which is why saving one broadcasts `teams-changed`.
 */

import { FONT_CHOICES } from './preset-schema.js';
import { onState } from './live.js';
import { mediaControl } from './media-field.js';
import {
  TEAM_FIELDS,
  TEAM_REGIONS,
  EMPTY_TEAM,
  PLAYER_FIELDS,
  ROSTER_LIMIT,
  applyTeam,
  emptyPlayer,
  looksLikeRiotId,
  teamLabel,
} from './teams.js';
import { el, field, grid, help, makeFields, subhead, title } from './fields.js';
import { api, account, outputUrl, targetKey } from './session.js';
import { diffTeams, downloadLibraryFile, importSummary, readLibraryFile, resolveImport } from './library-file.js';
import { makeTakeBar } from './take-bar.js';

/*
 * Which bus this dashboard edits.
 *
 * Preview. Everything typed, imported, swapped or cued here stages, and reaches
 * an audience only when Send to program is pressed - see take-bar.js. The one
 * exception is not here but in the server: the game client's roster and scene
 * feeds write both buses, because an operator taking once per lock-in is not a
 * workflow anybody wants.
 */
const EDIT_BUS = 'preview';
import {
  AUDIO_FIELDS,
  AUDIO_GROUPS,
  SEQ_FIELDS,
  SEQ_GROUPS,
  WINNER_MAP_ROWS,
  WINNER_SCORE_FIELDS,
  WINNER_SIDE_CHOICES,
  WINNER_STAGES,
  WINNER_STAGE_COUNT,
  WINNER_STYLE_FIELDS,
  WINNER_STYLE_GROUPS,
  WINNER_TEXT_FIELDS,
  latestPlayedMap,
  resolveWinner,
  seriesScore,
  sequenceRunMs,
  winnerSource,
} from './winner-schema.js';

const SAVE_DEBOUNCE_MS = 180;
const CUE_WRAP = 1_000_000;

const $ = (id) => document.getElementById(id);

const els = {
  resetBtn: $('w-reset'),
  status: $('w-status'),
  obsUrl: $('w-obs-url'),
  openLink: $('w-open'),
  checker: $('w-checker'),
  frame: $('w-preview-frame'),
  preview: $('w-preview'),

  activateBtn: $('w-activate'),
  backBtn: $('w-back'),
  nextBtn: $('w-next'),
  replayBtn: $('w-replay'),
  stopBtn: $('w-stop'),
  musicBtn: $('w-music'),
  playBtn: $('w-play'),
  music: $('w-music-state'),
  air: $('w-air'),
  airLabel: $('w-air-label'),
  stages: $('w-stages'),
  cueHint: $('w-cue-hint'),

  editors: {
    content: $('wed-content'),
    sides: $('wed-sides'),
    teams: $('wed-teams'),
    seq: $('wed-seq'),
    audio: $('wed-audio'),
    style: $('wed-style'),
  },
};

const toast = (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: message }));

// --------------------------------------------------------------- saving ---

let state = null;
let library = [];
let catalogue = { maps: [] };
let saveTimer = null;
let saveGeneration = 0;
let saveInFlight = false;

function setStatus(kind, label) {
  els.status.className = `save-status ${kind}`.trim();
  els.status.textContent = label;
}

function queueSave() {
  setStatus('saving', 'Saving...');
  // Any timing edit changes what the transport bar reports, so it is refreshed
  // here rather than at each of the twenty-odd controls. The derived series
  // score rides the same funnel for the same reason.
  syncCueUi();
  syncDerivedUi();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
}

/** For cues, where a debounce would mean the graphic moves late on air. */
function saveNow() {
  clearTimeout(saveTimer);
  setStatus('saving', 'Saving...');
  return save();
}

async function save() {
  const generation = ++saveGeneration;
  saveInFlight = true;
  try {
    const response = await fetch(api('/api/winner', EDIT_BUS), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);

    // Adopt the sanitised copy so the dashboard and the graphic can never
    // disagree - but only if nothing has been typed since this save started.
    if (generation === saveGeneration) {
      state = payload.state;
      // The adopted copy is the sanitised one, so anything derived from it is
      // re-read here or it would lag a save behind.
      syncDerivedUi();
    }
    setStatus('', 'Saved');
  } catch (error) {
    setStatus('failed', 'Not saved');
    toast(`Winner graphic not saved: ${error.message}`);
  } finally {
    // Only the newest save reopens this dashboard to incoming state; an older
    // one finishing late must not let a remote update land on edits a newer
    // save is still carrying.
    if (generation === saveGeneration) saveInFlight = false;
  }
}

const fields = makeFields(() => state, queueSave);
const { textField, urlField, numberField, choiceField, selectField, colourField, checkField, rangeField } = fields;

// ------------------------------------------------------------- transport ---

/**
 * Every button is the same move: say what the sequence should be doing now and
 * bump the cue. The cue is what separates an operator's intent from the stream
 * of state pushes ordinary typing produces, and it is what makes Replay mean
 * something while the sequence is already on scene one.
 *
 * `restart` rides along because "go to scene 0" is two different gestures - the
 * overlay arriving, and stepping back to the first scene while it is already up.
 */
function cue(change) {
  const seq = state.seq;
  state.seq = { ...seq, restart: false, ...change, cue: ((seq.cue ?? 0) + 1) % CUE_WRAP };
  syncCueUi();
  return saveNow();
}

/** Whether starting the sequence should also start the music. */
const hasTrack = () => Boolean(state.audio.enabled && state.audio.track);

// Activate starts the music if it is not already running. Pre-cued music is
// left alone deliberately: the output page only rewinds a track it had to start
// from silence, so an early cue lifts to the bed rather than jumping back to
// the top of the sting.
const activate = () => cue({ active: true, stage: 0, restart: true, music: state.seq.music || hasTrack() });
const replay = activate;

// Stop normally takes the music with the graphic. `keepPlaying` is what leaves
// it running underneath whatever comes next, and Fade music is then the thing
// that ends it.
const stop = () => cue({ active: false, music: state.seq.music && Boolean(state.audio.keepPlaying) });

/**
 * Music on its own, without disturbing the graphic.
 *
 * Deliberately not routed through cue(): the cue counter is what tells the
 * output page an operator asked for something, and it cannot tell which part of
 * the state that was - so bumping it here made fading the music replay whatever
 * scene was on air. `music` is a boolean, so the page can just compare it.
 */
function setMusic(on) {
  state.seq = { ...state.seq, music: on };
  syncCueUi();
  return saveNow();
}

const step = (delta) =>
  cue({ active: true, stage: Math.min(WINNER_STAGE_COUNT - 1, Math.max(0, state.seq.stage + delta)) });

/** The stage pips, doubling as a way to jump straight to a scene. */
function buildStagePips() {
  els.stages.replaceChildren(
    ...WINNER_STAGES.map((stage, index) => {
      const pip = el('button', 'stage-pip', { type: 'button', title: `Cut to "${stage.label}"` });
      pip.append(el('span', 'stage-pip-num', {}, String(index + 1)), el('span', null, {}, stage.label));
      pip.addEventListener('click', () => cue({ active: true, stage: index, restart: index === 0 }));
      return pip;
    }),
  );
}

function syncCueUi() {
  const seq = state?.seq;
  if (!seq) return;

  const active = Boolean(seq.active);
  els.air.classList.toggle('is-live', active);
  /*
   * "Preview", not "On air". This lamp reads the bus this dashboard EDITS, and
   * since the split that is the staged copy - so the old wording would have sat
   * a few pixels above a second lamp that means the opposite, both lit red. The
   * one thing an operator must never have to work out is which of two identical
   * indicators is the one an audience can see.
   */
  els.airLabel.textContent = active ? `Preview - scene ${seq.stage + 1}` : 'Preview off';

  els.activateBtn.disabled = active;
  els.stopBtn.disabled = !active;
  els.replayBtn.disabled = !active;
  els.backBtn.disabled = !active || seq.stage === 0;
  els.nextBtn.disabled = !active || seq.stage >= WINNER_STAGE_COUNT - 1;

  for (const [index, pip] of [...els.stages.children].entries()) {
    pip.classList.toggle('is-current', active && index === seq.stage);
    pip.classList.toggle('is-done', active && index < seq.stage);
  }

  // One button, both directions. Only there once a track is loaded - otherwise
  // it is a button for nothing.
  const ready = hasTrack();
  els.musicBtn.hidden = !ready;
  els.music.hidden = !ready;
  els.musicBtn.textContent = seq.music ? 'Fade music' : 'Cue music';
  els.musicBtn.title = seq.music
    ? 'Fade the music out without touching the graphic'
    : 'Start the music now, before the sequence - it lifts to the bed level on Activate';
  els.music.classList.toggle('is-live', Boolean(seq.music));
  els.music.title = seq.music ? 'Music playing' : 'Music stopped';

  // Explains an empty preview rather than leaving it looking broken.
  els.frame.classList.toggle('is-hidden', !active);
  els.frame.style.setProperty('--hide-note-delay', `${seq.outMs + 120}ms`);

  const seconds = (ms) => `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`;
  const summary = seq.autoAdvance
    ? [`runs itself in ${seconds(sequenceRunMs(state))}`, seq.exitAtEnd ? 'then comes off' : 'then holds on the winner']
    : ['manual - Next drives it'];
  if (seq.music) summary.push('music playing');
  els.cueHint.textContent = summary.join('  ·  ');
}

els.activateBtn.addEventListener('click', activate);
els.replayBtn.addEventListener('click', replay);
els.stopBtn.addEventListener('click', stop);
els.nextBtn.addEventListener('click', () => step(1));
els.backBtn.addEventListener('click', () => step(-1));
els.musicBtn.addEventListener('click', () => setMusic(!state.seq.music));

/*
 * Play the sequence in preview, at the real timings.
 *
 * Its own route rather than a cue, because it is not a change to the graphic -
 * it is a flag beside the session saying "let preview advance itself for a
 * while". Kept out of the winner state deliberately: a field there would be
 * copied to air by the very next take. See makeRehearsal in server.js.
 */
let rehearsing = false;

async function togglePlay() {
  const run = !rehearsing;
  try {
    const response = await fetch(api('/api/rehearse'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ graphic: 'winner', run }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  } catch (error) {
    toast(`Could not play the sequence: ${error.message}`);
  }
}

els.playBtn.addEventListener('click', togglePlay);

// The flag is server state - another dashboard on the same production sees the
// rehearsal too - so the button reads it back rather than tracking its own.
onState('rehearsal', (next) => {
  rehearsing = Boolean(next?.winner);
  els.playBtn.textContent = rehearsing ? '■ Stop preview' : '▶ Play in preview';
  els.playBtn.classList.toggle('is-active', rehearsing);
  els.playBtn.title = rehearsing
    ? 'Stop the preview run and hold on the scene it is showing'
    : 'Play the sequence in preview at its real timings. Never touches what is on air.';
});

/**
 * What another operator changed, arriving live.
 *
 * Auto-advance happens on the server, so the sequence moves without this
 * dashboard having asked - the command channel is therefore taken from every
 * frame, mid-edit or not.
 *
 * The rest is somebody else's editing, adopted only while this dashboard has
 * nothing outstanding of its own: between the debounce and the POST, `state`
 * here is ahead of the server, and taking the server's copy then would undo
 * what was just typed. `syncFields` also skips whatever holds focus, so a
 * field being typed in is never rewritten under the caret.
 */
onState('winnerPreview', (next) => {
  if (!state || !next) return;

  if (next.seq) {
    state.seq.active = next.seq.active;
    state.seq.stage = next.seq.stage;
    state.seq.restart = next.seq.restart;
    state.seq.cue = next.seq.cue;
  }
  syncCueUi();

  if (saveTimer || saveInFlight) return;
  state = next;
  fields.syncFields();
  syncDerivedUi();
});

// ------------------------------------------------------- editor: content ---

/** The same control, bound to a dotted path in the live graphic state. */
const logoField = (label, path) =>
  mediaControl(
    label,
    () => fields.get(path),
    (value) => fields.set(path, value),
  );

/** Fills one of the two teams on this graphic from the library. */
function teamPicker(half) {
  const select = el('select');
  select.append(el('option', null, { value: '' }, library.length ? '- pick a team -' : '- no saved teams -'));
  for (const team of library) {
    select.append(el('option', null, { value: team.id }, team.region ? `${team.name} (${team.region})` : team.name));
  }
  select.value = state[half].teamId ?? '';
  select.disabled = !library.length;

  select.addEventListener('change', () => {
    const team = library.find((entry) => entry.id === select.value);
    if (!team) {
      state[half].teamId = '';
      queueSave();
      return;
    }
    // Copied, not linked: the score below belongs to this match, and renaming
    // the team next week must not rewrite a graphic that already went to air.
    applyTeam(state[half], team);
    state[half].teamId = team.id;
    queueSave();
    buildContentEditor();
    buildTeamsEditor();
    toast(`Filled the ${half} team from "${team.name}"`);
  });

  return field('From the team library', select);
}

function wrapChildren(className, children) {
  const node = el('div', className);
  node.append(...children);
  return node;
}

function teamBlock(half) {
  const swatch = el('span', 'side-swatch');
  swatch.style.background = state[half].colour;

  const heading = subhead(half === 'left' ? 'Left team' : 'Right team');
  heading.prepend(swatch);

  return wrapChildren('team-block', [
    heading,
    grid(null, [teamPicker(half)]),
    grid(2, [
      textField('Name', `${half}.name`, { maxlength: 32 }),
      textField('Tricode', `${half}.shortName`, { maxlength: 8, placeholder: 'SEN' }),
    ]),
    grid(2, [selectField('Region', `${half}.region`, TEAM_REGIONS), seriesField(half)]),
    grid(2, [colourField('Team colour', `${half}.colour`, { sampleFrom: () => state[half].logo, clearable: true })]),
    logoField('Logo', `${half}.logo`),
  ]);
}

/*
 * The series score box, and the one place it is kept honest.
 *
 * Held in module scope rather than looked up, because the sync below runs on
 * every keystroke and must never rebuild the panel: replacing the input the
 * operator is typing into loses the caret, which is the trap already documented
 * over syncTeamForm.
 */
const seriesInputs = { left: null, right: null };
let winnerNote = null;

function seriesField(half) {
  const wrap = numberField('Maps won', `${half}.score`, { max: 99 });
  seriesInputs[half] = wrap.querySelector('input');
  return wrap;
}

/**
 * What the winner scene's note should say, given how the winner is decided.
 *
 * It names the rule that answered, not just the answer. Mid-series the trophy
 * comes from the last map played rather than from the series score, and an
 * operator who reads "the series score makes X the winner" while the score says
 * 1-1 has been told something that is not true - which is exactly the confusion
 * this whole change is about.
 */
function winnerNoteText() {
  const decided = resolveWinner(state);
  const who = state[decided].name || (decided === 'left' ? 'the left team' : 'the right team');
  const { left, right } = seriesScore(state);

  switch (winnerSource(state)) {
    case 'override':
      return 'Overridden by hand - the series score is being ignored.';

    /*
     * It says which map, and never that the series is over.
     *
     * Nothing here knows the best-of - a Bo3 at 2-1 and a Bo5 at 2-1 are the
     * same state - so any claim about the series being finished would be a
     * guess presented as a fact. Naming the map is true either way: at 2-1 in a
     * Bo3 it is the map that won the series, and at 2-1 in a Bo5 it is the map
     * that was just played.
     */
    case 'map': {
      const latest = latestPlayedMap(state);
      const name = String(latest?.name ?? '').trim() || 'the last map';
      return `Series ${left} - ${right}. Showing ${who}, who won ${name}.`;
    }

    default:
      return state.autoSeriesScore === false
        ? `The series score makes ${who} the winner.`
        : `Nothing played yet - the map rows make it ${left} - ${right}, so ${who} wins.`;
  }
}

/**
 * Push everything derived back onto the controls that display it.
 *
 * Called from queueSave, which is the one funnel every control already goes
 * through, so a map score typed anywhere moves the series boxes and the winner
 * note without either of them being wired to it directly.
 */
function syncDerivedUi() {
  if (!state) return;
  const counted = state.autoSeriesScore !== false;
  const score = seriesScore(state);

  for (const half of ['left', 'right']) {
    const input = seriesInputs[half];
    if (!input) continue;
    input.disabled = counted;
    input.title = counted ? 'Counted from the map rows - untick that to type it by hand.' : '';
    // Never rewrite the box the cursor is in.
    if (document.activeElement !== input) input.value = String(counted ? score[half] : state[half].score ?? 0);
  }

  if (winnerNote) winnerNote.textContent = winnerNoteText();
}

/** One row of the score line's map breakdown. */
function mapRow(index) {
  const mapNames = catalogue.maps.map((map) => map.name);
  const row = grid(3, [
    selectField(`Map ${index + 1}`, `maps.${index}.name`, mapNames),
    numberField('Left', `maps.${index}.left`, { max: 99 }),
    numberField('Right', `maps.${index}.right`, { max: 99 }),
  ]);
  // Gives the map name the room and leaves the two-digit scores narrow.
  row.classList.add('score-map-row');
  return row;
}

/** What each scene is called in the editor, in the operator's words. */
const SCENE_BLURB = {
  map: 'the map just played',
  winner: 'the winner',
  score: 'the series score',
};

/**
 * One scene's worth of editor, in whatever position the schema puts the scene.
 *
 * Built from WINNER_STAGES rather than written out in order, so a scene that
 * moves in the sequence moves here too. Getting that wrong is quiet and nasty:
 * the panel would still say "Scene 2" over the fields for whatever now plays
 * third, and nothing about the page would look wrong.
 */
function sceneSection(stage, index) {
  const heading = subhead(`Scene ${index + 1} - ${SCENE_BLURB[stage.key] ?? stage.label.toLowerCase()}`);
  const texts = WINNER_TEXT_FIELDS.filter((entry) => entry.stage === stage.key).map((entry) =>
    textField(entry.label, entry.key, { maxlength: entry.max, placeholder: entry.placeholder }),
  );

  switch (stage.key) {
    case 'map':
      return [
        heading,
        grid(2, [selectField('Map', 'mapName', catalogue.maps.map((map) => map.name)), ...texts]),
        grid(null, [
          urlField('Map image override', 'mapImage', { placeholder: 'https://... (blank = official splash)' }),
        ]),
      ];

    case 'score':
      return [
        heading,
        grid(2, texts.slice(0, 1)),
        ...Array.from({ length: WINNER_MAP_ROWS }, (_, row) => mapRow(row)),
        help('A map row with no map picked is left out of the graphic, so a Bo3 is just a Bo5 with two rows empty.'),
        grid(null, WINNER_SCORE_FIELDS.map((entry) => checkField(entry.label, entry.key))),
        help(
          'On, the two Maps won boxes up in the team blocks are filled in from these rows and locked, so the ' +
            'number beside the crest can never disagree with the maps underneath it. A row still on 0 - 0 counts ' +
            'for neither side. Untick it for a series that started before the app was open, a forfeit, or a map ' +
            'awarded with no round score - the number you typed is kept, so it is safe to switch back and forth.',
        ),
        grid(2, texts.slice(1)),
        help(
          'A map that is picked but still on 0 - 0 has not been played, so it is faded and carries the note above ' +
            'instead of a score. The last one gets the second wording, once something before it has been played - ' +
            'a decider settles a series already under way. Leave either blank to fade the row with no words on it.',
        ),
      ];

    default: {
      // Captured rather than written once: the dropdown and every map score
      // change what this says, and none of them rebuild the panel.
      winnerNote = help(winnerNoteText());
      return [
        heading,
        grid(2, [choiceField('Winning team', 'winner', WINNER_SIDE_CHOICES), ...texts.slice(0, 1)]),
        grid(null, texts.slice(1)),
        winnerNote,
      ];
    }
  }
}

function buildContentEditor() {
  els.editors.content.replaceChildren(
    title('Content'),

    ...WINNER_STAGES.flatMap(sceneSection),

    subhead('Event'),
    logoField('Event logo', 'eventLogo'),
    help(
      'Only on screen while the sequence is - it comes and goes with the overlay rather than sitting over the game ' +
        'feed between cues. Where it lands is under Style: by default it is part of the winner and score scenes, ' +
        'arriving with them, rather than a mark in the corner.',
    ),
  );
}

/*
 * The two sides of the series, in their own card.
 *
 * Lifted out of Content, which was carrying three scenes, both teams and the
 * event logo in one column. It stays in the Data group beside Content - these
 * are the two halves of "what does this graphic say", and an operator setting
 * up a series wants both.
 *
 * Rebuilt together with Content rather than on its own, and that is not
 * belt-and-braces: the winner note in Content reads the team's NAME, so a team
 * picked here changes a sentence over there.
 */
function buildTeamsEditor() {
  els.editors.sides.replaceChildren(
    title('Teams'),
    teamBlock('left'),
    teamBlock('right'),
  );
}

// ------------------------------------------------------ editor: sequence ---

/** One editor control per schema field, chosen by its declared type. */
function seqField(entry) {
  const path = `seq.${entry.key}`;
  switch (entry.type) {
    case 'choice':
      return choiceField(entry.label, path, entry.options);
    case 'bool':
      return checkField(entry.label, path);
    default:
      return numberField(entry.label, path, { min: entry.min, max: entry.max });
  }
}

function buildSeqEditor() {
  const host = els.editors.seq;
  const groups = [];

  for (const group of SEQ_GROUPS) {
    const entries = SEQ_FIELDS.filter((entry) => entry.group === group);
    const columns = entries.every((entry) => entry.type === 'bool') ? null : 2;
    groups.push(subhead(group), grid(columns, entries.map(seqField)));
  }

  host.replaceChildren(
    title('Sequence'),
    help(
      `Three scenes: ${WINNER_STAGES.map((stage) => stage.label.toLowerCase()).join(', then ')}. Each one reveals ` +
        'band by band, and the backdrop carries on off the far side at the end. With auto-advance off, nothing ' +
        'moves until you press Next - the holds below are ignored.',
    ),
    help(
      'The opening plays only when the overlay arrives, on Activate or Replay. Sweep crosses the frame in one ' +
        'move; Shards throws the backdrop in as slats from above and below; Blinds closes it in as bars from the ' +
        'sides; Impact slams it in behind a flash of the accent colour; Streak sends an accent bolt across and ' +
        'drags the backdrop in behind it; Facets cascades angled shards across the frame until they lock together; ' +
        'Prism spins in a lattice of diamonds outlined and lit in the accent colour, in rings out from the middle; ' +
        'Mosaic is the same in squares, growing rather than spinning, for a cleaner grid and fewer layers; ' +
        'Pulse throws rings of neon out from the centre and opens the backdrop as a circle behind the last of them.',
    ),
    help(
      'The scene change is what happens between the three cards. Push and Rise deal the bands in from the side or ' +
        'from below; Crossfade is the quiet one; Wipe reveals by clipping without any fade; Zoom pushes through; ' +
        'Shear throws each band in on a lean that unwinds as it lands; Neon glint sends a lit bar across the frame ' +
        'with the next card arriving behind it.',
    ),
    ...groups,
  );
}

// --------------------------------------------------------- editor: music ---

function audioField(entry) {
  const path = `audio.${entry.key}`;
  switch (entry.type) {
    case 'bool':
      return checkField(entry.label, path);
    case 'ratio':
      return rangeField(entry.label, path);
    default:
      return numberField(entry.label, path, { min: entry.min, max: entry.max });
  }
}

function buildAudioEditor() {
  const host = els.editors.audio;
  const groups = [];

  for (const group of AUDIO_GROUPS) {
    const entries = AUDIO_FIELDS.filter((entry) => entry.group === group);
    const columns = entries.every((entry) => entry.type === 'bool') ? null : 2;
    groups.push(subhead(group), grid(columns, entries.map(audioField)));
  }

  host.replaceChildren(
    title('Music'),
    help(
      'Starts when you press Activate, lifts when the winner lands, then settles to an ambient level a caster can ' +
        'talk over. It plays in the OBS source only - this preview stays silent so you are not hearing the same ' +
        'sting twice, a frame apart.',
    ),
    trackControl(),
    ...groups,
    help(
      'The level follows the sequence: bed under the map card, up on the winner, then ambient for the score line ' +
        'and everything after it. The settle timer is only for a sequence left holding on the winner - moving on ' +
        'to the score line brings the music down on its own.',
    ),
  );
}

/** The track itself: upload or paste, same control the logos use. */
const trackControl = () =>
  mediaControl(
    'Track',
    () => state.audio.track,
    (value) => fields.set('audio.track', value),
    { accept: 'audio/*', placeholder: 'https://... or drop an MP3, OGG, WAV, M4A here' },
  );

// --------------------------------------------------------- editor: style ---

function styleField(entry) {
  const path = `style.${entry.key}`;
  switch (entry.type) {
    case 'font':
      return selectField(entry.label, path, FONT_CHOICES, { allowUnknown: false });
    case 'choice':
      return choiceField(entry.label, path, entry.options);
    case 'media':
      return logoField(entry.label, path);
    case 'ratio':
      return rangeField(entry.label, path);
    // A slider like a ratio, but over the field's own range rather than 0..1 -
    // so the schema decides how far a multiplier may go, not this switch. Shown
    // as a percentage: 100% reads as "the size it was" far more directly than
    // 1.00 does, and this is the one slider here with a default worth returning
    // to rather than a taste to be dialled in.
    case 'scale':
      return rangeField(entry.label, path, {
        min: entry.min,
        max: entry.max,
        step: entry.step,
        readout: (value) => `${Math.round(value * 100)}%`,
      });
    case 'bool':
      return checkField(entry.label, path);
    case 'px':
      return numberField(entry.label, path, { min: entry.min, max: entry.max });
    default:
      return colourField(entry.label, path);
  }
}

function buildStyleEditor() {
  const host = els.editors.style;
  const groups = [];

  for (const group of WINNER_STYLE_GROUPS) {
    const entries = WINNER_STYLE_FIELDS.filter((entry) => entry.group === group);
    const columns = entries.every((entry) => entry.type === 'bool') ? null : 2;
    groups.push(subhead(group), grid(columns, entries.map(styleField)));

    if (group === 'Typeface') {
      groups.push(
        help(
          'The logo itself is on the Global tab - it is shared with the other two graphics. These two decide what ' +
            'this sequence does with it: where it sits, and how big. Size is one multiplier over every slot, so a ' +
            'square crest and a wide wordmark can each be made to sit properly without touching four numbers. ' +
            '100% is the original size. In the corner it grows down and to the left from where it is pinned; ' +
            'in a scene it grows the row it is in, so the bands under it move down to make room.',
        ),
      );
    }

    if (group === 'Layout') {
      groups.push(
        help(
          'Max width caps the winner name as a share of the frame, so a long org does not run edge to edge - past ' +
            'it the name condenses, and past that it falls back to the tricode. Vertical spacing scales the gaps ' +
            'between every band on all three slides at once; it is the one to reach for after changing the logo ' +
            'size, since the space under the mark was set when the mark could not grow.',
        ),
      );
    }

    if (group === 'Texture') {
      groups.push(
        help(
          'A finish on the backdrop, above the map plate and under the text, for the whole sequence. The lattice is ' +
            'the prism opening standing still and the grid is the mosaic, so the score line sits on the thing the ' +
            'opening built - pair them up, and set the size to 240 for a grid that matches the mosaic cell for ' +
            'cell. Keep it low - the moment it reads as a pattern it is competing with the team name. It also ' +
            'gives an encoder some structure to hold on to, which is what stops a blurred splash banding on a stream.',
        ),
      );
    }
  }

  host.replaceChildren(title('Style'), ...groups);
}

// -------------------------------------------------- editor: team library ---

async function teamAction(body) {
  const response = await fetch(api('/api/teams'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);

  library = payload.teams;
  // The scoreboard's side pickers read the same list.
  window.dispatchEvent(new CustomEvent('teams-changed', { detail: library }));
  buildTeamEditor();
  buildContentEditor();
  buildTeamsEditor();
  return payload;
}

/**
 * The library form edits a draft rather than the live state, because a team is
 * only worth saving once it is complete - a half-typed name should not appear in
 * every dropdown on the page while it is being typed.
 */
let draft = { id: null, ...EMPTY_TEAM, players: [] };

/**
 * The one control on the form that depends on what has been typed into the rest
 * of it, and therefore the only thing an edit has to update.
 *
 * Rebuilding the panel instead - which is what this used to do - replaces the
 * very input being typed into, so the caret is gone after each keystroke and a
 * team name has to be entered one letter and one click at a time. Nothing else
 * here reads the draft as it is typed, so there is nothing else to refresh.
 */
let teamSaveBtn = null;

const syncTeamForm = () => {
  if (teamSaveBtn) teamSaveBtn.disabled = !String(draft.name ?? '').trim();
};

const draftFields = makeFields(() => draft, syncTeamForm);

function editTeam(team) {
  // The roster copied, not shared: the form edits rows in place, and without
  // this an abandoned edit would have already changed the library entry it came
  // from - visibly, in every picker, without a save.
  draft = team
    ? { ...team, players: (team.players ?? []).map((p) => ({ ...p })) }
    : { id: null, ...EMPTY_TEAM, players: [] };
  buildTeamEditor();
}

function draftControl(entry) {
  switch (entry.type) {
    case 'choice':
      return draftFields.selectField(entry.label, entry.key, TEAM_REGIONS);
    case 'hex':
      return draftFields.colourField(entry.label, entry.key, { sampleFrom: () => draft.logo, clearable: true });
    case 'image':
      return null; // handled below - the logo control is not a plain input
    default:
      return draftFields.textField(entry.label, entry.key, {
        maxlength: entry.max,
        placeholder: entry.placeholder ?? '',
      });
  }
}

/** The same control, writing into the draft rather than the live graphic. */
const draftLogoField = () =>
  mediaControl(
    'Logo',
    () => draft.logo,
    (value) => {
      draft.logo = value;
    },
  );

function teamCard(team) {
  const card = el('div', 'team-card');

  const crest = el('div', 'team-card-logo');
  if (team.logo) crest.append(el('img', null, { src: team.logo, alt: '' }));
  else crest.append(el('span', null, {}, teamLabel(team).slice(0, 3)));
  crest.style.setProperty('--team-colour', team.colour);

  const who = el('div', 'team-card-who');
  who.append(el('div', 'team-card-name', {}, team.name));
  who.append(el('div', 'team-card-meta', {}, [team.shortName, team.region].filter(Boolean).join('  ·  ')));

  const tools = el('div', 'row-tools');

  const edit = el('button', 'mini-btn', { type: 'button' }, 'Edit');
  edit.addEventListener('click', () => editTeam(team));

  const remove = el('button', 'mini-btn', { type: 'button' }, 'Delete');
  remove.addEventListener('click', async () => {
    if (!window.confirm(`Delete "${team.name}"? Graphics already using it keep their name and logo.`)) return;
    try {
      await teamAction({ action: 'delete', id: team.id });
      toast(`Deleted "${team.name}"`);
    } catch (error) {
      toast(`Could not delete: ${error.message}`);
    }
  });

  tools.append(edit, remove);
  card.append(crest, who, tools);
  return card;
}

/**
 * The roster editor.
 *
 * Its own container, repainted on its own, because of the note above
 * `teamSaveBtn`: rebuilding the whole panel replaces the input being typed
 * into, and the caret goes with it. So the text boxes write straight into
 * `draft.players[i]` on every keystroke and repaint NOTHING, and only adding or
 * removing a row - which changes how many boxes there are - repaints this
 * block. The rest of the form never moves.
 *
 * Nothing here validates on the way in. A half-typed Riot ID is the normal
 * state of a Riot ID being typed, so the mark below is advisory and the server
 * is what decides: a blank is always allowed, and a malformed one is stored as
 * typed rather than silently dropped, because a value that vanishes when you
 * look away is worse than one that is visibly wrong.
 */
function rosterEditor() {
  const rows = el('div', 'roster-rows');

  const paint = () => {
    rows.replaceChildren(
      ...draft.players.map((player, index) => {
        const row = el('div', 'roster-row');

        for (const entry of PLAYER_FIELDS) {
          const input = el('input', null, {
            type: 'text',
            spellcheck: 'false',
            placeholder: entry.placeholder ?? '',
            maxlength: entry.max,
            'aria-label': `${entry.label} ${index + 1}`,
          });
          input.value = player[entry.key] ?? '';
          input.addEventListener('input', () => {
            player[entry.key] = input.value;
            if (entry.key === 'riotId') mark(input);
          });
          if (entry.key === 'riotId') mark(input);
          row.append(input);
        }

        const drop = el('button', 'btn btn-small btn-ghost', { type: 'button', title: 'Remove this player' }, '×');
        drop.addEventListener('click', () => {
          draft.players.splice(index, 1);
          paint();
        });
        row.append(drop);

        return row;
      }),
      draft.players.length
        ? null
        : el('p', 'field-help', {}, 'No players yet. A team works fine without one - this is for recognising them in a lobby.'),
      addRow(),
    );
  };

  /** Advisory, never enforcing. See the note above. */
  const mark = (input) => {
    const value = input.value.trim();
    input.classList.toggle('is-wrong', Boolean(value) && !looksLikeRiotId(value));
    input.title = value && !looksLikeRiotId(value) ? 'That does not look like GameName#Tag' : '';
  };

  function addRow() {
    const add = el('button', 'btn btn-small', { type: 'button' }, 'Add player');
    add.disabled = draft.players.length >= ROSTER_LIMIT;
    if (add.disabled) add.title = `${ROSTER_LIMIT} is the most a roster holds.`;
    add.addEventListener('click', () => {
      draft.players.push(emptyPlayer());
      paint();
      // Straight into the box that just appeared, so adding five players is
      // five clicks and typing rather than ten.
      rows.querySelector('.roster-row:last-of-type input')?.focus();
    });
    return add;
  }

  paint();
  return rows;
}

function buildTeamEditor() {
  const host = els.editors.teams;
  const editing = Boolean(draft.id);

  const save = el('button', 'btn btn-primary', { type: 'button' }, editing ? 'Update team' : 'Add team');
  teamSaveBtn = save;
  syncTeamForm();
  save.addEventListener('click', async () => {
    try {
      const { saved } = await teamAction({ action: 'save', team: draft });
      toast(`Saved "${saved.name}"`);
      editTeam(null);
    } catch (error) {
      toast(`Could not save: ${error.message}`);
    }
  });

  const cancel = el('button', 'btn btn-ghost', { type: 'button' }, editing ? 'New team' : 'Clear');
  cancel.addEventListener('click', () => editTeam(null));

  const actions = el('div', 'team-form-actions');
  actions.append(save, cancel);

  const controls = TEAM_FIELDS.map(draftControl).filter(Boolean);

  host.replaceChildren(
    title('Team library'),
    help(
      'Saved once and reused. Picking a team copies its name, tricode, region, logo and colour onto a graphic - it ' +
        'does not link them, so editing a team here never changes something that is already on air. Leave the ' +
        'colour switched off and they wear whichever side they are playing, which is usually what you want for a ' +
        'team with no brand colour of its own.',
    ),
    library.length
      ? wrapChildren('team-list', library.map(teamCard))
      : el('p', 'empty', {}, 'No teams saved yet. Add one below and it will appear on both graphics.'),
    subhead(editing ? `Editing ${draft.name}` : 'Add a team'),
    grid(2, controls),
    draftLogoField(),

    subhead('Roster'),
    help(
      'Who plays for them. Optional, and nothing here goes on air by itself - it is how a player is recognised in ' +
        'a lobby, and where a Riot ID lives so it can be checked later. A name an operator corrects mid-match still ' +
        'wins over this one.',
    ),
    rosterEditor(),

    actions,
    subhead('Share this library'),
    help(
      'Export writes a JSON file of your teams. Import folds somebody else\'s file into yours: it adds and ' +
        'updates, and never deletes a team. What arrives becomes yours to edit - picking a team copies its ' +
        'fields onto a graphic rather than linking them, so an import can never change something already on air.',
    ),
    teamShareActions(),
  );
}

/**
 * Export and import for the team library.
 *
 * Matched on what the name slugs to rather than on the id in the file, so
 * re-importing the same file is a no-op instead of a second copy. There is
 * deliberately no "keep both" for a collision: all three pickers render a team
 * as `name (region)` and nothing else, so two entries with the same name are
 * two visually identical dropdown rows and a coin flip over which logo goes on
 * air. Keep mine or take theirs is the whole choice.
 */
function teamShareActions() {
  const exportBtn = el('button', 'mini-btn', { type: 'button' }, 'Export library');
  exportBtn.addEventListener('click', async () => {
    if (!library.length) {
      toast('There are no teams to export yet.');
      return;
    }
    const me = await account();
    const { count } = downloadLibraryFile('teams', library, me?.user?.username ?? '');
    toast(`Exported ${count} team${count === 1 ? '' : 's'}`);
  });

  const picker = el('input', null, { type: 'file', accept: 'application/json', id: 'wed-team-import' });
  picker.style.display = 'none';
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file) return;
    try {
      openTeamImport(await readLibraryFile(file, 'teams'));
    } catch (error) {
      toast(error.message);
    }
  });

  const importBtn = el('button', 'mini-btn', { type: 'button' }, 'Import from file');
  importBtn.addEventListener('click', () => picker.click());

  return wrapChildren('team-form-actions', [exportBtn, importBtn, picker]);
}

/** The diff, rendered into the team panel instead of the editor. */
function openTeamImport(opened) {
  const host = els.editors.teams;
  const diff = diffTeams(opened.rows, library);
  const choices = diff.differs.map(() => 'mine');

  const paint = () => {
    const sum = importSummary(diff, choices);

    const rows = diff.differs.map((entry, index) => {
      const row = el('div', 'access-row');
      row.append(
        el('span', 'access-name', {}, entry.label),
        el('span', 'admin-meta', {}, `differs: ${entry.changed.join(', ')}`),
      );
      for (const [key, label] of [['mine', 'Keep mine'], ['theirs', 'Take theirs']]) {
        const button = el('button', `btn btn-small${choices[index] === key ? ' is-active' : ''}`, { type: 'button' }, label);
        button.addEventListener('click', () => {
          choices[index] = key;
          paint();
        });
        row.append(button);
      }
      return row;
    });

    const total = sum.added + sum.replaced;
    const apply = el(
      'button',
      'btn btn-primary',
      { type: 'button' },
      `Import ${total} team${total === 1 ? '' : 's'} (${sum.added} added, ${sum.replaced} replaced, nothing deleted)`,
    );
    apply.disabled = total === 0;
    apply.addEventListener('click', async () => {
      apply.disabled = true;
      try {
        // Re-derived against the library as it is now, for the same reason the
        // alias import does it: another editor on this session may have saved
        // a team while this panel was open.
        const payload = resolveImport(diffTeams(opened.rows, library), choices);
        if (!payload.length) {
          buildTeamEditor();
          toast('Nothing to import - you kept every team you already had.');
          return;
        }
        const result = await teamAction({ action: 'import', teams: payload });
        toast(`Imported ${result?.added ?? 0} new and updated ${result?.updated ?? 0}`);
      } catch (error) {
        toast(`Not imported: ${error.message}`);
        buildTeamEditor();
      }
    });

    const backup = el('button', 'btn btn-ghost', { type: 'button' }, 'Export mine first');
    backup.addEventListener('click', async () => {
      const me = await account();
      downloadLibraryFile('teams', library, me?.user?.username ?? '');
      toast('Saved a copy of your current library');
    });

    const cancel = el('button', 'btn btn-ghost', { type: 'button' }, 'Cancel');
    cancel.addEventListener('click', buildTeamEditor);

    host.replaceChildren(
      title('Import teams', el('span', 'pill', {}, opened.from ? `from ${opened.from}` : 'from a file')),
      help(
        `${opened.rows.length} team${opened.rows.length === 1 ? '' : 's'} in the file. ` +
          `${sum.added} are new to you, ${sum.identical} you already have exactly, and ${diff.differs.length} disagree with yours.`,
      ),
      ...(rows.length ? [subhead('These disagree with what you have'), wrapChildren('team-list', rows)] : []),
      wrapChildren('team-form-actions', [apply, backup, cancel]),
    );
  };

  paint();
}

// -------------------------------------------------------------- preview ---

function fitPreview() {
  const width = els.frame.clientWidth;
  if (width) els.preview.style.transform = `scale(${width / 1920})`;
}

new ResizeObserver(fitPreview).observe(els.frame);
window.addEventListener('resize', fitPreview);
window.addEventListener('app-tab', (event) => {
  if (event.detail === 'winner') fitPreview();
});

els.checker.addEventListener('change', () => {
  els.frame.classList.toggle('checker', els.checker.checked);
});

els.resetBtn.addEventListener('click', async () => {
  if (!window.confirm('Reset the winner graphic to defaults? Every field will be cleared.')) return;

  const response = await fetch(api('/api/winner', EDIT_BUS), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reset: true }),
  });
  const payload = await response.json();
  state = payload.state;
  buildAll();
  setStatus('', 'Saved');
  toast('Winner graphic reset');
});

// ----------------------------------------------------------------- start ---

function buildAll() {
  buildStagePips();
  buildContentEditor();
  buildTeamsEditor();
  buildTeamEditor();
  buildSeqEditor();
  buildAudioEditor();
  buildStyleEditor();
  syncCueUi();
  // After the editors exist, or the boxes it drives have not been built yet.
  syncDerivedUi();
}

async function start() {
  void targetKey().then((key) => {
    const url = outputUrl('/winner.html', key);
    els.obsUrl.textContent = url;
    els.obsUrl.title = url;
    els.openLink.href = url;
  });
  // The shared overlay points at whichever button would fix an empty preview,
  // and on this tab that is Activate rather than Show.
  els.frame.style.setProperty('--hide-note', '"Off air - press Activate to play the sequence"');

  const [winner, assetData, teamData] = await Promise.all([
    fetch(api('/api/winner', EDIT_BUS)).then((r) => r.json()),
    fetch('/api/valorant-assets')
      .then((r) => (r.ok ? r.json() : { maps: [] }))
      .catch(() => ({ maps: [] })),
    fetch(api('/api/teams'))
      .then((r) => r.json())
      .catch(() => ({ teams: [] })),
  ]);

  state = winner.state;
  catalogue = assetData;
  library = teamData.teams ?? [];

  buildAll();
  setStatus('', 'Saved');
  fitPreview();
}

start().catch((error) => {
  els.editors.content.replaceChildren(el('p', 'empty', {}, `Could not load the winner graphic: ${error.message}`));
  // Nothing was built, so the Teams card beside this one would sit there as an
  // empty bordered box next to the explanation. One message reads better than
  // a message and a mystery.
  els.editors.sides.hidden = true;
});

// ------------------------------------------------------------- the take ---

makeTakeBar({
  graphic: 'winner',
  prefix: 'w',
  programChannel: 'winner',
  previewChannel: 'winnerPreview',
  isLive: (state) => Boolean(state.seq?.active),
  // The scene number, because "on air" alone is not enough to act on when the
  // sequence is three scenes long and running itself.
  describe: (state) => (state.seq?.active ? `ON AIR - scene ${(state.seq.stage ?? 0) + 1}` : 'Off air'),
  toast,
});
