import assert from 'node:assert/strict';
import test from 'node:test';

import {runPreflight} from '../../web/collage/preflight.js';
import {decodeSourceImage, isCollageSupportedPath, preparePhotoSource, resolvePhotoSource} from '../../web/collage/sources.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return {promise, resolve, reject};
}

async function withGlobals(values, run) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, globalThis[key]);
    globalThis[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

test('source readiness decodes the full original before resolving the source', async () => {
  const decoding = deferred();
  let requestedUrl = '';
  let settled = false;
  class PendingImage {
    set src(value) { requestedUrl = value; }
    decode() { return decoding.promise; }
  }
  const fetch = async url => {
    assert.match(String(url), /^\/api\/image-info\?path=/);
    return {ok: true, json: async () => ({width: 3000, height: 4000, mimeType: 'image/jpeg'})};
  };

  await withGlobals({Image: PendingImage, fetch}, async () => {
    const prepared = preparePhotoSource({path: 'album/one.jpg', name: 'one.jpg'}).then(value => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settled, false, 'source must not become ready while original decode is pending');
    decoding.resolve();
    const source = await prepared;
    assert.equal(requestedUrl, '/api/media?path=album%2Fone.jpg');
    assert.equal(source.name, 'one.jpg');
    assert.equal(settled, true);
  });
});

test('a rejected original reports a stable failure and a later retry can succeed', async () => {
  let attempt = 0;
  class RetriedImage {
    decode() {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('broken pixels')) : Promise.resolve();
    }
    set src(_value) {}
  }

  await withGlobals({Image: RetriedImage}, async () => {
    await assert.rejects(
      decodeSourceImage('/api/media?path=album%2Fbroken.jpg'),
      {message: 'Не удалось декодировать фотографию'},
    );
    await decodeSourceImage('/api/media?path=album%2Fbroken.jpg');
    assert.equal(attempt, 2);
  });
});

test('Safari fallback waits for load when Image.decode is unavailable', async () => {
  let requestedUrl = '';
  class LoadOnlyImage {
    set src(value) {
      requestedUrl = value;
      queueMicrotask(() => this.onload?.());
    }
  }

  await withGlobals({Image: LoadOnlyImage}, async () => {
    await decodeSourceImage('/api/media?path=album%2Fsafari.jpg');
    assert.equal(requestedUrl, '/api/media?path=album%2Fsafari.jpg');
  });
});

test('Safari fallback rejects an original load failure', async () => {
  class FailedImage {
    set src(_value) { queueMicrotask(() => this.onerror?.()); }
  }

  await withGlobals({Image: FailedImage}, async () => {
    await assert.rejects(
      decodeSourceImage('/api/media?path=album%2Fmissing.jpg'),
      {message: 'Не удалось загрузить фотографию'},
    );
  });
});

test('TIFF paths are excluded from collage sources while browser-decodable formats remain available', () => {
  assert.equal(isCollageSupportedPath('album/photo.tif'), false);
  assert.equal(isCollageSupportedPath('album/photo.TIFF'), false);
  assert.equal(isCollageSupportedPath('album/photo.jpg'), true);
  assert.equal(isCollageSupportedPath('album/photo.png'), true);
});

test('camera EXIF display dimensions flow unchanged into crop quality for rotations and mirrors', async () => {
  const cases = [
    {orientation: 1, width: 4000, height: 3000},
    {orientation: 2, width: 4000, height: 3000},
    {orientation: 3, width: 4000, height: 3000},
    {orientation: 5, width: 3000, height: 4000},
    {orientation: 6, width: 3000, height: 4000},
    {orientation: 7, width: 3000, height: 4000},
    {orientation: 8, width: 3000, height: 4000},
  ];
  for (const item of cases) {
    const fetch = async url => {
      assert.match(String(url), /^\/api\/image-info\?path=/);
      return {ok: true, json: async () => ({width: item.width, height: item.height, mimeType: 'image/jpeg'})};
    };
    await withGlobals({fetch}, async () => {
      const source = await resolvePhotoSource({path: `camera/orientation-${item.orientation}.jpg`});
      assert.deepEqual([source.width, source.height], [item.width, item.height]);
      const quality = runPreflight(
        {layout: {cells: [{id: 'cell', x: 0, y: 0, width: 1, height: 1}]}, placements: [{cellId: 'cell', sourceId: source.id, crop: {x: 0, y: 0, width: 1, height: 1}}]},
        {widthMm: item.width / 100 * 25.4, heightMm: item.height / 100 * 25.4, ppi: 300},
        {[source.id]: {width: source.width, height: source.height}},
      );
      assert.equal(Math.round(quality.weakestPpi), 100, `orientation ${item.orientation}`);
      assert.equal(quality.issues.some(issue => issue.kind === 'distortion'), false, `orientation ${item.orientation}`);
    });
  }
});
