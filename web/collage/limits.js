// @ts-check

import {getPrintDimensions} from './formats.js';

/** One RGBA canvas backing store plus roughly one encoding/output buffer. */
export const EXPORT_BYTES_PER_PIXEL = 8;

/** Canvas area limit of iOS/iPadOS Safari; desktop browsers allow more. */
export const MAX_SAFE_CANVAS_PIXELS = 16_777_216;

/** Source photos above this size may exhaust browser memory on phones and tablets. */
export const LARGE_PHOTO_MEGAPIXELS = 40;

const MIN_EXPORT_BUDGET_BYTES = 128 * 1024 * 1024;
const MAX_EXPORT_BUDGET_BYTES = 512 * 1024 * 1024;
const BUDGET_BYTES_PER_DEVICE_GIB = 128 * 1024 * 1024;

/** @param {number} widthPx @param {number} heightPx */
export function estimateExportBytes(widthPx, heightPx) {
  return Math.ceil(widthPx) * Math.ceil(heightPx) * EXPORT_BYTES_PER_PIXEL;
}

/**
 * Memory budget for one JPEG export, shared by the PPI chooser and the export
 * itself so the UI never offers a PPI that the export would refuse.
 * @param {number} [deviceMemoryGiB] `navigator.deviceMemory`; unknown devices count as 4 GiB.
 */
export function exportMemoryBudget(deviceMemoryGiB = navigatorDeviceMemory()) {
  const gib = deviceMemoryGiB > 0 ? deviceMemoryGiB : 4;
  return Math.max(MIN_EXPORT_BUDGET_BYTES, Math.min(MAX_EXPORT_BUDGET_BYTES, gib * BUDGET_BYTES_PER_DEVICE_GIB));
}

/**
 * Highest PPI whose export estimate fits the budget for this format.
 * @param {string} formatId
 * @param {'portrait'|'landscape'} orientation
 * @param {number} bleedMm
 * @param {number} [budgetBytes]
 */
export function maxPpiForMemory(formatId, orientation, bleedMm, budgetBytes = exportMemoryBudget()) {
  const at300 = getPrintDimensions(formatId, orientation, 300, bleedMm);
  return 300 * Math.sqrt(budgetBytes / estimateExportBytes(at300.widthPx, at300.heightPx));
}

/** @param {number} widthPx @param {number} heightPx */
export function exceedsSafeCanvas(widthPx, heightPx) {
  return widthPx * heightPx > MAX_SAFE_CANVAS_PIXELS;
}

/** @param {number} width @param {number} height */
export function megapixels(width, height) {
  return width * height / 1_000_000;
}

/** @param {number} width @param {number} height */
export function isLargePhoto(width, height) {
  return megapixels(width, height) > LARGE_PHOTO_MEGAPIXELS;
}

function navigatorDeviceMemory() {
  if (typeof navigator === 'undefined') return 0;
  return Number(/** @type {Navigator & {deviceMemory?: number}} */ (navigator).deviceMemory) || 0;
}
