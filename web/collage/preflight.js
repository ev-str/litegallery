// @ts-check

import {normalizeCrop} from './crop-controller.js';
import {rotatedSourceDimensions} from './geometry.js';

/** @typedef {{width: number, height: number, available?: boolean}} ImageInfo */
/** @typedef {{id: string, severity: 'error'|'warning', kind: string, cellId: string, sourceId: string, message: string, ignored: boolean, canIgnore: true, action: {kind: string, label: string}, value?: number}} PreflightIssue */

/**
 * @param {import('./render-plan.js').RenderProject} project
 * @param {import('./render-plan.js').PrintSettings} print
 * @param {Map<string, ImageInfo>|Record<string, ImageInfo>} imageInfo
 * @param {Iterable<string>} [ignoredIssueIds]
 * @returns {{issues: PreflightIssue[], blocking: PreflightIssue[], ignored: PreflightIssue[], ignoredIds: string[], weakestPpi: number|null}}
 */
export function runPreflight(project, print, imageInfo, ignoredIssueIds = []) {
  const ignored = new Set(ignoredIssueIds);
  const bySource = imageInfo instanceof Map ? imageInfo : new Map(Object.entries(imageInfo));
  const cells = new Map(project.layout.cells.map(cell => [cell.id, cell]));
  /** @type {PreflightIssue[]} */
  const issues = [];
  let weakestPpi = Infinity;
  for (const placement of project.placements) {
    const cell = cells.get(placement.cellId);
    if (!cell) continue;
    const info = bySource.get(placement.sourceId);
    if (!info || info.available === false || !(info.width > 0) || !(info.height > 0)) {
      issues.push(issue('missing', placement, 'error', 'Исходный файл недоступен', ignored));
      continue;
    }
    const crop = normalizeCrop(placement.crop);
    const dimensions = rotatedSourceDimensions(info.width, info.height, placement.rotation);
    const physicalWidthInches = print.widthMm * cell.width / 25.4;
    const physicalHeightInches = print.heightMm * cell.height / 25.4;
    const ppi = Math.min(dimensions.width * crop.width / physicalWidthInches, dimensions.height * crop.height / physicalHeightInches);
    weakestPpi = Math.min(weakestPpi, ppi);
    if (ppi < 300) {
      issues.push(issue('low-ppi', placement, ppi < 200 ? 'error' : 'warning', `Качество кадра ${Math.round(ppi)} PPI`, ignored, ppi));
    }
    const sourceAspect = dimensions.width * crop.width / (dimensions.height * crop.height);
    const targetAspect = physicalWidthInches / physicalHeightInches;
    const distortion = Math.abs(sourceAspect / targetAspect - 1) * 100;
    if (distortion > 1) {
      issues.push(issue('distortion', placement, distortion > 5 ? 'error' : 'warning', `Искажение пропорций ${distortion.toFixed(1)}%`, ignored, distortion));
    }
  }
  return {
    issues,
    blocking: issues.filter(item => item.severity === 'error' && !item.ignored),
    ignored: issues.filter(item => item.ignored),
    ignoredIds: [...ignored],
    weakestPpi: Number.isFinite(weakestPpi) ? weakestPpi : null,
  };
}

/**
 * @param {string} kind @param {{cellId: string, sourceId: string}} placement
 * @param {'error'|'warning'} severity @param {string} message @param {Set<string>} ignored
 * @param {number} [value]
 * @returns {PreflightIssue}
 */
function issue(kind, placement, severity, message, ignored, value) {
  const id = `${kind}:${placement.cellId}:${placement.sourceId}`;
  const action = kind === 'missing'
    ? {kind: 'locate-source', label: 'Найти файл заново'}
    : {kind: 'edit-crop', label: 'Открыть кроп'};
  return {id, kind, cellId: placement.cellId, sourceId: placement.sourceId, severity, message, ignored: ignored.has(id), canIgnore: true, action, value};
}

/** @param {Iterable<string>} current @param {string} issueId @param {boolean} shouldIgnore */
export function setIssueIgnored(current, issueId, shouldIgnore) {
  const next = new Set(current);
  if (shouldIgnore) next.add(issueId);
  else next.delete(issueId);
  return [...next];
}
