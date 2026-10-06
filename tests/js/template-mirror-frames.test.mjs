import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {renderCanvas} from '../../web/collage/canvas-renderer.js';
import {
  EDGE_PRESETS,
  getEdgePreset,
  normalizeEdgeOptions,
  paperFrameGeometry,
  perforatedFrameGeometry,
  traceFramePath,
} from '../../web/collage/frames.js';
import {centeredCrop, intersectionArea} from '../../web/collage/geometry.js';
import {createPhotoSource, createProject, getCellAspect} from '../../web/collage/model.js';
import {actions, createCollageStore} from '../../web/collage/store.js';
import {
  assertTemplatePartition,
  getCanonicalTemplateId,
  getMirroredTemplateId,
  getTemplate,
  getTemplateTransformState,
  getTemplatesForCount,
  getTransformedTemplateId,
  getVisibleTemplatesForCount,
  isTemplateAxisSymmetric,
  isTemplateMirrorable,
} from '../../web/collage/templates.js';

const EPSILON = 1e-9;
const round = value => Math.round(value * 1e9) / 1e9;
const rectKey = rect => [rect.x, rect.y, rect.width, rect.height].map(round).join(':');
const mirrorRect = rect => ({...rect, x: round(1 - rect.x - rect.width)});
const flipYRect = rect => ({...rect, y: round(1 - rect.y - rect.height)});
const transformRect = (rect, flipX = false, flipY = false) => {
  let transformed = rect;
  if (flipX) transformed = mirrorRect(transformed);
  if (flipY) transformed = flipYRect(transformed);
  return transformed;
};
const signature = (template, flipX = false, flipY = false) => template.cells
  .map(cell => rectKey(transformRect(cell.rect, flipX, flipY)))
  .sort()
  .join('|');

function assertExactPartition(template) {
  assert.doesNotThrow(() => assertTemplatePartition(template));
  const area = template.cells.reduce((sum, cell) => sum + cell.rect.width * cell.rect.height, 0);
  assert.ok(Math.abs(area - 1) <= EPSILON, `${template.id} leaves a gap`);
  for (let left = 0; left < template.cells.length; left += 1) {
    for (let right = left + 1; right < template.cells.length; right += 1) {
      assert.ok(
        intersectionArea(template.cells[left].rect, template.cells[right].rect) <= EPSILON,
        `${template.id} overlaps cells ${left + 1} and ${right + 1}`,
      );
    }
  }
}

test('staggered template catalogue contains every approved exact partition', () => {
  const expectedCounts = new Map([[4, 5], [5, 4], [6, 5], [7, 6], [8, 5]]);
  for (const [photoCount, expected] of expectedCounts) {
    const templates = getTemplatesForCount(photoCount).filter(template => template.family === 'staggered');
    assert.equal(templates.length, expected, `${photoCount} photos must expose ${expected} staggered definitions`);
    for (const template of templates) {
      assert.equal(template.photoCount, photoCount, template.id);
      assert.equal(template.cells.length, photoCount, template.id);
      assertExactPartition(template);
    }
  }
});

test('visible chooser removes duplicates under horizontal, vertical, and combined flips', () => {
  for (let photoCount = 2; photoCount <= 12; photoCount += 1) {
    const all = getTemplatesForCount(photoCount);
    const visible = getVisibleTemplatesForCount(photoCount);
    const visibleIds = new Set(visible.map(template => template.id));
    const canonicalSignatures = new Set();

    for (const template of visible) {
      const canonical = [
        signature(template),
        signature(template, true, false),
        signature(template, false, true),
        signature(template, true, true),
      ].sort()[0];
      assert.equal(canonicalSignatures.has(canonical), false, `${template.id} duplicates a visible transform`);
      canonicalSignatures.add(canonical);
    }

    for (const template of all) {
      const canonicalId = getCanonicalTemplateId(template.id);
      assert.equal(visibleIds.has(canonicalId), true, `${template.id} has no visible canonical`);
    }
  }
});

test('curated chooser keeps the approved compact catalogue for two, three, and four photos', () => {
  assert.deepEqual(getVisibleTemplatesForCount(2).map(template => template.id), [
    '2-columns', '2-rows', '2-wide-left', '2-wide-top',
  ]);
  assert.equal(getTemplatesForCount(2).some(template => template.id === '2-portrait-right'), false);
  assert.deepEqual(getVisibleTemplatesForCount(3).map(template => template.id), [
    '3-columns', '3-rows', '3-hero-left', '3-hero-top', '3-portrait-centre', '3-portrait-left',
  ]);
  assert.deepEqual(getVisibleTemplatesForCount(4).map(template => template.id), [
    '4-grid', '4-columns', '4-rows', '4-hero-left', '4-hero-top', '4-wide-left-grid',
    '4-magazine-corner', '4-staggered-1', '4-staggered-6', '4-staggered-11', '4-pinwheel', '4-portrait-left',
  ]);
  assert.deepEqual(
    getTemplatesForCount(4).filter(template => template.family === 'staggered').map(template => template.id),
    ['4-staggered-1', '4-staggered-2', '4-staggered-6', '4-staggered-11', '4-staggered-12'],
  );
  for (const removed of ['4-staggered-3', '4-staggered-4', '4-staggered-5', '4-staggered-7', '4-staggered-8', '4-staggered-9', '4-staggered-10']) {
    assert.equal(getVisibleTemplatesForCount(4).some(template => template.id === removed), false, removed);
  }
});

test('curated chooser keeps the approved compact catalogue for five through eight photos', () => {
  const expected = new Map([
    [5, [
      '5-rows-2-3', '5-columns-2-3', '5-columns-2-3-wide', '5-rows-2-3-wide',
      '5-hero-left', '5-hero-top', '5-sun', '5-magazine-bands', '5-magazine-lower-corner',
      '5-staggered-1', '5-staggered-2', '5-staggered-3', '5-staggered-4',
      '5-pinwheel', '5-portrait-left',
    ]],
    [6, [
      '6-grid-3x2', '6-grid-2x3', '6-columns-2-4', '6-columns-2-4-wide',
      '6-hero-left', '6-hero-top', '6-sun', '6-magazine-corner', '6-magazine-bands',
      '6-staggered-1', '6-staggered-2', '6-staggered-3', '6-staggered-4', '6-staggered-5',
      '6-pinwheel',
    ]],
    [7, [
      '7-rows-3-4', '7-columns-2-5', '7-columns-2-5-equal', '7-columns-2-5-wide', '7-rows-2-5',
      '7-hero-left', '7-hero-top', '7-sun', '7-magazine-bands', '7-magazine-columns',
      '7-staggered-1', '7-staggered-2', '7-staggered-3', '7-staggered-4', '7-staggered-5', '7-staggered-6',
      '7-pinwheel', '7-portrait-left',
    ]],
    [8, [
      '8-grid-4x2', '8-grid-2x4', '8-columns-2-6', '8-columns-6-2-equal', '8-columns-2-6-wide',
      '8-rows-2-6', '8-rows-3-5', '8-hero-left', '8-sun',
      '8-staggered-1', '8-staggered-2', '8-staggered-3', '8-staggered-5', '8-staggered-6',
      '8-pinwheel', '8-portrait-left',
    ]],
  ]);
  for (const [count, ids] of expected) {
    assert.deepEqual(getVisibleTemplatesForCount(count).map(template => template.id), ids, `${count} visible templates`);
    assert.equal(getVisibleTemplatesForCount(count).length, ids.length, `${count} visible count`);
  }
  const removed = new Map([
    [5, ['5-staggered-5', '5-staggered-6']],
    [6, ['6-columns-2-4-equal', '6-columns-4-2-equal', '6-staggered-6']],
    [8, ['8-columns-2-6-equal', '8-staggered-4']],
  ]);
  for (const [count, ids] of removed) {
    const allIds = new Set(getTemplatesForCount(count).map(template => template.id));
    for (const id of ids) assert.equal(allIds.has(id), false, `${id} must be removed from the catalogue`);
  }
});

test('virtual transforms preserve cell index and toggle independently on both axes', () => {
  for (let photoCount = 2; photoCount <= 12; photoCount += 1) {
    for (const canonical of getVisibleTemplatesForCount(photoCount)) {
      const xId = getTransformedTemplateId(canonical.id, 'x');
      const yId = getTransformedTemplateId(canonical.id, 'y');
      const xyId = getTransformedTemplateId(xId, 'y');
      for (const [id, flipX, flipY] of [[xId, true, false], [yId, false, true], [xyId, true, true]]) {
        const transformed = getTemplate(id);
        assert.equal(transformed.cells.length, canonical.cells.length);
        canonical.cells.forEach((cell, index) => {
          assert.deepEqual(
            transformed.cells[index].rect,
            transformRect(cell.rect, flipX, flipY),
            `${canonical.id} cell ${index + 1} (${flipX ? 'x' : ''}${flipY ? 'y' : ''})`,
          );
        });
        assert.deepEqual(getTemplateTransformState(id), {flipX, flipY}, id);
      }
      assert.equal(getTransformedTemplateId(xId, 'x'), canonical.id, `${canonical.id} x toggle`);
      assert.equal(getTransformedTemplateId(yId, 'y'), canonical.id, `${canonical.id} y toggle`);
      assert.equal(getTransformedTemplateId(xyId, 'x'), yId, `${canonical.id} xy -> y`);
      assert.equal(getTransformedTemplateId(xyId, 'y'), xId, `${canonical.id} xy -> x`);
      assert.equal(isTemplateAxisSymmetric(canonical.id, 'x'), signature(canonical) === signature(canonical, true, false));
      assert.equal(isTemplateAxisSymmetric(canonical.id, 'y'), signature(canonical) === signature(canonical, false, true));
    }
  }
});

test('legacy hidden mirror IDs resolve back to their visible canonical template', () => {
  for (let photoCount = 2; photoCount <= 12; photoCount += 1) {
    const visibleIds = new Set(getVisibleTemplatesForCount(photoCount).map(template => template.id));
    for (const legacy of getTemplatesForCount(photoCount).filter(template => !visibleIds.has(template.id) && isTemplateMirrorable(template))) {
      const canonicalId = getCanonicalTemplateId(legacy.id);
      assert.equal(visibleIds.has(canonicalId), true, `${legacy.id} canonical must be visible`);
      assert.equal(getMirroredTemplateId(legacy.id), canonicalId, `${legacy.id} must return to canonical`);
    }
  }
});

test('legacy --mirror IDs remain horizontal flips of the same indexed cells', () => {
  for (let photoCount = 2; photoCount <= 12; photoCount += 1) {
    for (const canonical of getVisibleTemplatesForCount(photoCount).filter(isTemplateMirrorable)) {
      const legacy = getTemplate(`${canonical.id}--mirror`);
      canonical.cells.forEach((cell, index) => {
        assert.deepEqual(legacy.cells[index].rect, mirrorRect(cell.rect), `${canonical.id} legacy cell ${index + 1}`);
      });
      assert.deepEqual(getTemplateTransformState(legacy.id), {flipX: true, flipY: false});
    }
  }
});

test('magazine and pinwheel layouts are complete, non-overlapping, and covered by the catalogue', () => {
  const magazineIds = new Set([
    '4-magazine-corner',
    '5-magazine-bands', '5-magazine-lower-corner',
    '6-magazine-corner', '6-magazine-bands',
    '7-magazine-bands', '7-magazine-columns',
    '9-centre-hero',
    '10-magazine-3-2-1-4',
  ]);
  for (const id of magazineIds) {
    const template = getTemplate(id);
    assert.equal(template.family, 'magazine', id);
    assertExactPartition(template);
  }
  for (let count = 4; count <= 12; count += 1) {
    const pinwheel = getTemplate(`${count}-pinwheel`);
    assert.equal(pinwheel.family, 'pinwheel');
    assert.equal(pinwheel.photoCount, count);
    assertExactPartition(pinwheel);
    assert.equal(
      getTemplatesForCount(count).some(template => template.family === 'pinwheel'),
      true,
      `${count} photos must include a pinwheel`,
    );
  }
  for (let count = 4; count <= 7; count += 1) {
    assert.equal(
      getTemplatesForCount(count).some(template => template.family === 'magazine'),
      true,
      `${count} photos must include a magazine layout`,
    );
  }
});

const makeSource = (path, width = 3000, height = 4000) => createPhotoSource({
  path,
  width,
  height,
  size: 4_000_000,
  modTime: '2026-10-04T00:00:00Z',
});

test('template flips preserve exact crops while real layout changes centre-reset changed aspects', () => {
  const store = createCollageStore(createProject({photoCount: 4}));
  store.dispatch(actions.setTemplate('4-staggered-1'));
  const sources = [makeSource('album/proportional.jpg'), makeSource('album/free.jpg')];
  store.dispatch(actions.registerSources(sources));
  store.dispatch(actions.addPlacement({id: 'proportional', sourceId: sources[0].id, cellIndex: 0}));
  store.dispatch(actions.addPlacement({id: 'free', sourceId: sources[1].id, cellIndex: 1}));
  store.dispatch(actions.setCrop('proportional', {x: .08, y: .12, width: .72, height: .61}, 'proportional'));
  store.dispatch(actions.setCrop('free', {x: .17, y: .19, width: .54, height: .47}, 'free'));
  const edited = structuredClone(store.getState().placements);

  for (const id of ['4-staggered-1--flip-x', '4-staggered-1--flip-xy', '4-staggered-1--flip-y', '4-staggered-1']) {
    store.dispatch(actions.setTemplate(id));
    assert.deepEqual(store.getState().placements, edited, `${id} keeps target cell aspects and exact user crops`);
  }

  store.dispatch(actions.setTemplate('4-grid'));
  const changed = store.getState();
  for (const [placementId, cellIndex] of [['proportional', 0], ['free', 1]]) {
    const placement = changed.placements[placementId];
    const source = changed.sources[placement.sourceId];
    assert.deepEqual(
      placement.crop,
      centeredCrop(source.width, source.height, getCellAspect(changed, cellIndex)),
      `${placementId} must reset to the centred default`,
    );
  }

  store.dispatch(actions.setTemplate('4-staggered-1'));
  const returned = store.getState();
  for (const [placementId, cellIndex] of [['proportional', 0], ['free', 1]]) {
    const placement = returned.placements[placementId];
    const source = returned.sources[placement.sourceId];
    assert.deepEqual(
      placement.crop,
      centeredCrop(source.width, source.height, getCellAspect(returned, cellIndex)),
      `${placementId} must be derived from the source, not accumulate zoom`,
    );
  }
});

function recordingPathContext() {
  const calls = [];
  return {
    calls,
    moveTo: (x, y) => calls.push(['moveTo', x, y]),
    lineTo: (x, y) => calls.push(['lineTo', x, y]),
    quadraticCurveTo: (...values) => calls.push(['quadraticCurveTo', ...values]),
    rect: (x, y, width, height) => calls.push(['rect', x, y, width, height]),
    closePath: () => calls.push(['closePath']),
  };
}

test('every edge contour reaches all four sides without a diagonal closing gap', () => {
  const rect = {x: 10, y: 20, width: 120, height: 80};
  const corners = [[10, 20], [130, 20], [130, 100], [10, 100]];
  for (const preset of ['straight', 'rounded', 'zigzag', 'wave', 'lightning', 'deckle', 'stamp', 'perforated', 'old-photo', 'polaroid']) {
    const ctx = recordingPathContext();
    traceFramePath(ctx, rect, {preset, depth: .12, frequency: 11});
    if (preset === 'straight' || preset === 'perforated' || preset === 'old-photo' || preset === 'polaroid') {
      assert.deepEqual(ctx.calls, [['rect', 10, 20, 120, 80]], preset);
      continue;
    }
    assert.equal(ctx.calls.at(-1)[0], 'closePath', `${preset} must close its contour`);
    const coordinates = ctx.calls.flatMap(call => {
      if (call[0] === 'moveTo' || call[0] === 'lineTo') return [[call[1], call[2]]];
      if (call[0] === 'quadraticCurveTo') return [[call[1], call[2]], [call[3], call[4]]];
      return [];
    });
    for (const corner of corners) {
      assert.equal(coordinates.some(point => point[0] === corner[0] && point[1] === corner[1]), true, `${preset} misses ${corner}`);
    }
    if (preset !== 'rounded') {
      assert.deepEqual(coordinates[0], corners[0], `${preset} must start at the top-left corner`);
      assert.deepEqual(coordinates.at(-1), corners[0], `${preset} must return to the top-left before closePath`);
    }
  }
});

test('perforated is a distinct adjustable inset frame with holes on every side', () => {
  const preset = getEdgePreset('perforated');
  assert.equal(EDGE_PRESETS.filter(item => item.id === 'perforated').length, 1);
  assert.notEqual(preset.id, getEdgePreset('stamp').id);
  assert.equal(preset.supportsDepth, true);
  assert.equal(preset.supportsFrequency, true);
  assert.deepEqual(normalizeEdgeOptions({preset: 'perforated', depth: .08, frequency: 9}), {
    preset: 'perforated', depth: .08, frequency: 9, radius: 0,
  });

  const rect = {x: 10, y: 20, width: 160, height: 100};
  const sparse = perforatedFrameGeometry(rect, {preset: 'perforated', depth: .05, frequency: 4});
  const dense = perforatedFrameGeometry(rect, {preset: 'perforated', depth: .05, frequency: 12});
  const deep = perforatedFrameGeometry(rect, {preset: 'perforated', depth: .14, frequency: 4});
  assert.deepEqual(sparse.outerRect, rect);
  assert.ok(sparse.innerRect.x > rect.x && sparse.innerRect.y > rect.y);
  assert.ok(sparse.innerRect.x + sparse.innerRect.width < rect.x + rect.width);
  assert.ok(sparse.innerRect.y + sparse.innerRect.height < rect.y + rect.height);
  assert.ok(dense.holes.length > sparse.holes.length * 2, 'frequency must add more perforations');
  assert.ok(deep.innerRect.x > sparse.innerRect.x, 'depth must widen the inset band');
  assert.ok(deep.holes[0].radius > sparse.holes[0].radius, 'depth must enlarge the small holes');

  const epsilon = 1e-6;
  const sides = new Set();
  for (const hole of dense.holes) {
    assert.ok(hole.radius > 0);
    assert.ok(hole.x - hole.radius >= rect.x - epsilon && hole.x + hole.radius <= rect.x + rect.width + epsilon);
    assert.ok(hole.y - hole.radius >= rect.y - epsilon && hole.y + hole.radius <= rect.y + rect.height + epsilon);
    if (hole.y < dense.innerRect.y) sides.add('top');
    if (hole.y > dense.innerRect.y + dense.innerRect.height) sides.add('bottom');
    if (hole.x < dense.innerRect.x) sides.add('left');
    if (hole.x > dense.innerRect.x + dense.innerRect.width) sides.add('right');
  }
  assert.deepEqual([...sides].sort(), ['bottom', 'left', 'right', 'top']);
});

test('wave is smooth rather than flat or V-shaped, and stamp responds to depth and frequency', () => {
  const rect = {x: 10, y: 20, width: 120, height: 80};
  const contour = (preset, depth, frequency) => {
    const ctx = recordingPathContext();
    traceFramePath(ctx, rect, {preset, depth, frequency});
    return ctx.calls.filter(call => call[0] === 'moveTo' || call[0] === 'lineTo');
  };

  const wave = contour('wave', .1, 3);
  const topWave = wave.filter(call => call[2] >= rect.y && call[2] <= rect.y + 8 && call[1] >= rect.x && call[1] <= rect.x + rect.width);
  assert.ok(new Set(topWave.map(call => round(call[2]))).size >= 8, 'wave must use a smooth multi-sample curve');
  assert.deepEqual(wave[0], ['moveTo', rect.x, rect.y]);
  assert.deepEqual(wave.at(-1), ['lineTo', rect.x, rect.y]);

  const sparseStamp = contour('stamp', .05, 4);
  const denseStamp = contour('stamp', .05, 12);
  assert.ok(denseStamp.length > sparseStamp.length * 2, 'stamp frequency must add more perforation samples');
  const shallow = contour('stamp', .03, 6);
  const deep = contour('stamp', .15, 6);
  const maxInset = calls => Math.max(...calls.slice(0, calls.length / 4).map(call => call[2] - rect.y));
  assert.ok(maxInset(deep) > maxInset(shallow) * 3, 'stamp depth must control perforation radius');
  assert.deepEqual(denseStamp[0], ['moveTo', rect.x, rect.y]);
  assert.deepEqual(denseStamp.at(-1), ['lineTo', rect.x, rect.y]);
});

test('paper presets keep inner artwork inside a complete backing and polaroid has a wider bottom strip', () => {
  const rect = {x: 10, y: 20, width: 200, height: 300};
  const oldPhoto = paperFrameGeometry(rect, {preset: 'old-photo', depth: .1});
  const polaroid = paperFrameGeometry(rect, {preset: 'polaroid', depth: .1});
  assert.equal(oldPhoto.paperColor, '#EEE0CD');
  assert.equal(polaroid.paperColor, '#FFFFFF');

  for (const paper of [oldPhoto, polaroid]) {
    assert.ok(paper.imageRect.x > rect.x && paper.imageRect.y > rect.y);
    assert.ok(paper.imageRect.x + paper.imageRect.width < rect.x + rect.width);
    assert.ok(paper.imageRect.y + paper.imageRect.height < rect.y + rect.height);
  }
  const oldTop = oldPhoto.imageRect.y - rect.y;
  const oldBottom = rect.y + rect.height - oldPhoto.imageRect.y - oldPhoto.imageRect.height;
  assert.ok(Math.abs(oldTop - oldBottom) <= EPSILON, 'old-photo paper must be balanced vertically');
  const polaroidTop = polaroid.imageRect.y - rect.y;
  const polaroidBottom = rect.y + rect.height - polaroid.imageRect.y - polaroid.imageRect.height;
  assert.ok(polaroidBottom > polaroidTop, 'polaroid bottom strip must be wider than its top strip');
});

test('canvas renderer paints paper backing and draws the photo into the inner artwork rectangle', async () => {
  const calls = [];
  const ctx = {
    save() {}, restore() {}, beginPath() {}, clip() {}, stroke() {},
    rect: (...args) => calls.push(['rect', ...args]),
    fillRect: (...args) => calls.push(['fillRect', ...args]),
    drawImage: (...args) => calls.push(['drawImage', ...args]),
    set fillStyle(value) { calls.push(['fillStyle', value]); },
    set strokeStyle(value) {}, set lineWidth(value) {},
  };
  const rect = {x: 15, y: 25, width: 200, height: 300};
  const frame = {preset: 'polaroid', depth: .1, frequency: 0};
  const inner = paperFrameGeometry(rect, frame).imageRect;
  const bitmap = {width: 3000, height: 4000, close() { calls.push(['close']); }};
  const plan = {
    background: '#FAFAFA', width: 400, height: 500,
    cells: [{sourceId: 'source', sourceUrl: '/photo', crop: {x: 0, y: 0, width: 1, height: 1}, rect, artworkRect: rect, frame}],
    lines: {width: 0, color: '#000000'},
  };
  await renderCanvas(ctx, plan, async () => bitmap);
  assert.ok(calls.some(call => call[0] === 'fillRect' && call.slice(1).every((value, index) => value === [rect.x, rect.y, rect.width, rect.height][index])), 'paper backing is missing');
  const draw = calls.find(call => call[0] === 'drawImage');
  assert.deepEqual(draw.slice(-4), [inner.x, inner.y, inner.width, inner.height]);
  assert.ok(calls.some(call => call[0] === 'close'), 'decoded bitmap must be released');
});

test('canvas renderer maps and rotates a clockwise crop before drawing', async () => {
  const calls = [];
  const ctx = {
    save: () => calls.push(['save']), restore: () => calls.push(['restore']),
    beginPath() {}, clip() {}, fillRect() {}, rect() {},
    translate: (...args) => calls.push(['translate', ...args]),
    rotate: (...args) => calls.push(['rotate', ...args]),
    drawImage: (...args) => calls.push(['drawImage', ...args]),
    set fillStyle(_value) {}, set strokeStyle(_value) {}, set lineWidth(_value) {},
  };
  const rect = {x: 10, y: 20, width: 200, height: 100};
  const bitmap = {width: 400, height: 300, close() {}};
  const plan = {
    background: '#FFFFFF', width: 400, height: 300,
    cells: [{
      sourceId: 'source', sourceUrl: '/photo',
      crop: {x: 0.25, y: 0.125, width: 0.5, height: 0.75}, rotation: 90,
      rect, artworkRect: rect, frame: {preset: 'straight', depth: 0, frequency: 0},
    }],
    lines: {width: 0, color: '#FFFFFF'},
  };
  await renderCanvas(ctx, plan, async () => bitmap);
  assert.ok(calls.some(call => call[0] === 'translate' && call[1] === 110 && call[2] === 70));
  assert.ok(calls.some(call => call[0] === 'rotate' && Math.abs(call[1] - Math.PI / 2) < 1e-12));
  const draw = calls.find(call => call[0] === 'drawImage');
  assert.deepEqual(draw.slice(2, 6), [50, 75, 300, 150]);
  assert.deepEqual(draw.slice(-4), [-50, -100, 100, 200]);
});

test('shared canvas renderer paints perforated band and every round hole without changing the photo clip', async () => {
  const calls = [];
  const ctx = {
    save: () => calls.push(['save']), restore: () => calls.push(['restore']),
    beginPath: () => calls.push(['beginPath']), clip: () => calls.push(['clip']),
    rect: (...args) => calls.push(['rect', ...args]),
    moveTo: (...args) => calls.push(['moveTo', ...args]),
    arc: (...args) => calls.push(['arc', ...args]),
    fill: (...args) => calls.push(['fill', ...args]),
    fillRect: (...args) => calls.push(['fillRect', ...args]),
    drawImage: (...args) => calls.push(['drawImage', ...args]),
    set fillStyle(value) { calls.push(['fillStyle', value]); },
    set strokeStyle(_value) {}, set lineWidth(_value) {},
  };
  const rect = {x: 15, y: 25, width: 200, height: 300};
  const frame = {preset: 'perforated', depth: .08, frequency: 9};
  const geometry = perforatedFrameGeometry(rect, frame);
  const bitmap = {width: 3000, height: 4000, close: () => calls.push(['close'])};
  const plan = {
    background: '#FAFAFA', width: 400, height: 500,
    cells: [{sourceId: 'source', sourceUrl: '/photo', crop: {x: 0, y: 0, width: 1, height: 1}, rect, artworkRect: rect, frame}],
    lines: {width: 0, color: '#445566'},
  };
  await renderCanvas(ctx, plan, async () => bitmap);
  assert.deepEqual(calls.filter(call => call[0] === 'drawImage').at(0).slice(-4), [rect.x, rect.y, rect.width, rect.height]);
  assert.equal(calls.filter(call => call[0] === 'arc').length, geometry.holes.length);
  assert.ok(calls.some(call => call[0] === 'fillStyle' && call[1] === '#445566'));
  assert.deepEqual(calls.filter(call => call[0] === 'fill').at(-1), ['fill', 'evenodd']);
  assert.ok(calls.some(call => call[0] === 'rect' && call.slice(1).every((value, index) => value === [rect.x, rect.y, rect.width, rect.height][index])));

  const editorSource = await readFile(new URL('../../web/collage/editor.js', import.meta.url), 'utf8');
  const exportSource = await readFile(new URL('../../web/collage/export.js', import.meta.url), 'utf8');
  assert.match(editorSource, /renderCanvas\(/, 'preview must use the shared renderer');
  assert.match(exportSource, /renderCanvas\(/, 'JPEG export must use the shared renderer');
});

test('edge controls expose Russian tooltip metadata for every visual preset', async () => {
  const editorSource = await readFile(new URL('../../web/collage/editor.js', import.meta.url), 'utf8');
  const labels = ['Ровный', 'Скруглённый', 'Зигзаг', 'Волна', 'Молния', 'Рваный край', 'Марка', 'Перфорация', 'Старое фото', 'Полароид'];
  for (const label of labels) assert.match(editorSource, new RegExp(`['\"]${label}['\"]`), label);
  assert.match(editorSource, /button\.dataset\.tooltip\s*=\s*label/);
  assert.match(editorSource, /button\.title\s*=\s*label/);
  assert.match(editorSource, /button\.setAttribute\(['\"]aria-label['\"],\s*label\)/);
});
