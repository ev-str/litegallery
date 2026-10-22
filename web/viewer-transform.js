// Display-only geometry for the photo viewer. Sizes are CSS pixels, offsets are
// measured from the centre of the stage, and rotation is in quarter turns. Nothing
// here touches the file: the viewer only transforms the <img> element.

export const MAX_SCALE = 8;
export const ZOOM_STEP = 1.25;
const EPSILON = 1e-3;

/**
 * @typedef {{width: number, height: number}} Size
 * @typedef {'fit'|'original'|'zoom'} ViewMode
 * @typedef {{mode: ViewMode, scale: number, x: number, y: number, rotation: number}} View
 * @typedef {{image: Size, fit: Size, stage: Size}} Frame
 *   image: decoded pixels; fit: area a fitted photo fills; stage: visible area that bounds panning.
 */

/** @returns {View} */
export function initialView() {
  return {mode: 'fit', scale: 1, x: 0, y: 0, rotation: 0};
}

/** @param {Size} size @param {number} rotation */
export function rotatedSize(size, rotation) {
  return rotation % 180 ? {width: size.height, height: size.width} : size;
}

/** Largest scale at which the whole rotated photo is visible. @param {Frame} frame @param {number} rotation */
export function fitScale(frame, rotation) {
  const {width, height} = rotatedSize(frame.image, rotation);
  if (!(width > 0 && height > 0 && frame.fit.width > 0 && frame.fit.height > 0)) return 1;
  return Math.min(frame.fit.width / width, frame.fit.height / height);
}

/** Zoom never goes below Fit (or 1:1 for small photos) and stops at MAX_SCALE, or twice Fit if that is larger. */
export function scaleLimits(/** @type {Frame} */ frame, /** @type {number} */ rotation) {
  const fit = fitScale(frame, rotation);
  return {fit, min: Math.min(fit, 1), max: Math.max(MAX_SCALE, fit * 2)};
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// A photo larger than the stage may move until its edge meets the stage edge; a smaller one stays centred.
function clampOffset(offset, content, visible) {
  const slack = Math.max(0, (content - visible) / 2);
  return clamp(offset, -slack, slack);
}

/** Resolve the scale for the mode, keep it in range, and keep the photo covering the stage. @param {View} view @param {Frame} frame @returns {View} */
export function settle(view, frame) {
  const limits = scaleLimits(frame, view.rotation);
  const scale = view.mode === 'fit' ? limits.fit : view.mode === 'original' ? 1 : clamp(view.scale, limits.min, limits.max);
  const size = rotatedSize(frame.image, view.rotation);
  return {
    ...view,
    scale,
    x: clampOffset(view.x, size.width * scale, frame.stage.width),
    y: clampOffset(view.y, size.height * scale, frame.stage.height),
  };
}

/** True while the photo is larger than the stage, so dragging pans it instead of swiping. @param {View} view @param {Frame} frame */
export function canPan(view, frame) {
  const size = rotatedSize(frame.image, view.rotation);
  return size.width * view.scale > frame.stage.width + 0.5 || size.height * view.scale > frame.stage.height + 0.5;
}

/**
 * Zoom to `scale`, keeping the photo point under `point` (relative to the stage centre) in place.
 * @param {View} view @param {Frame} frame @param {number} scale @param {{x: number, y: number}} [point]
 * @returns {View}
 */
export function zoomAt(view, frame, scale, point = {x: 0, y: 0}) {
  const limits = scaleLimits(frame, view.rotation);
  const next = clamp(scale, limits.min, limits.max);
  const ratio = next / view.scale;
  /** @type {ViewMode} */
  const mode = Math.abs(next - limits.fit) < EPSILON ? 'fit' : Math.abs(next - 1) < EPSILON ? 'original' : 'zoom';
  return settle({...view, mode, scale: next, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio}, frame);
}

/** @param {View} view @param {Frame} frame @param {number} dx @param {number} dy */
export function panBy(view, frame, dx, dy) {
  return settle({...view, x: view.x + dx, y: view.y + dy}, frame);
}

/** @param {View} view @param {Frame} frame @param {ViewMode} mode */
export function setMode(view, frame, mode) {
  return settle({...view, mode, x: 0, y: 0}, frame);
}

/** Double-click and double-tap: Fit zooms in at the point (to 1:1 or twice Fit), anything else returns to Fit. */
export function toggleZoom(/** @type {View} */ view, /** @type {Frame} */ frame, point = {x: 0, y: 0}) {
  if (view.mode !== 'fit') return setMode(view, frame, 'fit');
  const limits = scaleLimits(frame, view.rotation);
  return zoomAt(view, frame, Math.min(limits.max, Math.max(1, limits.fit * 2)), point);
}

/**
 * Rotate by quarter turns about the stage centre; Fit is recomputed for the new orientation.
 * @param {View} view @param {Frame} frame @param {number} turns positive is clockwise
 */
export function rotate(view, frame, turns) {
  let {x, y} = view;
  for (let step = 0; step < ((turns % 4) + 4) % 4; step += 1) [x, y] = [-y, x];
  return settle({...view, rotation: (((view.rotation + turns * 90) % 360) + 360) % 360, x, y}, frame);
}
