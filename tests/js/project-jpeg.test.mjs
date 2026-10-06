import assert from 'node:assert/strict';
import test from 'node:test';

import {withJpegDensity} from '../../web/collage/jpeg-metadata.js';
import {createPhotoSource, createProject} from '../../web/collage/model.js';
import {
  PROJECT_FORMAT,
  PROJECT_FORMAT_VERSION,
  createProjectDocument,
  projectJsonBlob,
  projectZipBlob,
  readProjectBlob,
  validateProjectDocument,
} from '../../web/collage/project.js';
import {actions, createCollageStore} from '../../web/collage/store.js';

function canonicalProject() {
  const store = createCollageStore(createProject({appVersion: '1.2.3', photoCount: 2}));
  const source = createPhotoSource({
    path: 'family/photo.jpg',
    width: 3000,
    height: 4000,
    size: 4_000_000,
    modTime: '2026-10-03T10:00:00Z',
  });
  store.dispatch(actions.registerSources([source]));
  store.dispatch(actions.addPlacement({id: 'placement:one', sourceId: source.id, cellIndex: 0}));
  return store.getState();
}

function canonicalProjectWithSources(paths) {
  const store = createCollageStore(createProject({appVersion: '1.2.3', photoCount: 2}));
  const sources = paths.map(path => createPhotoSource({
    path,
    width: 3000,
    height: 4000,
    size: 4_000_000,
    modTime: '2026-10-03T10:00:00Z',
  }));
  store.dispatch(actions.registerSources(sources));
  return {project: store.getState(), sources};
}

test('canonical project JSON round-trips with app and format versions', async () => {
  const state = canonicalProject();
  state.placements['placement:one'].rotation = 270;
  const document = createProjectDocument(state, '1.2.3');
  assert.equal(document.format, PROJECT_FORMAT);
  assert.equal(document.formatVersion, PROJECT_FORMAT_VERSION);
  assert.equal(document.appVersion, '1.2.3');
  assert.match(document.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.notEqual(document.project, state);
  assert.deepEqual(document.project, state);
  assert.equal(validateProjectDocument(document).ok, true);

  const blob = projectJsonBlob(document);
  assert.equal(blob.type, 'application/json');
  const imported = await readProjectBlob(blob);
  assert.equal(imported.ok, true);
  assert.deepEqual(imported.ok && imported.project, state);
  assert.equal(imported.ok && imported.project.placements['placement:one'].rotation, 270);
});

test('project version check distinguishes future, migratable, and malformed files', () => {
  const valid = createProjectDocument(canonicalProject(), 'dev');
  assert.deepEqual(validateProjectDocument({...valid, formatVersion: 99}), {
    ok: false,
    reason: 'newer-version',
    formatVersion: 99,
    message: 'Проект создан в более новой версии LiteGallery',
  });
  assert.deepEqual(validateProjectDocument({...valid, formatVersion: 0}), {
    ok: false,
    reason: 'older-version',
    formatVersion: 0,
    message: 'Для проекта требуется миграция',
  });
  assert.equal(validateProjectDocument({}).reason, 'invalid');
  assert.equal(validateProjectDocument({...valid, project: {}}).reason, 'invalid');
  assert.equal(validateProjectDocument({...valid, project: {...valid.project, appearance: undefined}}).reason, 'invalid');

  const invalidBleed = structuredClone(valid);
  invalidBleed.project.print.bleedMm = 1;
  assert.equal(validateProjectDocument(invalidBleed).reason, 'invalid');

  const unknownPlacement = structuredClone(valid);
  unknownPlacement.project.layout.order[0] = 'placement:missing';
  assert.equal(validateProjectDocument(unknownPlacement).reason, 'invalid');
});

test('malformed and oversized JSON files are rejected before import', async () => {
  const malformed = await readProjectBlob(new Blob(['{'], {type: 'application/json'}));
  assert.deepEqual(malformed, {ok: false, reason: 'invalid', message: 'Не удалось прочитать JSON проекта'});

  const oversized = await readProjectBlob(new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]));
  assert.equal(oversized.ok, false);
  assert.equal(oversized.reason, 'invalid');
  assert.match(oversized.message, /слишком большой/);
});

test('ZIP adapter receives unique, traversal-safe, case-insensitive photo names', async () => {
  const {project, sources} = canonicalProjectWithSources([
    'album/source-1.jpg',
    'album/source-2.jpg',
    'album/source-3.jpg',
    'album/source-4.jpg',
    'album/source-5.jpg',
  ]);
  const document = createProjectDocument(project, 'dev');
  let captured = [];
  const adapter = {
    async create(entries) {
      captured = entries;
      return new Blob(['zip'], {type: 'application/zip'});
    },
  };
  const result = await projectZipBlob(document, [
    {sourceId: sources[0].id, name: '../family.jpg', blob: new Blob(['one'])},
    {sourceId: sources[1].id, name: 'FAMILY.JPG', blob: new Blob(['two'])},
    {sourceId: sources[2].id, name: '...', blob: new Blob(['three'])},
    {sourceId: sources[3].id, name: 'nested\\portrait?.jpg', blob: new Blob(['four'])},
    {sourceId: sources[4].id, name: '/absolute/escape.jpg', blob: new Blob(['five'])},
  ], adapter);

  assert.equal(result.type, 'application/zip');
  assert.equal(captured[0].name, 'project.json');
  assert.deepEqual(captured.slice(1).map(entry => entry.name), [
    'photos/family.jpg',
    'photos/2-FAMILY.JPG',
    'photos/photo-3.jpg',
    'photos/portrait_.jpg',
    'photos/escape.jpg',
  ]);
  assert.equal(new Set(captured.map(entry => entry.name.toLowerCase())).size, captured.length);
  assert.equal(captured.some(entry => entry.name.includes('..') || entry.name.includes('\\')), false);
  assert.equal(captured.slice(1).every(entry => entry.name.startsWith('photos/')), true);
});

test('ZIP adapter must return an application/zip Blob', async () => {
  const document = createProjectDocument(canonicalProject(), 'dev');
  await assert.rejects(
    () => projectZipBlob(document, [], {create: async () => new Blob(['wrong'], {type: 'text/plain'})}),
    /invalid Blob/,
  );
});

test('JFIF density is inserted into a JPEG that has no APP0 segment', async () => {
  const source = new Blob([Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)], {type: 'image/jpeg'});
  const outputBlob = await withJpegDensity(source, 300);
  const output = new Uint8Array(await outputBlob.arrayBuffer());
  assert.equal(outputBlob.type, 'image/jpeg');
  assert.deepEqual([...output.slice(0, 11)], [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  assert.equal(output[13], 1);
  assert.equal((output[14] << 8) | output[15], 300);
  assert.equal((output[16] << 8) | output[17], 300);
  assert.deepEqual([...output.slice(-2)], [0xff, 0xd9]);
});

test('existing JFIF density is patched in place without changing other bytes', async () => {
  const source = Uint8Array.of(
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x02, 0x00,
    0x00, 0x01, 0x00, 0x01,
    0x00, 0x00,
    0xff, 0xd9,
  );
  const output = new Uint8Array(await (await withJpegDensity(new Blob([source]), 450)).arrayBuffer());
  assert.equal(output.length, source.length);
  assert.equal(output[13], 1);
  assert.equal((output[14] << 8) | output[15], 450);
  assert.equal((output[16] << 8) | output[17], 450);
  assert.deepEqual([...output.slice(0, 13)], [...source.slice(0, 13)]);
  assert.deepEqual([...output.slice(18)], [...source.slice(18)]);
});

test('JFIF density rounds and clamps to the unsigned 16-bit range', async () => {
  const source = new Blob([Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)]);
  const low = new Uint8Array(await (await withJpegDensity(source, 0)).arrayBuffer());
  const high = new Uint8Array(await (await withJpegDensity(source, 100_000)).arrayBuffer());
  assert.equal((low[14] << 8) | low[15], 1);
  assert.equal((high[14] << 8) | high[15], 65535);
});

test('non-JPEG input is rejected', async () => {
  await assert.rejects(() => withJpegDensity(new Blob(['not jpeg']), 300), /not a JPEG/);
});
