import assert from 'node:assert/strict';
import test from 'node:test';

import {commitPreviewFrame} from '../../web/collage/preview.js';

function mockCanvas(width, height, withContext = true) {
  const draws = [];
  let contextRequests = 0;
  return {
    width,
    height,
    draws,
    get contextRequests() { return contextRequests; },
    getContext(kind, options) {
      contextRequests += 1;
      assert.equal(kind, '2d');
      assert.deepEqual(options, {alpha: false});
      return withContext ? {drawImage: (...args) => draws.push(args)} : null;
    },
  };
}

test('a stale preview revision is rejected without touching the visible canvas', () => {
  const visible = mockCanvas(640, 480);
  const staleBuffer = mockCanvas(1200, 800);
  assert.equal(commitPreviewFrame(visible, staleBuffer, 4, 5), false);
  assert.deepEqual([visible.width, visible.height], [640, 480]);
  assert.equal(visible.contextRequests, 0);
  assert.deepEqual(visible.draws, []);
});

test('the latest preview revision atomically promotes the complete buffer', () => {
  const visible = mockCanvas(640, 480);
  const latestBuffer = mockCanvas(900, 1350);
  assert.equal(commitPreviewFrame(visible, latestBuffer, 7, 7), true);
  assert.deepEqual([visible.width, visible.height], [900, 1350]);
  assert.equal(visible.contextRequests, 1);
  assert.deepEqual(visible.draws, [[latestBuffer, 0, 0]]);
});

test('an older render cannot overwrite a newer frame that has already committed', () => {
  const visible = mockCanvas(1, 1);
  const latestBuffer = mockCanvas(800, 1200);
  const staleBuffer = mockCanvas(1200, 800);
  assert.equal(commitPreviewFrame(visible, latestBuffer, 11, 11), true);
  const drawsAfterLatest = [...visible.draws];

  assert.equal(commitPreviewFrame(visible, staleBuffer, 10, 11), false);
  assert.deepEqual([visible.width, visible.height], [800, 1200]);
  assert.deepEqual(visible.draws, drawsAfterLatest);
  assert.equal(visible.contextRequests, 1);
});

test('latest commit fails without mutating dimensions when a 2D context is unavailable', () => {
  const visible = mockCanvas(320, 240, false);
  const buffer = mockCanvas(900, 1350);
  assert.equal(commitPreviewFrame(visible, buffer, 3, 3), false);
  assert.deepEqual([visible.width, visible.height], [320, 240]);
  assert.deepEqual(visible.draws, []);
});
