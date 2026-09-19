/**
 * One live connection for the whole dashboard.
 *
 * Every graphic pushes its state over server-sent events, and an event stream
 * holds an HTTP connection open for as long as the page does. A browser allows
 * six of those to one origin - so a dashboard with a module per graphic and a
 * live preview of each reaches the ceiling on its own, and the next request,
 * which is the POST saving what you just typed, queues behind connections that
 * will never finish. There is nothing in any log to explain it; the dashboard
 * simply says "Saving..." for ever.
 *
 * So the dashboard modules share this one, and /api/events carries all three.
 * The output pages are left alone: each is a separate browser source holding a
 * single connection, which was never the problem.
 */

import { api } from './session.js';

/** @type {Map<string, Set<(state: object) => void>>} */
const handlers = new Map();

let stream = null;

function connect() {
  if (stream) return;
  stream = new EventSource(api('/api/events'));
  stream.addEventListener('error', () => console.warn('dashboard stream dropped - reconnecting'));
}

/**
 * Subscribe to one graphic's state.
 *
 * The handler is called with each new state, including the current one as soon
 * as the connection opens - the same contract a dedicated stream had, so a
 * caller cannot tell the difference.
 *
 * @param {'graphic'|'winner'|'select'} name
 * @param {(state: object) => void} handler
 * @returns {() => void} unsubscribe
 */
export function onState(name, handler) {
  connect();

  if (!handlers.has(name)) {
    handlers.set(name, new Set());
    stream.addEventListener(name, (event) => {
      let state;
      try {
        state = JSON.parse(event.data)?.state;
      } catch (error) {
        // A malformed frame is not worth breaking a dashboard over, and it must
        // not take the other two graphics' handlers down with it.
        console.warn(`ignored a malformed ${name} update: ${error.message}`);
        return;
      }
      if (!state) return;
      for (const listener of handlers.get(name)) {
        try {
          listener(state);
        } catch (error) {
          /*
           * console.ERROR, and the difference is not cosmetic.
           *
           * Catching here is right - one module's broken handler must not take
           * the other six down with it - but catching turns a crash into a
           * line of text, and a line of text nobody reads is the same as
           * silence. As a warn it WAS silence: every suite in this repo
           * collects `pageerror` and console messages of type `error`, so a
           * throwing listener was the one class of fault that could not fail a
           * test. The bracket dashboard's brand subscription threw on every
           * event-colour change from the day it was written, behind this line.
           *
           * A listener that throws is a bug by definition - nothing here is
           * allowed to fail - so it is reported as one.
           */
          console.error(`a ${name} listener threw: ${error.message}`);
        }
      }
    });
  }

  handlers.get(name).add(handler);
  return () => handlers.get(name)?.delete(handler);
}
