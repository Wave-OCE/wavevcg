/**
 * Scaling every graphic preview, once.
 *
 * A `.preview-frame` reserves a 16:9 box that is whatever width the column
 * gives it; the iframe inside it is CSS-sized to a FIXED 1920x1080, because
 * that is the stage the output page draws on and a browser source renders at an
 * exact canvas size. So something has to scale the iframe down to the frame,
 * and `overflow: hidden` on the frame means getting it wrong does not look
 * wrong - it looks CROPPED, which reads as a graphic drawn too big rather than
 * as a preview nobody scaled.
 *
 * That is exactly what happened: the three original dashboards each carried a
 * byte-identical `fitPreview`, and the four graphics added after them did not,
 * so all four previews showed the top-left corner of a 1920x1080 page at 1:1.
 * Four copies of six lines is the shape of a rule that gets forgotten; this is
 * the rule in one place instead.
 *
 * ## Why a ResizeObserver and nothing else
 *
 * A panel behind a closed tab has `clientWidth: 0`, and scaling by zero would
 * collapse the iframe. The observer fires when the element gets a size - which
 * is the moment its tab opens - so the timing falls out of the same mechanism
 * rather than needing an `app-tab` listener per dashboard. A zero width is
 * skipped rather than applied, so a hidden frame keeps whatever scale it last
 * had and is re-measured the moment it is on screen.
 */

const STAGE_W = 1920;

/**
 * Watch every preview frame on the page and keep its iframe scaled to it.
 *
 * Safe to call more than once: a frame is marked when it is claimed, so a
 * second call does not stack a second observer on the same element.
 */
export function scalePreviews(root = document) {
  for (const frame of root.querySelectorAll('.preview-frame')) {
    if (frame.dataset.scaled === 'yes') continue;
    const iframe = frame.querySelector('iframe');
    if (!iframe) continue;

    frame.dataset.scaled = 'yes';
    const fit = () => {
      const width = frame.clientWidth;
      // Zero means the panel is hidden. Leave the last good scale alone.
      if (width) iframe.style.transform = `scale(${width / STAGE_W})`;
    };

    new ResizeObserver(fit).observe(frame);
    fit();
  }
}
