import assert from 'node:assert/strict';
import test from 'node:test';

import {describeCount, describeEmpty, describeScope, normalizeQuery, relativeFolder, relativePath, searchMedia} from '../../web/search.js';

const item = (path, kind = 'image') => ({name: path.split('/').pop(), path, kind});
const plain = {folder: 'Trips', recursive: false};
const recursive = {folder: 'Trips', recursive: true};
const paths = items => items.map(entry => entry.path);

// A recursive listing of "Trips" in gallery order (the gallery has already sorted it).
const LISTING = [
  item('Trips/Sea Day.JPG'),
  item('Trips/Paris/louvre.png'),
  item('Trips/Paris/Night/eiffel.mp4', 'video'),
  item('Trips/Rome/sea view.jpg'),
];

test('queries ignore case and surrounding spaces', () => {
  assert.equal(normalizeQuery('  SeA  '), 'sea');
  assert.deepEqual(paths(searchMedia(LISTING, '  SEA ', plain)), ['Trips/Sea Day.JPG', 'Trips/Rome/sea view.jpg']);
  assert.deepEqual(paths(searchMedia(LISTING, 'LOUVRE.PNG', plain)), ['Trips/Paris/louvre.png']);
});

test('Cyrillic and composed/decomposed names match regardless of case and form', () => {
  const listing = [item('Отпуск/Йошкар-Ола.jpg'.normalize('NFD')), item('Отпуск/Море.jpg')];
  assert.deepEqual(paths(searchMedia(listing, 'йошкар', {folder: 'Отпуск', recursive: false})), [listing[0].path]);
  assert.deepEqual(paths(searchMedia(listing, 'МОРЕ', {folder: 'Отпуск', recursive: false})), ['Отпуск/Море.jpg']);
});

test('a plain listing matches file names only', () => {
  assert.deepEqual(searchMedia(LISTING, 'paris', plain), []);
});

test('a recursive listing matches the path below the opened folder, not the folder itself', () => {
  assert.deepEqual(paths(searchMedia(LISTING, 'paris', recursive)), ['Trips/Paris/louvre.png', 'Trips/Paris/Night/eiffel.mp4']);
  assert.deepEqual(paths(searchMedia(LISTING, 'paris/night/', recursive)), ['Trips/Paris/Night/eiffel.mp4']);
  assert.deepEqual(searchMedia(LISTING, 'trips', recursive), []);
});

test('results keep the order of the list they narrow', () => {
  const reversed = [...LISTING].reverse();
  assert.deepEqual(paths(searchMedia(reversed, 'a', recursive)), paths(reversed.filter(entry => /a/i.test(relativePath(entry, 'Trips')))));
});

test('an empty or blank query returns the list itself', () => {
  assert.equal(searchMedia(LISTING, '', recursive), LISTING);
  assert.equal(searchMedia(LISTING, '   ', plain), LISTING);
});

test('relative path and folder are measured from the opened folder; the root has no prefix', () => {
  assert.equal(relativePath(LISTING[2], 'Trips'), 'Paris/Night/eiffel.mp4');
  assert.equal(relativeFolder(LISTING[2], 'Trips'), 'Paris/Night');
  assert.equal(relativeFolder(LISTING[0], 'Trips'), '');
  assert.equal(relativePath(item('top.jpg'), ''), 'top.jpg');
});

test('scope, count, and empty-state copy', () => {
  assert.equal(describeScope({folder: 'Trips/Paris', recursive: false, filter: 'all'}), 'По именам файлов в папке «Paris»');
  assert.equal(describeScope({folder: 'Trips', recursive: true, filter: 'video'}), 'По именам и путям в папке «Trips» и её подпапках · только видео');
  assert.equal(describeScope({folder: '', recursive: false, filter: 'image'}), 'По именам файлов в папке «Все фото» · только фото');
  assert.equal(describeCount(3, ''), '3 файла');
  assert.equal(describeCount(1, 'sea'), 'Найдено: 1 файл');
  assert.equal(describeCount(0, ' x '), 'Найдено: 0 файлов');

  assert.equal(describeEmpty({count: 2, total: 4, query: 'a', ...plain, filter: 'all'}), null);
  assert.deepEqual(describeEmpty({count: 0, total: 4, query: ' zzz ', ...plain, filter: 'all'}), {
    title: 'Ничего не найдено',
    hint: 'В этом списке нет файлов, имя которых содержит «zzz». Включите «Из подпапок» в Галерее, чтобы искать и во вложенных папках',
  });
  assert.equal(describeEmpty({count: 0, total: 4, query: 'zzz', ...recursive, filter: 'image'})?.hint, 'В этом списке нет файлов, путь которых содержит «zzz». Фильтр «Фото» тоже действует');
  assert.equal(describeEmpty({count: 0, total: 0, query: '', ...plain, filter: 'all'})?.title, 'Искать пока не в чем');
});
