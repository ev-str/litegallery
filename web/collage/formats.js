// @ts-check

/** @typedef {import('./types.js').PrintOrientation} PrintOrientation */

export const DEFAULT_PRINT_PPI = 300;
export const OPTIONAL_BLEED_MM = 2;

/** @type {Array<{id: string, label: string, widthMm: number, heightMm: number}>} */
const FORMAT_LIST = [
  {id: '10x15', label: '10 × 15 см', widthMm: 100, heightMm: 150},
  {id: '13x18', label: '13 × 18 см', widthMm: 130, heightMm: 180},
  {id: '15x20', label: '15 × 20 см', widthMm: 150, heightMm: 200},
  {id: '20x30', label: '20 × 30 см', widthMm: 200, heightMm: 300},
  {id: '30x45', label: '30 × 45 см', widthMm: 300, heightMm: 450},
  {id: 'a4', label: 'A4 · 21 × 29,7 см', widthMm: 210, heightMm: 297},
];

/** @type {ReadonlyArray<Readonly<{id: string, label: string, widthMm: number, heightMm: number}>>} */
export const PRINT_FORMATS = Object.freeze(FORMAT_LIST.map(format => Object.freeze(format)));

/** @param {string} formatId */
export function getPrintFormat(formatId) {
  const format = PRINT_FORMATS.find(item => item.id === formatId);
  if (!format) throw new RangeError(`Unknown print format: ${formatId}`);
  return format;
}

/** @param {number} millimetres @param {number} ppi */
export function mmToPixels(millimetres, ppi) {
  if (millimetres < 0 || ppi <= 0) throw new RangeError('Millimetres must be non-negative and PPI must be positive');
  return Math.round(millimetres / 25.4 * ppi);
}

/**
 * `bleedMm` is per side: a 2 mm bleed adds 4 mm to each output dimension.
 * @param {string} formatId
 * @param {PrintOrientation} orientation
 * @param {number} ppi
 * @param {number} [bleedMm]
 */
export function getPrintDimensions(formatId, orientation, ppi, bleedMm = 0) {
  const format = getPrintFormat(formatId);
  if (orientation !== 'portrait' && orientation !== 'landscape') throw new RangeError(`Unknown orientation: ${orientation}`);
  if (bleedMm < 0) throw new RangeError('Bleed cannot be negative');
  const trimWidthMm = orientation === 'portrait' ? format.widthMm : format.heightMm;
  const trimHeightMm = orientation === 'portrait' ? format.heightMm : format.widthMm;
  const outputWidthMm = trimWidthMm + bleedMm * 2;
  const outputHeightMm = trimHeightMm + bleedMm * 2;
  return {
    trimWidthMm,
    trimHeightMm,
    outputWidthMm,
    outputHeightMm,
    widthPx: mmToPixels(outputWidthMm, ppi),
    heightPx: mmToPixels(outputHeightMm, ppi),
    trimOffsetPx: mmToPixels(bleedMm, ppi),
    ppi,
    bleedMm,
  };
}

/** @param {number} widthPx @param {number} heightPx */
export function estimateRgbaBytes(widthPx, heightPx) {
  return Math.ceil(widthPx) * Math.ceil(heightPx) * 4;
}

/** @param {number} bytes */
export function formatMegabytes(bytes) {
  return bytes / (1024 * 1024);
}
