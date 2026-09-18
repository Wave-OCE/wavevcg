/**
 * A modal dialog, as the platform's rather than as three more things to get
 * wrong.
 *
 * ## Why a helper rather than one per panel
 *
 * The scaffolding around a `<dialog>` is short and every line of it is
 * load-bearing, which is the worst combination to copy four times. Getting the
 * teardown subtly different between two panels is not a visual inconsistency,
 * it is a leak: a dialog removed on Cancel but not on Escape stays in the DOM
 * holding its listeners, and the next open finds a stale one already there.
 *
 * So the four rules live here once:
 *
 *   ONE AT A TIME. A second dialog opened over the first takes the focus trap
 *   with it and strands the one underneath - Escape then closes the wrong one,
 *   and the page beneath is unreachable.
 *
 *   ON document.body, never inside a painted host. This is the caret rule met
 *   by separation: a repaint replaces everything under its host, so a dialog
 *   living in there would have the box being typed into pulled out from under
 *   the caret by an event that has nothing to do with it. Every panel using
 *   this repaints itself for its own reasons.
 *
 *   ONE TEARDOWN PATH. `close` fires for Escape, for the backdrop, for a Cancel
 *   button and for a successful Save alike, so all four leave exactly the same
 *   state behind. That single fact is the whole reason to use a real dialog
 *   instead of a div pretending to be one.
 *
 *   THE BACKDROP IS THE DIALOG. A click on the shaded area lands on the dialog
 *   element itself and never on its content, which is what makes the check
 *   below reliable rather than a guess about coordinates.
 *
 * ## Leaving with unsaved work in the box
 *
 * Every dialog here saves ONCE, on Save, which is what lets Cancel promise that
 * nothing happened. The cost of that promise is that Escape, the backdrop and
 * Cancel all throw the work away - and two of those three are reflexes. An
 * operator who has just typed a thirty-player roster and pressed Escape out of
 * habit has no way back, and nothing on screen said there was anything to lose.
 *
 * So a caller may pass `dirty`, and the three routes a PERSON leaves by go
 * through `askClose` instead of straight to `close`. The routes a PROGRAM
 * leaves by - a save that succeeded, a delete that succeeded - still call
 * `close` directly, because there is nothing left to discard and a prompt after
 * a successful save is a prompt that trains people to dismiss prompts.
 *
 * THE PROMPT IS NOT A SECOND DIALOG, and that is the whole reason it is built
 * here rather than by each panel. A second `showModal()` takes the focus trap
 * with it and strands the first - the ONE AT A TIME rule above - and this is
 * precisely the case where the first dialog has to survive, because it is
 * holding the work being asked about. It is a sheet INSIDE the open dialog:
 * one element, one focus trap, one teardown path, and the form is still there
 * underneath when the answer is "keep editing".
 *
 * `window.confirm` was the other option and is worse for a reason this codebase
 * has already written down about the Delete buttons: a confirm appears AFTER
 * the click, is answered by reflex, and cannot put the safe answer under the
 * cursor. Here the safe answer is the one that takes focus.
 *
 * ## What it deliberately does NOT do
 *
 * It does not build the body, own a draft, or know what Save means. Those
 * differ per panel and the moment a helper starts taking a field list it stops
 * being scaffolding and starts being a form framework - which is how a shared
 * helper ends up with a flag per caller.
 *
 * It does not work out `dirty` either, for the same reason - a panel knows
 * whether its draft has moved and a helper measuring the DOM would be wrong the
 * first time somebody added a control that is not an input. `watchChanges`
 * below is the shape every caller here happens to want, and using it is
 * optional.
 */

import { el } from './fields.js';

/** Is a modal already up? Callers guard on this before building a body. */
export const modalOpen = () => document.querySelector('dialog.rl-modal') !== null;

/**
 * The open dialog's "is there unsaved work in here" answer, and whether the
 * discard sheet is currently covering it.
 *
 * Module-level rather than a WeakMap keyed on the dialog, because ONE AT A TIME
 * is enforced three lines above: there is never a second dialog for a second
 * entry to belong to, and a map would imply otherwise.
 */
let guard = null;
let sheet = null;

/**
 * Has anything been typed? Snapshot at open, compare later.
 *
 * A string rather than a deep compare, because every caller either has a draft
 * object (`JSON.stringify`) or a handful of controls (their values joined), and
 * a helper that tried to diff either would need to know which.
 *
 * WHEN it is called is the caller's decision and it matters: the right moment
 * is once the form has finished filling itself in - after a production name box
 * is seeded with "Court 2", after a match draft is padded out to `bestOf` map
 * rows. Called any earlier, the form's own work reads as the operator's and the
 * dialog opens already dirty, which puts a discard prompt in front of somebody
 * who has typed nothing. That prompt is the one that has to be believed on the
 * dialog holding thirty players, so it must never cry wolf.
 */
export function watchChanges(snapshot) {
  const opened = snapshot();
  return () => snapshot() !== opened;
}

/**
 * Leave, the way a PERSON leaves: Escape, the backdrop, or Cancel.
 *
 * Exported because a Cancel button is built by the caller and this is the one
 * thing it has to do differently. Everything else about closing is unchanged -
 * a save that worked still calls `dialog.close()`, and should.
 */
export function askClose(dialog) {
  if (!dialog) return;
  if (!guard?.()) {
    dialog.close();
    return;
  }
  if (sheet) return; // already asking; a second Escape must not stack another
  ask(dialog);
}

/**
 * The sheet itself.
 *
 * Keep editing takes focus and is what Escape does, because the two ways of
 * getting this wrong are not comparable: going back to a form you meant to
 * leave costs one more click, and discarding a roster you meant to keep costs
 * the roster. The destructive button is the one that has to be aimed at.
 */
function ask(dialog) {
  sheet = el('div', 'rl-modal-ask', { role: 'alertdialog', 'aria-label': 'Discard unsaved changes?' });

  const keep = el('button', 'btn btn-primary', { type: 'button' }, 'Keep editing');
  keep.addEventListener('click', () => dismiss());

  /*
   * Its OWN class, not the footer's `rl-modal-danger`.
   *
   * That class carries `order: -1` and, under 520px, `order: 1; flex-basis:
   * 100%` - rules written for the FOOTER, where Remove must not end up under
   * the thumb that was reaching for Save. Borrowed here for its colour, they
   * silently swapped these two buttons round at phone width, putting Discard on
   * the right where Keep editing had been on every wider screen. Caught by a
   * screenshot at 400px, which is the only thing that would have.
   */
  const discard = el('button', 'btn btn-ghost rl-modal-ask-danger', { type: 'button' }, 'Discard changes');
  discard.addEventListener('click', () => {
    dismiss();
    // Past the guard deliberately: this IS the answer to the guard's question.
    dialog.close();
  });

  const box = el('div', 'rl-modal-ask-box');
  box.append(
    el('h2', 'rl-modal-ask-title', {}, 'Discard unsaved changes?'),
    el('p', 'rl-modal-ask-text', {}, 'Nothing here has been saved yet. Closing now throws it away.'),
    el('div', 'rl-modal-ask-row'),
  );
  box.lastElementChild.append(discard, keep);
  sheet.append(box);
  dialog.append(sheet);
  keep.focus();
}

function dismiss() {
  sheet?.remove();
  sheet = null;
}

/**
 * Put a dialog on screen.
 *
 * @param {object}      options
 * @param {string}      [options.className]  extra classes on the dialog itself,
 *   for a panel that wants its own width or its own footer rules.
 * @param {Element}     options.body         built by the caller, whole.
 * @param {Element}     [options.foot]       the button row, likewise.
 * @param {() => boolean} [options.dirty]    is there unsaved work in here? See
 *   the note above - given one, Escape, the backdrop and `askClose` ask before
 *   throwing it away. A dialog whose every button writes immediately has
 *   nothing to discard and must NOT pass this.
 * @param {() => void}  [options.onClose]    run once, after it is removed.
 * @returns {HTMLDialogElement|null} null if one was already open.
 */
export function openModal({ className = '', body, foot, dirty, onClose } = {}) {
  if (modalOpen()) return null;

  const dialog = el('dialog', `rl-modal${className ? ` ${className}` : ''}`);
  dialog.append(...[body, foot].filter(Boolean));
  document.body.append(dialog);

  guard = typeof dirty === 'function' ? dirty : null;
  sheet = null;

  dialog.addEventListener('close', () => {
    guard = null;
    dismiss();
    dialog.remove();
    onClose?.();
  });

  /*
   * Escape. Always prevented, so that leaving has exactly ONE route through
   * this file however it was asked for - the platform closing the dialog behind
   * `askClose`'s back is the bug this line exists to make impossible.
   */
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    // While the sheet is up, Escape answers the SHEET. Dismissing it is the
    // safe answer, which is the same one its focused button gives.
    if (sheet) dismiss();
    else askClose(dialog);
  });

  dialog.addEventListener('click', (event) => {
    // The sheet covers the dialog's own box, so a click that still lands on the
    // dialog while it is up came from the backdrop outside it. Same answer.
    if (event.target !== dialog) return;
    if (sheet) dismiss();
    else askClose(dialog);
  });

  dialog.showModal();
  return dialog;
}

/**
 * A heading with an optional second line under it.
 *
 * Here rather than in each caller because every one of these dialogs names the
 * thing being edited and then says which one it is - "Sentinels", "Quarter
 * final 2", "operator" - and a heading that sometimes carries a subtitle and
 * sometimes does not is exactly the sort of thing three panels spell three
 * ways.
 */
export function modalTitle(text, sub) {
  const heading = el('h2', 'rl-modal-title', {}, text);
  if (sub) heading.append(el('span', 'rl-modal-sub', {}, sub));
  return heading;
}

/**
 * The button row: destructive on the left, then a gap, then the safe ones.
 *
 * Left/right rather than side by side, and it is worth writing down why. Delete
 * and Save next to each other is a mis-click that cannot be undone, and this
 * program has three of those (a team a fixture names, a production, an
 * account). The spacer is what keeps the pointer travelling between them.
 *
 * `extras` sit with the safe buttons - a tally, a count, anything the operator
 * reads on their way to pressing Save.
 */
export function modalFoot({ danger, extras = [], cancel, confirm } = {}) {
  const foot = el('div', 'rl-modal-foot');
  foot.append(...[danger, el('span', 'rl-modal-spacer'), ...extras, cancel, confirm].filter(Boolean));
  return foot;
}
