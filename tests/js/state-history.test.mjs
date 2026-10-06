import assert from 'node:assert/strict';
import test from 'node:test';

import {createPhotoSource, createProject, getCellAspect, sourceIdFromPath, validateProject} from '../../web/collage/model.js';
import {actions, createCollageStore} from '../../web/collage/store.js';

const makeSource = (path, width = 3000, height = 4000) => createPhotoSource({
  path,
  width,
  height,
  size: 4_000_000,
  modTime: '2026-10-03T10:00:00Z',
});

const centre = crop => ({x: crop.x + crop.width / 2, y: crop.y + crop.height / 2});

function assertCropMatchesCell(project, placementId, cellIndex) {
  const placement = project.placements[placementId];
  const source = project.sources[placement.sourceId];
  const cropAspect = source.width * placement.crop.width / (source.height * placement.crop.height);
  assert.ok(Math.abs(cropAspect - getCellAspect(project, cellIndex)) < 1e-9);
}

test('new projects default to the agreed 13 × 18 cm portrait print format', () => {
  assert.deepEqual(createProject().print, {
    formatId: '13x18',
    orientation: 'portrait',
    ppi: 300,
    bleedMm: 0,
  });
});

test('project title is undoable and legacy projects without it stay valid', () => {
  const project = createProject({title: 'Первый коллаж'});
  const store = createCollageStore(project);
  store.dispatch(actions.setTitle('Пироги на даче'));
  store.dispatch(actions.setTitle('Пироги на даче!'));
  assert.equal(store.getState().title, 'Пироги на даче!');
  assert.equal(store.getHistory().past.length, 1);
  assert.equal(store.getHistory().past.at(-1), 'Название коллажа');
  store.undo();
  assert.equal(store.getState().title, 'Первый коллаж');

  const legacy = structuredClone(project);
  delete legacy.title;
  assert.equal(validateProject(legacy).valid, true);
});

test('source IDs are stable library-relative identities and reject escaping paths', () => {
  assert.equal(sourceIdFromPath('./folder\\photo 1.jpg'), 'source:folder%2Fphoto%201.jpg');
  assert.throws(() => sourceIdFromPath('/absolute/photo.jpg'), /library-relative/);
  assert.throws(() => sourceIdFromPath('../outside.jpg'), /library-relative/);
  assert.throws(() => sourceIdFromPath('folder/../outside.jpg'), /library-relative/);
});

test('one source can have two independent placements in the same collage', () => {
  const store = createCollageStore(createProject({photoCount: 2}));
  const photo = makeSource('folder-a/photo.jpg');
  store.dispatch(actions.registerSources([photo]));
  store.dispatch(actions.addPlacement({id: 'placement:one', sourceId: photo.id, cellIndex: 0}));
  store.dispatch(actions.addPlacement({id: 'placement:two', sourceId: photo.id, cellIndex: 1}));

  const state = store.getState();
  assert.equal(Object.keys(state.sources).length, 1);
  assert.equal(Object.keys(state.placements).length, 2);
  assert.deepEqual(state.layout.order, ['placement:one', 'placement:two']);
  assert.equal(state.placements['placement:one'].sourceId, photo.id);
  assert.equal(state.placements['placement:two'].sourceId, photo.id);
  assert.notEqual(state.placements['placement:one'], state.placements['placement:two']);
  assert.notEqual(state.placements['placement:one'].crop, state.placements['placement:two'].crop);
  assert.equal(state.placements['placement:one'].rotation, 0);
});

test('crop action stores photo rotation and undo restores the previous angle', () => {
  const store = createCollageStore(createProject({photoCount: 2}));
  const photo = makeSource('album/rotated.jpg', 4000, 3000);
  store.dispatch(actions.registerSources([photo]));
  store.dispatch(actions.addPlacement({id: 'rotated', sourceId: photo.id, cellIndex: 0}));
  const crop = {x: 0, y: 0.125, width: 1, height: 0.75};
  store.dispatch(actions.setCrop('rotated', crop, 'proportional', 90));
  assert.equal(store.getState().placements.rotated.rotation, 90);
  assert.equal(store.getHistory().past.at(-1), 'Кроп фотографии');
  store.undo();
  assert.equal(store.getState().placements.rotated.rotation, 0);
});

test('sources from multiple folders coexist and registration does not pollute undo history', () => {
  const store = createCollageStore(createProject({photoCount: 2}));
  const first = makeSource('folder-a/one.jpg');
  const second = makeSource('folder-b/two.jpg');
  store.dispatch(actions.registerSources([first, second]));
  assert.deepEqual(Object.values(store.getState().sources).map(item => item.folderPath).sort(), ['folder-a', 'folder-b']);
  assert.equal(store.canUndo(), false);
});

test('history keeps exactly the latest 20 operations', () => {
  const store = createCollageStore(createProject());
  for (let index = 1; index <= 25; index += 1) {
    store.dispatch(actions.setBackground(`#${index.toString(16).padStart(6, '0')}`));
  }
  assert.equal(store.getHistory().limit, 20);
  assert.equal(store.getHistory().past.length, 20);
  for (let index = 0; index < 20; index += 1) store.undo();
  assert.equal(store.getState().appearance.backgroundColor, '#000005');
  assert.equal(store.canUndo(), false);
  assert.equal(store.canRedo(), true);
});

test('undo and redo restore state, while a new action clears the redo branch', () => {
  const store = createCollageStore(createProject());
  store.dispatch(actions.setBackground('#112233'));
  store.dispatch(actions.setBackground('#445566'));
  store.undo();
  assert.equal(store.getState().appearance.backgroundColor, '#112233');
  assert.equal(store.canRedo(), true);
  store.redo();
  assert.equal(store.getState().appearance.backgroundColor, '#445566');
  store.undo();
  store.dispatch(actions.setBackground('#778899'));
  assert.equal(store.canRedo(), false);
});

test('coalesced slider actions and explicit slider transactions each create one undo step', () => {
  const gapAction = actions.setGap(7);
  assert.equal(gapAction.meta.label, 'Толщина рамки');
  assert.equal(gapAction.payload.gapMm, 7);
  assert.doesNotMatch(JSON.stringify(gapAction), /Линии между фотографиями/);

  const coalesced = createCollageStore(createProject());
  coalesced.dispatch(actions.setGap(3));
  coalesced.dispatch(gapAction);
  coalesced.dispatch(actions.setGap(11));
  assert.equal(coalesced.getHistory().past.length, 1);
  assert.equal(coalesced.getHistory().past[0], 'Толщина рамки');
  assert.equal(JSON.parse(JSON.stringify(coalesced.getState())).appearance.gapMm, 11);
  coalesced.undo();
  assert.equal(coalesced.getState().appearance.gapMm, 2);

  const transacted = createCollageStore(createProject());
  transacted.beginTransaction('frame-depth', 'Глубина края');
  transacted.dispatch(actions.setFrame({depth: 0.2}));
  transacted.dispatch(actions.setFrame({depth: 0.5}));
  transacted.dispatch(actions.setFrame({depth: 0.8}));
  transacted.endTransaction();
  assert.equal(transacted.getHistory().past.length, 1);
  assert.equal(transacted.getState().appearance.frame.depth, 0.8);
  transacted.undo();
  assert.equal(transacted.getState().appearance.frame.depth, 0.25);
});

test('cancelling a transaction restores its starting state without an undo entry', () => {
  const store = createCollageStore(createProject());
  store.beginTransaction('gap', 'Линии');
  store.dispatch(actions.setGap(8));
  store.cancelTransaction();
  assert.equal(store.getState().appearance.gapMm, 2);
  assert.equal(store.getHistory().past.length, 0);
});

test('template shrink preserves order and crop centres; excess sources remain available', () => {
  const store = createCollageStore(createProject({photoCount: 4}));
  const photos = Array.from({length: 4}, (_, index) => makeSource(`album/photo-${index + 1}.jpg`));
  store.dispatch(actions.registerSources(photos));
  photos.forEach((photo, index) => {
    store.dispatch(actions.addPlacement({id: `placement:${index + 1}`, sourceId: photo.id, cellIndex: index}));
  });
  store.dispatch(actions.setCrop('placement:1', {x: 0.25, y: 0.25, width: 0.5, height: 0.5}, 'proportional'));
  const beforeCentre = centre(store.getState().placements['placement:1'].crop);

  store.dispatch(actions.setTemplate('3-columns'));
  const reduced = store.getState();
  assert.deepEqual(reduced.layout.order, ['placement:1', 'placement:2', 'placement:3']);
  assert.deepEqual(Object.keys(reduced.placements).sort(), ['placement:1', 'placement:2', 'placement:3']);
  assert.ok(reduced.sources[photos[3].id], 'removed placement source must remain in the photo panel');
  assert.deepEqual(centre(reduced.placements['placement:1'].crop), beforeCentre);

  store.dispatch(actions.setTemplate('4-grid'));
  assert.deepEqual(store.getState().layout.order, ['placement:1', 'placement:2', 'placement:3', null]);
  store.undo();
  assert.deepEqual(store.getState().layout.order, ['placement:1', 'placement:2', 'placement:3']);
});

test('moving to an occupied cell swaps placements and removing one leaves an empty cell', () => {
  const store = createCollageStore(createProject({photoCount: 2}));
  const photos = [makeSource('a/one.jpg'), makeSource('b/two.jpg')];
  store.dispatch(actions.registerSources(photos));
  store.dispatch(actions.addPlacement({id: 'p1', sourceId: photos[0].id, cellIndex: 0}));
  store.dispatch(actions.addPlacement({id: 'p2', sourceId: photos[1].id, cellIndex: 1}));
  store.dispatch(actions.movePlacement(0, 1));
  assert.deepEqual(store.getState().layout.order, ['p2', 'p1']);
  store.dispatch(actions.removePlacement('p1'));
  assert.deepEqual(store.getState().layout.order, ['p2', null]);
  assert.equal(store.getState().placements.p1, undefined);
});

test('loading another valid project resets both undo and redo history', () => {
  const store = createCollageStore(createProject());
  store.dispatch(actions.setBackground('#112233'));
  store.undo();
  assert.equal(store.canRedo(), true);
  const replacement = createProject({appVersion: 'loaded'});
  store.dispatch(actions.replaceProject(replacement));
  assert.equal(store.getState(), replacement);
  assert.equal(store.canUndo(), false);
  assert.equal(store.canRedo(), false);
  assert.deepEqual(validateProject(replacement), {valid: true, errors: []});
});

test('saving a proportional crop refits it to the cell while a free crop is preserved', () => {
  const store = createCollageStore(createProject({photoCount: 2}));
  const sources = [makeSource('album/proportional.jpg'), makeSource('album/free.jpg')];
  store.dispatch(actions.registerSources(sources));
  store.dispatch(actions.addPlacement({id: 'p-proportional', sourceId: sources[0].id, cellIndex: 0}));
  store.dispatch(actions.addPlacement({id: 'p-free', sourceId: sources[1].id, cellIndex: 1}));

  const proportionalDraft = {x: 0.25, y: 0.25, width: 0.5, height: 0.5};
  const freeDraft = {x: 0.2, y: 0.3, width: 0.45, height: 0.35};
  store.dispatch(actions.setCrop('p-proportional', proportionalDraft, 'proportional'));
  store.dispatch(actions.setCrop('p-free', freeDraft, 'free'));

  const state = store.getState();
  assertCropMatchesCell(state, 'p-proportional', 0);
  assert.deepEqual(centre(state.placements['p-proportional'].crop), centre(proportionalDraft));
  assert.deepEqual(state.placements['p-free'].crop, freeDraft);
});

test('moving a proportional crop refits it to the target cell while a free crop remains unchanged', () => {
  const store = createCollageStore(createProject({photoCount: 3}));
  store.dispatch(actions.setTemplate('3-hero-left'));
  const sources = [makeSource('album/proportional.jpg'), makeSource('album/free.jpg')];
  store.dispatch(actions.registerSources(sources));
  store.dispatch(actions.addPlacement({id: 'p-proportional', sourceId: sources[0].id, cellIndex: 0}));
  store.dispatch(actions.addPlacement({id: 'p-free', sourceId: sources[1].id, cellIndex: 1}));
  store.dispatch(actions.setCrop('p-proportional', {x: 0.2, y: 0.2, width: 0.6, height: 0.6}, 'proportional'));
  store.dispatch(actions.setCrop('p-free', {x: 0.1, y: 0.25, width: 0.7, height: 0.4}, 'free'));
  const freeBefore = structuredClone(store.getState().placements['p-free'].crop);

  store.dispatch(actions.movePlacement(0, 2));
  let state = store.getState();
  assert.equal(state.layout.order[2], 'p-proportional');
  assertCropMatchesCell(state, 'p-proportional', 2);

  store.dispatch(actions.movePlacement(1, 0));
  state = store.getState();
  assert.equal(state.layout.order[0], 'p-free');
  assert.deepEqual(state.placements['p-free'].crop, freeBefore);
});

test('format and orientation dispatch update print state synchronously and refit only proportional crops', () => {
  const store = createCollageStore(createProject({photoCount: 2}));
  const sources = [makeSource('album/proportional.jpg'), makeSource('album/free.jpg')];
  store.dispatch(actions.registerSources(sources));
  store.dispatch(actions.addPlacement({id: 'p-proportional', sourceId: sources[0].id, cellIndex: 0}));
  store.dispatch(actions.addPlacement({id: 'p-free', sourceId: sources[1].id, cellIndex: 1}));
  store.dispatch(actions.setCrop('p-proportional', {x: 0.2, y: 0.2, width: 0.6, height: 0.6}, 'proportional'));
  store.dispatch(actions.setCrop('p-free', {x: 0.15, y: 0.2, width: 0.65, height: 0.45}, 'free'));
  const freeBefore = structuredClone(store.getState().placements['p-free'].crop);
  let observedPrint = null;
  const unsubscribe = store.subscribe(state => { observedPrint = state.print; });

  store.dispatch(actions.setPrint({formatId: 'a4', orientation: 'landscape'}));
  unsubscribe();
  const state = store.getState();
  assert.deepEqual(state.print, {formatId: 'a4', orientation: 'landscape', ppi: 300, bleedMm: 0});
  assert.equal(observedPrint, state.print, 'subscribers see the new print state during dispatch');
  assertCropMatchesCell(state, 'p-proportional', 0);
  assert.deepEqual(state.placements['p-free'].crop, freeBefore);
});
