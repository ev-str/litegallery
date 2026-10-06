import assert from 'node:assert/strict';
import test from 'node:test';

import {
  centreCrop,
  cropForCell,
  cropFromKey,
  moveCrop,
  normalizeCrop,
  resizeCrop,
} from '../../web/collage/crop-controller.js';
import {EDGE_PRESETS, getEdgePreset, normalizeEdgeOptions} from '../../web/collage/frames.js';
import {exportJpeg, prepareExportPlan} from '../../web/collage/export.js';
import {getPrintDimensions, PRINT_FORMATS} from '../../web/collage/formats.js';
import {cropDistortionPercent, effectiveCropPpi, refitCropAroundCenter, rotatedSourceDimensions, sourceCropForRotation} from '../../web/collage/geometry.js';
import {createPhotoSource, createProject} from '../../web/collage/model.js';
import {runPreflight, setIssueIgnored} from '../../web/collage/preflight.js';
import {buildRenderPlan, resolveFrameLineColor, sourceUrl} from '../../web/collage/render-plan.js';
import {actions, createCollageStore} from '../../web/collage/store.js';
import {getTemplate} from '../../web/collage/templates.js';

test('crop frame moves and resizes within source bounds while the photo stays fixed', () => {
  assert.deepEqual(normalizeCrop({x: -1, y: 2, width: 0.5, height: 0.4}), {x: 0, y: 0.6, width: 0.5, height: 0.4});
  assert.deepEqual(moveCrop({x: 0.2, y: 0.3, width: 0.5, height: 0.4}, 0.8, -0.8), {x: 0.5, y: 0, width: 0.5, height: 0.4});
  assert.deepEqual(centreCrop({x: 0, y: 0, width: 0.4, height: 0.2}), {x: 0.3, y: 0.4, width: 0.4, height: 0.2});
});

test('proportional resize follows the target ratio and free resize can distort it', () => {
  const initial = {x: 0.25, y: 0.25, width: 0.5, height: 0.5};
  assert.deepEqual(
    resizeCrop(initial, {width: 0.4, mode: 'proportional', aspectRatio: 2}),
    {x: 0.3, y: 0.4, width: 0.4, height: 0.2},
  );
  assert.deepEqual(
    resizeCrop(initial, {width: 0.4, height: 0.3, mode: 'free'}),
    {x: 0.3, y: 0.35, width: 0.4, height: 0.3},
  );
});

test('keyboard arrows move the frame and plus/minus scale it', () => {
  const crop = {x: 0.25, y: 0.25, width: 0.5, height: 0.5};
  assert.deepEqual(cropFromKey(crop, 'ArrowRight', {step: 0.1}), {x: 0.35, y: 0.25, width: 0.5, height: 0.5});
  assert.equal(cropFromKey(crop, '+', {resizeStep: 0.1, mode: 'free'}).width, 0.4);
  assert.equal(cropFromKey(crop, '-', {resizeStep: 0.1, mode: 'free'}).width, 0.6);
});

test('template crop refit retains centre and matches the new cell aspect', () => {
  const crop = {x: 0.1, y: 0.2, width: 0.6, height: 0.5};
  const result = refitCropAroundCenter(crop, 4000, 3000, 1);
  assert.ok(Math.abs(result.x + result.width / 2 - 0.4) < 1e-12);
  assert.ok(Math.abs(result.y + result.height / 2 - 0.45) < 1e-12);
  assert.ok(Math.abs(4000 * result.width / (3000 * result.height) - 1) < 1e-12);

  const controllerResult = cropForCell(crop, 4 / 3, 1);
  assert.ok(Math.abs(controllerResult.x + controllerResult.width / 2 - 0.4) < 1e-12);
  assert.ok(Math.abs(controllerResult.y + controllerResult.height / 2 - 0.45) < 1e-12);
});

test('effective crop PPI and free-crop distortion use cropped source pixels', () => {
  assert.equal(effectiveCropPpi({x: 0, y: 0, width: 1, height: 1}, 3000, 4000, 1500, 2000, 300), 600);
  assert.equal(effectiveCropPpi({x: 0, y: 0, width: 0.5, height: 0.5}, 3000, 4000, 1500, 2000, 300), 300);
  assert.equal(effectiveCropPpi({x: 0, y: 0, width: 1, height: 1}, 3000, 4000, 0, 2000, 300), 0);
  assert.equal(cropDistortionPercent({x: 0, y: 0, width: 1, height: 1}, 3000, 4000, 0.75), 0);
  assert.ok(cropDistortionPercent({x: 0, y: 0, width: 1, height: 0.5}, 3000, 4000, 0.75) > 99);
});

test('photo rotation swaps effective dimensions and maps crops back to source pixels', () => {
  assert.deepEqual(rotatedSourceDimensions(4000, 3000, 0), {width: 4000, height: 3000});
  assert.deepEqual(rotatedSourceDimensions(4000, 3000, 90), {width: 3000, height: 4000});
  assert.deepEqual(rotatedSourceDimensions(4000, 3000, 270), {width: 3000, height: 4000});
  const crop = {x: 0.125, y: 0.25, width: 0.25, height: 0.5};
  assert.deepEqual(sourceCropForRotation(crop, 0), crop);
  assert.deepEqual(sourceCropForRotation(crop, 90), {x: 0.25, y: 0.625, width: 0.5, height: 0.25});
  assert.deepEqual(sourceCropForRotation(crop, 180), {x: 0.625, y: 0.25, width: 0.25, height: 0.5});
  assert.deepEqual(sourceCropForRotation(crop, 270), {x: 0.25, y: 0.125, width: 0.5, height: 0.25});
});

test('all approved edge styles are exposed and accepted by canonical editor state', () => {
  const approved = ['straight', 'rounded', 'zigzag', 'wave', 'lightning', 'deckle', 'stamp', 'perforated', 'old-photo', 'polaroid'];
  assert.deepEqual(EDGE_PRESETS.map(item => item.id), approved);
  const store = createCollageStore(createProject());
  for (const edgeStyle of approved) {
    assert.doesNotThrow(() => store.dispatch(actions.setFrame({edgeStyle})));
    assert.equal(store.getState().appearance.frame.edgeStyle, edgeStyle);
    assert.equal(getEdgePreset(edgeStyle).id, edgeStyle);
  }
});

test('frequency applies only to repeating edges and rounded depth becomes radius', () => {
  for (const preset of ['straight', 'rounded', 'old-photo', 'polaroid']) {
    assert.equal(normalizeEdgeOptions({preset, depth: 0.1, frequency: 30}).frequency, 0, preset);
  }
  for (const preset of ['zigzag', 'wave', 'lightning', 'deckle', 'stamp', 'perforated']) {
    const options = normalizeEdgeOptions({preset, depth: 0.1, frequency: 30});
    assert.equal(options.frequency, 30, preset);
    assert.equal(options.depth, 0.1, preset);
  }
  assert.equal(normalizeEdgeOptions({preset: 'straight', depth: 0.1}).depth, 0);
  assert.equal(normalizeEdgeOptions({preset: 'rounded', depth: 0.1}).radius, 0.1);
});

test('preflight reports unavailable, low-PPI, and distorted placements and supports ignore', () => {
  const project = {
    layout: {cells: [
      {id: 'left', x: 0, y: 0, width: 0.5, height: 1},
      {id: 'right', x: 0.5, y: 0, width: 0.5, height: 1},
    ]},
    placements: [
      {cellId: 'left', sourceId: 'weak', crop: {x: 0, y: 0, width: 1, height: 0.5}},
      {cellId: 'right', sourceId: 'missing', crop: {x: 0, y: 0, width: 1, height: 1}},
    ],
  };
  const print = {widthMm: 300, heightMm: 450, ppi: 300};
  const info = {weak: {width: 600, height: 900}, missing: {width: 0, height: 0, available: false}};
  const first = runPreflight(project, print, info);
  assert.ok(first.issues.some(item => item.id === 'low-ppi:left:weak'));
  assert.ok(first.issues.some(item => item.id === 'distortion:left:weak'));
  assert.ok(first.issues.some(item => item.id === 'missing:right:missing'));
  assert.ok(first.blocking.length >= 2);
  assert.ok(first.weakestPpi < 200);

  const ignoredIds = setIssueIgnored([], 'missing:right:missing', true);
  const second = runPreflight(project, print, info, ignoredIds);
  assert.deepEqual(second.ignored.map(item => item.id), ['missing:right:missing']);
  assert.equal(second.blocking.some(item => item.id === 'missing:right:missing'), false);
  assert.deepEqual(setIssueIgnored(ignoredIds, 'missing:right:missing', false), []);
});

test('preflight quality uses dimensions after photo rotation', () => {
  const project = {
    layout: {cells: [{id: 'cell', x: 0, y: 0, width: 1, height: 1}]},
    placements: [{cellId: 'cell', sourceId: 'photo', crop: {x: 0, y: 0, width: 1, height: 1}, rotation: 90}],
  };
  const result = runPreflight(project, {widthMm: 50.8, heightMm: 25.4, ppi: 300}, {photo: {width: 400, height: 800}});
  assert.equal(result.weakestPpi, 400);
  assert.equal(result.issues.some(item => item.kind === 'distortion'), false);
});

test('render plan consumes canonical ProjectState and maps template order to immutable cells', () => {
  const project = createProject({photoCount: 2});
  const source = createPhotoSource({path: 'album/photo.jpg', width: 3000, height: 4000});
  const store = createCollageStore(project);
  store.dispatch(actions.registerSources([source]));
  store.dispatch(actions.addPlacement({id: 'placement:one', sourceId: source.id, cellIndex: 0}));
  store.dispatch(actions.setBackground('#112233'));
  store.dispatch(actions.setGap(3));
  store.dispatch(actions.setFrame({mode: 'color', color: '#AABBCC', edgeStyle: 'rounded', depth: 0.1}));

  const state = store.getState();
  const plan = buildRenderPlan(state);
  const template = getTemplate(state.layout.templateId);
  assert.equal(plan.cells.length, template.cells.length);
  assert.equal(plan.cells[0].sourceId, source.id);
  assert.equal(plan.cells[0].rotation, 0);
  assert.equal(plan.cells[1].sourceId, null);
  assert.equal(plan.background, '#112233');
  assert.equal(plan.print.ppi, 300);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.cells), true);
});

test('preview and export plans share geometry and keep bleed outside trim', () => {
  const project = createProject({photoCount: 2});
  project.print = {...project.print, formatId: 'a4', ppi: 300, bleedMm: 2};
  const exportPlan = buildRenderPlan(project);
  assert.deepEqual([exportPlan.width, exportPlan.height], [2528, 3555]);
  assert.ok(Math.abs(exportPlan.trim.width / exportPlan.trim.height - 210 / 297) < 1e-12);
  assert.ok(exportPlan.trim.x > 0 && exportPlan.trim.y > 0);

  const previewPlan = buildRenderPlan(project, {pixelWidth: 428, pixelHeight: 602});
  assert.deepEqual(previewPlan.trim, {x: 4, y: 4, width: 420, height: 594});
  assert.equal(previewPlan.cells[0].rect.x, 4);
  assert.equal(previewPlan.cells.at(-1).rect.x + previewPlan.cells.at(-1).rect.width, 424);
});

test('canonical export derives every physical format from the shared format registry', () => {
  for (const format of PRINT_FORMATS) {
    for (const orientation of ['portrait', 'landscape']) {
      const project = createProject();
      project.print = {...project.print, formatId: format.id, orientation, bleedMm: 2};
      const expected = getPrintDimensions(format.id, orientation, project.print.ppi, 2);
      const prepared = prepareExportPlan(project, undefined, {maxMemoryBytes: Infinity});
      assert.equal(prepared.print.widthMm, expected.trimWidthMm, `${format.id} ${orientation} width`);
      assert.equal(prepared.print.heightMm, expected.trimHeightMm, `${format.id} ${orientation} height`);
      assert.equal(prepared.print.bleedMm, 2);
    }
  }
});

test('JPEG export rejects an already aborted request before allocating or starting a worker', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => exportJpeg(createProject(), undefined, {signal: controller.signal}),
    error => error instanceof DOMException && error.name === 'AbortError',
  );
});

test('preview and canonical JPEG plan resolve identical divider colours for every frame mode', () => {
  const cases = [
    {mode: 'none', backgroundColor: '#DDEEFF', color: '#123456', expected: '#DDEEFF'},
    {mode: 'white', backgroundColor: '#DDEEFF', color: '#123456', expected: '#FFFFFF'},
    {mode: 'color', backgroundColor: '#DDEEFF', color: '#123456', expected: '#123456'},
  ];
  for (const item of cases) {
    const project = createProject({photoCount: 2});
    project.appearance = {
      ...project.appearance,
      backgroundColor: item.backgroundColor,
      frame: {...project.appearance.frame, mode: item.mode, color: item.color},
    };
    const previewColor = resolveFrameLineColor(project.appearance);
    const exportColor = buildRenderPlan(project).lines.color;
    assert.equal(previewColor, item.expected, item.mode);
    assert.equal(exportColor, previewColor, `${item.mode}: preview/export mismatch`);
  }
});

test('crop source URL prefers embedded blobs, falls back to media API, and ignores unsafe persisted schemes', () => {
  const source = {
    id: 'source:album%2Fphoto%201.jpg',
    path: 'album/photo 1.jpg',
    name: 'photo 1.jpg',
    folderPath: 'album',
    size: 4_000_000,
    modTime: '',
    width: 3000,
    height: 4000,
  };
  const fallback = '/api/media?path=album%2Fphoto%201.jpg';

  assert.equal(sourceUrl({...source, sourceUrl: ' blob:https://gallery.local/embedded-photo '}), 'blob:https://gallery.local/embedded-photo');
  assert.equal(sourceUrl(source), fallback);
  for (const unsafe of ['javascript:alert(1)', 'data:image/jpeg;base64,AAAA', 'https://evil.example/photo.jpg', '//evil.example/photo.jpg']) {
    assert.equal(sourceUrl({...source, sourceUrl: unsafe}), fallback, unsafe);
  }
});
