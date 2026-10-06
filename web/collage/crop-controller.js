// @ts-check

/**
 * A crop rectangle expressed in source-image coordinates from 0 to 1.
 * The image never moves; editing changes this rectangle instead.
 * @typedef {{x: number, y: number, width: number, height: number}} NormalizedCrop
 */

const MIN_CROP_SIZE = 0.01;

/** @param {number} value @param {number} min @param {number} max */
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * @param {Partial<NormalizedCrop>|undefined|null} crop
 * @returns {NormalizedCrop}
 */
export function normalizeCrop(crop) {
  const width = clamp(Number(crop?.width) || 1, MIN_CROP_SIZE, 1);
  const height = clamp(Number(crop?.height) || 1, MIN_CROP_SIZE, 1);
  return {
    x: clamp(Number(crop?.x) || 0, 0, 1 - width),
    y: clamp(Number(crop?.y) || 0, 0, 1 - height),
    width,
    height,
  };
}

/** @param {NormalizedCrop} crop @param {number} dx @param {number} dy */
export function moveCrop(crop, dx, dy) {
  const current = normalizeCrop(crop);
  return normalizeCrop({...current, x: current.x + dx, y: current.y + dy});
}

/**
 * Resize around the crop centre. In proportional mode the requested width is
 * authoritative and height follows the supplied target aspect ratio.
 * @param {NormalizedCrop} crop
 * @param {{width?: number, height?: number, mode?: 'proportional'|'free', aspectRatio?: number}} change
 */
export function resizeCrop(crop, change) {
  const current = normalizeCrop(crop);
  const centreX = current.x + current.width / 2;
  const centreY = current.y + current.height / 2;
  let width = clamp(change.width ?? current.width, MIN_CROP_SIZE, 1);
  let height = clamp(change.height ?? current.height, MIN_CROP_SIZE, 1);
  if (change.mode !== 'free') {
    const aspect = change.aspectRatio && change.aspectRatio > 0
      ? change.aspectRatio
      : current.width / current.height;
    height = width / aspect;
    if (height > 1) {
      height = 1;
      width = Math.min(1, height * aspect);
    }
  }
  width = Math.min(width, 2 * Math.min(centreX, 1 - centreX) || width);
  height = Math.min(height, 2 * Math.min(centreY, 1 - centreY) || height);
  return normalizeCrop({
    x: centreX - width / 2,
    y: centreY - height / 2,
    width,
    height,
  });
}

/** @param {NormalizedCrop} crop */
export function centreCrop(crop) {
  const current = normalizeCrop(crop);
  return {...current, x: (1 - current.width) / 2, y: (1 - current.height) / 2};
}

/**
 * Recalculate a proportional crop for a cell while retaining the old centre.
 * @param {NormalizedCrop} crop
 * @param {number} imageAspect
 * @param {number} cellAspect
 */
export function cropForCell(crop, imageAspect, cellAspect) {
  const current = normalizeCrop(crop);
  if (!(imageAspect > 0) || !(cellAspect > 0)) return current;
  const desiredNormalizedAspect = cellAspect / imageAspect;
  let width = current.width;
  let height = width / desiredNormalizedAspect;
  if (height > 1) {
    height = Math.min(1, current.height);
    width = height * desiredNormalizedAspect;
  }
  return resizeCrop(current, {width, height, mode: 'free'});
}

/**
 * Keyboard contract for the crop editor. Arrow keys move the frame; plus and
 * minus resize it. Values are normalized, so UI scale does not affect edits.
 * @param {NormalizedCrop} crop
 * @param {string} key
 * @param {{step?: number, resizeStep?: number, mode?: 'proportional'|'free', aspectRatio?: number}} [options]
 */
export function cropFromKey(crop, key, options = {}) {
  const step = options.step ?? 0.005;
  if (key === 'ArrowLeft') return moveCrop(crop, -step, 0);
  if (key === 'ArrowRight') return moveCrop(crop, step, 0);
  if (key === 'ArrowUp') return moveCrop(crop, 0, -step);
  if (key === 'ArrowDown') return moveCrop(crop, 0, step);
  const resizeStep = options.resizeStep ?? 0.02;
  if (key === '+' || key === '=') {
    return resizeCrop(crop, {width: crop.width - resizeStep, height: crop.height - resizeStep, ...options});
  }
  if (key === '-') {
    return resizeCrop(crop, {width: crop.width + resizeStep, height: crop.height + resizeStep, ...options});
  }
  return normalizeCrop(crop);
}
