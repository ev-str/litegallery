import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COVER_SIZE,
  formatMemoryContents,
  formatMemoryPeriod,
  MEMORIES_SHOWN_LIMIT,
  memoriesView,
  memoryViewerItems,
  pickCoverMedia,
  readMemoriesResponse,
} from '../../web/memories.js';

const media = (count, kind = 'image', folder = 'Album') => Array.from({length: count}, (_, index) => ({
  path: `${folder}/IMG_${String(index + 1).padStart(2, '0')}.jpg`,
  kind,
  sortTime: 1_700_000_000 + index,
}));

const event = (id, items = media(5)) => {
  const [startDate, endDate] = id.split('_');
  return {id, year: Number(startDate.slice(0, 4)), startDate, endDate, anchorDate: '2026-10-20', mediaCount: items.length, media: items};
};

const events = count => Array.from({length: count}, (_, index) => event(`${2025 - index}-10-0${1 + (index % 5)}_${2025 - index}-10-0${5 + (index % 5)}`));

const ready = (list, extra = {}) => ({version: 1, state: 'ready', generatedAt: '2026-10-23T03:00:00Z', revision: 'abc123', shown: Math.min(6, list.length), events: list, ...extra});

test('periods read as calendar ranges in Russian', () => {
  assert.equal(formatMemoryPeriod('2023-10-05', '2023-10-05'), '5 октября 2023');
  assert.equal(formatMemoryPeriod('2023-10-03', '2023-10-09'), '3–9 октября 2023');
  assert.equal(formatMemoryPeriod('2023-09-28', '2023-10-04'), '28 сентября – 4 октября 2023');
  assert.equal(formatMemoryPeriod('2022-12-29', '2023-01-03'), '29 декабря 2022 – 3 января 2023');
  assert.equal(formatMemoryPeriod('2024-02-29', '2024-03-02'), '29 февраля – 2 марта 2024');
});

test('an unparsable date falls back to the raw values', () => {
  assert.equal(formatMemoryPeriod('2023-13-01', '2023-13-02'), '2023-13-01 – 2023-13-02');
});

test('contents count photos and videos separately', () => {
  assert.equal(formatMemoryContents(media(5)), '5 фото');
  assert.equal(formatMemoryContents([...media(12), ...media(2, 'video')]), '12 фото · 2 видео');
  assert.equal(formatMemoryContents(media(1, 'video')), '1 видео');
});

test('the cover spreads photos over the event and keeps backend order', () => {
  const list = media(10);
  assert.deepEqual(pickCoverMedia(list).map(item => item.path), [0, 3, 6, 9].map(index => list[index].path));
  assert.equal(pickCoverMedia(list).length, COVER_SIZE);
  assert.deepEqual(pickCoverMedia(media(3)), media(3));
  assert.deepEqual(pickCoverMedia(media(7), 1), [media(7)[0]]);
});

test('the cover prefers photos and fills with videos only when photos run out', () => {
  const list = [...media(2, 'video', 'V'), ...media(6)];
  assert.ok(pickCoverMedia(list).every(item => item.kind === 'image'));
  const mixed = [media(1, 'video', 'V')[0], ...media(2), ...media(3, 'video', 'W')];
  const cover = pickCoverMedia(mixed);
  assert.equal(cover.length, 4);
  assert.deepEqual(cover.map(item => mixed.indexOf(item)), [...cover.map(item => mixed.indexOf(item))].sort((a, b) => a - b));
  assert.equal(cover.filter(item => item.kind === 'image').length, 2);
});

test('a ready response keeps event order and the backend shown count', () => {
  const list = events(9);
  const model = readMemoriesResponse(ready(list));
  assert.equal(model.state, 'ready');
  assert.deepEqual(model.events.map(item => item.id), list.map(item => item.id));
  assert.equal(model.shown, 6);
  assert.equal(model.version, '2026-10-23T03:00:00Z');
});

test('shown never exceeds six or the number of events', () => {
  assert.equal(readMemoriesResponse(ready(events(9), {shown: 9})).shown, MEMORIES_SHOWN_LIMIT);
  assert.equal(readMemoriesResponse(ready(events(2), {shown: 6})).shown, 2);
  assert.equal(readMemoriesResponse(ready(events(4), {shown: undefined})).shown, 4);
  assert.equal(readMemoriesResponse(ready(events(4), {shown: 3})).shown, 3);
});

test('unavailable and malformed responses are unavailable', () => {
  assert.deepEqual(readMemoriesResponse({version: 1, state: 'unavailable', shown: 0, events: []}), {state: 'unavailable'});
  assert.equal(readMemoriesResponse(null).state, 'unavailable');
  assert.equal(readMemoriesResponse({state: 'ready', events: 'oops'}).state, 'unavailable');
  assert.equal(readMemoriesResponse(ready([{...event('2024-10-01_2024-10-03'), media: [{path: 'a.jpg', kind: 'raw'}]}])).state, 'unavailable');
  assert.equal(readMemoriesResponse(ready([{...event('2024-10-01_2024-10-03'), id: ''}])).state, 'unavailable');
});

test('the main surface shows the first events and Все воспоминания shows every event', () => {
  const model = readMemoriesResponse(ready(events(9)));
  const recent = memoriesView(model, 'recent');
  assert.equal(recent.events.length, 6);
  assert.deepEqual(recent.events, model.events.slice(0, 6));
  assert.equal(recent.hasMore, true);
  const all = memoriesView(model, 'all');
  assert.deepEqual(all.events, model.events);
});

test('without extra events the full list is not offered', () => {
  const model = readMemoriesResponse(ready(events(3)));
  assert.equal(memoriesView(model, 'recent').hasMore, false);
  assert.deepEqual(memoriesView(model, 'all').events, model.events);
});

test('empty and unavailable memories show no events', () => {
  assert.deepEqual(memoriesView(readMemoriesResponse(ready([])), 'recent'), {events: [], hasMore: false});
  assert.deepEqual(memoriesView({state: 'unavailable'}, 'recent'), {events: [], hasMore: false});
});

test('viewer items follow backend media order and carry the artifact version', () => {
  const list = [...media(3, 'image', 'Trips/2024'), ...media(1, 'video', 'Trips/2024/clips')];
  const items = memoryViewerItems(event('2024-10-01_2024-10-03', list), 'v1');
  assert.deepEqual(items.map(item => item.path), list.map(item => item.path));
  assert.deepEqual(items[0], {name: 'IMG_01.jpg', path: 'Trips/2024/IMG_01.jpg', kind: 'image', sortTime: 1_700_000_000, modTime: 'v1', size: 0});
  assert.equal(items[3].kind, 'video');
});
