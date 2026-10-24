import assert from 'node:assert/strict';
import test from 'node:test';

import {fakeTimers, settle} from './fake-timers.mjs';
import {createSearchRequests, describeCount, describeMessage, describeScope, normalizeQuery, relativeFolder, relativePath, SEARCH_DEBOUNCE_MS, searchURL} from '../../web/search.js';

const item = path => ({name: path.split('/').pop(), path, kind: 'image'});

/** Requests whose answers the test releases by hand, in any order. */
function heldLoader() {
  const calls = [];
  const load = (query, signal) => new Promise((resolve, reject) => {
    calls.push({query, signal, resolve: entries => resolve({entries, truncated: false}), reject});
  });
  return {calls, load};
}

function requests(load) {
  const timers = fakeTimers();
  const answers = [];
  const search = createSearchRequests({load, onAnswer: answer => answers.push(answer), setTimer: timers.setTimer, clearTimer: timers.clearTimer});
  return {timers, answers, search};
}

test('queries ignore case, surrounding spaces, and Unicode form', () => {
  assert.equal(normalizeQuery('  SeA  '), 'sea');
  assert.equal(normalizeQuery('Йошкар'.normalize('NFD')), 'йошкар');
  assert.equal(searchURL('paris/sea day'), '/api/search?q=paris%2Fsea%20day');
});

test('an empty query sends nothing and answers idle', async () => {
  const {calls, load} = heldLoader();
  const {timers, answers, search} = requests(load);
  search.run('');
  await timers.advance(SEARCH_DEBOUNCE_MS * 4);
  assert.equal(calls.length, 0);
  assert.deepEqual(answers.map(answer => answer.state), ['idle']);
});

test('a request waits for the debounce; typing again restarts it', async () => {
  const {calls, load} = heldLoader();
  const {timers, answers, search} = requests(load);
  search.run('s');
  await timers.advance(SEARCH_DEBOUNCE_MS - 1);
  search.run('se');
  await timers.advance(SEARCH_DEBOUNCE_MS - 1);
  assert.equal(calls.length, 0);
  await timers.advance(1);
  assert.deepEqual(calls.map(call => call.query), ['se']);
  calls[0].resolve([item('Trip/Sea.jpg')]);
  await settle();
  assert.deepEqual(answers.map(answer => answer.state), ['loading', 'loading', 'ready']);
  assert.deepEqual(answers.at(-1).entries.map(entry => entry.path), ['Trip/Sea.jpg']);
});

test('the latest query wins: the previous request is aborted and its late answer dropped', async () => {
  const {calls, load} = heldLoader();
  const {timers, answers, search} = requests(load);
  search.run('sea');
  await timers.advance(SEARCH_DEBOUNCE_MS);
  search.run('paris');
  assert.equal(calls[0].signal.aborted, true);
  await timers.advance(SEARCH_DEBOUNCE_MS);
  calls[1].resolve([item('Trip/Paris/louvre.png')]);
  calls[0].resolve([item('Trip/Sea.jpg')]);
  await settle();
  const ready = answers.filter(answer => answer.state === 'ready');
  assert.deepEqual(ready.map(answer => answer.query), ['paris']);
  assert.equal(calls[1].signal.aborted, false);
});

test('clearing the field cancels a pending request', async () => {
  const {calls, load} = heldLoader();
  const {timers, answers, search} = requests(load);
  search.run('sea');
  await timers.advance(SEARCH_DEBOUNCE_MS);
  search.run('');
  assert.equal(calls[0].signal.aborted, true);
  calls[0].resolve([item('Trip/Sea.jpg')]);
  await settle();
  assert.equal(answers.at(-1).state, 'idle');
  assert.equal(timers.live.size, 0);
});

test('HTTP 503 answers unavailable; other failures answer error', async () => {
  for (const [failure, state] of [[Object.assign(new Error('HTTP 503'), {status: 503}), 'unavailable'], [Object.assign(new Error('HTTP 500'), {status: 500}), 'error'], [new TypeError('offline'), 'error']]) {
    const {timers, answers, search} = requests(() => Promise.reject(failure));
    search.run('sea');
    await timers.advance(SEARCH_DEBOUNCE_MS);
    assert.equal(answers.at(-1).state, state);
    assert.deepEqual(answers.at(-1).entries, []);
  }
});

test('relative path and folder are measured from the opened folder; the root has no prefix', () => {
  const deep = item('Trips/Paris/Night/eiffel.mp4');
  assert.equal(relativePath(deep, 'Trips'), 'Paris/Night/eiffel.mp4');
  assert.equal(relativeFolder(deep, 'Trips'), 'Paris/Night');
  assert.equal(relativeFolder(deep, ''), 'Trips/Paris/Night');
  assert.equal(relativeFolder(item('top.jpg'), ''), '');
});

test('scope, count, and message copy', () => {
  assert.equal(describeScope('all'), 'По именам файлов и папок во всей галерее');
  assert.equal(describeScope('video'), 'По именам файлов и папок во всей галерее · только видео');
  assert.equal(describeCount({state: 'loading', count: 3, truncated: false}), 'Поиск…');
  assert.equal(describeCount({state: 'ready', count: 1, truncated: false}), 'Найдено: 1 файл');
  assert.equal(describeCount({state: 'ready', count: 2000, truncated: true}), 'Найдено: 2000 файлов · показаны не все, уточните запрос');
  assert.equal(describeCount({state: 'idle', count: 0, truncated: false}), '');

  const message = options => describeMessage({query: 'zzz', found: 0, count: 0, filter: 'all', ...options});
  assert.equal(message({state: 'idle'}).title, 'Что найти?');
  assert.equal(message({state: 'loading'}), null);
  assert.equal(message({state: 'unavailable'}).title, 'Поиск пока готовится');
  assert.equal(message({state: 'error'}).title, 'Не удалось выполнить поиск');
  assert.equal(message({state: 'ready', found: 2, count: 2}), null);
  assert.deepEqual(message({state: 'ready'}), {title: 'Ничего не найдено', hint: 'В галерее нет файлов и папок, имя которых содержит «zzz»'});
  assert.equal(message({state: 'ready', found: 2, filter: 'image'}).hint, 'Фильтр «Фото» скрывает найденные файлы');
});
