import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canPan, fitScale, initialView, MAX_SCALE, panBy, rotate, rotatedSize, scaleLimits, setMode, settle, toggleZoom, zoomAt,
} from '../../web/viewer-transform.js';

const stage = {width: 1200, height: 800};
const frameFor = (width, height, fit = stage) => ({image: {width, height}, fit, stage});
const portrait = frameFor(640, 900);
const landscape = frameFor(4000, 2000);
const tiny = frameFor(160, 120);

function displayed(view, frame) {
  const size = rotatedSize(frame.image, view.rotation);
  return {width: size.width * view.scale, height: size.height * view.scale};
}

test('Fit shows the whole portrait or landscape photo, touching the stage on one side', () => {
  for (const frame of [portrait, landscape, tiny]) {
    const view = settle(initialView(), frame);
    const size = displayed(view, frame);
    assert.ok(size.width <= stage.width + 1e-6 && size.height <= stage.height + 1e-6, 'no cropping');
    assert.ok(Math.abs(size.width - stage.width) < 1e-6 || Math.abs(size.height - stage.height) < 1e-6, 'fills one side');
    assert.deepEqual([view.x, view.y], [0, 0]);
    assert.equal(canPan(view, frame), false);
  }
  assert.equal(fitScale(portrait, 0), 800 / 900);
  assert.equal(fitScale(landscape, 0), 1200 / 4000);
});

test('Original is 1:1 and Fit is recomputed for the rotated orientation', () => {
  const original = setMode(initialView(), landscape, 'original');
  assert.equal(original.scale, 1);
  assert.ok(canPan(original, landscape));

  const turned = rotate(settle(initialView(), landscape), landscape, 1);
  assert.equal(turned.rotation, 90);
  assert.equal(turned.scale, 800 / 4000);
  const size = displayed(turned, landscape);
  assert.ok(size.width <= stage.width && size.height <= stage.height + 1e-6);
  assert.equal(rotate(turned, landscape, -2).rotation, 270);
  assert.equal(rotate(turned, landscape, 3).rotation, 0);
});

test('zoom stays in range and keeps the point under the cursor in place', () => {
  const fit = settle(initialView(), landscape);
  const limits = scaleLimits(landscape, 0);
  assert.equal(zoomAt(fit, landscape, 0.01).scale, limits.min);
  assert.equal(zoomAt(fit, landscape, 100).scale, MAX_SCALE);
  assert.equal(scaleLimits(tiny, 0).min, 1, 'small photos may shrink to 1:1');
  assert.ok(scaleLimits(tiny, 0).max >= fitScale(tiny, 0) * 2);

  const point = {x: 300, y: -100};
  const zoomed = zoomAt(fit, landscape, 1, point);
  assert.equal(zoomed.mode, 'original');
  // The photo pixel under the point before and after zooming is the same.
  const pixel = (view, p) => [(p.x - view.x) / view.scale, (p.y - view.y) / view.scale];
  assert.deepEqual(pixel(zoomed, point), pixel(fit, point));
  assert.equal(zoomAt(zoomed, landscape, fit.scale).mode, 'fit');
});

test('pan works only beyond Fit and never drags the photo off the stage', () => {
  const fit = settle(initialView(), portrait);
  assert.deepEqual(panBy(fit, portrait, 500, 500), fit);

  const original = setMode(fit, landscape, 'original');
  const far = panBy(original, landscape, 1e6, -1e6);
  assert.equal(far.x, (4000 - stage.width) / 2);
  assert.equal(far.y, -(2000 - stage.height) / 2);
  // The stage stays covered: the photo's left edge stops at the stage's left edge.
  assert.equal(stage.width / 2 + far.x - 4000 / 2, 0);
});

test('rotation carries the centred point with it and the offset stays in bounds', () => {
  const zoomed = panBy(setMode(initialView(), landscape, 'original'), landscape, 200, 100);
  const turned = rotate(zoomed, landscape, 1);
  assert.deepEqual([turned.x, turned.y], [-100, 200]);
  assert.equal(turned.mode, 'original');
  const back = rotate(turned, landscape, -1);
  assert.deepEqual([back.x, back.y], [200, 100]);
});

test('double-click toggles between Fit and a larger zoom at the point', () => {
  const fit = settle(initialView(), portrait);
  const zoomed = toggleZoom(fit, portrait, {x: 100, y: 50});
  assert.equal(zoomed.mode, 'zoom');
  assert.equal(zoomed.scale, fitScale(portrait, 0) * 2);
  assert.deepEqual(toggleZoom(zoomed, portrait), fit);
  assert.equal(toggleZoom(settle(initialView(), landscape), landscape).scale, 1, 'large photos open at 1:1');
});

test('an unknown photo size falls back to 1:1 instead of NaN', () => {
  const view = settle(initialView(), frameFor(0, 0));
  assert.equal(view.scale, 1);
  assert.deepEqual([view.x, view.y], [0, 0]);
});
