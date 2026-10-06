import assert from 'node:assert/strict';
import test from 'node:test';

import {createPhotoLoadingBarrier} from '../../web/collage/loading-barrier.js';

const entries = [
  {path: 'first/a.jpg', name: 'a.jpg'},
  {path: 'second/b.jpg', name: 'b.jpg'},
  {path: 'second/c.jpg', name: 'c.jpg'},
];

const source = entry => ({id: `source:${entry.path}`, path: entry.path, name: entry.name});

test('readiness progress reports N/M and cannot finish until every thumbnail is ready', () => {
  const barrier = createPhotoLoadingBarrier(entries);

  assert.deepEqual(
    {...barrier.snapshot(), entries: undefined, sources: undefined, failures: undefined},
    {entries: undefined, sources: undefined, failures: undefined, total: 3, readyCount: 0, loadingCount: 3, canFinish: false, canRemove: true},
  );
  barrier.succeed(entries[0].path, source(entries[0]));
  let snapshot = barrier.snapshot();
  assert.deepEqual([snapshot.readyCount, snapshot.total, snapshot.loadingCount, snapshot.canFinish], [1, 3, 2, false]);

  barrier.succeed(entries[1].path, source(entries[1]));
  snapshot = barrier.snapshot();
  assert.deepEqual([snapshot.readyCount, snapshot.total, snapshot.loadingCount, snapshot.canFinish], [2, 3, 1, false]);

  barrier.succeed(entries[2].path, source(entries[2]));
  snapshot = barrier.snapshot();
  assert.deepEqual([snapshot.readyCount, snapshot.total, snapshot.loadingCount, snapshot.canFinish], [3, 3, 0, true]);
  assert.deepEqual(snapshot.sources.map(item => item.id), entries.map(item => source(item).id));
});

test('a named thumbnail failure blocks atomic hydrate/autofill and exposes no broken source', () => {
  const barrier = createPhotoLoadingBarrier(entries.slice(0, 2));
  barrier.succeed(entries[0].path, source(entries[0]));
  barrier.fail(entries[1].path, new Error('Не удалось декодировать превью фотографии'));

  const snapshot = barrier.snapshot();
  assert.equal(snapshot.canFinish, false, 'partial ready state must never authorize a project commit');
  assert.deepEqual(snapshot.sources.map(item => item.id), [source(entries[0]).id]);
  assert.equal(snapshot.failures.length, 1);
  assert.equal(snapshot.failures[0].entry.name, 'b.jpg');
  assert.equal(snapshot.failures[0].error.message, 'Не удалось декодировать превью фотографии');
  assert.deepEqual([snapshot.readyCount, snapshot.total, snapshot.loadingCount], [1, 2, 0]);
});

test('retry clears the named failure, returns to loading progress, and succeeds atomically', () => {
  const barrier = createPhotoLoadingBarrier(entries.slice(0, 2));
  barrier.succeed(entries[0].path, source(entries[0]));
  barrier.fail(entries[1].path, new Error('broken thumbnail'));
  assert.equal(barrier.snapshot().canFinish, false);

  assert.equal(barrier.start(entries[1].path), true);
  let snapshot = barrier.snapshot();
  assert.deepEqual([snapshot.readyCount, snapshot.total, snapshot.loadingCount], [1, 2, 1]);
  assert.deepEqual(snapshot.failures, []);
  assert.equal(snapshot.canFinish, false);

  assert.equal(barrier.succeed(entries[1].path, source(entries[1])), true);
  snapshot = barrier.snapshot();
  assert.equal(snapshot.canFinish, true);
  assert.deepEqual(snapshot.sources.map(item => item.id), entries.slice(0, 2).map(item => source(item).id));
});

test('removing a failed photo permits continuation only when at least two ready photos remain', () => {
  const barrier = createPhotoLoadingBarrier(entries);
  barrier.succeed(entries[0].path, source(entries[0]));
  barrier.succeed(entries[1].path, source(entries[1]));
  barrier.fail(entries[2].path, new Error('broken thumbnail'));
  assert.equal(barrier.snapshot().canFinish, false);
  assert.equal(barrier.snapshot().canRemove, true);

  assert.equal(barrier.remove(entries[2].path), true);
  let snapshot = barrier.snapshot();
  assert.deepEqual([snapshot.readyCount, snapshot.total, snapshot.canFinish, snapshot.canRemove], [2, 2, true, false]);
  assert.deepEqual(snapshot.failures, []);

  const minimumBarrier = createPhotoLoadingBarrier(entries.slice(0, 2));
  minimumBarrier.succeed(entries[0].path, source(entries[0]));
  minimumBarrier.fail(entries[1].path, new Error('broken thumbnail'));
  assert.equal(minimumBarrier.remove(entries[1].path), false);
  snapshot = minimumBarrier.snapshot();
  assert.deepEqual([snapshot.readyCount, snapshot.total, snapshot.canFinish, snapshot.canRemove], [1, 2, false, false]);
  assert.equal(snapshot.failures[0].entry.name, 'b.jpg');
});

test('unknown and duplicate entry paths cannot perturb readiness accounting', () => {
  const barrier = createPhotoLoadingBarrier([entries[0], {...entries[0], name: 'duplicate.jpg'}, entries[1]]);
  assert.equal(barrier.snapshot().total, 2);
  assert.equal(barrier.succeed('missing.jpg', {id: 'unexpected'}), false);
  assert.equal(barrier.fail('missing.jpg', new Error('unexpected')), false);
  assert.equal(barrier.start('missing.jpg'), false);
  assert.equal(barrier.remove('missing.jpg'), false);
  assert.deepEqual([barrier.snapshot().readyCount, barrier.snapshot().loadingCount], [0, 2]);
});
