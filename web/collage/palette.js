// @ts-check

/** @type {Array<{id: string, label: string, color: string}>} */
const BACKGROUNDS = [
  {id: 'cream', label: 'Кремовый', color: '#F4E3D0'},
  {id: 'paper', label: 'Белый', color: '#FFFDF8'},
  {id: 'mist', label: 'Серо-голубой', color: '#DDE8E8'},
  {id: 'sand', label: 'Песочный', color: '#D8C6B5'},
  {id: 'coffee', label: 'Кофейный', color: '#5D493E'},
  {id: 'charcoal', label: 'Графитовый', color: '#202120'},
  {id: 'wheat', label: 'Пшеничный', color: '#E7D9A8'},
  {id: 'sage', label: 'Шалфейный', color: '#C9DCC5'},
  {id: 'cloud', label: 'Облачный', color: '#C7D3E3'},
  {id: 'rose', label: 'Пыльная роза', color: '#DAB9AF'},
  {id: 'slate', label: 'Серо-зелёный', color: '#8EA1A0'},
];

/** @type {ReadonlyArray<Readonly<{id: string, label: string, color: string}>>} */
export const BACKGROUND_PALETTE = Object.freeze(BACKGROUNDS.map(background => Object.freeze(background)));
export const DEFAULT_BACKGROUND = BACKGROUND_PALETTE[0].color;

/** @param {string} color */
export function normalizeHexColor(color) {
  const value = String(color).trim();
  const short = /^#([0-9a-f]{3})$/i.exec(value);
  if (short) return `#${[...short[1]].map(part => part + part).join('').toUpperCase()}`;
  const full = /^#([0-9a-f]{6})$/i.exec(value);
  if (!full) throw new TypeError(`Invalid colour: ${color}`);
  return `#${full[1].toUpperCase()}`;
}

/** @param {string} color */
function hexToHsl(color) {
  const hex = normalizeHexColor(color).slice(1);
  const red = parseInt(hex.slice(0, 2), 16) / 255;
  const green = parseInt(hex.slice(2, 4), 16) / 255;
  const blue = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return {h: 28, s: 0, l: lightness * 100};
  const delta = max - min;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue = max === red ? ((green - blue) / delta) % 6 : max === green ? (blue - red) / delta + 2 : (red - green) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  return {h: hue, s: saturation * 100, l: lightness * 100};
}

/** @param {number} hue @param {number} saturation @param {number} lightness */
function hslToHex(hue, saturation, lightness) {
  const s = clampPercent(saturation) / 100;
  const l = clampPercent(lightness) / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const h = ((hue % 360) + 360) % 360 / 60;
  const x = chroma * (1 - Math.abs(h % 2 - 1));
  const values = h < 1 ? [chroma, x, 0] : h < 2 ? [x, chroma, 0] : h < 3 ? [0, chroma, x] : h < 4 ? [0, x, chroma] : h < 5 ? [x, 0, chroma] : [chroma, 0, x];
  const match = l - chroma / 2;
  return `#${values.map(value => Math.round((value + match) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** @param {number} value */
function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}

/**
 * Produce a stable ring of harmonious frame colours around the selected
 * background. Neutral backgrounds receive enough chroma to remain useful.
 * @param {string} backgroundColor
 * @param {number} [count]
 */
export function createFramePalette(backgroundColor, count = 11) {
  const base = hexToHsl(backgroundColor);
  const offsets = [180, 150, 210, 30, -30, 120, 240, 60, -60, 0, 300];
  const saturation = Math.max(28, Math.min(58, base.s * .85 + 18));
  const lightness = base.l > 68 ? 40 : base.l < 34 ? 72 : base.l > 51 ? 34 : 76;
  const targetCount = Math.max(1, Math.floor(count));
  /** @type {string[]} */
  const colors = [];
  const seen = new Set();
  /** @param {number} offset */
  const append = (offset) => {
    const color = normalizeHexColor(hslToHex(base.h + offset, saturation, lightness));
    if (seen.has(color)) return;
    seen.add(color);
    colors.push(color);
  };
  for (const offset of offsets) {
    if (colors.length >= targetCount) break;
    append(offset);
  }
  // Rounded RGB values can coincide even for different HSL offsets. Continue
  // around the hue wheel with a non-repeating step until the requested palette
  // is filled (or every practical candidate has been exhausted).
  for (let index = 1; colors.length < targetCount && index <= 720; index += 1) {
    append(index * 137.50776405003785);
  }
  return Object.freeze(colors);
}
