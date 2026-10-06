// @ts-check

import {normalizeCrop} from './crop-controller.js';
import {normalizeEdgeOptions} from './frames.js';
import {getPrintDimensions} from './formats.js';
import {getTemplate} from './templates.js';

/** @typedef {{widthMm: number, heightMm: number, ppi: number, bleedMm?: number}} PrintSettings */
/** @typedef {{id: string, x: number, y: number, width: number, height: number}} LayoutCell */
/** @typedef {{cellId: string, sourceId: string, sourceUrl?: string, crop?: import('./crop-controller.js').NormalizedCrop, rotation?: import('./types.js').PhotoRotation, frame?: object}} Placement */
/** @typedef {{layout: {id?: string, cells: LayoutCell[]}, placements: Placement[], background?: string, lines?: {width?: number, color?: string}, frame?: object}} RenderProject */
/** @typedef {{pixelWidth?: number, pixelHeight?: number, ignoredIssueIds?: Iterable<string>}} RenderTarget */

/** @param {number} mm @param {number} ppi */
export const mmToPixels = (mm, ppi) => Math.max(1, Math.round(mm / 25.4 * ppi));

/**
 * Resolve the divider/decorative-frame colour once for preview and export.
 * @param {import('./types.js').AppearanceSettings} appearance
 */
export function resolveFrameLineColor(appearance) {
  if (appearance.frame.mode === 'color') return appearance.frame.color;
  if (appearance.frame.mode === 'white') return '#FFFFFF';
  return appearance.backgroundColor;
}

/**
 * Build one immutable geometry plan used by both preview and full export.
 * Layout coordinates address the trim area; bleed extends the background only.
 * Canonical calls use `(ProjectState, target?)`. The legacy explicit render
 * shape remains accepted for callers that already provide physical settings.
 * @param {RenderProject|import('./types.js').ProjectState} project
 * @param {PrintSettings|RenderTarget} [printOrTarget]
 * @param {RenderTarget} [legacyTarget]
 */
export function buildRenderPlan(project, printOrTarget = {}, legacyTarget = {}) {
  const canonical = isCanonicalProject(project);
  const canonicalProject = /** @type {import('./types.js').ProjectState} */ (project);
  const adapted = canonical ? adaptCanonicalProject(canonicalProject) : /** @type {RenderProject} */ (project);
  const print = canonical ? canonicalPrint(canonicalProject) : /** @type {PrintSettings} */ (printOrTarget);
  const target = canonical ? /** @type {RenderTarget} */ (printOrTarget) : legacyTarget;
  if (!(print.widthMm > 0) || !(print.heightMm > 0) || !(print.ppi > 0)) {
    throw new TypeError('invalid print settings');
  }
  const bleedMm = Math.max(0, print.bleedMm ?? 0);
  const naturalWidth = mmToPixels(print.widthMm + bleedMm * 2, print.ppi);
  const naturalHeight = mmToPixels(print.heightMm + bleedMm * 2, print.ppi);
  const width = Math.max(1, Math.round(target.pixelWidth ?? naturalWidth));
  const height = Math.max(1, Math.round(target.pixelHeight ?? naturalHeight));
  const nominalBleedX = width * bleedMm / (print.widthMm + bleedMm * 2);
  const nominalBleedY = height * bleedMm / (print.heightMm + bleedMm * 2);
  const availableTrimWidth = width - nominalBleedX * 2;
  const availableTrimHeight = height - nominalBleedY * 2;
  const physicalAspect = print.widthMm / print.heightMm;
  const trimWidth = Math.min(availableTrimWidth, availableTrimHeight * physicalAspect);
  const trimHeight = trimWidth / physicalAspect;
  const trim = {
    x: (width - trimWidth) / 2,
    y: (height - trimHeight) / 2,
    width: trimWidth,
    height: trimHeight,
  };
  const ignored = new Set(target.ignoredIssueIds ?? []);
  const placements = new Map(adapted.placements.map(item => [item.cellId, item]));
  const cells = adapted.layout.cells.map(cell => {
    assertNormalizedCell(cell);
    const placement = placements.get(cell.id);
    const unavailableIsIgnored = placement && ignored.has(`missing:${cell.id}:${placement.sourceId}`);
    const rect = Object.freeze({
      x: trim.x + trim.width * cell.x,
      y: trim.y + trim.height * cell.y,
      width: trim.width * cell.width,
      height: trim.height * cell.height,
    });
    const artworkRect = Object.freeze({
      x: cell.x <= 0.000001 ? 0 : rect.x,
      y: cell.y <= 0.000001 ? 0 : rect.y,
      width: (cell.x + cell.width >= 0.999999 ? width : rect.x + rect.width) - (cell.x <= 0.000001 ? 0 : rect.x),
      height: (cell.y + cell.height >= 0.999999 ? height : rect.y + rect.height) - (cell.y <= 0.000001 ? 0 : rect.y),
    });
    return Object.freeze({
      id: cell.id,
      rect,
      artworkRect,
      sourceId: unavailableIsIgnored ? null : placement?.sourceId ?? null,
      sourceUrl: unavailableIsIgnored ? null : placement?.sourceUrl ?? null,
      crop: Object.freeze(normalizeCrop(placement?.crop)),
      rotation: placement?.rotation ?? 0,
      frame: Object.freeze(normalizeEdgeOptions(placement?.frame ?? adapted.frame)),
    });
  });
  return Object.freeze({
    width,
    height,
    naturalWidth,
    naturalHeight,
    print: Object.freeze({...print, bleedMm}),
    trim: Object.freeze(trim),
    background: adapted.background || '#ffffff',
    lines: Object.freeze({width: Math.max(0, adapted.lines?.width ?? 0), color: adapted.lines?.color || '#ffffff'}),
    cells: Object.freeze(cells),
  });
}

/** @param {RenderProject|import('./types.js').ProjectState} project */
function isCanonicalProject(project) {
  return Boolean(project && !Array.isArray(project.placements) && 'print' in project && 'sources' in project && 'appearance' in project);
}

/** @param {import('./types.js').ProjectState} project @returns {PrintSettings} */
function canonicalPrint(project) {
  const dimensions = getPrintDimensions(project.print.formatId, project.print.orientation, project.print.ppi, project.print.bleedMm);
  return {
    widthMm: dimensions.trimWidthMm,
    heightMm: dimensions.trimHeightMm,
    ppi: project.print.ppi,
    bleedMm: project.print.bleedMm,
  };
}

/** @param {import('./types.js').ProjectState} project @returns {RenderProject} */
function adaptCanonicalProject(project) {
  const template = getTemplate(project.layout.templateId);
  const dimensions = getPrintDimensions(project.print.formatId, project.print.orientation, project.print.ppi, project.print.bleedMm);
  const outputWidthPx = dimensions.widthPx;
  const gapPixels = project.appearance.gapMm / dimensions.outputWidthMm * outputWidthPx;
  const frame = project.appearance.frame;
  const edge = {
    preset: frame.edgeStyle,
    depth: frame.depth * 0.18,
    frequency: 2 + Math.round(frame.frequency * 46),
    radius: frame.depth * 0.5,
  };
  /** @type {Placement[]} */
  const placements = [];
  project.layout.order.forEach((placementId, index) => {
    if (!placementId) return;
    const placement = project.placements[placementId];
    const source = placement && project.sources[placement.sourceId];
    const cell = template.cells[index];
    if (!placement || !source || !cell) return;
    placements.push({
      cellId: cell.id,
      sourceId: source.id,
      sourceUrl: sourceUrl(source),
      crop: placement.crop,
      rotation: placement.rotation ?? 0,
      frame: edge,
    });
  });
  return {
    layout: {id: template.id, cells: template.cells.map(cell => ({id: cell.id, ...cell.rect}))},
    placements,
    background: project.appearance.backgroundColor,
    lines: {
      width: gapPixels,
      color: resolveFrameLineColor(project.appearance),
    },
    frame: edge,
  };
}

/**
 * Runtime ZIP imports attach an object URL to the canonical source record.
 * Persisted or otherwise untrusted schemes are ignored; the read-only gallery
 * endpoint remains the deterministic fallback.
 * @param {import('./types.js').PhotoSource & {sourceUrl?: unknown}} source
 */
export function sourceUrl(source) {
  if (typeof source.sourceUrl === 'string') {
    const candidate = source.sourceUrl.trim();
    if (candidate.startsWith('blob:') || candidate.startsWith('/') && !candidate.startsWith('//')) return candidate;
  }
  return `/api/media?path=${encodeURIComponent(source.path)}`;
}

/** @param {LayoutCell} cell */
function assertNormalizedCell(cell) {
  const values = [cell.x, cell.y, cell.width, cell.height];
  if (!cell.id || values.some(value => !Number.isFinite(value)) || cell.width <= 0 || cell.height <= 0 ||
      cell.x < 0 || cell.y < 0 || cell.x + cell.width > 1.000001 || cell.y + cell.height > 1.000001) {
    throw new TypeError(`invalid layout cell: ${cell.id || '<unnamed>'}`);
  }
}
