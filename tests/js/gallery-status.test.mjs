import assert from 'node:assert/strict';
import test from 'node:test';

import {createStatusPoller, describeStatus, errorSubject, formatMoment, isRelativeMediaPath, stateLabel, STATUS_POLL_MS} from '../../web/gallery-status.js';
import {formatCount} from '../../web/format.js';

const now = new Date(2026, 9, 23, 13, 30);
/** Tiles read as `value label`, the same text the surface shows. */
const texts = metrics => (metrics ?? []).map(({value, label}) => `${value} ${label}`);
const local = (day, hours, minutes) => new Date(2026, 9, day, hours, minutes).toISOString();

const running = {
  version: 1,
  state: 'running',
  run: {state: 'running', phase: 'thumbnails', startedAt: local(23, 10, 0), updatedAt: local(23, 13, 29), scanned: 400, processed: 120, generated: 30, skipped: 89, errors: 1, total: 400, progress: 0.3},
  cache: {mediaFiles: 400, images: 380, videos: 20, readyThumbnails: 390, missingThumbnails: 8, unavailableThumbnails: 2, sizeBytes: 1288490189, lastFullScanAt: local(22, 3, 5)},
  recentErrors: [
    {at: local(23, 10, 1), operation: 'thumbnail', path: '2024/a.jpg', error: 'decode: unexpected EOF'},
    {at: local(23, 10, 2), operation: 'walk', path: 'locked', error: 'open: permission denied'},
  ],
  recentErrorsLimit: 20,
  memories: {state: 'ready', updatedAt: local(23, 3, 6), readyVersion: 'abc123', readyAt: local(23, 3, 6), periods: 147, memories: 12, shown: 6, errors: 0},
};

test('only three run-state labels exist', () => {
  assert.equal(stateLabel('running'), 'Выполняется');
  assert.equal(stateLabel('ready'), 'Готово');
  for (const other of ['unavailable', 'succeeded', 'failed', undefined, 7]) assert.equal(stateLabel(other), 'Статус недоступен');
});

test('moments read as today, yesterday, a date this year, or a dated past year', () => {
  assert.equal(formatMoment(new Date(2026, 9, 23, 10, 0), now), 'сегодня в 10:00');
  assert.equal(formatMoment(new Date(2026, 9, 22, 23, 5), now), 'вчера в 23:05');
  assert.equal(formatMoment(new Date(2026, 9, 1, 9, 5), now), '1 октября в 09:05');
  assert.match(formatMoment(new Date(2025, 2, 3, 9, 5), now), /^3 марта 2025.* в 09:05$/);
  assert.equal(formatMoment(new Date(2026, 0, 31, 8, 0), new Date(2026, 1, 1, 9, 0)), 'вчера в 08:00');
});

test('counts keep the number and label together with Russian plurals', () => {
  assert.equal(formatCount(147, ['период', 'периода', 'периодов']), '147 периодов');
  assert.equal(formatCount(12, ['воспоминание', 'воспоминания', 'воспоминаний']), '12 воспоминаний');
  assert.equal(formatCount(0, ['ошибка', 'ошибки', 'ошибок']), '0 ошибок');
  assert.equal(formatCount(21, ['ошибка', 'ошибки', 'ошибок']), '21 ошибка');
  assert.equal(formatCount(3, ['ошибка', 'ошибки', 'ошибок']), '3 ошибки');
});

test('a running warm shows its start, progress and run metrics', () => {
  const view = describeStatus(running, now);
  assert.equal(view.run.line, 'Текущий запуск — Выполняется');
  assert.equal(view.run.started, 'Запущен: сегодня в 10:00');
  assert.deepEqual(view.run.progress, {value: 120, max: 400, text: '120 / 400 · 30%'});
  assert.deepEqual(texts(view.run.metrics), ['120 обработано', '30 создано', '89 пропущено', '1 ошибка']);
  assert.deepEqual(texts(view.cache?.metrics), ['400 медиафайлов', '390 миниатюр готово', '8 миниатюр отсутствует', '2 миниатюры недоступны', '1.2 ГБ размер кэша']);
  assert.equal(view.cache?.lastFullScan, 'Последний полный обход: вчера в 03:05');
});

test('each metric is a tile: the number apart from its plural label', () => {
  const view = describeStatus(running, now);
  assert.deepEqual(view.run.metrics[3], {value: '1', label: 'ошибка'});
  assert.deepEqual(view.cache?.metrics[1], {value: '390', label: 'миниатюр готово'});
  assert.deepEqual(view.cache?.metrics.at(-1), {value: '1.2 ГБ', label: 'размер кэша'});
  assert.deepEqual(view.memories.metrics[0], {value: '147', label: 'периодов'});
  assert.equal(describeStatus({...running, run: {...running.run, errors: 22}}, now).run.metrics[3].label, 'ошибки');
});

test('the cache size tile is shown only for a valid size; zero reads as 0 Б', () => {
  const sized = sizeBytes => describeStatus({...running, cache: {...running.cache, sizeBytes}}, now).cache?.metrics;
  assert.deepEqual(sized(0)?.at(-1), {value: '0 Б', label: 'размер кэша'});
  for (const invalid of [undefined, -1, 1.5, '12']) assert.equal(sized(invalid)?.length, 4, String(invalid));
});

test('a finished run is ready and progress is computed when the server omits it', () => {
  const run = {...running.run, state: 'succeeded', processed: 400, progress: undefined};
  const view = describeStatus({...running, state: 'ready', run}, now);
  assert.equal(view.run.line, 'Текущий запуск — Готово');
  assert.equal(view.run.progress?.text, '400 / 400 · 100%');
  const noTotal = describeStatus({...running, run: {...running.run, total: undefined, progress: undefined}}, now);
  assert.equal(noTotal.run.progress, null);
});

test('a failed request, a malformed document and a missing cache block read as unavailable', () => {
  for (const status of [null, 'oops', {}]) {
    const view = describeStatus(status, now);
    assert.equal(view.run.line, 'Текущий запуск — Статус недоступен');
    assert.equal(view.run.started, '');
    assert.deepEqual(view.run.metrics, []);
    assert.equal(view.cache, null);
    assert.deepEqual(view.errors, []);
    assert.equal(view.memories.line, 'Статус недоступен');
    assert.deepEqual(view.memories.metrics, []);
  }
  const noCache = describeStatus({...running, cache: undefined}, now);
  assert.equal(noCache.cache, null);
  assert.equal(noCache.run.line, 'Текущий запуск — Выполняется');
});

test('a stale or failed run keeps its start but is unavailable', () => {
  const view = describeStatus({...running, state: 'unavailable', run: {...running.run, stale: true}}, now);
  assert.equal(view.run.line, 'Текущий запуск — Статус недоступен');
  assert.equal(view.run.started, 'Запущен: сегодня в 10:00');
});

test('recent errors are newest first and never show absolute or escaping paths', () => {
  const recentErrors = [
    ...running.recentErrors,
    {path: '/volume1/photo/x.jpg', error: 'leak'},
    {path: 'C:\\photos\\x.jpg', error: 'leak'},
    {path: '../outside.jpg', error: 'leak'},
    {path: '', error: 'memories write failed'},
  ];
  const view = describeStatus({...running, recentErrors}, now);
  assert.deepEqual(view.errors, [
    {path: 'locked', error: 'open: permission denied'},
    {path: '2024/a.jpg', error: 'decode: unexpected EOF'},
  ]);
  for (const path of ['/a', '\\a', 'C:/a', 'a/../b', '']) assert.equal(isRelativeMediaPath(path), false, path);
  assert.equal(isRelativeMediaPath('2024/a b.jpg'), true);
  assert.deepEqual(describeStatus({...running, recentErrors: []}, now).errors, []);
});

test('service errors without a path stay visible under a neutral name', () => {
  const recentErrors = [
    {operation: 'walk', path: 'locked', error: 'open: permission denied'},
    {operation: 'date-index', path: '', error: 'write date index: permission denied'},
    {operation: 'memories', path: '', error: 'write memories: permission denied'},
    {operation: 'metadata-cache', path: '', error: 'rename: permission denied'},
    {operation: 'thumbnail', path: '/volume1/photo/secret.jpg', error: 'leak'},
    {operation: 'memories', path: 'C:\\photos', error: 'leak'},
    {operation: 'walk', path: '../escape.jpg', error: 'leak'},
    {operation: 'Bad Op', path: '', error: 'raw'},
    {operation: 'constructor', path: '', error: 'proto'},
    {path: '', error: 'no operation'},
  ];
  const view = describeStatus({...running, recentErrors}, now);
  assert.deepEqual(view.errors, [
    {path: 'Служебная операция', error: 'proto'},
    {path: 'Служебная операция', error: 'rename: permission denied'},
    {path: 'Сборка воспоминаний', error: 'write memories: permission denied'},
    {path: 'Индекс дат', error: 'write date index: permission denied'},
    {path: 'locked', error: 'open: permission denied'},
  ]);
  for (const entry of view.errors) assert.doesNotMatch(entry.path, /date-index|memories|metadata-cache|constructor/);
  assert.equal(errorSubject({operation: 'memories', path: '/abs'}), '');
  assert.equal(errorSubject(null), '');
});

test('the error list is empty only when no safe entry remains', () => {
  const unsafe = [{operation: 'thumbnail', path: '/volume1/a.jpg', error: 'x'}, {path: '', error: 'no operation'}];
  assert.deepEqual(describeStatus({...running, recentErrors: unsafe}, now).errors, []);
  assert.equal(describeStatus({...running, recentErrors: [...unsafe, {operation: 'memories', path: '', error: 'x'}]}, now).errors.length, 1);
});

test('memories show state, last ready version and compact metrics', () => {
  const view = describeStatus(running, now);
  assert.equal(view.memories.line, 'Готово');
  assert.equal(view.memories.readyVersion, 'Последняя готовая версия: сегодня в 03:06');
  assert.deepEqual(texts(view.memories.metrics), ['147 периодов', '12 воспоминаний', '6 показано', '0 ошибок']);
});

test('unavailable memories keep the last known good version', () => {
  const memories = {state: 'unavailable', updatedAt: local(23, 4, 0), readyVersion: 'abc123', readyAt: local(22, 3, 6), periods: 147, memories: 12, shown: 6, errors: 1};
  const view = describeStatus({...running, memories}, now);
  assert.equal(view.memories.line, 'Статус недоступен');
  assert.equal(view.memories.readyVersion, 'Последняя готовая версия: вчера в 03:06');
  assert.deepEqual(texts(view.memories.metrics), ['147 периодов', '12 воспоминаний', '6 показано', '1 ошибка']);
  const bare = describeStatus({...running, memories: {state: 'unavailable'}}, now);
  assert.equal(bare.memories.readyVersion, '');
  assert.deepEqual(bare.memories.metrics, []);
});

function fakeTimers() {
  const timers = new Map();
  let next = 1;
  return {
    timers,
    setTimer(callback, ms) {
      timers.set(next, {callback, ms});
      return next++;
    },
    clearTimer(handle) { timers.delete(handle); },
    fire() {
      const [[handle, timer]] = timers;
      timers.delete(handle);
      timer.callback();
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return {promise, resolve, reject};
}

const settle = () => new Promise(resolve => setImmediate(resolve));

function poller({hidden = () => false} = {}) {
  const timers = fakeTimers();
  const requests = [];
  const results = [];
  const instance = createStatusPoller({
    load: signal => {
      const request = deferred();
      requests.push({...request, signal});
      return request.promise;
    },
    onResult: status => results.push(status),
    isHidden: hidden,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return {instance, timers, requests, results};
}

test('opening loads once and polls with one timer while the warmer runs', async () => {
  const {instance, timers, requests, results} = poller();
  instance.open();
  instance.open();
  assert.equal(requests.length, 1, 'a second open does not start another request');
  requests[0].resolve({state: 'running'});
  await settle();
  assert.equal(results.length, 1);
  assert.equal(timers.timers.size, 1);
  assert.equal([...timers.timers.values()][0].ms, STATUS_POLL_MS);

  timers.fire();
  assert.equal(requests.length, 2);
  assert.equal(timers.timers.size, 0, 'no timer while a request is in flight');
  requests[1].resolve({state: 'ready'});
  await settle();
  assert.equal(timers.timers.size, 0, 'polling ends once the warmer is done');
  assert.equal(instance.pending, false);
});

test('leaving stops polling, aborts the request and ignores its late result', async () => {
  const {instance, timers, requests, results} = poller();
  instance.open();
  requests[0].resolve({state: 'running'});
  await settle();
  timers.fire();
  instance.close();
  assert.equal(requests[1].signal.aborted, true);
  requests[1].resolve({state: 'running'});
  await settle();
  assert.equal(results.length, 1);
  assert.equal(timers.timers.size, 0);
  assert.equal(instance.active, false);

  instance.open();
  instance.close();
  instance.open();
  assert.equal(requests.length, 4, 'reopening starts a fresh request each time');
  requests[2].resolve({state: 'running'});
  requests[3].resolve({state: 'running'});
  await settle();
  assert.equal(results.length, 2, 'only the current request renders');
  assert.equal(timers.timers.size, 1, 'one timer after repeated open/close');
});

test('a failed request reports null and does not retry', async () => {
  const {instance, timers, requests, results} = poller();
  instance.open();
  requests[0].reject(new Error('HTTP 500'));
  await settle();
  assert.deepEqual(results, [null]);
  assert.equal(timers.timers.size, 0);
});

test('a hidden tab drops the timer and reloads once when visible again', async () => {
  let hidden = false;
  const {instance, timers, requests} = poller({hidden: () => hidden});
  instance.open();
  requests[0].resolve({state: 'running'});
  await settle();
  hidden = true;
  instance.hidden();
  assert.equal(timers.timers.size, 0);
  hidden = false;
  instance.visible();
  instance.visible();
  assert.equal(requests.length, 2);
  instance.close();
  instance.visible();
  assert.equal(requests.length, 2, 'nothing loads after leaving');
});
