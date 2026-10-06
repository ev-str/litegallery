// @ts-check

import {buildRenderPlan} from './render-plan.js';
import {fetchImageBitmap, renderCanvas} from './canvas-renderer.js';
import {withJpegDensity} from './jpeg-metadata.js';

self.onmessage = async (event) => {
  if (event.data?.type !== 'export') return;
  try {
    const {project, print, quality, ignoredIssueIds = []} = event.data;
    const canonical = project && !Array.isArray(project.placements) && 'print' in project;
    const plan = canonical
      ? buildRenderPlan(project, {ignoredIssueIds})
      : buildRenderPlan(project, print, {ignoredIssueIds});
    const canvas = new OffscreenCanvas(plan.width, plan.height);
    const context = canvas.getContext('2d', {alpha: false});
    if (!context) throw new Error('OffscreenCanvas 2D is unavailable');
    await renderCanvas(context, plan, fetchImageBitmap, {
      onProgress(completed, total) {
        self.postMessage({type: 'progress', completed, total});
      },
    });
    const raw = await canvas.convertToBlob({type: 'image/jpeg', quality});
    const jpeg = await withJpegDensity(raw, print.ppi);
    const buffer = await jpeg.arrayBuffer();
    self.postMessage({type: 'done', buffer}, [buffer]);
  } catch (error) {
    self.postMessage({type: 'error', message: error instanceof Error ? error.message : String(error)});
  }
};
