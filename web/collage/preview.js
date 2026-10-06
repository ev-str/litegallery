// @ts-check

/**
 * Atomically promote a completely rendered preview buffer to the visible
 * canvas. Stale revisions leave the currently visible frame untouched.
 *
 * @param {HTMLCanvasElement} visibleCanvas
 * @param {HTMLCanvasElement} bufferCanvas
 * @param {number} revision
 * @param {number} latestRevision
 * @returns {boolean}
 */
export function commitPreviewFrame(visibleCanvas, bufferCanvas, revision, latestRevision) {
  if (revision !== latestRevision) return false;
  const context = visibleCanvas.getContext('2d', {alpha: false});
  if (!context) return false;
  visibleCanvas.width = bufferCanvas.width;
  visibleCanvas.height = bufferCanvas.height;
  context.drawImage(bufferCanvas, 0, 0);
  return true;
}
