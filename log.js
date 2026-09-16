/**
 * Logging, with a ring buffer the admin panel can read.
 *
 * The thing this is actually for: a broadcast goes wrong, and the person who has
 * to work out why is standing at a desk with OBS open, not sitting at a shell on
 * the server. So every line goes two places at once - the console, where a
 * `docker logs` will find it, and a fixed-size buffer in memory that
 * `GET /api/admin/logs` serves to the Admin tab.
 *
 * In memory, deliberately. Nothing here is worth a file: a broadcast tool that
 * fills a disk with request logs during a tournament is a broadcast tool that
 * stops. The buffer holds the last few hundred lines, which covers the window
 * anybody actually asks about ("what happened just now?"), and the console
 * output is there for anything longer - that is the container runtime's job.
 *
 * **Everything is redacted on the way in, not on the way out.** The buffer is
 * served to a browser, and a secret that reaches it is a secret that has leaked
 * whatever the reader is allowed to see. See `redact`.
 */

/** Most severe first, so an index comparison is a level comparison. */
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

const RANK = Object.fromEntries(LOG_LEVELS.map((name, index) => [name, index]));

/**
 * Strings that must never reach a log line, and the shapes they arrive in.
 *
 * The session key is the one that matters most and is the easiest to miss: it
 * travels as a query parameter, so it is in `req.url` on every single OBS and
 * webhook request. Logging raw URLs would put it in a buffer the admin panel
 * renders, in a `docker logs` anyone with shell access can read, and in whatever
 * ships those logs onward.
 *
 * `code` and `state` are the second pair that travel that way: an OAuth
 * callback arrives as `?code=...&state=...` on a route that logs like any
 * other, and the request line is written whatever the outcome. The code is
 * single-use and short-lived, which is not the same as harmless - it is
 * exchangeable for an identity assertion until it is spent, and a 500 on that
 * route logs the whole query string at error level.
 */
const SECRET_PARAMS = new Set(['key', 'password', 'token', 'secret', 'current', 'code', 'state']);

/** `?key=abc123` -> `?key=<hidden>`, leaving everything else readable. */
export function safeUrl(rawUrl) {
  const value = String(rawUrl ?? '');
  const at = value.indexOf('?');
  if (at === -1) return value;

  const pathname = value.slice(0, at);
  let params;
  try {
    params = new URLSearchParams(value.slice(at + 1));
  } catch {
    // Unparseable, so it cannot be inspected - and something that cannot be
    // inspected cannot be shown to be safe.
    return `${pathname}?<unreadable>`;
  }

  for (const name of params.keys()) {
    if (SECRET_PARAMS.has(name.toLowerCase())) params.set(name, '<hidden>');
  }
  const query = params.toString();
  if (!query) return pathname;
  try {
    // Read back for a human: toString re-encodes everything, and `#SEN` is
    // easier to recognise in a log than `%23SEN`.
    return `${pathname}?${decodeURIComponent(query)}`;
  } catch {
    return `${pathname}?${query}`;
  }
}

/**
 * Send whatever else writes to the console into the buffer as well.
 *
 * The state stores report a failed save with `console.warn` from inside a
 * promise chain, which is the right place for them to do it - they have no
 * logger and should not grow one. But "the scoreboard could not be saved" is
 * precisely what an operator needs to see in the admin panel, and it would
 * otherwise only ever reach `docker logs`.
 *
 * Wrapping the console is blunt. It is also the only way to catch a line
 * written by code that does not know this module exists, which includes
 * anything Node itself decides to warn about.
 */
export function captureConsole(logger) {
  const original = { warn: console.warn, error: console.error };

  const wrap = (level) =>
    function wrapped(...args) {
      // Only the logger, not the original as well. The logger prints through
      // the console functions it captured when it was built, so the line still
      // reaches the terminal - once, in the same format as everything else,
      // instead of twice in two different ones.
      logger[level](
        'console',
        args.map((arg) => (arg instanceof Error ? (arg.stack ?? arg.message) : String(arg))).join(' '),
      );
    };

  console.warn = wrap('warn');
  console.error = wrap('error');

  return () => {
    console.warn = original.warn;
    console.error = original.error;
  };
}

/**
 * Scrub a value that is about to be attached to a log line.
 *
 * Recursive, because meta arrives as an object and the interesting secrets are
 * one level down. Keys are matched by name rather than by value: a heuristic
 * that looked for things *shaped* like a key would miss the one that was not,
 * and the cost of hiding a field that did not need hiding is nil.
 */
export function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '<deep>';

  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => redact(entry, depth + 1));

  const out = {};
  for (const [name, entry] of Object.entries(value)) {
    const lowered = name.toLowerCase();
    if (
      lowered.includes('password') ||
      lowered.includes('secret') ||
      lowered === 'hash' ||
      lowered === 'salt' ||
      lowered === 'cookie' ||
      lowered === 'sessionkey' ||
      // A substring rather than an exact match: an OAuth exchange answers with
      // `access_token` and `refresh_token`, and an exact test on 'token' would
      // have let both straight through into a buffer the admin panel renders.
      lowered.includes('token') ||
      // The header a token exchange is sent under. It carries the client secret
      // on the way out and a bearer token on the way back, and it matched none
      // of the tests above - 'authorization' contains neither 'token' nor
      // 'secret'.
      lowered.includes('authorization') ||
      // A substring, for the same reason 'token' is one. This was an exact
      // match on 'key' and it failed open for `controlKey`, which is a
      // credential that opens the desk and which `publicUser` carries - so any
      // meta object holding one put it straight into the ring buffer the admin
      // panel renders in a browser, and redaction happens on the way IN, so
      // there is no fixing it afterwards. The exact test was also a standing
      // trap for every future credential: an event key, an API key, anything
      // named `<thing>Key` sailed past it with nothing failing. Hiding a field
      // that did not need hiding costs nothing, which is this function's own
      // stated rule.
      lowered.includes('key')
    ) {
      out[name] = '<hidden>';
    } else if (lowered === 'url' || lowered === 'path') {
      out[name] = safeUrl(entry);
    } else {
      out[name] = redact(entry, depth + 1);
    }
  }
  return out;
}

const pad = (value, width) => String(value).padEnd(width);
const clock = (at) => new Date(at).toISOString().slice(11, 23);

/**
 * @param {object} options
 * @param {string} options.level   the quietest level to emit
 * @param {number} options.capacity how many lines the admin panel can look back
 */
export function makeLogger({ level = 'info', capacity = 500 } = {}) {
  let threshold = RANK[level] ?? RANK.info;

  /*
   * Bound now, not looked up per call.
   *
   * `captureConsole` replaces console.warn and console.error later, and a
   * logger that resolved `console.warn` at write time would call the wrapper,
   * which calls the logger, which calls the wrapper. Holding the originals is
   * what makes that impossible rather than merely unlikely.
   */
  const sink = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  /** @type {{seq: number, at: number, level: string, tag: string, message: string, meta?: object}[]} */
  const entries = [];
  let seq = 0;

  function write(name, tag, message, meta) {
    if (RANK[name] > threshold) return;

    seq += 1;
    const at = Date.now();
    const safeMeta = meta ? redact(meta) : undefined;
    const entry = { seq, at, level: name, tag, message: String(message ?? ''), ...(safeMeta ? { meta: safeMeta } : {}) };

    entries.push(entry);
    // Trimmed one at a time rather than in a batch: this runs on every line, and
    // a shift on a few-hundred-element array is not worth being clever about.
    if (entries.length > capacity) entries.shift();

    const detail = safeMeta ? ` ${JSON.stringify(safeMeta)}` : '';
    const line = `${clock(at)} ${pad(name.toUpperCase(), 5)} ${pad(tag, 9)} ${entry.message}${detail}`;
    if (name === 'error') sink.error(line);
    else if (name === 'warn') sink.warn(line);
    else sink.log(line);
  }

  return {
    get level() {
      return LOG_LEVELS[threshold];
    },

    /** Changing it at runtime is the whole point of a debug switch. */
    setLevel(name) {
      if (RANK[name] === undefined) return false;
      threshold = RANK[name];
      // At warn, so it survives being turned down. Recording the change at info
      // meant that lowering the level to `warn` erased its own audit trail -
      // the one line you need to explain why the log went quiet.
      write('warn', 'log', `level is now ${name}`);
      return true;
    },

    error: (tag, message, meta) => write('error', tag, message, meta),
    warn: (tag, message, meta) => write('warn', tag, message, meta),
    info: (tag, message, meta) => write('info', tag, message, meta),
    debug: (tag, message, meta) => write('debug', tag, message, meta),

    /**
     * The buffer, newest first.
     *
     * `since` lets the panel poll for what it has not seen rather than re-render
     * the lot - a sequence number rather than a timestamp, because two lines can
     * share a millisecond and a clock can go backwards.
     */
    recent({ limit = 200, level: floor = 'debug', since = 0, tag = '' } = {}) {
      const cap = RANK[floor] ?? RANK.debug;
      const wanted = String(tag).trim().toLowerCase();
      const matched = entries.filter(
        (entry) => entry.seq > since && RANK[entry.level] <= cap && (!wanted || entry.tag === wanted),
      );
      return matched.slice(-limit).reverse();
    },

    get size() {
      return entries.length;
    },

    /** Highest sequence number issued, so a poller knows where it is. */
    get cursor() {
      return seq;
    },
  };
}
