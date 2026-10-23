// @ts-check
import {apiURL, formatCount} from './format.js';
import {iconMarkup} from './icons.js';

/**
 * Memories surface. `/api/memories` is the only source of events, their order,
 * and their media order; this module only presents them.
 */

export const MEMORIES_TITLE = 'Вспомните то, что происходило в эти же дни';
/** Upper bound for the main surface when a response omits `shown`. */
export const MEMORIES_SHOWN_LIMIT = 6;
export const COVER_SIZE = 4;

/**
 * @typedef {{path: string, kind: 'image'|'video', sortTime: number, captured?: boolean}} MemoryMedia
 * @typedef {{id: string, year: number, startDate: string, endDate: string, anchorDate: string, mediaCount: number, media: MemoryMedia[]}} MemoryEvent
 * @typedef {{state: 'ready', revision: string, version: string, shown: number, events: MemoryEvent[]} | {state: 'unavailable'}} MemoriesModel
 * @typedef {{name: string, path: string, kind: 'image'|'video', sortTime: number, modTime: string, size: number}} ViewerItem
 */

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** @param {string} value YYYY-MM-DD */
function parseDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? {year, month, day} : null;
}

/**
 * Calendar period of an event: '5 октября 2023', '3–9 октября 2023',
 * '28 сентября – 4 октября 2023', '29 декабря 2022 – 3 января 2023'.
 * @param {string} startDate
 * @param {string} endDate
 */
export function formatMemoryPeriod(startDate, endDate) {
  const start = parseDay(startDate);
  const end = parseDay(endDate);
  if (!start || !end) return [startDate, endDate].filter(Boolean).join(' – ');
  const month = (/** @type {{month: number}} */ day) => MONTHS[day.month - 1];
  if (start.year !== end.year) return `${start.day} ${month(start)} ${start.year} – ${end.day} ${month(end)} ${end.year}`;
  if (start.month !== end.month) return `${start.day} ${month(start)} – ${end.day} ${month(end)} ${end.year}`;
  if (start.day !== end.day) return `${start.day}–${end.day} ${month(end)} ${end.year}`;
  return `${start.day} ${month(start)} ${start.year}`;
}

/** '12 фото · 2 видео' @param {MemoryMedia[]} media */
export function formatMemoryContents(media) {
  const videos = media.filter(item => item.kind === 'video').length;
  const images = media.length - videos;
  return [images && formatCount(images, ['фото', 'фото', 'фото']), videos && formatCount(videos, ['видео', 'видео', 'видео'])].filter(Boolean).join(' · ');
}

/**
 * Cover media spread evenly over the event, photos first because a video
 * poster may not exist yet. The result keeps the backend media order.
 * @param {MemoryMedia[]} media
 * @param {number} [count]
 */
export function pickCoverMedia(media, count = COVER_SIZE) {
  /** @param {number[]} indices @param {number} wanted */
  const spread = (indices, wanted) => {
    if (wanted >= indices.length) return indices;
    if (wanted === 1) return [indices[0]];
    return Array.from({length: wanted}, (_, step) => indices[Math.round(step * (indices.length - 1) / (wanted - 1))]);
  };
  /** @type {number[]} */
  const images = [];
  /** @type {number[]} */
  const videos = [];
  media.forEach((item, index) => (item.kind === 'video' ? videos : images).push(index));
  const picked = spread(images, count);
  picked.push(...spread(videos, count - picked.length));
  return picked.sort((left, right) => left - right).map(index => media[index]);
}

/** @param {unknown} value @returns {value is MemoryEvent} */
function isEvent(value) {
  const event = /** @type {MemoryEvent} */ (value);
  return Boolean(event) && typeof event.id === 'string' && event.id !== '' && typeof event.startDate === 'string' &&
    typeof event.endDate === 'string' && Array.isArray(event.media) && event.media.length > 0 &&
    event.media.every(item => item && typeof item.path === 'string' && (item.kind === 'image' || item.kind === 'video'));
}

/**
 * Validates the response shape without second-guessing the backend: events
 * keep their order, and a malformed response counts as unavailable.
 * @param {any} response
 * @returns {MemoriesModel}
 */
export function readMemoriesResponse(response) {
  if (!response || response.state !== 'ready' || !Array.isArray(response.events) || !response.events.every(isEvent)) {
    return {state: 'unavailable'};
  }
  const events = /** @type {MemoryEvent[]} */ (response.events);
  const requested = Number.isInteger(response.shown) ? response.shown : MEMORIES_SHOWN_LIMIT;
  return {
    state: 'ready',
    revision: String(response.revision ?? ''),
    version: String(response.generatedAt ?? response.revision ?? ''),
    shown: Math.max(0, Math.min(requested, MEMORIES_SHOWN_LIMIT, events.length)),
    events,
  };
}

/**
 * Events on screen for a mode: the main surface shows the first `shown`, the
 * full list shows every event. `hasMore` decides whether `Все воспоминания` exists.
 * @param {MemoriesModel} model
 * @param {'recent'|'all'} mode
 */
export function memoriesView(model, mode) {
  if (model.state !== 'ready') return {events: [], hasMore: false, entryVisible: false};
  const hasMore = model.events.length > model.shown;
  return {
    events: mode === 'all' && hasMore ? model.events : model.events.slice(0, model.shown),
    hasMore,
    entryVisible: model.events.length > 0,
  };
}

/**
 * Viewer playlist in backend order. The artifact version busts browser caches
 * of thumbnails and media whenever a new artifact is published.
 * @param {MemoryEvent} event
 * @param {string} version
 * @returns {ViewerItem[]}
 */
export function memoryViewerItems(event, version) {
  return event.media.map(item => ({
    name: item.path.slice(item.path.lastIndexOf('/') + 1),
    path: item.path,
    kind: item.kind,
    sortTime: item.sortTime,
    modTime: version,
    size: 0,
  }));
}

/**
 * @typedef {'loading'|'ready'|'empty'|'unavailable'|'error'} MemoriesState
 * @typedef {{focus(options?: FocusOptions): void}} Focusable
 * @typedef {(items: ViewerItem[], options: {tv: boolean, returnFocus: Focusable}) => void} OpenViewer
 */

/**
 * @param {{
 *   panel: HTMLElement,
 *   entry: HTMLElement,
 *   openViewer: OpenViewer,
 *   load?: () => Promise<any>,
 * }} options
 */
export function createMemories({panel, entry, openViewer, load = defaultLoad}) {
  panel.classList.add('memories-surface');
  panel.removeAttribute('aria-label');
  panel.setAttribute('aria-labelledby', 'memoriesTitle');
  panel.innerHTML = `
    <header class="memories-header">
      <h1 id="memoriesTitle" tabindex="-1"></h1>
      <p class="memories-note" role="status" aria-live="polite"></p>
    </header>
    <div class="memories-message" hidden>
      <strong></strong>
      <span></span>
      <button class="memories-retry" type="button" hidden>Повторить</button>
    </div>
    <div class="memories-all-header" hidden>
      <button class="memories-back" type="button">${iconMarkup('arrow-left')}<span>Недавние</span></button>
      <h2 id="memoriesAllTitle" tabindex="-1">Все воспоминания</h2>
    </div>
    <ul class="memories-list" role="list"></ul>
    <button class="memories-all" type="button" hidden>Все воспоминания</button>`;
  const title = /** @type {HTMLElement} */ (panel.querySelector('#memoriesTitle'));
  const note = /** @type {HTMLElement} */ (panel.querySelector('.memories-note'));
  const message = /** @type {HTMLElement} */ (panel.querySelector('.memories-message'));
  const retry = /** @type {HTMLButtonElement} */ (panel.querySelector('.memories-retry'));
  const allHeader = /** @type {HTMLElement} */ (panel.querySelector('.memories-all-header'));
  const allTitle = /** @type {HTMLElement} */ (panel.querySelector('#memoriesAllTitle'));
  const backButton = /** @type {HTMLButtonElement} */ (panel.querySelector('.memories-back'));
  const list = /** @type {HTMLUListElement} */ (panel.querySelector('.memories-list'));
  const allButton = /** @type {HTMLButtonElement} */ (panel.querySelector('.memories-all'));
  title.textContent = MEMORIES_TITLE;

  /** Last good model; an error keeps it on screen. @type {MemoriesModel | null} */
  let model = null;
  /** @type {MemoriesState} */
  let state = 'loading';
  /** @type {'recent'|'all'} */
  let mode = 'recent';
  /** Control the user was on, restored after a re-render, the viewer, or another section. */
  let lastFocus = /** @type {{id: string, action: 'open'|'tv'} | null} */ (null);
  let renderedKey = '';
  let request = 0;

  /** @param {string} id @param {'open'|'tv'} action */
  const control = (id, action) => /** @type {HTMLElement | null} */ (list.querySelector(`[data-memory-id="${CSS.escape(id)}"] [data-memory-action="${action}"]`));

  function render() {
    const view = model ? memoriesView(model, mode) : {events: [], hasMore: false, entryVisible: false};
    entry.hidden = !view.entryVisible;
    if (!view.hasMore) mode = 'recent';
    panel.dataset.state = state;
    panel.dataset.mode = mode;
    panel.setAttribute('aria-busy', String(state === 'loading'));
    const showList = view.events.length > 0;
    list.hidden = !showList;
    allHeader.hidden = !showList || mode !== 'all';
    allButton.hidden = !showList || mode !== 'recent' || !view.hasMore;
    if (model?.state === 'ready') allTitle.textContent = `Все воспоминания · ${model.events.length}`;
    note.textContent = state === 'loading' ? 'Загрузка воспоминаний…' : state === 'error' && showList ? 'Не удалось обновить воспоминания. Показаны последние загруженные.' : '';
    renderMessage(showList);
    const key = `${model?.state === 'ready' ? model.revision : ''}\n${mode}\n${view.events.map(event => event.id).join(',')}`;
    if (key === renderedKey) return;
    renderedKey = key;
    const focused = list.contains(document.activeElement) ? lastFocus : null;
    list.replaceChildren(...view.events.map(event => createCard(event, model?.state === 'ready' ? model.version : '')));
    if (focused) (control(focused.id, focused.action) ?? list.querySelector('[data-memory-action="open"]') ?? title)?.focus({preventScroll: true});
  }

  /** @param {boolean} showList */
  function renderMessage(showList) {
    const copy = showList ? null : {
      loading: null,
      ready: null,
      empty: ['Сейчас воспоминаний нет', 'Загляните сюда позже: подборки обновляются сами.'],
      unavailable: ['Воспоминания пока недоступны', 'Подборка ещё готовится. Галерея при этом работает как обычно.'],
      error: ['Не удалось загрузить воспоминания', 'Проверьте соединение и попробуйте ещё раз.'],
    }[state];
    message.hidden = !copy;
    retry.hidden = state !== 'error';
    if (!copy) return;
    /** @type {HTMLElement} */ (message.querySelector('strong')).textContent = copy[0];
    /** @type {HTMLElement} */ (message.querySelector('span')).textContent = copy[1];
  }

  /** @param {MemoryEvent} event @param {string} version */
  function createCard(event, version) {
    const period = formatMemoryPeriod(event.startDate, event.endDate);
    const contents = formatMemoryContents(event.media);
    const item = document.createElement('li');
    item.className = 'memory-card';
    item.dataset.memoryId = event.id;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'memory-open';
    open.dataset.memoryAction = 'open';
    open.setAttribute('aria-label', `Открыть воспоминание: ${period}, ${contents}`);
    const cover = document.createElement('span');
    const picks = pickCoverMedia(event.media);
    cover.className = 'memory-cover';
    cover.dataset.count = String(picks.length);
    cover.setAttribute('aria-hidden', 'true');
    for (const media of picks) {
      const cell = document.createElement('span');
      cell.className = `memory-cover-cell ${media.kind}`;
      const image = document.createElement('img');
      image.alt = '';
      image.decoding = 'async';
      image.loading = 'lazy';
      image.addEventListener('load', () => cell.classList.add('is-loaded'), {once: true});
      image.addEventListener('error', () => {
        cell.classList.add('is-broken');
        cell.insertAdjacentHTML('beforeend', media.kind === 'video' ? iconMarkup('play') : iconMarkup('image-off'));
      }, {once: true});
      image.src = apiURL(media.kind === 'video' ? '/api/video-poster' : '/api/thumb', media.path, version);
      cell.append(image);
      cover.append(cell);
    }
    const text = document.createElement('span');
    text.className = 'memory-text';
    text.innerHTML = '<strong class="memory-period"></strong><span class="memory-contents"></span>';
    /** @type {HTMLElement} */ (text.querySelector('.memory-period')).textContent = period;
    /** @type {HTMLElement} */ (text.querySelector('.memory-contents')).textContent = contents;
    open.append(cover, text);
    const tv = document.createElement('button');
    tv.type = 'button';
    tv.className = 'memory-tv';
    tv.dataset.memoryAction = 'tv';
    tv.title = 'Режим TV';
    tv.setAttribute('aria-label', `Показать в режиме TV: ${period}`);
    tv.innerHTML = iconMarkup('tv');
    item.append(open, tv);
    return item;
  }

  /** @param {string} id @param {boolean} tv */
  function openEvent(id, tv) {
    if (model?.state !== 'ready') return;
    const event = model.events.find(candidate => candidate.id === id);
    if (!event) return;
    lastFocus = {id, action: tv ? 'tv' : 'open'};
    const action = lastFocus.action;
    // The card may be re-rendered while the viewer is open; return to whatever now shows the event.
    const returnFocus = {focus: (/** @type {FocusOptions} */ options) => (control(id, action) ?? control(id, 'open') ?? title).focus(options)};
    openViewer(memoryViewerItems(event, model.version), {tv, returnFocus});
  }

  /** @param {'recent'|'all'} next */
  function setMode(next) {
    mode = next;
    lastFocus = null;
    render();
    (next === 'all' ? allTitle : allButton.hidden ? title : allButton).focus({preventScroll: true});
    panel.scrollIntoView?.({block: 'start'});
  }

  async function refresh() {
    const token = ++request;
    if (!model) {
      state = 'loading';
      render();
    }
    try {
      const next = readMemoriesResponse(await load());
      if (token !== request) return;
      model = next;
      state = next.state === 'unavailable' ? 'unavailable' : next.events.length ? 'ready' : 'empty';
    } catch {
      if (token !== request) return;
      state = 'error';
    }
    render();
  }

  list.addEventListener('click', event => {
    const button = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('[data-memory-action]'));
    const id = button?.closest('.memory-card')?.getAttribute('data-memory-id');
    if (button && id) openEvent(id, button.dataset.memoryAction === 'tv');
  });
  panel.addEventListener('focusin', event => {
    const button = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('[data-memory-action]'));
    const id = button?.closest('.memory-card')?.getAttribute('data-memory-id');
    if (button && id) lastFocus = {id, action: button.dataset.memoryAction === 'tv' ? 'tv' : 'open'};
  });
  panel.addEventListener('keydown', event => {
    if ((event.key === 'Escape' || event.key === 'Backspace') && mode === 'all' && !(/** @type {Element} */ (event.target).matches('input, textarea'))) {
      event.preventDefault();
      setMode('recent');
      return;
    }
    const next = neighbour(/** @type {Element} */ (event.target), event.key);
    if (!next) return;
    event.preventDefault();
    next.focus({preventScroll: true});
    next.scrollIntoView({block: 'nearest', inline: 'nearest'});
  });
  allButton.addEventListener('click', () => setMode('all'));
  backButton.addEventListener('click', () => setMode('recent'));
  retry.addEventListener('click', () => refresh());
  // A memories artifact published while the tab was hidden shows up when the user returns.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  /** Arrow keys move between cards by position, so TV remotes can walk the grid. @param {Element} from @param {string} key */
  function neighbour(from, key) {
    const direction = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[key];
    if (!direction || !from.matches('[data-memory-action="open"]')) return null;
    const origin = from.getBoundingClientRect();
    let best = /** @type {HTMLElement | null} */ (null);
    let bestScore = Infinity;
    for (const candidate of list.querySelectorAll('[data-memory-action="open"]')) {
      if (candidate === from) continue;
      const rect = candidate.getBoundingClientRect();
      const dx = rect.left + rect.width / 2 - (origin.left + origin.width / 2);
      const dy = rect.top + rect.height / 2 - (origin.top + origin.height / 2);
      if (dx * direction[0] + dy * direction[1] <= 1) continue;
      const score = Math.abs(direction[0] ? dx : dy) + Math.abs(direction[0] ? dy : dx) * 2.5;
      if (score < bestScore) [best, bestScore] = [/** @type {HTMLElement} */ (candidate), score];
    }
    return best;
  }

  render();

  return {
    refresh,
    /** Coming back restores the event the user left; the list refreshes in the background. */
    enter() {
      const target = lastFocus && (control(lastFocus.id, lastFocus.action) ?? control(lastFocus.id, 'open'));
      target?.focus({preventScroll: true});
      target?.scrollIntoView({block: 'nearest'});
      refresh();
    },
    get state() { return state; },
  };
}

async function defaultLoad() {
  const response = await fetch('/api/memories', {cache: 'no-store'});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
