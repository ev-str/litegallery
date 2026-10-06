// @ts-check

/** @typedef {import('./types.js').CropRect} CropRect */
/** @typedef {import('./types.js').NormalizedRect} NormalizedRect */
/** @typedef {import('./types.js').PhotoRotation} PhotoRotation */

export const GEOMETRY_EPSILON = 1e-7;

/** @param {unknown} value @returns {value is PhotoRotation} */
export function isPhotoRotation(value) {
  return value === 0 || value === 90 || value === 180 || value === 270;
}

/** @param {unknown} value @returns {PhotoRotation} */
export function normalizePhotoRotation(value) {
  return isPhotoRotation(value) ? value : 0;
}

/** @param {number} width @param {number} height @param {unknown} rotation */
export function rotatedSourceDimensions(width, height, rotation) {
  const turnsSideways = normalizePhotoRotation(rotation) === 90 || normalizePhotoRotation(rotation) === 270;
  return turnsSideways ? {width: height, height: width} : {width, height};
}

/**
 * Map a crop expressed in clockwise-rotated image coordinates back to the
 * original source bitmap so preview and JPEG export sample identical pixels.
 * @param {CropRect} crop
 * @param {unknown} rotation
 */
export function sourceCropForRotation(crop, rotation) {
  const safe = clampCrop(crop);
  switch (normalizePhotoRotation(rotation)) {
    case 90:
      return {x: safe.y, y: 1 - safe.x - safe.width, width: safe.height, height: safe.width};
    case 180:
      return {x: 1 - safe.x - safe.width, y: 1 - safe.y - safe.height, width: safe.width, height: safe.height};
    case 270:
      return {x: 1 - safe.y - safe.height, y: safe.x, width: safe.height, height: safe.width};
    default:
      return safe;
  }
}

/** @param {number} value @param {number} [min] @param {number} [max] */
export function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

/** @param {NormalizedRect} rect */
export function normalizeRect(rect) {
  const x = clamp(Number(rect.x));
  const y = clamp(Number(rect.y));
  return {
    x,
    y,
    width: clamp(Number(rect.width), 0, 1 - x),
    height: clamp(Number(rect.height), 0, 1 - y),
  };
}

/** @param {NormalizedRect} rect */
export function rectArea(rect) {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

/** @param {NormalizedRect} left @param {NormalizedRect} right */
export function intersectionArea(left, right) {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
  return Math.max(0, width) * Math.max(0, height);
}

/**
 * Convert a normalized template rectangle to output pixels. Shared by preview
 * and export so rounding never leaves seams at the outer canvas edge.
 * @param {NormalizedRect} rect
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 */
export function rectToPixels(rect, canvasWidth, canvasHeight) {
  const left = Math.round(rect.x * canvasWidth);
  const top = Math.round(rect.y * canvasHeight);
  const right = Math.round((rect.x + rect.width) * canvasWidth);
  const bottom = Math.round((rect.y + rect.height) * canvasHeight);
  return {x: left, y: top, width: right - left, height: bottom - top};
}

/** @param {number} sourceWidth @param {number} sourceHeight @param {number} targetAspect */
export function centeredCrop(sourceWidth, sourceHeight, targetAspect) {
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetAspect <= 0) {
    throw new RangeError('Source dimensions and target aspect must be positive');
  }
  const sourceAspect = sourceWidth / sourceHeight;
  if (sourceAspect > targetAspect) {
    const width = targetAspect / sourceAspect;
    return {x: (1 - width) / 2, y: 0, width, height: 1};
  }
  const height = sourceAspect / targetAspect;
  return {x: 0, y: (1 - height) / 2, width: 1, height};
}

/** @param {CropRect} crop */
export function clampCrop(crop) {
  const width = clamp(Number(crop.width), GEOMETRY_EPSILON, 1);
  const height = clamp(Number(crop.height), GEOMETRY_EPSILON, 1);
  return {
    x: clamp(Number(crop.x), 0, 1 - width),
    y: clamp(Number(crop.y), 0, 1 - height),
    width,
    height,
  };
}

/**
 * Refit a crop around its existing centre for a new cell aspect.
 * @param {CropRect} crop
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @param {number} targetAspect
 */
export function refitCropAroundCenter(crop, sourceWidth, sourceHeight, targetAspect) {
  const safe = clampCrop(crop);
  const centerX = safe.x + safe.width / 2;
  const centerY = safe.y + safe.height / 2;
  const sourceAspect = sourceWidth / sourceHeight;
  let width = safe.width;
  let height = safe.height;
  if (sourceAspect * width / height > targetAspect) {
    width = height * targetAspect / sourceAspect;
  } else {
    height = width * sourceAspect / targetAspect;
  }
  width = Math.min(width, 1);
  height = Math.min(height, 1);
  return clampCrop({x: centerX - width / 2, y: centerY - height / 2, width, height});
}

/**
 * Effective source pixels available for each output inch.
 * @param {CropRect} crop
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @param {number} outputWidthPx
 * @param {number} outputHeightPx
 * @param {number} outputPpi
 */
export function effectiveCropPpi(crop, sourceWidth, sourceHeight, outputWidthPx, outputHeightPx, outputPpi) {
  if (outputWidthPx <= 0 || outputHeightPx <= 0 || outputPpi <= 0) return 0;
  const safe = clampCrop(crop);
  const widthPpi = sourceWidth * safe.width / (outputWidthPx / outputPpi);
  const heightPpi = sourceHeight * safe.height / (outputHeightPx / outputPpi);
  return Math.floor(Math.min(widthPpi, heightPpi));
}

/**
 * Percentage by which a free crop must stretch on its most distorted axis.
 * Zero means the crop and destination have the same aspect.
 * @param {CropRect} crop
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @param {number} targetAspect
 */
export function cropDistortionPercent(crop, sourceWidth, sourceHeight, targetAspect) {
  const safe = clampCrop(crop);
  const cropAspect = sourceWidth * safe.width / (sourceHeight * safe.height);
  const scaleRatio = Math.max(cropAspect / targetAspect, targetAspect / cropAspect);
  return Math.max(0, (scaleRatio - 1) * 100);
}
