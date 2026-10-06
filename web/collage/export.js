// @ts-check

import {buildRenderPlan} from './render-plan.js';
import {fetchImageBitmap, renderCanvas} from './canvas-renderer.js';
import {getPrintDimensions} from './formats.js';
import {withJpegDensity} from './jpeg-metadata.js';
import {estimateExportBytes, exportMemoryBudget} from './limits.js';

/**
 * @param {import('./render-plan.js').RenderProject} project
 * @param {import('./render-plan.js').PrintSettings} print
 * @param {{quality?: number, signal?: AbortSignal, onProgress?: (completed: number, total: number) => void, preferWorker?: boolean, ignoredIssueIds?: Iterable<string>, maxMemoryBytes?: number, onPpiFallback?: (from: number, to: number) => void}} [options]
 */
export async function exportJpeg(project, print, options = {}) {
  if (options.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
  const quality = Math.max(0.1, Math.min(1, options.quality ?? 0.95));
  const prepared = prepareExportPlan(project, print, options);
  if (options.preferWorker !== false && typeof Worker === 'function' && typeof OffscreenCanvas === 'function') {
    try {
      return await exportWithWorker(/** @type {import('./render-plan.js').RenderProject} */ (prepared.project), prepared.print, quality, options);
    } catch (error) {
      if (options.signal?.aborted || error instanceof DOMException && error.name === 'AbortError') throw error;
      // Capability/runtime failures fall through to the documented main-thread path.
    }
  }
  return exportOnMainThread(prepared.plan, prepared.print.ppi, quality, options);
}

/** @param {ReturnType<import('./render-plan.js').buildRenderPlan>} plan @param {number} ppi @param {number} quality @param {any} options */
async function exportOnMainThread(plan, ppi, quality, options) {
  if (typeof document === 'undefined') throw new Error('main-thread canvas fallback is unavailable');
  const canvas = document.createElement('canvas');
  canvas.width = plan.width;
  canvas.height = plan.height;
  const context = canvas.getContext('2d', {alpha: false});
  if (!context) throw new Error('2D canvas is unavailable');
  await renderCanvas(context, plan, fetchImageBitmap, options);
  const jpeg = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('JPEG encoding failed')), 'image/jpeg', quality));
  return withJpegDensity(/** @type {Blob} */ (jpeg), ppi);
}

/** @param {import('./render-plan.js').RenderProject} project @param {import('./render-plan.js').PrintSettings} print @param {number} quality @param {any} options */
function exportWithWorker(project, print, quality, options) {
  if (options.signal?.aborted) return Promise.reject(new DOMException('Export cancelled', 'AbortError'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./export-worker.js', import.meta.url), {type: 'module'});
    const abort = () => {
      worker.terminate();
      reject(new DOMException('Export cancelled', 'AbortError'));
    };
    options.signal?.addEventListener('abort', abort, {once: true});
    worker.onmessage = (event) => {
      if (event.data.type === 'progress') options.onProgress?.(event.data.completed, event.data.total);
      if (event.data.type === 'done') {
        cleanup();
        resolve(new Blob([event.data.buffer], {type: 'image/jpeg'}));
      }
      if (event.data.type === 'error') {
        cleanup();
        reject(new Error(event.data.message));
      }
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || 'export worker failed'));
    };
    const cleanup = () => {
      options.signal?.removeEventListener('abort', abort);
      worker.terminate();
    };
    worker.postMessage({type: 'export', project, print, quality, ignoredIssueIds: [...(options.ignoredIssueIds ?? [])]});
  });
}

/** @param {{width: number, height: number}} plan */
export function estimateExportMemory(plan) {
  return estimateExportBytes(plan.width, plan.height);
}

/**
 * Produce the exact export contract before allocating a canvas. A high-PPI
 * request that exceeds the configured budget is retried at 300 PPI; if that
 * also does not fit, the caller receives an actionable memory error.
 * @param {import('./render-plan.js').RenderProject|import('./types.js').ProjectState} project
 * @param {import('./render-plan.js').PrintSettings} print
 * @param {{ignoredIssueIds?: Iterable<string>, maxMemoryBytes?: number, onPpiFallback?: (from: number, to: number) => void}} [options]
 */
export function prepareExportPlan(project, print, options = {}) {
  const canonical = Boolean(project && !Array.isArray(project.placements) && 'print' in project);
  const canonicalProject = /** @type {import('./types.js').ProjectState} */ (project);
  let exportProject = project;
  let exportPrint = canonical
    ? canonicalPhysicalPrint(canonicalProject)
    : print;
  let plan = canonical
    ? buildRenderPlan(/** @type {import('./types.js').ProjectState} */ (exportProject), {ignoredIssueIds: options.ignoredIssueIds})
    : buildRenderPlan(/** @type {import('./render-plan.js').RenderProject} */ (exportProject), exportPrint, {ignoredIssueIds: options.ignoredIssueIds});
  const limit = options.maxMemoryBytes ?? exportMemoryBudget();
  const requestedPpi = exportPrint.ppi;
  if (estimateExportMemory(plan) > limit && requestedPpi > 300) {
    if (canonical) {
      exportProject = {...canonicalProject, print: {...canonicalProject.print, ppi: 300}};
      exportPrint = canonicalPhysicalPrint(/** @type {import('./types.js').ProjectState} */ (exportProject));
      plan = buildRenderPlan(/** @type {import('./types.js').ProjectState} */ (exportProject), {ignoredIssueIds: options.ignoredIssueIds});
    } else {
      exportPrint = {...print, ppi: 300};
      plan = buildRenderPlan(/** @type {import('./render-plan.js').RenderProject} */ (exportProject), exportPrint, {ignoredIssueIds: options.ignoredIssueIds});
    }
    options.onPpiFallback?.(requestedPpi, 300);
  }
  if (estimateExportMemory(plan) > limit) {
    const error = new Error('Недостаточно памяти для экспорта; попробуйте 300 PPI на компьютере с большим объёмом памяти');
    error.name = 'ExportMemoryError';
    throw error;
  }
  return {project: exportProject, print: exportPrint, plan, requestedPpi, actualPpi: exportPrint.ppi, estimatedBytes: estimateExportMemory(plan)};
}

/** @param {import('./types.js').ProjectState} project */
function canonicalPhysicalPrint(project) {
  const dimensions = getPrintDimensions(project.print.formatId, project.print.orientation, project.print.ppi, project.print.bleedMm);
  return {
    widthMm: dimensions.trimWidthMm,
    heightMm: dimensions.trimHeightMm,
    ppi: project.print.ppi,
    bleedMm: project.print.bleedMm,
  };
}
