// @ts-check

// Search inside the listing already on screen. Nothing is fetched: results are
// the gallery's visible list (filter and sort applied) narrowed by the query, in
// the same order. A plain listing matches file names; a recursive one matches
// the path below the opened folder, so a subfolder name finds its files too.

import {formatCount} from './format.js';
import {iconMarkup} from './icons.js';
import {createMediaWindow} from './media-window.js';

/**
 * @typedef {{name: string, path: string, kind: string}} SearchItem
 * @typedef {{folder: string, recursive: boolean}} SearchScope folder is the opened folder, '' for the root
 */

/** Comparable form of a query or a file name: trimmed, one Unicode form, case folded. @param {string} text */
export const normalizeQuery = text => text.normalize('NFC').trim().toLocaleLowerCase('ru');

/** Path of an item below the opened folder. @param {SearchItem} item @param {string} folder */
export function relativePath(item, folder) {
  const prefix = folder ? `${folder}/` : '';
  return item.path.startsWith(prefix) ? item.path.slice(prefix.length) : item.path;
}

/** Subfolder of an item below the opened folder; '' when it lies in the folder itself. @param {SearchItem} item @param {string} folder */
export function relativeFolder(item, folder) {
  const relative = relativePath(item, folder);
  return relative.slice(0, Math.max(0, relative.length - item.name.length)).replace(/\/$/, '');
}

/** Text a query is matched against. @param {SearchItem} item @param {SearchScope} scope */
export const searchText = (item, {folder, recursive}) => (recursive ? relativePath(item, folder) : item.name);

/**
 * Items whose name (or relative path, in a recursive listing) contains the query.
 * An empty query keeps the list itself, so clearing it restores the same array.
 * @template {SearchItem} T
 * @param {T[]} items @param {string} query @param {SearchScope} scope
 * @returns {T[]}
 */
export function searchMedia(items, query, scope) {
  const needle = normalizeQuery(query);
  if (!needle) return items;
  return items.filter(item => normalizeQuery(searchText(item, scope)).includes(needle));
}

const FILTER_NOTES = {all: '', image: 'только фото', video: 'только видео'};

/**
 * One line that says where and how the search looks.
 * @param {SearchScope & {filter: 'all'|'image'|'video'}} scope
 */
export function describeScope({folder, recursive, filter}) {
  const name = folder ? `«${folder.split('/').pop()}»` : '«Все фото»';
  const where = recursive ? `По именам и путям в папке ${name} и её подпапках` : `По именам файлов в папке ${name}`;
  return [where, FILTER_NOTES[filter]].filter(Boolean).join(' · ');
}

/** @param {number} count @param {string} query */
export function describeCount(count, query) {
  const files = formatCount(count, ['файл', 'файла', 'файлов']);
  return normalizeQuery(query) ? `Найдено: ${files}` : files;
}

/**
 * Heading and hint of the empty result, or null when there are results.
 * @param {{count: number, total: number, query: string} & SearchScope & {filter: 'all'|'image'|'video'}} options
 *   total is the size of the list searched, before the query
 */
export function describeEmpty({count, total, query, recursive, folder, filter}) {
  if (count) return null;
  if (!total) return {title: 'Искать пока не в чем', hint: filter === 'all' ? 'Здесь нет фотографий и видео' : 'Здесь нет файлов выбранного типа'};
  const hints = [`В этом списке нет файлов, ${recursive ? 'путь' : 'имя'} которых содержит «${query.trim()}»`];
  if (filter !== 'all') hints.push(`Фильтр «${filter === 'image' ? 'Фото' : 'Видео'}» тоже действует`);
  else if (!recursive && folder) hints.push('Включите «Из подпапок» в Галерее, чтобы искать и во вложенных папках');
  return {title: 'Ничего не найдено', hint: hints.join('. ')};
}

/**
 * @typedef {{signal: AbortSignal, priority: () => number}} CardWork
 * @typedef {{
 *   panel: HTMLElement, input: HTMLInputElement, clear: HTMLButtonElement, count: HTMLElement,
 *   scope: HTMLElement, empty: HTMLElement, grid: HTMLElement,
 * }} SearchElements
 */

/**
 * The `Найти` section. Its grid is a second windowed renderer over the same cards
 * as the gallery, so the gallery grid, scroll, and focus stay as they were.
 * @template {SearchItem} T
 * @param {SearchElements & {
 *   getItems: () => T[] | null,
 *   getScope: () => SearchScope & {filter: 'all'|'image'|'video'},
 *   createCard: (item: T, index: number, work: CardWork) => HTMLElement,
 *   viewportTop?: () => number,
 *   onChange?: () => void,
 *   onResults?: (results: T[]) => void,
 * }} options
 *   getItems returns the gallery's visible list, or null while it is loading.
 *   onChange runs after the rendered rows change; onResults after a new result list.
 */
export function createSearch({panel, input, clear, count, scope, empty, grid, getItems, getScope, createCard, viewportTop, onChange, onResults = () => {}}) {
  const renderer = createMediaWindow({grid, createCard, viewportTop, onChange});
  /** @type {T[]} */
  let results = [];
  /** @type {T[] | null} */
  let source = null;
  let shownQuery = '';
  let shownScope = '';
  let savedScroll = 0;

  clear.innerHTML = iconMarkup('x');

  /** Rebuild the results when the list, the scope, or the query changed. @returns {boolean} whether it did */
  function update() {
    const items = getItems();
    const current = getScope();
    const scopeKey = JSON.stringify(current);
    clear.hidden = !input.value;
    if (items === source && normalizeQuery(input.value) === shownQuery && scopeKey === shownScope) return false;
    source = items;
    shownQuery = normalizeQuery(input.value);
    shownScope = scopeKey;
    scope.textContent = describeScope(current);
    if (!items) {
      results = [];
      renderer.clear();
      count.textContent = 'Загрузка…';
      empty.hidden = true;
      onResults(results);
      return true;
    }
    results = searchMedia(items, input.value, current);
    count.textContent = describeCount(results.length, input.value);
    const message = describeEmpty({count: results.length, total: items.length, query: input.value, ...current});
    empty.hidden = !message;
    if (message) {
      /** @type {HTMLElement} */ (empty.querySelector('strong')).textContent = message.title;
      /** @type {HTMLElement} */ (empty.querySelector('span')).textContent = message.hint;
      renderer.clear();
    } else {
      renderer.setItems(results);
    }
    onResults(results);
    return true;
  }

  // Typing restarts the results from the top, where the field is.
  function onInput() {
    if (update()) scrollTo({top: 0, behavior: 'instant'});
  }

  input.addEventListener('input', onInput);
  clear.addEventListener('click', () => {
    input.value = '';
    onInput();
    input.focus();
  });

  return {
    /** Enter the section: unchanged results keep their scroll, new ones start at the top. */
    enter() {
      const rebuilt = update();
      scrollTo({top: rebuilt ? 0 : savedScroll, behavior: 'instant'});
      renderer.sync();
      return rebuilt;
    },
    leave() {
      savedScroll = scrollY;
    },
    /** Re-run the search after the gallery list changed while the section is open. */
    refresh() {
      if (!panel.hidden) update();
    },
    /** @param {Element | null} card */
    owns: card => Boolean(card && grid.contains(card)),
    /** @param {string | null | undefined} path */
    tileFor: path => renderer.reveal(path),
    /** @param {number} index */
    revealIndex: index => renderer.revealIndex(index),
    /** @param {Element} card @param {string} key */
    neighbour: (card, key) => renderer.neighbour(card, key),
    get results() {
      return results;
    },
    get query() {
      return input.value;
    },
  };
}
