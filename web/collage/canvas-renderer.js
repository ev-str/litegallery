// @ts-check

import {paperFrameGeometry, perforatedFrameGeometry, traceFramePath} from './frames.js';
import {normalizePhotoRotation, sourceCropForRotation} from './geometry.js';

/** @typedef {ReturnType<import('./render-plan.js').buildRenderPlan>} RenderPlan */
/** @typedef {{width: number, height: number, close?: () => void}} BitmapLike */
/** @typedef {(source: {id: string, url: string}) => Promise<CanvasImageSource & BitmapLike>} ImageLoader */

/**
 * Draw sequentially so a full-resolution export owns at most one ImageBitmap.
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {RenderPlan} plan
 * @param {ImageLoader} loadImage
 * @param {{signal?: AbortSignal, onProgress?: (completed: number, total: number) => void}} [options]
 */
export async function renderCanvas(ctx, plan, loadImage, options = {}) {
  ctx.save();
  ctx.fillStyle = plan.background;
  ctx.fillRect(0, 0, plan.width, plan.height);
  ctx.restore();
  let completed = 0;
  const populated = plan.cells.filter(cell => cell.sourceId && cell.sourceUrl);
  for (const cell of populated) {
    if (options.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    const bitmap = await loadImage({id: /** @type {string} */ (cell.sourceId), url: /** @type {string} */ (cell.sourceUrl)});
    try {
      drawCell(ctx, bitmap, cell, plan.lines.color);
    } finally {
      bitmap.close?.();
    }
    options.onProgress?.(++completed, populated.length);
  }
  if (plan.lines.width > 0) {
    ctx.save();
    ctx.strokeStyle = plan.lines.color;
    ctx.lineWidth = plan.lines.width;
    for (const cell of plan.cells) {
      ctx.beginPath();
      traceFramePath(ctx, cell.rect, cell.frame);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/**
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {CanvasImageSource & BitmapLike} bitmap
 * @param {RenderPlan['cells'][number]} cell
 * @param {string} decorationColor
 */
function drawCell(ctx, bitmap, cell, decorationColor) {
  const sourceCrop = sourceCropForRotation(cell.crop, cell.rotation);
  const sx = Math.round(sourceCrop.x * bitmap.width);
  const sy = Math.round(sourceCrop.y * bitmap.height);
  const sw = Math.max(1, Math.round(sourceCrop.width * bitmap.width));
  const sh = Math.max(1, Math.round(sourceCrop.height * bitmap.height));
  ctx.save();
  const paper = paperFrameGeometry(cell.rect, cell.frame);
  const drawRect = paper?.imageRect ?? cell.artworkRect ?? cell.rect;
  if (paper) {
    ctx.fillStyle = paper.paperColor;
    ctx.fillRect(cell.rect.x, cell.rect.y, cell.rect.width, cell.rect.height);
  }
  ctx.beginPath();
  traceFramePath(ctx, drawRect, paper ? {preset: 'straight'} : cell.frame);
  ctx.clip();
  drawRotatedImage(ctx, bitmap, {sx, sy, sw, sh}, drawRect, cell.rotation);
  ctx.restore();
  drawPerforatedFrame(ctx, cell.rect, cell.frame, decorationColor);
}

/**
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {CanvasImageSource & BitmapLike} bitmap
 * @param {{sx: number, sy: number, sw: number, sh: number}} source
 * @param {{x: number, y: number, width: number, height: number}} destination
 * @param {unknown} rotation
 */
function drawRotatedImage(ctx, bitmap, source, destination, rotation) {
  const degrees = normalizePhotoRotation(rotation);
  if (degrees === 0) {
    ctx.drawImage(bitmap, source.sx, source.sy, source.sw, source.sh, destination.x, destination.y, destination.width, destination.height);
    return;
  }
  ctx.save();
  ctx.translate(destination.x + destination.width / 2, destination.y + destination.height / 2);
  ctx.rotate(degrees * Math.PI / 180);
  const sideways = degrees === 90 || degrees === 270;
  const width = sideways ? destination.height : destination.width;
  const height = sideways ? destination.width : destination.height;
  ctx.drawImage(bitmap, source.sx, source.sy, source.sw, source.sh, -width / 2, -height / 2, width, height);
  ctx.restore();
}

/**
 * Paint the decorative band after the photograph. The inner rectangle and
 * round subpaths are holes in one even-odd fill, so the photograph remains
 * visible through both and preview/export share exactly the same rendering.
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {RenderPlan['cells'][number]['rect']} rect
 * @param {RenderPlan['cells'][number]['frame']} frame
 * @param {string} color
 */
function drawPerforatedFrame(ctx, rect, frame, color) {
  const geometry = perforatedFrameGeometry(rect, frame);
  if (!geometry) return;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.rect(geometry.outerRect.x, geometry.outerRect.y, geometry.outerRect.width, geometry.outerRect.height);
  ctx.rect(geometry.innerRect.x, geometry.innerRect.y, geometry.innerRect.width, geometry.innerRect.height);
  for (const hole of geometry.holes) {
    ctx.moveTo(hole.x + hole.radius, hole.y);
    ctx.arc(hole.x, hole.y, hole.radius, 0, Math.PI * 2);
  }
  ctx.fill('evenodd');
  ctx.restore();
}

/** @type {ImageLoader} */
export async function fetchImageBitmap(source) {
  const response = await fetch(source.url, {credentials: 'same-origin'});
  if (!response.ok) throw new Error(`cannot load image ${source.id}: HTTP ${response.status}`);
  const blob = await response.blob();
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  if (typeof Image !== 'function') throw new Error('no browser image decoder is available');
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}
