import assert from 'node:assert/strict';
import test from 'node:test';

import {createLoadQueue} from '../../web/load-queue.js';
import {createPosterGenerator} from '../../web/video-posters.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const video = {path: 'Album/clip.mp4', modTime: '2026-01-15T12:00:00Z', size: 1000};

/** A generator whose runs finish only when the test settles them. */
function controlledGenerator() {
  const runs = [];
  const generate = item => new Promise((resolve, reject) => runs.push({item, resolve, reject}));
  return {runs, generate};
}

/** A tile subscription that records what it received. */
function tile(generator, item = video) {
  const controller = new AbortController();
  const received = {ready: [], failures: 0};
  generator.request(item, {
    signal: controller.signal,
    onReady: url => received.ready.push(url),
    onFailure: () => { received.failures++; },
  });
  return {controller, received};
}

test('a tile that returns during a running generation gets its poster without a second run', async () => {
  const {runs, generate} = controlledGenerator();
  const generator = createPosterGenerator({queue: createLoadQueue({concurrency: 1}), generate});
  const first = tile(generator);
  await tick();
  assert.equal(runs.length, 1);

  // The first tile leaves the window while the poster is being generated.
  first.controller.abort();
  assert.equal(generator.pending, 1);
  const second = tile(generator);
  const third = tile(generator);
  third.controller.abort();
  await tick();
  assert.equal(runs.length, 1);

  runs[0].resolve('/api/video-poster?ready=1');
  await tick();
  assert.deepEqual(first.received, {ready: [], failures: 0});
  assert.deepEqual(second.received, {ready: ['/api/video-poster?ready=1'], failures: 0});
  assert.deepEqual(third.received, {ready: [], failures: 0});
  assert.equal(generator.pending, 0);
});

test('a failed generation reaches only active tiles and is not retried', async () => {
  const {runs, generate} = controlledGenerator();
  const generator = createPosterGenerator({queue: createLoadQueue({concurrency: 1}), generate});
  const gone = tile(generator);
  const active = tile(generator);
  await tick();
  gone.controller.abort();
  runs[0].reject(new Error('no frame'));
  await tick();
  assert.equal(gone.received.failures, 0);
  assert.equal(active.received.failures, 1);
  assert.equal(generator.pending, 0);
  const later = tile(generator);
  assert.equal(later.received.failures, 1);
  await tick();
  assert.equal(runs.length, 1);
});

test('one generation per version runs at a time, and a queued one without tiles is dropped', async () => {
  const {runs, generate} = controlledGenerator();
  const queue = createLoadQueue({concurrency: 1});
  const generator = createPosterGenerator({queue, generate});
  const other = {...video, path: 'Album/other.mp4'};
  const changed = {...video, size: 2000};
  tile(generator);
  const queued = tile(generator, other);
  const twin = tile(generator, other);
  tile(generator, changed);
  await tick();
  assert.equal(runs.length, 1);
  assert.equal(generator.pending, 3);

  // Leaving and returning while queued keeps one job; leaving for good drops it.
  queued.controller.abort();
  assert.equal(generator.pending, 3);
  twin.controller.abort();
  assert.equal(generator.pending, 2);
  assert.equal(queue.queued, 1);

  runs[0].resolve('ready');
  await tick();
  await tick();
  assert.deepEqual(runs.map(run => run.item), [video, changed]);
});

test('paused work waits and starts on resume', async () => {
  const {runs, generate} = controlledGenerator();
  const queue = createLoadQueue({concurrency: 1});
  const generator = createPosterGenerator({queue, generate});
  queue.setConcurrency(0);
  const waiting = tile(generator);
  await tick();
  assert.equal(runs.length, 0);
  queue.setConcurrency(1);
  await tick();
  assert.equal(runs.length, 1);
  runs[0].resolve('ready');
  await tick();
  assert.deepEqual(waiting.received.ready, ['ready']);
});
