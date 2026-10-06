// @ts-check

/** @typedef {'straight'|'rounded'|'zigzag'|'wave'|'lightning'|'deckle'|'stamp'|'perforated'|'old-photo'|'polaroid'} EdgePresetId */
/** @typedef {{id: EdgePresetId, supportsDepth: boolean, supportsFrequency: boolean}} EdgePreset */
/** @typedef {{preset?: EdgePresetId, depth?: number, frequency?: number, radius?: number}} EdgeOptions */
/** @typedef {{x: number, y: number, width: number, height: number}} Rect */
/** @typedef {{paperColor: string, imageRect: Rect}} PaperFrameGeometry */
/** @typedef {{outerRect: Rect, innerRect: Rect, holes: Array<{x: number, y: number, radius: number}>}} PerforatedFrameGeometry */

/** @type {ReadonlyArray<EdgePreset>} */
export const EDGE_PRESETS = Object.freeze([
  {id: 'straight', supportsDepth: false, supportsFrequency: false},
  {id: 'rounded', supportsDepth: true, supportsFrequency: false},
  {id: 'zigzag', supportsDepth: true, supportsFrequency: true},
  {id: 'wave', supportsDepth: true, supportsFrequency: true},
  {id: 'lightning', supportsDepth: true, supportsFrequency: true},
  {id: 'deckle', supportsDepth: true, supportsFrequency: true},
  {id: 'stamp', supportsDepth: true, supportsFrequency: true},
  {id: 'perforated', supportsDepth: true, supportsFrequency: true},
  {id: 'old-photo', supportsDepth: true, supportsFrequency: false},
  {id: 'polaroid', supportsDepth: true, supportsFrequency: false},
]);

/** @param {string|undefined} id */
export function getEdgePreset(id) {
  return EDGE_PRESETS.find(item => item.id === id) ?? EDGE_PRESETS[0];
}

/** @param {EdgeOptions|undefined} options */
export function normalizeEdgeOptions(options) {
  const preset = getEdgePreset(options?.preset);
  return {
    preset: preset.id,
    depth: preset.supportsDepth ? Math.max(0, Math.min(0.18, options?.depth ?? 0.035)) : 0,
    frequency: preset.supportsFrequency ? Math.max(2, Math.min(48, Math.round(options?.frequency ?? 12))) : 0,
    radius: preset.id === 'rounded' ? Math.max(0, Math.min(0.5, options?.radius ?? options?.depth ?? 0.08)) : 0,
  };
}

/**
 * Paper presets keep the complete photograph inside a rectangular backing.
 * Scaling the image rect instead of clipping its edges preserves its aspect
 * ratio; the polaroid is shifted upwards to leave the characteristic wider
 * white strip below the image.
 * @param {Rect} rect
 * @param {EdgeOptions} rawOptions
 * @returns {PaperFrameGeometry|null}
 */
export function paperFrameGeometry(rect, rawOptions = {}) {
  const options = normalizeEdgeOptions(rawOptions);
  if (options.preset !== 'old-photo' && options.preset !== 'polaroid') return null;
  const scale = Math.max(0.64, 1 - options.depth * 2);
  const width = rect.width * scale;
  const height = rect.height * scale;
  const remainingX = rect.width - width;
  const remainingY = rect.height - height;
  const topShare = options.preset === 'polaroid' ? 0.3 : 0.5;
  return {
    paperColor: options.preset === 'old-photo' ? '#EEE0CD' : '#FFFFFF',
    imageRect: {
      x: rect.x + remainingX / 2,
      y: rect.y + remainingY * topShare,
      width,
      height,
    },
  };
}

/**
 * Geometry for a solid rectangular band with small round holes inside it.
 * This is deliberately separate from traceFramePath: unlike the stamp preset,
 * perforation decorates the photograph without changing its clipping contour.
 * @param {Rect} rect
 * @param {EdgeOptions} rawOptions
 * @returns {PerforatedFrameGeometry|null}
 */
export function perforatedFrameGeometry(rect, rawOptions = {}) {
  const options = normalizeEdgeOptions(rawOptions);
  if (options.preset !== 'perforated') return null;
  const shortest = Math.min(rect.width, rect.height);
  const band = Math.min(shortest * .22, Math.max(shortest * .025, shortest * options.depth));
  const innerRect = {
    x: rect.x + band,
    y: rect.y + band,
    width: Math.max(0, rect.width - band * 2),
    height: Math.max(0, rect.height - band * 2),
  };
  const nominalStep = shortest / Math.max(3, options.frequency + 1);
  const horizontalCount = Math.max(2, Math.round(rect.width / nominalStep) - 1);
  const verticalCount = Math.max(2, Math.round(rect.height / nominalStep) - 1);
  const horizontalStep = rect.width / (horizontalCount + 1);
  const verticalStep = rect.height / (verticalCount + 1);
  const radius = Math.max(.5, Math.min(band * .24, horizontalStep * .2, verticalStep * .2));
  const inset = band / 2;
  /** @type {PerforatedFrameGeometry['holes']} */
  const holes = [];
  for (let index = 1; index <= horizontalCount; index++) {
    const x = rect.x + horizontalStep * index;
    holes.push({x, y: rect.y + inset, radius}, {x, y: rect.y + rect.height - inset, radius});
  }
  for (let index = 1; index <= verticalCount; index++) {
    const y = rect.y + verticalStep * index;
    holes.push({x: rect.x + inset, y, radius}, {x: rect.x + rect.width - inset, y, radius});
  }
  return {outerRect: {...rect}, innerRect, holes};
}

/**
 * Add a complete, closed cell contour to the current canvas path.
 * Depth is relative to the shorter side and always cuts inward, so adjacent
 * cells never paint outside their layout bounds.
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {Rect} rect
 * @param {EdgeOptions} [rawOptions]
 */
export function traceFramePath(ctx, rect, rawOptions = {}) {
  const options = normalizeEdgeOptions(rawOptions);
  const {x, y, width, height} = rect;
  if (options.preset === 'rounded') {
    const radius = Math.min(width, height) * options.radius;
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    return;
  }
  if (options.preset === 'straight') {
    ctx.rect(x, y, width, height);
    return;
  }
  if (options.preset === 'old-photo' || options.preset === 'polaroid') {
    ctx.rect(x, y, width, height);
    return;
  }
  if (options.preset === 'perforated') {
    ctx.rect(x, y, width, height);
    return;
  }
  const depth = Math.min(width, height) * options.depth;
  const frequency = options.frequency;
  const top = edgePoints(x, y, width, 0, depth, frequency, options.preset, 0);
  const right = edgePoints(x + width, y, height, 1, depth, frequency, options.preset, 1);
  const bottom = edgePoints(x + width, y + height, width, 2, depth, frequency, options.preset, 2);
  const left = edgePoints(x, y + height, height, 3, depth, frequency, options.preset, 3);
  const points = [...top, ...right, ...bottom, ...left];
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  ctx.closePath();
}

/**
 * @param {number} startX @param {number} startY @param {number} length
 * @param {0|1|2|3} side @param {number} depth @param {number} frequency
 * @param {EdgePresetId} preset @param {number} seed
 * @returns {Array<[number, number]>}
 */
function edgePoints(startX, startY, length, side, depth, frequency, preset, seed) {
  const samplesPerElement = preset === 'wave' || preset === 'stamp' ? 10 : 2;
  const samples = Math.max(2, frequency * samplesPerElement);
  /** @type {Array<[number, number]>} */
  const points = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    let amount = 0;
    if (preset === 'zigzag') amount = i % 2 ? depth : 0;
    else if (preset === 'wave') amount = depth * 0.5 * (1 - Math.cos(t * frequency * Math.PI * 2));
    else if (preset === 'stamp') {
      const phase = (t * frequency) % 1;
      amount = depth * Math.sqrt(Math.max(0, 1 - Math.pow(phase * 2 - 1, 2)));
    }
    else if (preset === 'lightning') {
      const tooth = i % 4;
      amount = tooth === 0 ? 0 : tooth === 1 ? depth : tooth === 2 ? depth * 0.35 : depth * 0.8;
    }
    else if (preset === 'deckle') amount = depth * (0.25 + 0.75 * noise(i * 3 + seed * 41));
    // Every side must meet both exact corners. Otherwise closePath() bridges
    // the missing endpoints with a long diagonal that cuts through the photo.
    if (i === 0 || i === samples) amount = 0;
    const along = t * length;
    if (side === 0) points.push([startX + along, startY + amount]);
    if (side === 1) points.push([startX - amount, startY + along]);
    if (side === 2) points.push([startX - along, startY - amount]);
    if (side === 3) points.push([startX + amount, startY - along]);
  }
  return points;
}

/** @param {number} value */
function noise(value) {
  const raw = Math.sin(value * 12.9898) * 43758.5453;
  return raw - Math.floor(raw);
}
