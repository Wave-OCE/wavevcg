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
 * ## The backdrop always asks
 *
 * Three exits, and they are not equally deliberate. Cancel is a button somebody
 * aimed at and Escape is a key somebody pressed; the BACKDROP is neither - it
 * is the whole rest of the screen, it carries no label, and it is hit by
 * reaching for something behind the dialog. Reported as the thing people leave
 * a form by accident, and it was the one exit with nothing in front of it.
 *
 * So the backdrop asks EVEN WHEN NOTHING HAS BEEN TYPED, and the other two do
 * not. That asymmetry is the whole design rather than an inconsistency: the
 * argument against a prompt with nothing to discard is that it teaches people
 * to dismiss prompts, and that argument is about the exits somebody MEANT to
 * take. `20m2a` still pins Escape closing an untouched form in one press.
 *
 * It asks a DIFFERENT question when there is nothing to lose, because
 * "discard unsaved changes?" would be a lie about a form nobody has touched,
 * and the button is not painted destructive - nothing is being destroyed.
 *
 * A dialog that passed no `dirty` is untouched by any of this. It holds no
 * draft, so there is nothing to ask about from any exit - which is the account
 * dialog, deliberately, and `ui-e2e` asserts it closes with no prompt.
 *
 * ## Asking before something that cannot be undone
 *
 * `confirmDanger` is the same box asked for a different reason, and the rule it
 * exists to make true is one line:
 *
 *   IRREVERSIBLE IS CONFIRMED IN THE PROGRAM'S OWN DIALOG. Only something
 *   undone by doing the opposite may use a `window.confirm`.
 *
 * The bar had drifted the wrong way round. A production and a stage - the two
 * SMALLEST deletions here - each took a typed name in a real dialog, while
 * deleting a whole tournament took a `window.prompt`, deleting an account took
 * a bare `confirm`, and seven Reset buttons that clear a graphic outright took
 * one too. Every argument this file already makes about the discard sheet
 * applies to all three, and applies harder, because these do not lose a draft -
 * they lose a season, a colleague's workspace, or the look somebody spent the
 * morning on.
 *
 * Over an open dialog it is a SHEET, for the reason the discard prompt is one:
 * a second `showModal()` takes the focus trap with it and strands the first. On
 * a page with no dialog up it is a real `<dialog>` wearing the same box. So
 * "this cannot be undone" looks like ONE thing whether it was provoked from
 * inside the account editor or from a Reset button on a graphics tab, which is
 * the whole point of it living here rather than in nine call sites.
 *
 * ## A form too long to read in one scroll
 *
 * `tabs` splits the BODY and nothing else. The stage editor is what provoked
 * it: name, format, series, groups, generation and templates in one column,
 * with the operator scrolling past four sections to reach the one they opened
 * it for.
 *
 * Three rules, and each of them is a bug this codebase has already had:
 *
 *   EVERY PANE IS BUILT ONCE and kept in the DOM. Switching toggles `[hidden]`
 *   and touches nothing else. Building a pane when its tab is picked would
 *   replace the box somebody is typing into - the caret rule - and would also
 *   throw away what they had typed in the pane they just left.
 *
 *   THE FOOTER IS OUTSIDE THE TABS, because Save means the whole form and not
 *   the open tab. A dialog that saved per-tab would be a dialog where Cancel
 *   stops meaning "nothing happened", which is the promise the whole
 *   save-once design is built on.
 *
 *   `dirty` STILL WATCHES THE WHOLE DRAFT. A guard that only saw the open tab
 *   would let somebody type a name, move to Groups, press Escape and lose it
 *   with no prompt.
 *
 * The strip reuses `.card-tabs` / `.card-tab` from the graphics editors rather
 * than growing its own look - an operator should not have to learn two kinds of
 * tab in one program.
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

import { el, field } from './fields.js';

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
 * What to do if the sheet goes away WITHOUT either of its buttons being
 * pressed - Escape, or a click on the backdrop.
 *
 * The discard prompt needs nothing here: dismissing it means "keep editing",
 * which is simply the sheet no longer being there. `confirmDanger` answers a
 * PROMISE, and a promise has to be settled however it ended - otherwise a
 * caller awaiting it waits for ever, and the operator is left looking at a
 * button that did nothing at all.
 */
let sheetCancel = null;

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
export function askClose(dialog, { always = false } = {}) {
  if (!dialog) return;

  // No guard means no draft, which means nothing to ask about however this was
  // provoked. `always` cannot override that - see the account dialog.
  if (!guard) {
    dialog.close();
    return;
  }

  const dirty = guard();
  if (!always && !dirty) {
    dialog.close();
    return;
  }
  if (sheet) return; // already asking; a second Escape must not stack another
  ask(dialog, dirty);
}

/**
 * The box both prompts wear: a question, what it costs, anything the caller
 * needs between the two, and the pair of buttons.
 *
 * One builder rather than two, which is the only reason the discard prompt and
 * `confirmDanger` look identical. Two boxes differing by a few pixels of
 * padding read as two different mechanisms, and an operator who has learned
 * that one of them is serious has learned nothing about the other.
 */
function askBox({ title, lines = [], extras = [], danger, safe }) {
  const box = el('div', 'rl-modal-ask-box');
  box.append(el('h2', 'rl-modal-ask-title', {}, title));
  for (const line of lines) box.append(el('p', 'rl-modal-ask-text', {}, line));
  box.append(...extras);

  const row = el('div', 'rl-modal-ask-row');
  row.append(danger, safe);
  box.append(row);
  return box;
}

/**
 * The discard sheet, and the leave-anyway sheet - one box, two questions.
 *
 * Keep editing takes focus and is what Escape does, because the two ways of
 * getting this wrong are not comparable: going back to a form you meant to
 * leave costs one more click, and discarding a roster you meant to keep costs
 * the roster. The destructive button is the one that has to be aimed at.
 *
 * `dirty` false only ever reaches here from the BACKDROP, and it changes both
 * the words and the paint. Saying "discard unsaved changes" about a form nobody
 * has touched is a lie, and painting the leave button `--on-air` when nothing
 * is being destroyed spends the one colour that means something.
 */
function ask(dialog, dirty = true) {
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
  const discard = el(
    'button',
    `btn btn-ghost${dirty ? ' rl-modal-ask-danger' : ''}`,
    { type: 'button' },
    dirty ? 'Discard changes' : 'Close it',
  );
  discard.addEventListener('click', () => {
    dismiss();
    // Past the guard deliberately: this IS the answer to the guard's question.
    dialog.close();
  });

  const title = dirty ? 'Discard unsaved changes?' : 'Close this editor?';
  sheet = el('div', 'rl-modal-ask', { role: 'alertdialog', 'aria-label': title });
  sheet.append(
    askBox({
      title,
      lines: [
        dirty
          ? 'Nothing here has been saved yet. Closing now throws it away.'
          : 'You clicked outside the editor. Nothing has been changed, so nothing will be lost.',
      ],
      danger: discard,
      safe: keep,
    }),
  );
  dialog.append(sheet);
  keep.focus();
}

/**
 * Ask before something that cannot be undone. See the rule in the header.
 *
 * Resolves TRUE only if the destructive button was actually pressed. Escape,
 * the backdrop, the safe button and a second question arriving while one is
 * already up all resolve false - there is no path out of here that leaves the
 * caller unanswered, which is what lets every call site read as one `if`.
 *
 * @param {object}   options
 * @param {string}   options.title       the question, phrased as one.
 * @param {string[]} [options.lines]     what it costs. One paragraph each, and
 *   worth spending: this is the space a `window.confirm` does not have, and the
 *   reason it is worth leaving one.
 * @param {string}   [options.confirm]   the destructive button's label. Say
 *   what it DOES - "Delete for good", "Reset it" - never "OK". A button that
 *   names its action is the last chance to notice you are on the wrong one.
 * @param {string}   [options.safe]      the way out. Takes focus.
 * @param {string}   [options.typed]     require this string typed back before
 *   the destructive button turns on at all. For anything whose blast radius is
 *   a whole workspace: a confirmation is answered "yes" by reflex and a name is
 *   not. The button being DISABLED until it matches is the half that matters -
 *   it puts the confirmation before the click rather than after it.
 * @param {string}   [options.typedLabel]
 * @returns {Promise<boolean>}
 */
export function confirmDanger({
  title,
  lines = [],
  confirm: confirmLabel = 'Delete',
  safe: safeLabel = 'Cancel',
  typed = null,
  typedLabel = 'Type the name to confirm',
} = {}) {
  return new Promise((resolve) => {
    const go = el('button', 'btn btn-ghost rl-modal-ask-danger', { type: 'button' }, confirmLabel);
    const back = el('button', 'btn btn-primary', { type: 'button' }, safeLabel);

    const extras = [];
    let box = null;
    if (typed) {
      const wanted = String(typed).trim();
      box = el('input', null, { type: 'text', placeholder: typed, 'aria-label': typedLabel });
      go.disabled = true;
      box.addEventListener('input', () => {
        go.disabled = box.value.trim() !== wanted;
      });
      extras.push(field(typedLabel, box));
    }

    const content = askBox({ title, lines, extras, danger: go, safe: back });

    /*
     * Focus: the safe answer, EXCEPT where there is a box to type in.
     *
     * The rule everywhere else here is that the safe answer takes it, so a
     * reflex keypress cannot destroy anything. A typed gate makes that
     * impossible on its own - the destructive button is disabled until the name
     * matches, and nothing in this box is a `<form>`, so Enter does nothing at
     * all. With the danger gone, the box is the thing the operator came here to
     * use, and starting anywhere else is a click they have to make for nothing.
     */
    const first = () => (box ?? back).focus();

    const host = document.querySelector('dialog.rl-modal');
    if (host) {
      // One question at a time, for the same reason there is one dialog at a
      // time. A caller that manages to ask twice gets "no" for the second
      // rather than a sheet stacked on a sheet.
      if (sheet) {
        resolve(false);
        return;
      }

      const settle = (answer) => {
        // Cleared FIRST: this press is the answer, so the Escape/backdrop hook
        // that would also say "no" must not fire behind it.
        sheetCancel = null;
        dismiss();
        resolve(answer);
      };
      go.addEventListener('click', () => settle(true));
      back.addEventListener('click', () => settle(false));

      sheet = el('div', 'rl-modal-ask', { role: 'alertdialog', 'aria-label': title });
      sheet.append(content);
      sheetCancel = () => resolve(false);
      host.append(sheet);
      first();
      return;
    }

    /*
     * Nothing open, so this gets a dialog of its own - wearing the same box,
     * which is what `.rl-modal-solo` in styles.css exists to arrange.
     *
     * `onClose` is the single answer path for all three ways out, which is the
     * same reason openModal has one teardown: Escape, the backdrop and Cancel
     * must not be three chances to get the resolve wrong.
     */
    let answer = false;
    const dialog = openModal({
      className: 'rl-modal-solo',
      body: content,
      onClose: () => resolve(answer),
    });
    if (!dialog) {
      // Something else was already up. Answer no rather than acting unasked.
      resolve(false);
      return;
    }
    go.addEventListener('click', () => {
      answer = true;
      dialog.close();
    });
    back.addEventListener('click', () => dialog.close());
    first();
  });
}

function dismiss() {
  // Read and cleared BEFORE it runs. A hook that went on to open another sheet
  // would otherwise find this one still recorded and tear the new one straight
  // back down again.
  const cancelled = sheetCancel;
  sheetCancel = null;
  sheet?.remove();
  sheet = null;
  cancelled?.();
}

/**
 * The tab strip and its panes, built once.
 *
 * Returns the two elements to insert; the caller's `tabs` array is not touched,
 * because a helper that wrote back onto what it was handed would make the
 * second call with the same array behave differently from the first.
 */
function tabParts(tabs) {
  const strip = el('nav', 'card-tabs rl-modal-tabs', { role: 'tablist', 'aria-label': 'Sections' });
  const panes = el('div', 'rl-modal-panes');

  const built = tabs.map((tab) => {
    const button = el(
      'button',
      'card-tab',
      { type: 'button', role: 'tab', 'data-pane': tab.id, 'aria-selected': 'false' },
      tab.label,
    );
    const pane = el('div', 'rl-modal-pane', { 'data-pane': tab.id, role: 'tabpanel' });
    pane.append(tab.body);
    strip.append(button);
    panes.append(pane);
    return { id: tab.id, button, pane };
  });

  const show = (id) => {
    for (const entry of built) {
      const on = entry.id === id;
      // `hidden` only. styles.css enforces `[hidden] { display: none
      // !important }` globally, which is what makes that safe on a pane that
      // sets its own display - the trap the veto board's logo bar fell into.
      entry.pane.hidden = !on;
      entry.button.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  };
  for (const entry of built) entry.button.addEventListener('click', () => show(entry.id));
  show(built[0].id);

  return [strip, panes];
}

/**
 * Put a dialog on screen.
 *
 * @param {object}      options
 * @param {string}      [options.className]  extra classes on the dialog itself,
 *   for a panel that wants its own width or its own footer rules.
 * @param {Element}     [options.body]       built by the caller, whole. Use
 *   this OR `tabs`, never both - a body beside a tab strip is a section of the
 *   form that belongs to no tab, which is the thing tabs exist to remove.
 * @param {Element}     [options.head]       stays above the strip and never
 *   scrolls: the title, and anything that names what is being edited.
 * @param {{id: string, label: string, body: Element}[]} [options.tabs]
 * @param {Element}     [options.foot]       the button row, likewise.
 * @param {() => boolean} [options.dirty]    is there unsaved work in here? See
 *   the note above - given one, Escape, the backdrop and `askClose` ask before
 *   throwing it away. A dialog whose every button writes immediately has
 *   nothing to discard and must NOT pass this.
 * @param {() => void}  [options.onClose]    run once, after it is removed.
 * @returns {HTMLDialogElement|null} null if one was already open.
 */
export function openModal({ className = '', body, head, tabs, foot, dirty, onClose } = {}) {
  if (modalOpen()) return null;

  const tabbed = Array.isArray(tabs) && tabs.length > 0;
  const dialog = el('dialog', `rl-modal${tabbed ? ' is-tabbed' : ''}${className ? ` ${className}` : ''}`);

  const parts = [];
  if (head) {
    // Wrapped here rather than by every caller, so the padding above a strip
    // cannot end up different on two dialogs.
    const bar = el('div', 'rl-modal-head');
    bar.append(head);
    parts.push(bar);
  }
  if (tabbed) parts.push(...tabParts(tabs));
  if (body) parts.push(body);
  if (foot) parts.push(foot);

  dialog.append(...parts);
  document.body.append(dialog);

  guard = typeof dirty === 'function' ? dirty : null;
  // Both, together. Clearing the sheet and leaving its cancel hook behind would
  // leave a dead promise armed to answer on THIS dialog's close.
  sheet = null;
  sheetCancel = null;

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
    // `always`: this is the exit nobody aims at. See the header.
    else askClose(dialog, { always: true });
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
