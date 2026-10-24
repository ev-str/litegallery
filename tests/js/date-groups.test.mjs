import assert from 'node:assert/strict';
import test from 'node:test';

import {GROUP_MODES, GROUP_STORAGE_KEY, groupKey, groupLabel, groupMedia, groupRuns, normalizeGroupMode, UNDATED_LABEL} from '../../web/date-groups.js';
import {createGalleryState} from '../../web/gallery-state.js';

// Local noon of a calendar day, as the gallery's Unix seconds; independent of the test time zone.
const at = (year, month, day, hour = 12) => new Date(year, month - 1, day, hour).getTime() / 1000;
const item = (name, sortTime, captured = true) => ({name, path: `Album/${name}`, sortTime, captured});

test('modes are normalized; anything unknown means no grouping', () => {
  assert.deepEqual(GROUP_MODES, ['none', 'year', 'month', 'day']);
  for (const mode of GROUP_MODES) assert.equal(normalizeGroupMode(mode), mode);
  for (const value of [null, undefined, '', 'week', 'Year', 1]) assert.equal(normalizeGroupMode(value), 'none');
});

test('keys follow the local calendar and labels use Russian month forms', () => {
  const time = at(2026, 9, 6);
  assert.equal(groupKey(time, 'none'), '');
  assert.equal(groupKey(time, 'year'), '2026');
  assert.equal(groupKey(time, 'month'), '2026-09');
  assert.equal(groupKey(time, 'day'), '2026-09-06');
  assert.equal(groupLabel('2026'), '2026');
  assert.equal(groupLabel('2026-09'), 'сентябрь 2026');
  assert.equal(groupLabel('2026-09-06'), '6 сентября 2026');
  assert.equal(groupLabel('2025-01'), 'январь 2025');
  assert.equal(groupLabel('2025-05-31'), '31 мая 2025');
  // The last second of a year and of a month stay in it; the next second starts the next group.
  const lastOfYear = at(2026, 1, 1, 0) - 1;
  assert.equal(groupKey(lastOfYear, 'year'), '2025');
  assert.equal(groupKey(lastOfYear + 1, 'year'), '2026');
  const lastOfMonth = at(2026, 3, 1, 0) - 1;
  assert.equal(groupKey(lastOfMonth, 'month'), '2026-02');
  assert.equal(groupKey(lastOfMonth, 'day'), '2026-02-28');
  assert.equal(groupKey(lastOfMonth + 1, 'month'), '2026-03');
  // No date: one group of its own.
  assert.equal(groupKey(0, 'day'), '');
  assert.equal(groupKey(undefined, 'year'), '');
  assert.equal(groupLabel(''), UNDATED_LABEL);
});

test('a list sorted by date keeps its order; runs split it at year and month borders', () => {
  const newestFirst = [
    item('d.jpg', at(2026, 1, 2)),
    item('c.jpg', at(2026, 1, 1)),
    item('b.jpg', at(2025, 12, 31)),
    item('a.jpg', at(2025, 11, 30)),
  ];
  const byYear = groupMedia(newestFirst, 'year', true);
  assert.deepEqual(byYear.items.map(entry => entry.name), ['d.jpg', 'c.jpg', 'b.jpg', 'a.jpg']);
  assert.deepEqual(byYear.groups, [{key: '2026', label: '2026', count: 2}, {key: '2025', label: '2025', count: 2}]);
  const byMonth = groupMedia(newestFirst, 'month', true);
  assert.deepEqual(byMonth.groups?.map(group => [group.label, group.count]), [['январь 2026', 2], ['декабрь 2025', 1], ['ноябрь 2025', 1]]);
  const byDay = groupMedia([...newestFirst].reverse(), 'day', false);
  assert.deepEqual(byDay.items.map(entry => entry.name), ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
  assert.deepEqual(byDay.groups?.map(group => group.label), ['30 ноября 2025', '31 декабря 2025', '1 января 2026', '2 января 2026']);
});

test('no grouping returns the same list without groups', () => {
  const items = [item('a.jpg', at(2026, 1, 1))];
  const result = groupMedia(items, 'none', true);
  assert.equal(result.items, items);
  assert.equal(result.groups, null);
  assert.equal(groupRuns(items, 'none'), null);
});

test('a list sorted by name gets date groups in the sort direction and keeps name order inside', () => {
  // Sorted A–Z by name: dates are mixed.
  const byName = [
    item('apple.jpg', at(2024, 6, 1)),
    item('banana.jpg', at(2026, 6, 1)),
    item('cherry.jpg', at(2024, 7, 1)),
    item('date.jpg', at(2026, 6, 2)),
    item('elder.jpg', 0, false),
  ];
  const ascending = groupMedia(byName, 'year', false);
  assert.deepEqual(ascending.groups?.map(group => group.label), ['2024', '2026', UNDATED_LABEL]);
  assert.deepEqual(ascending.items.map(entry => entry.name), ['apple.jpg', 'cherry.jpg', 'banana.jpg', 'date.jpg', 'elder.jpg']);
  // Z–A: the caller reversed the names; groups go newest first, undated last.
  const descending = groupMedia([...byName].reverse(), 'year', true);
  assert.deepEqual(descending.groups?.map(group => group.label), ['2026', '2024', UNDATED_LABEL]);
  assert.deepEqual(descending.items.map(entry => entry.name), ['date.jpg', 'banana.jpg', 'cherry.jpg', 'apple.jpg', 'elder.jpg']);
});

test('a fallback file time is not grouped as a capture date, and Без даты is always last', () => {
  const fallback = item('without-exif.jpg', at(2030, 1, 1), false);
  const captured = item('captured.jpg', at(2020, 1, 1));
  for (const descending of [false, true]) {
    const result = groupMedia([fallback, captured], 'year', descending);
    assert.deepEqual(result.groups?.map(group => group.label), ['2020', UNDATED_LABEL]);
    assert.deepEqual(result.items.map(entry => entry.name), ['captured.jpg', 'without-exif.jpg']);
  }
});

test('runs of a filtered grouped list are the same groups, narrowed', () => {
  const {items} = groupMedia([
    item('a.jpg', at(2026, 9, 6, 10)),
    item('b.mp4', at(2026, 9, 6, 9)),
    item('c.jpg', at(2026, 9, 5)),
    item('d.mp4', at(2026, 8, 30)),
  ], 'month', true);
  const found = items.filter(entry => entry.name.endsWith('.mp4'));
  assert.deepEqual(groupRuns(found, 'month'), [{key: '2026-09', label: 'сентябрь 2026', count: 1}, {key: '2026-08', label: 'август 2026', count: 1}]);
  assert.deepEqual(groupRuns([], 'day'), []);
});

test('the gallery state stores the mode under one localStorage key', () => {
  const values = new Map([[GROUP_STORAGE_KEY, 'month']]);
  const local = {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value))};
  const session = {getItem: () => null, setItem: () => {}};
  const state = createGalleryState({local, session});
  assert.equal(GROUP_STORAGE_KEY, 'gallery-media-group');
  assert.equal(state.groupBy, 'month');
  state.setGroupBy('day');
  assert.equal(state.groupBy, 'day');
  assert.equal(values.get(GROUP_STORAGE_KEY), 'day');
  state.setGroupBy('week');
  assert.equal(state.groupBy, 'none');
  assert.equal(values.get(GROUP_STORAGE_KEY), 'none');
  values.set(GROUP_STORAGE_KEY, 'garbage');
  assert.equal(createGalleryState({local, session}).groupBy, 'none');
  values.delete(GROUP_STORAGE_KEY);
  assert.equal(createGalleryState({local, session}).groupBy, 'none');
});
