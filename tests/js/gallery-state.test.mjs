import assert from 'node:assert/strict';
import test from 'node:test';

import {createGalleryState, DEFAULT_DENSITY, DENSITY_CHOICES, VIEWS_KEY} from '../../web/gallery-state.js';

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

test('controls read the existing localStorage keys and fall back on bad values', () => {
  const local = memoryStorage({
    'gallery-media-sort': 'name',
    'gallery-media-filter': 'video',
    'gallery-media-order': 'asc',
    'gallery-folder-order': 'desc',
    'gallery-density-desktop': '7',
    'gallery-density-phone': '4',
  });
  const state = createGalleryState({path: 'Album A', local, session: memoryStorage()});
  assert.equal(state.path, 'Album A');
  assert.equal(state.requestedPath, 'Album A');
  assert.equal(state.shownPath, null);
  assert.equal(state.sortKey, 'name');
  assert.equal(state.filter, 'video');
  assert.equal(state.descending, false);
  assert.equal(state.folderDescending, true);
  assert.equal(state.columns('desktop'), 7);
  assert.equal(state.columns('phone'), DEFAULT_DENSITY.phone);

  const fallback = createGalleryState({local: memoryStorage({'gallery-media-sort': 'size', 'gallery-media-filter': 'raw'}), session: memoryStorage()});
  assert.equal(fallback.sortKey, 'date');
  assert.equal(fallback.filter, 'all');
  assert.equal(fallback.descending, true);
});

test('setters persist under the same keys and ignore unknown values', () => {
  const local = memoryStorage();
  const state = createGalleryState({local, session: memoryStorage()});
  state.setFilter('image');
  state.setFilter('raw');
  state.setSortKey('name');
  state.setSortKey('size');
  state.toggleDescending();
  state.toggleFolderOrder();
  state.setColumns('phone', DENSITY_CHOICES.phone[0]);
  state.setColumns('desktop', 4);
  assert.equal(state.filter, 'image');
  assert.equal(state.sortKey, 'name');
  assert.deepEqual(Object.fromEntries(local.values), {
    'gallery-media-filter': 'image',
    'gallery-media-sort': 'name',
    'gallery-media-order': 'asc',
    'gallery-folder-order': 'asc',
    'gallery-density-phone': String(DENSITY_CHOICES.phone[0]),
  });
});

test('folder views are separate, merged, kept for the tab, and bounded', () => {
  const session = memoryStorage();
  const state = createGalleryState({local: memoryStorage(), session});
  state.saveView('Album A', {scrollY: 900, anchorPath: 'Album A/Photo 09.png', anchorOffset: 80});
  state.saveView('Album B', {scrollY: 40});
  state.saveView('Album A', {focusPath: 'Album A/Photo 10.png'});
  assert.deepEqual(state.view('Album A'), {scrollY: 900, anchorPath: 'Album A/Photo 09.png', anchorOffset: 80, focusPath: 'Album A/Photo 10.png'});
  assert.deepEqual(state.view('Album B'), {scrollY: 40});
  assert.equal(state.view('Album C'), undefined);

  const reloaded = createGalleryState({local: memoryStorage(), session});
  assert.deepEqual(reloaded.view('Album A'), state.view('Album A'));

  for (let index = 0; index < 250; index += 1) reloaded.saveView(`Folder ${index}`, {scrollY: index});
  const stored = JSON.parse(session.getItem(VIEWS_KEY));
  assert.equal(Object.keys(stored).length, 200);
  assert.equal(stored['Folder 249'].scrollY, 249);
  assert.equal(reloaded.view('Album A'), undefined);
});

test('damaged or unavailable session storage only loses views', () => {
  const state = createGalleryState({local: memoryStorage(), session: memoryStorage({[VIEWS_KEY]: '{oops'})});
  assert.equal(state.view(''), undefined);
  const full = {getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }};
  const limited = createGalleryState({local: memoryStorage(), session: full});
  limited.saveView('', {scrollY: 12});
  assert.deepEqual(limited.view(''), {scrollY: 12});
});
