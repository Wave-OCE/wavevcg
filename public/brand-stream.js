/**
 * The event's colours, on an output page's own EventSource.
 *
 * Six browser sources subscribe to this and the whole point is that they do it
 * IDENTICALLY. Six hand-written listeners is six chances to forget the repaint,
 * to parse without a guard, or to start from a different default - and the
 * symptom of any of those is one graphic on a stream wearing last season's
 * colour while the other five moved.
 *
 * It rides the connection the page already has. Each output page opens exactly
 * one EventSource and a browser allows six per origin; a second stream just for
 * two hex strings is the cost that made the dashboard's multiplexer necessary
 * in the first place.
 *
 * ## The reader is a function, not a value
 *
 * `watchBrand` hands back `() => brand` rather than an object the caller keeps.
 * A page renders from whatever the latest frame said, and a snapshot captured
 * once at module scope would be the house default for the life of the browser
 * source - which is precisely the bug this file exists to make impossible.
 */

import { DEFAULT_BRAND, brandOf } from './brand.js';

/**
 * Listen for `brand` frames and keep the latest.
 *
 * @param {EventSource} stream    the page's own connection
 * @param {() => void} [onChange] repaint; called only when a frame lands
 * @returns {() => {accent: string, highlight: string}} the current colours
 */
export function watchBrand(stream, onChange) {
  let brand = { ...DEFAULT_BRAND };

  stream.addEventListener('brand', (event) => {
    try {
      // Through `brandOf`, so a frame from an older server that sent a blank -
      // or a field this build has not met - still resolves to something
      // paintable rather than putting an empty string into a CSS property.
      brand = brandOf(JSON.parse(event.data).state);
    } catch (error) {
      // A malformed frame must not take the graphic off air. The page keeps
      // the colours it had, which is the last thing that was true.
      console.warn(`ignored a malformed brand update: ${error.message}`);
      return;
    }
    onChange?.();
  });

  return () => brand;
}
