// @ts-check

import {DEFAULT_PRINT_PPI, getPrintDimensions} from './formats.js';
import {defaultProjectTitle, MAX_PROJECT_TITLE_LENGTH} from './filenames.js';
import {centeredCrop, clampCrop, isPhotoRotation, normalizePhotoRotation, rotatedSourceDimensions} from './geometry.js';
import {DEFAULT_BACKGROUND, normalizeHexColor} from './palette.js';
import {getDefaultTemplate, getTemplate} from './templates.js';
import {PROJECT_FORMAT_VERSION} from './types.js';

/** @typedef {import('./types.js').CropMode} CropMode */
/** @typedef {import('./types.js').CropRect} CropRect */
/** @typedef {import('./types.js').PhotoPlacement} PhotoPlacement */
/** @typedef {import('./types.js').PhotoSource} PhotoSource */
/** @typedef {import('./types.js').ProjectState} ProjectState */

/**
 * Stable source identity. Placement identity is intentionally separate, so a
 * source can be used more than once in one collage.
 * @param {string} path
 */
export function sourceIdFromPath(path) {
  const normalized = String(path).trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) throw new TypeError('Source path must be library-relative');
  return `source:${encodeURIComponent(normalized)}`;
}

/** @param {string} path */
function fileName(path) {
  return path.split('/').filter(Boolean).at(-1) || path;
}

/** @param {string} path */
function folderName(path) {
  return path.split('/').slice(0, -1).join('/');
}

/**
 * @param {{path: string, name?: string, size?: number, modTime?: string, width: number, height: number, mimeType?: string}} input
 * @returns {PhotoSource}
 */
export function createPhotoSource(input) {
  const path = String(input.path).trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!path || input.width <= 0 || input.height <= 0) throw new TypeError('Photo source requires a path and positive dimensions');
  return {
    id: sourceIdFromPath(path),
    path,
    name: input.name || fileName(path),
    folderPath: folderName(path),
    size: Math.max(0, Number(input.size) || 0),
    modTime: input.modTime || '',
    width: Math.round(input.width),
    height: Math.round(input.height),
    ...(input.mimeType ? {mimeType: input.mimeType} : {}),
  };
}

/**
 * UI action creators should allocate IDs before dispatch so the reducer stays
 * deterministic. Callers may pass an ID in tests/import flows.
 * @param {string=} preferredId
 */
export function createPlacementId(preferredId) {
  if (preferredId) return preferredId;
  if (globalThis.crypto?.randomUUID) return `placement:${globalThis.crypto.randomUUID()}`;
  return `placement:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * @param {PhotoSource} source
 * @param {number} targetAspect
 * @param {{id?: string, crop?: CropRect, cropMode?: CropMode, rotation?: import('./types.js').PhotoRotation}=} options
 * @returns {PhotoPlacement}
 */
export function createPlacement(source, targetAspect, options = {}) {
  if (targetAspect <= 0) throw new RangeError('Target aspect must be positive');
  const rotation = normalizePhotoRotation(options.rotation);
  const dimensions = rotatedSourceDimensions(source.width, source.height, rotation);
  return {
    id: createPlacementId(options.id),
    sourceId: source.id,
    crop: options.crop ? clampCrop(options.crop) : centeredCrop(dimensions.width, dimensions.height, targetAspect),
    cropMode: options.cropMode || 'proportional',
    rotation,
  };
}

/** @param {{appVersion?: string, photoCount?: number, title?: string}=} options @returns {ProjectState} */
export function createProject(options = {}) {
  const template = getDefaultTemplate(options.photoCount || 2);
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    appVersion: options.appVersion || 'dev',
    title: options.title ?? defaultProjectTitle(),
    print: {formatId: '13x18', orientation: 'portrait', ppi: DEFAULT_PRINT_PPI, bleedMm: 0},
    sources: {},
    placements: {},
    layout: {templateId: template.id, order: template.cells.map(() => null)},
    appearance: {
      backgroundColor: DEFAULT_BACKGROUND,
      gapMm: 2,
      frame: {mode: 'none', color: '#FFFFFF', edgeStyle: 'straight', depth: .25, frequency: .5},
    },
  };
}

/** @param {ProjectState} project */
export function getCanvasAspect(project) {
  const dimensions = getPrintDimensions(project.print.formatId, project.print.orientation, project.print.ppi, project.print.bleedMm);
  return dimensions.outputWidthMm / dimensions.outputHeightMm;
}

/** @param {ProjectState} project @param {number} cellIndex */
export function getCellAspect(project, cellIndex) {
  const template = getTemplate(project.layout.templateId);
  const cell = template.cells[cellIndex];
  if (!cell) throw new RangeError(`Unknown cell index: ${cellIndex}`);
  return getCanvasAspect(project) * cell.rect.width / cell.rect.height;
}

/** @param {ProjectState} project */
export function getOrderedPlacements(project) {
  return project.layout.order.map(id => id ? project.placements[id] || null : null);
}

/**
 * Validate external project data without mutating or migrating it.
 * @param {unknown} value
 */
export function validateProject(value) {
  /** @type {string[]} */
  const errors = [];
  if (!value || typeof value !== 'object') return {valid: false, errors: ['Project must be an object']};
  const project = /** @type {Record<string, any>} */ (value);
  if (project.formatVersion !== PROJECT_FORMAT_VERSION) errors.push(`Unsupported formatVersion: ${project.formatVersion}`);
  if (typeof project.appVersion !== 'string') errors.push('appVersion must be a string');
  if (project.title !== undefined && (typeof project.title !== 'string' || project.title.length > MAX_PROJECT_TITLE_LENGTH || /[\u0000-\u001f\u007f]/.test(project.title))) errors.push('title must be a short plain string');
  try {
    getPrintDimensions(project.print?.formatId, project.print?.orientation, project.print?.ppi, project.print?.bleedMm);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Invalid print settings');
  }
  let template;
  try {
    template = getTemplate(project.layout?.templateId);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Invalid template');
  }
  if (!Array.isArray(project.layout?.order) || template && project.layout.order.length !== template.cells.length) errors.push('Layout order must match template cells');
  if (!project.sources || typeof project.sources !== 'object' || Array.isArray(project.sources)) errors.push('sources must be an object');
  if (!project.placements || typeof project.placements !== 'object' || Array.isArray(project.placements)) errors.push('placements must be an object');
  if (project.sources && project.placements) {
    for (const [id, placement] of Object.entries(project.placements)) {
      if (!placement || placement.id !== id || !project.sources[placement.sourceId]) errors.push(`Invalid placement: ${id}`);
      try { clampCrop(placement?.crop); } catch { errors.push(`Invalid crop: ${id}`); }
      if (!['proportional', 'free'].includes(placement?.cropMode)) errors.push(`Invalid crop mode: ${id}`);
      if (placement?.rotation !== undefined && !isPhotoRotation(placement.rotation)) errors.push(`Invalid photo rotation: ${id}`);
    }
  }
  if (Array.isArray(project.layout?.order)) {
    const used = new Set();
    for (const id of project.layout.order) {
      if (id === null) continue;
      if (typeof id !== 'string' || !project.placements?.[id]) errors.push(`Unknown placement in layout: ${id}`);
      if (used.has(id)) errors.push(`Placement appears twice in layout: ${id}`);
      used.add(id);
    }
  }
  try { normalizeHexColor(project.appearance?.backgroundColor); } catch { errors.push('Invalid background colour'); }
  try { normalizeHexColor(project.appearance?.frame?.color); } catch { errors.push('Invalid frame colour'); }
  return {valid: errors.length === 0, errors};
}

/** @param {unknown} value @returns {asserts value is ProjectState} */
export function assertProject(value) {
  const validation = validateProject(value);
  if (!validation.valid) throw new TypeError(`Invalid collage project: ${validation.errors.join('; ')}`);
}
