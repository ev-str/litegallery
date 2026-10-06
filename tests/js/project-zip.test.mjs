import assert from 'node:assert/strict';
import test from 'node:test';

import {createPhotoSource, createProject} from '../../web/collage/model.js';
import {
  DEFAULT_ZIP_LIMITS,
  PROJECT_FORMAT_VERSION,
  createProjectDocument,
  createStoredZip,
  projectZipBlob,
  readProjectZip,
} from '../../web/collage/project.js';
import {actions, createCollageStore} from '../../web/collage/store.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function projectWithDuplicatePlacements() {
  const store = createCollageStore(createProject({appVersion: '1.2.3', photoCount: 3}));
  const first = createPhotoSource({path: 'folder-a/repeated.jpg', width: 3000, height: 4000, size: 4_000_000});
  const second = createPhotoSource({path: 'folder-b/unique.jpg', width: 4000, height: 3000, size: 5_000_000});
  store.dispatch(actions.registerSources([first, second]));
  store.dispatch(actions.addPlacement({id: 'placement:first', sourceId: first.id, cellIndex: 0}));
  store.dispatch(actions.addPlacement({id: 'placement:duplicate', sourceId: first.id, cellIndex: 1}));
  store.dispatch(actions.addPlacement({id: 'placement:second', sourceId: second.id, cellIndex: 2}));
  return {project: store.getState(), first, second};
}

const jsonBlob = value => new Blob([JSON.stringify(value)], {type: 'application/json'});
const zipBlob = bytes => new Blob([bytes], {type: 'application/zip'});

async function archiveWithDocument(document, entries = []) {
  return createStoredZip([{name: 'project.json', blob: jsonBlob(document)}, ...entries]);
}

function findSignature(bytes, signature, from = bytes.length - 4) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = from; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === signature) return offset;
  }
  throw new Error(`ZIP signature ${signature.toString(16)} not found`);
}

function inspectZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findSignature(bytes, 0x06054b50);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(view.getUint32(cursor, true), 0x02014b50, 'test fixture has a valid central entry');
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    const localOffset = view.getUint32(cursor + 42, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    entries.push({name, centralOffset: cursor, localOffset, dataOffset: localOffset + 30 + localNameLength + localExtraLength});
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return {view, eocdOffset, entryCount, centralSize, centralOffset, entries};
}

async function bytesOf(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

test('built-in ZIP32 round-trips canonical state, duplicate placements, and unique sources', async () => {
  const {project, first, second} = projectWithDuplicatePlacements();
  const document = createProjectDocument(project, '1.2.3');
  const archive = await projectZipBlob(document, [
    {sourceId: first.id, name: first.name, blob: new Blob(['first-photo'], {type: 'image/jpeg'})},
    {sourceId: second.id, name: second.name, blob: new Blob(['second-photo'], {type: 'image/jpeg'})},
  ]);

  const loaded = await readProjectZip(archive);
  assert.deepEqual(loaded.project, project);
  assert.equal(Object.keys(loaded.project.placements).length, 3);
  assert.equal(Object.keys(loaded.project.sources).length, 2);
  assert.equal(loaded.project.placements['placement:first'].sourceId, first.id);
  assert.equal(loaded.project.placements['placement:duplicate'].sourceId, first.id);
  assert.equal(loaded.photosBySource.size, 2);
  assert.equal(await loaded.photosBySource.get(first.id).blob.text(), 'first-photo');
  assert.equal(await loaded.photosBySource.get(second.id).blob.text(), 'second-photo');
});

test('archive manifest maps every embedded photo to its canonical source ID', async () => {
  const {project, first, second} = projectWithDuplicatePlacements();
  const archive = await projectZipBlob(createProjectDocument(project, 'dev'), [
    {sourceId: second.id, name: '../same.jpg', blob: new Blob(['second'])},
    {sourceId: first.id, name: 'SAME.JPG', blob: new Blob(['first'])},
  ]);
  const loaded = await readProjectZip(archive);
  assert.deepEqual(loaded.document.assets.photos, {
    [second.id]: 'photos/same.jpg',
    [first.id]: 'photos/2-SAME.JPG',
  });
  assert.equal(loaded.entries.filter(entry => entry.name.startsWith('photos/')).length, 2);
});

test('CRC corruption in stored photo data is rejected', async () => {
  const {project, first, second} = projectWithDuplicatePlacements();
  const archive = await projectZipBlob(createProjectDocument(project, 'dev'), [
    {sourceId: first.id, name: first.name, blob: new Blob(['photo-payload'])},
    {sourceId: second.id, name: second.name, blob: new Blob(['second-photo'])},
  ]);
  const bytes = await bytesOf(archive);
  const layout = inspectZip(bytes);
  const photo = layout.entries.find(entry => entry.name.startsWith('photos/'));
  assert.ok(photo);
  bytes[photo.dataOffset] ^= 0xff;
  await assert.rejects(() => readProjectZip(zipBlob(bytes)), /CRC32 mismatch/);
});

test('unsafe, absolute, backslash, and case-duplicate entry paths are rejected', async t => {
  const document = createProjectDocument(createProject(), 'dev');
  document.assets = {photos: {}};
  const hostileCases = [
    {name: 'parent traversal', entries: ['../escape.jpg']},
    {name: 'absolute path', entries: ['/escape.jpg']},
    {name: 'drive path', entries: ['C:/escape.jpg']},
    {name: 'backslash path', entries: ['photos\\escape.jpg']},
    {name: 'empty path segment', entries: ['photos//escape.jpg']},
    {name: 'case-insensitive duplicate', entries: ['photos/a.jpg', 'PHOTOS/A.JPG']},
  ];
  for (const hostile of hostileCases) {
    await t.test(hostile.name, async () => {
      const archive = await archiveWithDocument(document, hostile.entries.map(name => ({name, blob: new Blob(['x'])})));
      await assert.rejects(() => readProjectZip(archive), /Unsafe ZIP entry path|Duplicate ZIP entry/);
    });
  }
});

test('archive must contain exactly one case-sensitive project.json', async () => {
  const document = createProjectDocument(createProject(), 'dev');
  document.assets = {photos: {}};
  const missing = await createStoredZip([{name: 'photos/a.jpg', blob: new Blob(['x'])}]);
  await assert.rejects(() => readProjectZip(missing), /exactly one project\.json/);

  const duplicate = await createStoredZip([
    {name: 'project.json', blob: jsonBlob(document)},
    {name: 'PROJECT.JSON', blob: jsonBlob(document)},
  ]);
  await assert.rejects(() => readProjectZip(duplicate), /Duplicate ZIP entry/);
});

test('compression, encryption, data descriptors, and ZIP64 markers are rejected', async t => {
  const document = createProjectDocument(createProject(), 'dev');
  document.assets = {photos: {}};
  const base = await bytesOf(await archiveWithDocument(document));
  const mutations = [
    {
      name: 'compression',
      expected: /Only ZIP STORE/,
      mutate(bytes, layout) { layout.view.setUint16(layout.entries[0].centralOffset + 10, 8, true); },
    },
    {
      name: 'encryption',
      expected: /Encrypted ZIP entries/,
      mutate(bytes, layout) { layout.view.setUint16(layout.entries[0].centralOffset + 8, 0x0801, true); },
    },
    {
      name: 'data descriptor',
      expected: /data descriptors/,
      mutate(bytes, layout) { layout.view.setUint16(layout.entries[0].centralOffset + 8, 0x0808, true); },
    },
    {
      name: 'ZIP64 EOCD marker',
      expected: /ZIP64 archives/,
      mutate(bytes, layout) {
        layout.view.setUint16(layout.eocdOffset + 8, 0xffff, true);
        layout.view.setUint16(layout.eocdOffset + 10, 0xffff, true);
      },
    },
    {
      name: 'ZIP64 entry size marker',
      expected: /ZIP64 entries/,
      mutate(bytes, layout) { layout.view.setUint32(layout.entries[0].centralOffset + 24, 0xffffffff, true); },
    },
  ];

  for (const mutation of mutations) {
    await t.test(mutation.name, async () => {
      const bytes = new Uint8Array(base);
      const layout = inspectZip(bytes);
      mutation.mutate(bytes, layout);
      await assert.rejects(() => readProjectZip(zipBlob(bytes)), mutation.expected);
    });
  }
});

test('file-count, entry, total, archive, project, and central-directory limits are enforced', async t => {
  const {project, first, second} = projectWithDuplicatePlacements();
  const archive = await projectZipBlob(createProjectDocument(project, 'dev'), [
    {sourceId: first.id, name: first.name, blob: new Blob(['1234567890'])},
    {sourceId: second.id, name: second.name, blob: new Blob(['abcdefghij'])},
  ]);
  const bytes = await bytesOf(archive);
  const layout = inspectZip(bytes);
  const projectEntry = layout.entries.find(entry => entry.name === 'project.json');
  assert.ok(projectEntry);
  const projectSize = layout.view.getUint32(projectEntry.centralOffset + 24, true);
  const totalSize = layout.entries.reduce((sum, entry) => sum + layout.view.getUint32(entry.centralOffset + 24, true), 0);
  const cases = [
    {name: 'archive bytes', limits: {maxArchiveBytes: archive.size - 1}, expected: /archive is too large/},
    {name: 'central directory bytes', limits: {maxCentralDirectoryBytes: layout.centralSize - 1}, expected: /central directory is too large/},
    {name: 'file count', limits: {maxFiles: layout.entryCount - 1}, expected: /too many files/},
    {name: 'single entry bytes', limits: {maxEntryBytes: projectSize - 1}, expected: /entry is too large/},
    {name: 'total uncompressed bytes', limits: {maxTotalUncompressedBytes: totalSize - 1}, expected: /uncompressed size limit/},
    {name: 'project bytes', limits: {maxProjectBytes: projectSize - 1}, expected: /project\.json is too large/},
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      await assert.rejects(() => readProjectZip(archive, item.limits), item.expected);
    });
  }
  assert.equal(DEFAULT_ZIP_LIMITS.maxFiles, 100);
  await assert.rejects(() => readProjectZip(archive, {maxFiles: 0}), /Invalid ZIP limit/);
});

test('every project source must have exactly one embedded-photo mapping', async () => {
  const {project, first, second} = projectWithDuplicatePlacements();
  const document = createProjectDocument(project, 'dev');
  document.assets = {photos: {[first.id]: 'photos/first.jpg'}};
  const incomplete = await archiveWithDocument(document, [{name: 'photos/first.jpg', blob: new Blob(['first'])}]);
  await assert.rejects(() => readProjectZip(incomplete), /mapping|missing/i);

  const unknown = structuredClone(document);
  unknown.assets.photos = {'source:unknown': 'photos/first.jpg'};
  const unknownArchive = await archiveWithDocument(unknown, [{name: 'photos/first.jpg', blob: new Blob(['first'])}]);
  await assert.rejects(() => readProjectZip(unknownArchive), /unknown source/);

  const missingPhoto = structuredClone(document);
  missingPhoto.assets.photos = {[first.id]: 'photos/not-there.jpg', [second.id]: 'photos/second.jpg'};
  const missingPhotoArchive = await archiveWithDocument(missingPhoto, [{name: 'photos/second.jpg', blob: new Blob(['second'])}]);
  await assert.rejects(() => readProjectZip(missingPhotoArchive), /Mapped photo is missing/);
});

test('writer rejects partial and unexpected extra source-to-photo mappings', async () => {
  const {project, first, second} = projectWithDuplicatePlacements();
  const document = createProjectDocument(project, 'dev');
  await assert.rejects(
    () => projectZipBlob(document, [
      {sourceId: first.id, name: first.name, blob: new Blob(['first'])},
    ]),
    /source|photo|mapping/i,
    'two project sources cannot be saved with only one embedded original',
  );
  await assert.rejects(
    () => projectZipBlob(document, [
      {sourceId: first.id, name: first.name, blob: new Blob(['first'])},
      {sourceId: second.id, name: second.name, blob: new Blob(['second'])},
      {name: 'unexpected.jpg', blob: new Blob(['unexpected'])},
    ]),
    /unexpected|source|photo|mapping/i,
    'an embedded photo without a project source must be rejected',
  );
});

test('reader rejects an embedded photo that has no source mapping', async () => {
  const {project, first, second} = projectWithDuplicatePlacements();
  const extraPhoto = createProjectDocument(project, 'dev');
  extraPhoto.assets = {photos: {
    [first.id]: 'photos/first.jpg',
    [second.id]: 'photos/second.jpg',
  }};
  const extraPhotoArchive = await archiveWithDocument(extraPhoto, [
    {name: 'photos/first.jpg', blob: new Blob(['first'])},
    {name: 'photos/second.jpg', blob: new Blob(['second'])},
    {name: 'photos/unexpected.jpg', blob: new Blob(['unexpected'])},
  ]);
  await assert.rejects(
    () => readProjectZip(extraPhotoArchive),
    /unexpected|unreferenced|mapping/i,
  );
});

test('reader requires a one-to-one mapping between sources and embedded photos', async () => {
  const {project, first, second} = projectWithDuplicatePlacements();
  const sharedPhoto = createProjectDocument(project, 'dev');
  sharedPhoto.assets = {photos: {
    [first.id]: 'photos/shared.jpg',
    [second.id]: 'photos/shared.jpg',
  }};
  const sharedPhotoArchive = await archiveWithDocument(sharedPhoto, [
    {name: 'photos/shared.jpg', blob: new Blob(['shared'])},
  ]);
  await assert.rejects(
    () => readProjectZip(sharedPhotoArchive),
    /duplicate|one-to-one|mapping/i,
  );
});

test('ZIP import applies project format-version validation before exposing assets', async () => {
  const {project} = projectWithDuplicatePlacements();
  for (const [formatVersion, expected] of [
    [PROJECT_FORMAT_VERSION + 1, /более новой версии/],
    [PROJECT_FORMAT_VERSION - 1, /миграция/],
  ]) {
    const document = createProjectDocument(project, 'dev');
    document.formatVersion = formatVersion;
    document.assets = {photos: {}};
    const archive = await archiveWithDocument(document);
    await assert.rejects(() => readProjectZip(archive), expected);
  }
});

test('writer rejects unknown, duplicate, and absent photo-source assignments', async () => {
  const {project, first} = projectWithDuplicatePlacements();
  const document = createProjectDocument(project, 'dev');
  await assert.rejects(
    () => projectZipBlob(document, [{sourceId: 'source:unknown', name: 'x.jpg', blob: new Blob(['x'])}]),
    /Unknown photo source/,
  );
  await assert.rejects(
    () => projectZipBlob(document, [
      {sourceId: first.id, name: 'x.jpg', blob: new Blob(['x'])},
      {sourceId: first.id, name: 'y.jpg', blob: new Blob(['y'])},
    ]),
    /Duplicate photo source/,
  );
  await assert.rejects(() => projectZipBlob(document, []), /source|photo|mapping/i);
});
