// @ts-check

// Search the whole gallery. The server matches the query against the relative
// path of every file in the date index the cache warmer writes, so the results
// do not depend on the folder open in the gallery. The gallery's filter, sort,
// and grouping are then applied to the results here.

import {formatCount} from './format.js';
import {iconMarkup} from './icons.js';
import {createMediaWindow} from './media-window.js';

/** @typedef {import('./media-window.js').ItemGroup} ItemGroup */

/**
 * @typedef {{name: string, path: string, kind: string}} SearchItem
 * @typedef {'idle'|'loading'|'ready'|'unavailable'|'error'} SearchState
 * @typedef {{entries: any[], truncated: boolean}} SearchResponse
 * @typedef {{state: SearchState, query: string} & SearchResponse} SearchAnswer
 * @typedef {(query: string, signal: AbortSignal) => Promise<SearchResponse>} SearchLoader
 */

/** Pause after the last keystroke before a request is sent. */
export const SEARCH_DEBOUNCE_MS = 250;

/** Comparable form of a query: trimmed, one Unicode form, case folded. @param {string} text */
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

/** @param {string} query normalized */
export const searchURL = query => `/api/search?q=${encodeURIComponent(query)}`;

/**
 * Default loader. A non-OK answer throws an error carrying its HTTP status.
 * @type {SearchLoader}
 */
export async function loadSearch(query, signal) {
  const response = await fetch(searchURL(query), {signal});
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), {status: response.status});
  const data = await response.json();
  if (!Array.isArray(data?.entries)) throw new Error('Malformed search answer');
  return {entries: data.entries, truncated: data.truncated === true};
}

/**
 * Debounced requests where the latest query wins: a new query cancels the
 * pending timer and aborts the request in flight, and a late answer of an older
 * query is dropped. An empty query sends nothing.
 * @param {{
 *   load?: SearchLoader,
 *   onAnswer: (answer: SearchAnswer) => void,
 *   delay?: number,
 *   setTimer?: (callback: () => void, ms: number) => any,
 *   clearTimer?: (id: any) => void,
 * }} options
 */
export function createSearchRequests({load = loadSearch, onAnswer, delay = SEARCH_DEBOUNCE_MS, setTimer = setTimeout, clearTimer = clearTimeout}) {
  let token = 0;
  let timer = /** @type {any} */ (null);
  /** @type {AbortController | null} */
  let controller = null;

  function cancel() {
    token++;
    if (timer !== null) clearTimer(timer);
    timer = null;
    controller?.abort();
    controller = null;
  }

  /** @param {string} query normalized */
  function run(query) {
    cancel();
    const id = token;
    if (!query) {
      onAnswer({state: 'idle', query, entries: [], truncated: false});
      return;
    }
    onAnswer({state: 'loading', query, entries: [], truncated: false});
    timer = setTimer(async () => {
      timer = null;
      const current = new AbortController();
      controller = current;
      try {
        const {entries, truncated} = await load(query, current.signal);
        if (id !== token) return;
        onAnswer({state: 'ready', query, entries, truncated});
      } catch (error) {
        if (id !== token) return;
        const status = /** @type {{status?: number}} */ (error)?.status;
        onAnswer({state: status === 503 ? 'unavailable' : 'error', query, entries: [], truncated: false});
      } finally {
        if (controller === current) controller = null;
      }
    }, delay);
  }

  return {run, cancel};
}

const FILTER_NOTES = {all: '', image: 'только фото', video: 'только видео'};

/** One line that says where and how the search looks. @param {'all'|'image'|'video'} filter */
export const describeScope = filter => ['По именам файлов и папок во всей галерее', FILTER_NOTES[filter]].filter(Boolean).join(' · ');

/**
 * Status line next to the field.
 * @param {{state: SearchState, count: number, truncated: boolean}} options count is the number of results on screen
 */
export function describeCount({state, count, truncated}) {
  if (state === 'loading') return 'Поиск…';
  if (state !== 'ready') return '';
  const found = `Найдено: ${formatCount(count, ['файл', 'файла', 'файлов'])}`;
  return truncated ? `${found} · показаны не все, уточните запрос` : found;
}

/**
 * Heading and hint shown instead of results, or null when there are results or a request is running.
 * @param {{state: SearchState, query: string, found: number, count: number, filter: 'all'|'image'|'video'}} options
 *   found is the number of files the server returned, count the number left after the filter
 */
export function describeMessage({state, query, found, count, filter}) {
  switch (state) {
    case 'idle':
      return {title: 'Что найти?', hint: 'Введите часть имени файла или папки. Поиск идёт по всей галерее'};
    case 'loading':
      return null;
    case 'unavailable':
      return {title: 'Поиск пока готовится', hint: 'Индекс галереи ещё строится при прогреве кэша. Попробуйте чуть позже'};
    case 'error':
      return {title: 'Не удалось выполнить поиск', hint: 'Проверьте соединение и введите запрос ещё раз'};
  }
  if (count) return null;
  if (found) return {title: 'Ничего не найдено', hint: `Фильтр «${filter === 'image' ? 'Фото' : 'Видео'}» скрывает найденные файлы`};
  return {title: 'Ничего не найдено', hint: `В галерее нет файлов и папок, имя которых содержит «${query}»`};
}

/**
 * @typedef {{signal: AbortSignal, priority: () => number}} CardWork
 * @typedef {{
 *   panel: HTMLElement, input: HTMLInputElement, clear: HTMLButtonElement, count: HTMLElement,
 *   scope: HTMLElement, empty: HTMLElement, grid: HTMLElement, heading?: HTMLElement | null,
 * }} SearchElements
 *   heading is the sticky copy of the date heading at the top of the results
 */

/**
 * The `Найти` section. Its grid is a second windowed renderer over the same cards
 * as the gallery, so the gallery grid, scroll, and focus stay as they were.
 * @template {SearchItem} T
 * @param {SearchElements & {
 *   getFilter: () => 'all'|'image'|'video',
 *   arrange: (items: T[]) => {items: T[], groups: ItemGroup[] | null},
 *   createCard: (item: T, index: number, work: CardWork) => HTMLElement,
 *   load?: SearchLoader,
 *   viewportTop?: () => number,
 *   onChange?: () => void,
 *   onResults?: (results: T[]) => void,
 * }} options
 *   arrange applies the gallery's filter, sort, and grouping to the server results.
 *   onChange runs after the rendered rows change; onResults after a new result list.
 */
export function createSearch({panel, input, clear, count, scope, empty, grid, heading = null, getFilter, arrange, createCard, load, viewportTop, onChange, onResults = () => {}}) {
  const renderer = createMediaWindow({grid, createCard, viewportTop, onChange, stickyHeading: heading});
  /** @type {SearchAnswer} */
  let answer = {state: 'idle', query: '', entries: [], truncated: false};
  /** @type {T[]} */
  let results = [];
  /** The answer or the gallery view changed while the section was hidden. */
  let stale = true;
  let savedScroll = 0;
  const requests = createSearchRequests({load, onAnswer});

  clear.innerHTML = iconMarkup('x');

  /** @param {SearchAnswer} next */
  function onAnswer(next) {
    if (next.state === 'loading') {
      // The previous results stay on screen until the answer arrives.
      answer = {...answer, state: 'loading', query: next.query};
      count.textContent = describeCount({state: 'loading', count: 0, truncated: false});
      if (!results.length) empty.hidden = true;
      return;
    }
    answer = next;
    if (panel.hidden) {
      stale = true;
      return;
    }
    render();
    scrollTo({top: 0, behavior: 'instant'});
  }

  function render() {
    stale = false;
    const filter = getFilter();
    const arranged = arrange(answer.entries);
    results = arranged.items;
    scope.textContent = describeScope(filter);
    count.textContent = describeCount({state: answer.state, count: results.length, truncated: answer.truncated});
    const message = describeMessage({state: answer.state, query: answer.query, found: answer.entries.length, count: results.length, filter});
    empty.hidden = !message;
    if (message) {
      /** @type {HTMLElement} */ (empty.querySelector('strong')).textContent = message.title;
      /** @type {HTMLElement} */ (empty.querySelector('span')).textContent = message.hint;
    }
    if (results.length) renderer.setItems(results, arranged.groups);
    else renderer.clear();
    onResults(results);
  }

  function onInput() {
    clear.hidden = !input.value;
    const query = normalizeQuery(input.value);
    // Spaces or a change of case alone send nothing new; a failed query may be retried.
    if (query === answer.query && answer.state !== 'error' && answer.state !== 'unavailable') return;
    requests.run(query);
  }

  input.addEventListener('input', onInput);
  clear.addEventListener('click', () => {
    input.value = '';
    onInput();
    input.focus();
  });

  return {
    /** Enter the section: unchanged results keep their scroll; a failed query is tried again. */
    enter() {
      const rebuilt = stale;
      if (stale) render();
      if (answer.state === 'error' || answer.state === 'unavailable') requests.run(answer.query);
      scrollTo({top: rebuilt ? 0 : savedScroll, behavior: 'instant'});
      renderer.sync();
      return rebuilt;
    },
    leave() {
      savedScroll = scrollY;
    },
    /** Re-apply the gallery's filter, sort, and grouping after they changed. */
    refresh() {
      if (panel.hidden) stale = true;
      else render();
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
    get state() {
      return answer.state;
    },
  };
}
