/**
 * The editor controls both dashboards are built from.
 *
 * Every control does the same three things - read a dotted path out of some
 * state object, write the edited value back, and say that something changed -
 * so the only thing that varies between the scoreboard editor and the winner
 * editor is which state object and which save function. That is what
 * `makeFields` is closing over.
 *
 * The closures read the accessors on every call rather than capturing a state
 * object, so a dashboard that replaces its state wholesale (adopting the
 * server's sanitised copy after a save, say) does not leave stale controls
 * writing into an object nobody is looking at any more.
 *
 * Dependency-free, DOM-only.
 */

// The dashboards all listen for this; fields.js has no toast of its own and
// should not grow one.
const toast = (message) => window.dispatchEvent(new CustomEvent('app-toast', { detail: message }));

export function el(tag, className, attrs = {}, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    node.setAttribute(key, value === true ? '' : value);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

export const readPath = (source, path) =>
  path.split('.').reduce((value, part) => (value === null || value === undefined ? value : value[part]), source);

export function writePath(target, path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  const host = parts.reduce((value, part) => value[part], target);
  host[last] = value;
}

export const grid = (columns, children) => {
  const node = el('div', `field-grid${columns ? ` cols-${columns}` : ''}`);
  node.append(...children);
  return node;
};

export const title = (text, extra) => {
  const node = el('h2', 'panel-title', {}, text);
  if (extra) node.append(extra);
  return node;
};

export const subhead = (text) => el('div', 'subhead', {}, text);

export const help = (text) => el('p', 'field-help', {}, text);

/** The server stores image URLs up to 500 characters; the inputs must match. */
const URL_MAX = 500;
const USABLE_URL = /^(?:https?:\/\/\S+|\/[\w./-]*)$/i;

export function field(label, input) {
  const wrap = el('label', 'g-field');
  wrap.append(el('span', null, {}, label), input);
  return wrap;
}

/**
 * @param {() => object} state the object the paths below are relative to
 * @param {() => void} onChange called after every edit - normally a queued save
 */
export function makeFields(state, onChange) {
  const get = (path) => readPath(state(), path);
  const set = (path, value) => {
    writePath(state(), path, value);
    onChange();
  };

  /**
   * Controls that can re-read their value when the state changes underneath
   * them - which is what makes another operator's edit show up in this
   * dashboard rather than only on the output page.
   *
   * Each entry keeps the node it owns so `syncFields` can leave alone whatever
   * has focus. Writing into the box someone is mid-word in moves their caret to
   * the end, and with two operators on one field it becomes a fight neither
   * can win.
   */
  const bound = [];

  const bind = (node, apply) => {
    apply();
    bound.push({ node, apply });
  };

  /**
   * Re-apply the current state to every control built here.
   *
   * One control that throws must not take the rest of the form with it: a
   * half-synced dashboard is recoverable mid-broadcast, a blank one is not.
   */
  function syncFields() {
    const active = document.activeElement;
    for (const { node, apply } of bound) {
      if (node === active || node.contains?.(active)) continue;
      try {
        apply();
      } catch (error) {
        console.warn(`a field could not re-read its state: ${error.message}`);
      }
    }
  }

  /** Text/URL input bound to a dotted path in the state. */
  function textField(label, path, { placeholder = '', maxlength = 120 } = {}) {
    const input = el('input', null, { type: 'text', spellcheck: 'false', placeholder, maxlength });
    bind(input, () => {
      input.value = get(path) ?? '';
    });
    input.addEventListener('input', () => set(path, input.value));
    return field(label, input);
  }

  /**
   * A text field holding an image URL.
   *
   * Two things it does that a plain text field must not. The length cap matches
   * what the server actually stores - the 120 of a normal text field silently
   * truncates a CDN link, which then parses as a perfectly valid URL pointing
   * nowhere, so the image never appears and the field looks like it refused to
   * save. Measured against a real Discord attachment link: 181 characters, cut
   * mid-signature.
   *
   * And it says so when the value cannot survive sanitising. Anything that is
   * not http(s) or a path starting with / is discarded server-side, which
   * without a mark here is indistinguishable from the save failing.
   */
  function urlField(label, path, { placeholder = '' } = {}) {
    const wrap = textField(label, path, { placeholder, maxlength: URL_MAX });
    const input = wrap.querySelector('input');

    const mark = () => {
      const value = input.value.trim();
      const usable = !value || USABLE_URL.test(value);
      input.classList.toggle('invalid', !usable);
      input.title = usable
        ? ''
        : 'Must start with https://, http:// or / - anything else is discarded when the graphic saves.';
    };

    input.addEventListener('input', mark);
    // Registered after textField's own binding, so the value is already in
    // place when this re-checks it - otherwise a synced URL keeps the previous
    // value's invalid mark.
    bind(input, mark);
    return wrap;
  }

  function numberField(label, path, { min = 0, max = 999 } = {}) {
    const input = el('input', null, { type: 'number', min, max, step: '1' });
    bind(input, () => {
      input.value = String(get(path) ?? 0);
    });
    input.addEventListener('input', () => {
      // A cleared box means zero, not "keep the old number" - otherwise the
      // graphic silently keeps a stale score while the field looks empty.
      const parsed = Number.parseInt(input.value, 10);
      set(path, Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : 0);
    });
    return field(label, input);
  }

  /**
   * A calendar date, held as the `YYYY-MM-DD` the input itself produces.
   *
   * Stored as typed rather than as a timestamp, and that is the whole reason
   * this is not a textField with a pattern. A tournament starts on a DATE, not
   * at an instant; turning "the 4th" into an epoch would silently pick a
   * timezone and then show somebody the 3rd. The string has no timezone to get
   * wrong.
   *
   * `change` rather than `input`, unlike every other control here. A date input
   * emits `input` for each part as it is filled, so a half-typed year arrives as
   * a real edit - and on a field that queues a save, that means writing 0002 to
   * the server on the way to 2026.
   *
   * Blank is a value, not a failure: an end date nobody has set yet is the
   * normal state of every tournament still running.
   */
  function dateField(label, path) {
    const input = el('input', null, { type: 'date' });
    bind(input, () => {
      input.value = get(path) ?? '';
    });
    input.addEventListener('change', () => set(path, input.value));
    return field(label, input);
  }

  /**
   * A select over {key, label} options. Unlike selectField there is no blank
   * entry: these fields always hold one of the listed values.
   */
  function choiceField(label, path, options) {
    const select = el('select');
    for (const option of options) select.append(el('option', null, { value: option.key }, option.label));
    bind(select, () => {
      select.value = String(get(path) ?? '');
    });
    select.addEventListener('change', () => set(path, select.value));
    return field(label, select);
  }

  /** A select over plain strings, with a blank "none" entry. */
  function selectField(label, path, options, { allowUnknown = true, none = '- none -' } = {}) {
    const select = el('select');

    // Rebuilt rather than just re-assigned, because the value arriving from
    // another operator may be one this list never had - a team saved on their
    // machine, say. Without the option present the assignment silently selects
    // nothing and the field reads as empty.
    bind(select, () => {
      const current = String(get(path) ?? '');
      const values = options.includes(current) || !current || !allowUnknown ? options : [current, ...options];

      select.replaceChildren(el('option', null, { value: '' }, none));
      for (const value of values) select.append(el('option', null, { value }, value));
      select.value = current;
    });

    select.addEventListener('change', () => set(path, select.value));
    return field(label, select);
  }

  /**
   * A colour, and optionally a way to lift one out of the team's own logo.
   *
   * `sampleFrom` is a getter rather than a value because the logo can change
   * after this control is built - the operator drops one in, then reaches for
   * the colour - and a captured URL would be the old one.
   */
  function colourField(label, path, { sampleFrom, clearable = false } = {}) {
    const input = el('input', null, { type: 'color' });
    const stored = get(path);
    if (!sampleFrom && !clearable) {
      bind(input, () => {
        input.value = get(path) || '#000000';
      });
      input.addEventListener('input', () => set(path, input.value));
      return field(label, input);
    }

    input.value = stored || '#000000';
    input.addEventListener('input', () => set(path, input.value));

    /*
     * Switched off is a real setting, not an empty one - for a team colour it
     * means "wear whichever side you are on". So the box is disabled rather than
     * hidden: the operator can see the colour that would come back.
     */
    let toggle = null;
    if (clearable) {
      toggle = el('input', null, { type: 'checkbox' });
      toggle.checked = Boolean(stored);
      input.disabled = !toggle.checked;
      toggle.addEventListener('change', () => {
        input.disabled = !toggle.checked;
        set(path, toggle.checked ? input.value : '');
      });
    }

    // Bound on the row rather than the picker: the "From logo" button below is
    // async, and a sync landing mid-sample would fight the colour it is about
    // to write back.
    const rebind = () => {
      const value = get(path);
      if (toggle) {
        toggle.checked = Boolean(value);
        input.disabled = !toggle.checked;
      }
      input.value = value || '#000000';
    };

    const button = sampleFrom ? el('button', 'mini-btn', { type: 'button' }, 'From logo') : null;
    if (button) button.addEventListener('click', async () => {
      const source = String(sampleFrom() ?? '').trim();
      if (!source) {
        toast('No logo on this team yet - add one and try again.');
        return;
      }
      button.disabled = true;
      try {
        const { logoColour } = await import('./palette.js');
        const result = await logoColour(source);
        if (result.hex) {
          input.value = result.hex;
          if (toggle) {
            toggle.checked = true;
            input.disabled = false;
          }
          set(path, result.hex);
          toast(`Colour taken from the logo: ${result.hex}`);
        } else if (result.error === 'blocked') {
          toast('That logo is hosted elsewhere and the browser will not let the page read its pixels. Upload the file instead.');
        } else if (result.error === 'empty') {
          toast('Nothing in that logo reads as a colour - it may be black and white.');
        } else {
          toast('That logo could not be loaded.');
        }
      } finally {
        button.disabled = false;
      }
    });

    const row = el('div', 'colour-row');
    if (toggle) row.append(toggle);
    row.append(input);
    if (button) row.append(button);
    bind(row, rebind);
    return field(label, row);
  }

  /**
   * A colour that INHERITS when it is left blank.
   *
   * The one control for every accent and highlight in this program - the seven
   * graphics' style panels and the tournament's own Settings form all build
   * this, so "what does blank mean here" has one answer and one appearance
   * wherever an operator meets it. Consistency is the point: a Reset button
   * that looks different on the winner splash and the bracket is two controls
   * to learn for one idea.
   *
   * THE SWATCH ALWAYS SHOWS WHAT WOULD PAINT. While a field is inheriting it
   * shows the inherited colour rather than sitting black or empty, which is the
   * same call `optionalColourField` makes about a switched-off team colour: an
   * operator has to be able to see what they are about to change away from.
   * What distinguishes the two states is the word beside it and whether Reset
   * is available, never the swatch being wrong.
   *
   * TOUCHING THE PICKER OVERRIDES. There is deliberately no "inherit?"
   * checkbox: a tick-box beside a swatch that still shows a colour is two
   * controls saying one thing, and the pair immediately raises "what happens if
   * I untick it and then drag the picker". Reset is the only way back, which
   * makes the round trip one obvious button rather than a mode.
   *
   * @param {string} label
   * @param {string} path            where the OVERRIDE is stored; '' = inherit
   * @param {object} options
   * @param {() => string} options.inherited  the colour this falls back to
   * @param {string} [options.source]  what to call the thing it inherits from
   */
  function brandField(label, path, { inherited, source = 'the event' } = {}) {
    const input = el('input', null, { type: 'color', 'aria-label': label });
    const state = el('span', 'brand-state');
    const reset = el(
      'button',
      'mini-btn',
      { type: 'button', title: `Clear this and follow ${source} again.` },
      'Reset to default',
    );

    const fallback = () => String(inherited?.() ?? '') || '#000000';

    const rebind = () => {
      const own = String(get(path) ?? '').trim();
      input.value = own || fallback();
      reset.disabled = !own;
      state.textContent = own ? 'overridden here' : `from ${source}`;
      state.classList.toggle('is-inherited', !own);
    };

    // `input` rather than `change`: a colour picker fires input while the
    // operator drags, and waiting for change means the preview does not follow
    // the cursor - which is how somebody ends up picking a colour twice.
    input.addEventListener('input', () => set(path, input.value));
    reset.addEventListener('click', () => {
      set(path, '');
      // Immediately, not on the next repaint: `set` queues a save and the panel
      // this lives in may not rebuild at all, so the swatch would go on showing
      // the override it no longer holds.
      rebind();
    });

    const row = el('div', 'colour-row brand-row');
    row.append(input, state, reset);
    bind(row, rebind);
    return field(label, row);
  }

  function checkField(label, path) {
    const input = el('input', null, { type: 'checkbox' });
    bind(input, () => {
      input.checked = Boolean(get(path));
    });
    input.addEventListener('change', () => set(path, input.checked));
    const wrap = el('label', 'checkline');
    wrap.append(input, el('span', null, {}, label));
    return wrap;
  }

  /**
   * A slider, optionally with its value written on the label line.
   *
   * `readout` is a formatter rather than a flag, because the number a slider
   * holds and the number worth showing are rarely the same thing - 0.55 wants
   * to be read as 55%, and a multiplier wants a unit on it.
   *
   * Off by default. An opacity only ever needs "less" and "more", and a row of
   * numbers nobody reads is a row of numbers competing with the labels. It
   * earns its place the moment a slider has a *default* worth getting back to,
   * which a bare handle cannot be steered to.
   */
  function rangeField(label, path, { min = 0, max = 1, step = 0.05, readout = null } = {}) {
    const input = el('input', null, { type: 'range', min, max, step });
    const value = readout ? el('span', 'g-readout') : null;

    const show = (current) => {
      if (value) value.textContent = readout(Number(current));
    };

    bind(input, () => {
      const current = get(path) ?? 0;
      input.value = String(current);
      show(current);
    });

    input.addEventListener('input', () => {
      const next = Number.parseFloat(input.value);
      set(path, next);
      // Updated here as well as in the binding: syncFields deliberately skips
      // the control being interacted with, so the readout on the slider under
      // the cursor is the one thing a re-sync will never refresh.
      show(next);
    });

    const wrap = field(label, input);
    if (value) {
      wrap.classList.add('has-readout');
      // Into the label span, so the two sit on one line and the slider keeps
      // the full width of the field beneath them.
      wrap.firstChild.append(value);
    }
    return wrap;
  }

  /**
   * A colour that can be switched off entirely - blank means transparent, which
   * is what an OBS source wants for a page background.
   */
  function optionalColourField(label, path) {
    const toggle = el('input', null, { type: 'checkbox' });
    const picker = el('input', null, { type: 'color' });

    const current = get(path);
    toggle.checked = Boolean(current);
    picker.value = current || '#000000';
    picker.disabled = !toggle.checked;

    const rebind = () => {
      const value = get(path);
      toggle.checked = Boolean(value);
      picker.value = value || '#000000';
      picker.disabled = !toggle.checked;
    };

    const push = () => {
      picker.disabled = !toggle.checked;
      set(path, toggle.checked ? picker.value : '');
    };

    toggle.addEventListener('change', push);
    picker.addEventListener('input', push);

    const line = el('label', 'checkline');
    line.append(toggle, el('span', null, {}, label));

    const wrap = el('div', 'g-field');
    wrap.append(line, picker);
    bind(wrap, rebind);
    return wrap;
  }

  return {
    get,
    set,
    syncFields,
    textField,
    urlField,
    numberField,
    dateField,
    choiceField,
    selectField,
    colourField,
    brandField,
    checkField,
    rangeField,
    optionalColourField,
  };
}
