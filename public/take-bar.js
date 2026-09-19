/**
 * The take, for one graphic.
 *
 * Shared rather than written three times, for the same reason every field in
 * this project comes from a schema: three copies of "is preview different from
 * air" would be three chances to answer it differently, and the one that drifts
 * is the one an operator trusts at the wrong moment.
 *
 * What it owns is small and entirely about the OTHER bus. The cue bar above it
 * belongs to the dashboard module and edits preview; this row watches program,
 * says what is on air, and cuts across.
 *
 * ---------------------------------------------------------------------------
 * "Preview differs from air"
 * ---------------------------------------------------------------------------
 *
 * Deliberately a comparison of the two states rather than a dirty flag set when
 * somebody types. A flag is lost on a page reload and lies after a revert; a
 * comparison is right whenever it is asked, including on a dashboard that was
 * opened after the staging happened, which is exactly when an operator most
 * needs to know.
 *
 * The cue counters are stripped before comparing, and that is not a detail. The
 * two buses keep their own counters on purpose - program's climbs on its own
 * because it runs the automatic drivers - so comparing them raw would light
 * this up permanently and it would mean nothing within a minute.
 *
 * What is NOT stripped is the sequence position. When the winner graphic is
 * auto-advancing on air, program really is at a different scene from preview,
 * and saying so is honest. The label says "differs from air" rather than
 * "unsaved changes" for precisely that reason.
 */

import { onState } from './live.js';
import { api } from './session.js';

const $ = (id) => document.getElementById(id);

/** The counters, per graphic. See the note above on why these go. */
const CUE_PATH = {
  graphics: (state) => state.anim,
  select: (state) => state.anim,
  winner: (state) => state.seq,
  vetoBoard: (state) => state.anim,
  lineup: (state) => state.anim,
  headToHead: (state) => state.anim,
  bracket: (state) => state.anim,
  standings: (state) => state.anim,
};

function comparable(graphic, state) {
  if (!state) return '';
  const clone = structuredClone(state);
  const holder = CUE_PATH[graphic]?.(clone);
  if (holder) delete holder.cue;
  return JSON.stringify(clone);
}

/**
 * @param {object} options
 * @param {'graphics'|'winner'|'select'|'vetoBoard'|'lineup'|'headToHead'|'bracket'|'standings'} options.graphic  the API's name for it
 * @param {string} options.prefix                         the DOM id prefix
 * @param {string} options.programChannel                 SSE channel for air
 * @param {string} options.previewChannel                 SSE channel for preview
 * @param {(state: object) => string} options.describe    the on-air legend
 * @param {(state: object) => boolean} options.isLive     is it on screen
 * @param {(message: string) => void} options.toast
 */
/**
 * What Revert is, said where a Reset button needs to say it.
 *
 * Every Reset in this program writes to PREVIEW - measured in all seven
 * dashboards rather than assumed - so clearing a graphic does not move what an
 * audience is looking at, and Revert copies air back over preview. That makes
 * this button the undo a Reset otherwise has none of, which is worth telling
 * somebody at the moment they are being asked to confirm one.
 *
 * Exported from here rather than written out seven times because Revert is this
 * module's button: the source of a fact owns how it is described, or seven
 * dashboards grow seven slightly different ideas of what Reset costs.
 */
export const REVERT_NOTE =
  'It lands on PREVIEW. What is on air is untouched, and Revert on the take bar copies air back over this - ' +
  'which is the closest thing to an undo this has.';

export function makeTakeBar({ graphic, prefix, programChannel, previewChannel, describe, isLive, toast }) {
  const els = {
    bar: $(`${prefix}-take-bar`),
    lamp: $(`${prefix}-prog`),
    label: $(`${prefix}-prog-label`),
    take: $(`${prefix}-take`),
    revert: $(`${prefix}-revert`),
    staged: $(`${prefix}-staged`),
  };
  if (!els.bar) return null;

  let program = null;
  let preview = null;
  let busy = false;

  function paint() {
    if (program) {
      const live = isLive(program);
      els.lamp.classList.toggle('is-live', live);
      els.label.textContent = describe(program);
    }

    /*
     * Only once both have arrived. They come down the same connection but as
     * separate events, so for one frame after a reload there is exactly one of
     * them - and a bar that flashed "differs from air" every time the dashboard
     * opened would be a bar nobody reads.
     */
    const known = program && preview;
    const differs = known && comparable(graphic, preview) !== comparable(graphic, program);
    els.staged.hidden = !differs;
    els.bar.classList.toggle('is-staged', Boolean(differs));

    // Reverting when there is nothing staged would throw away nothing, but a
    // button that does nothing is a button that teaches nothing.
    els.revert.disabled = busy || !differs;
    els.take.disabled = busy;
  }

  async function send(action) {
    if (busy) return;
    busy = true;
    paint();
    try {
      const response = await fetch(api('/api/take'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ graphic, ...(action === 'revert' ? { action: 'revert' } : {}) }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.error) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);

      toast?.(
        action === 'revert'
          ? 'Preview reset to what is on air'
          : payload.replayed
            ? 'Sent to program - it will play its entry'
            : 'Sent to program - data only, nothing replayed',
      );
    } catch (error) {
      toast?.(`Could not send to program: ${error.message}`);
    } finally {
      busy = false;
      paint();
    }
  }

  els.take.addEventListener('click', () => send('take'));
  els.revert.addEventListener('click', () => {
    if (!window.confirm('Throw away what is staged and copy what is on air back into preview?')) return;
    send('revert');
  });

  onState(programChannel, (next) => {
    program = next;
    paint();
  });
  onState(previewChannel, (next) => {
    preview = next;
    paint();
  });

  return { paint };
}
