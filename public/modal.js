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
 * ## What it deliberately does NOT do
 *
 * It does not build the body, own a draft, or know what Save means. Those
 * differ per panel and the moment a helper starts taking a field list it stops
 * being scaffolding and starts being a form framework - which is how a shared
 * helper ends up with a flag per caller.
 */

import { el } from './fields.js';

/** Is a modal already up? Callers guard on this before building a body. */
export const modalOpen = () => document.querySelector('dialog.rl-modal') !== null;

/**
 * Put a dialog on screen.
 *
 * @param {object}      options
 * @param {string}      [options.className]  extra classes on the dialog itself,
 *   for a panel that wants its own width or its own footer rules.
 * @param {Element}     options.body         built by the caller, whole.
 * @param {Element}     [options.foot]       the button row, likewise.
 * @param {() => void}  [options.onClose]    run once, after it is removed.
 * @returns {HTMLDialogElement|null} null if one was already open.
 */
export function openModal({ className = '', body, foot, onClose } = {}) {
  if (modalOpen()) return null;

  const dialog = el('dialog', `rl-modal${className ? ` ${className}` : ''}`);
  dialog.append(...[body, foot].filter(Boolean));
  document.body.append(dialog);

  dialog.addEventListener('close', () => {
    dialog.remove();
    onClose?.();
  });

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
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
