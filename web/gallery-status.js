// @ts-check
// Read-only `Состояние галереи` surface: the cache warmer run, the whole cache, recent
// failures and the memories build, all from GET /api/status. Nothing here starts,
// stops or configures the warmer.

import {formatBytes, formatCount} from './format.js';

/** Pause between the end of one status request and the next while the warmer runs. */
export const STATUS_POLL_MS = 5_000;

const UNAVAILABLE = 'Статус недоступен';
/** @type {Record<string, string>} */
const STATE_LABELS = {running: 'Выполняется', ready: 'Готово'};

/** Run-state label: only `Выполняется`, `Готово` or `Статус недоступен`. @param {unknown} state */
export const stateLabel = state => (typeof state === 'string' && STATE_LABELS[state]) || UNAVAILABLE;

/** @param {unknown} value */
const count = value => (Number.isInteger(value) && /** @type {number} */ (value) >= 0 ? /** @type {number} */ (value) : null);

/** @param {unknown} value */
function parseTime(value) {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.getTime() <= 0 ? null : date;
}

const dayFormatter = new Intl.DateTimeFormat('ru', {day: 'numeric', month: 'long'});
const yearFormatter = new Intl.DateTimeFormat('ru', {day: 'numeric', month: 'long', year: 'numeric'});

/** @param {Date} a @param {Date} b */
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * Local wall-clock moment: `сегодня в 10:00`, `вчера в 23:15`, `12 октября в 09:05`,
 * `3 марта 2025 г. в 09:05`.
 * @param {Date} date @param {Date} now
 */
export function formatMoment(date, now) {
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const day = sameDay(date, now) ? 'сегодня'
    : sameDay(date, yesterday) ? 'вчера'
      : (date.getFullYear() === now.getFullYear() ? dayFormatter : yearFormatter).format(date);
  return `${day} в ${time}`;
}

/** A path the browser may show: relative, inside the library, not empty. @param {unknown} path */
export function isRelativeMediaPath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.startsWith('\\') || /^[a-z]:/i.test(path)) return false;
  return !path.split(/[\\/]/).includes('..');
}

/** @type {Record<string, string>} */
const SERVICE_OPERATIONS = {'date-index': 'Индекс дат', memories: 'Сборка воспоминаний'};

/**
 * What a recent error is about: its relative media path, or a neutral name for a
 * service operation without a path. Empty when the entry must stay hidden: an
 * absolute, drive or escaping path, or no path and no recognisable operation.
 * @param {any} entry
 */
export function errorSubject(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (isRelativeMediaPath(entry.path)) return entry.path;
  if (entry.path !== '' && entry.path !== undefined) return '';
  const operation = entry.operation;
  if (typeof operation !== 'string' || !/^[a-z][a-z0-9-]*$/.test(operation)) return '';
  return Object.hasOwn(SERVICE_OPERATIONS, operation) ? SERVICE_OPERATIONS[operation] : 'Служебная операция';
}

const same = /** @param {string} word */ word => [word, word, word];
const RUN_METRICS = /** @type {const} */ ([
  ['processed', same('обработано')],
  ['generated', same('создано')],
  ['skipped', same('пропущено')],
  ['errors', ['ошибка', 'ошибки', 'ошибок']],
]);
const CACHE_METRICS = /** @type {const} */ ([
  ['mediaFiles', ['медиафайл', 'медиафайла', 'медиафайлов']],
  ['readyThumbnails', ['миниатюра готова', 'миниатюры готовы', 'миниатюр готово']],
  ['missingThumbnails', ['миниатюра отсутствует', 'миниатюры отсутствуют', 'миниатюр отсутствует']],
  ['unavailableThumbnails', ['миниатюра недоступна', 'миниатюры недоступны', 'миниатюр недоступно']],
]);
const MEMORY_METRICS = /** @type {const} */ ([
  ['periods', ['период', 'периода', 'периодов']],
  ['memories', ['воспоминание', 'воспоминания', 'воспоминаний']],
  ['shown', same('показано')],
  ['errors', ['ошибка', 'ошибки', 'ошибок']],
]);

/** @typedef {{value: string, label: string}} Metric one tile: `147` over `периодов` */

/**
 * `147 периодов`-style metrics for the counters that are present and valid.
 * @param {any} source @param {ReadonlyArray<readonly [string, readonly string[]]>} metrics
 * @returns {Metric[]}
 */
function metricList(source, metrics) {
  /** @type {Metric[]} */
  const list = [];
  for (const [key, forms] of metrics) {
    const value = count(source?.[key]);
    if (value !== null) list.push({value: String(value), label: formatCount(value, forms).slice(String(value).length + 1)});
  }
  return list;
}

/**
 * @typedef {object} StatusView
 * @property {{state: string, line: string, started: string, progress: null | {value: number, max: number, text: string}, metrics: Metric[]}} run
 * @property {null | {metrics: Metric[], lastFullScan: string}} cache
 * @property {{path: string, error: string}[]} errors
 * @property {{state: string, line: string, readyVersion: string, metrics: Metric[]}} memories
 */

/**
 * Everything the surface shows, derived from one /api/status document. Any missing or
 * malformed part, including the whole document, reads as `Статус недоступен`.
 * @param {any} status the decoded response, or null when the request failed
 * @param {Date} [now]
 * @returns {StatusView}
 */
export function describeStatus(status, now = new Date()) {
  const ok = status !== null && typeof status === 'object';
  const state = ok && status.state in STATE_LABELS ? status.state : 'unavailable';
  const run = ok && status.run && typeof status.run === 'object' ? status.run : null;
  const started = parseTime(run?.startedAt);
  const processed = count(run?.processed);
  const total = count(run?.total);
  /** @type {StatusView['run']['progress']} */
  let progress = null;
  if (processed !== null && total) {
    const ratio = Math.min(1, typeof run.progress === 'number' && run.progress >= 0 ? run.progress : processed / total);
    const value = Math.min(processed, total);
    progress = {value, max: total, text: `${value} / ${total} · ${Math.floor(ratio * 100)}%`};
  }

  const cache = ok && status.cache && typeof status.cache === 'object' ? status.cache : null;
  const size = count(cache?.sizeBytes);
  const scanned = parseTime(cache?.lastFullScanAt);

  const memories = ok && status.memories && typeof status.memories === 'object' ? status.memories : {};
  const memoriesState = memories.state in STATE_LABELS ? memories.state : 'unavailable';
  const readyAt = parseTime(memories.readyAt);

  return {
    run: {
      state,
      line: `Текущий запуск — ${stateLabel(state)}`,
      started: started ? `Запущен: ${formatMoment(started, now)}` : '',
      progress,
      metrics: run ? metricList(run, RUN_METRICS) : [],
    },
    cache: cache && {
      metrics: size === null ? metricList(cache, CACHE_METRICS)
        : [...metricList(cache, CACHE_METRICS), {value: formatBytes(size) || '0 Б', label: 'размер кэша'}],
      lastFullScan: scanned ? `Последний полный обход: ${formatMoment(scanned, now)}` : '',
    },
    errors: (ok && Array.isArray(status.recentErrors) ? status.recentErrors : [])
      .map(/** @param {any} entry */ entry => ({path: errorSubject(entry), error: typeof entry?.error === 'string' ? entry.error : ''}))
      .filter(/** @param {{path: string}} entry */ entry => entry.path)
      .reverse(),
    memories: {
      state: memoriesState,
      line: stateLabel(memoriesState),
      readyVersion: readyAt ? `Последняя готовая версия: ${formatMoment(readyAt, now)}` : '',
      metrics: metricList(memories, MEMORY_METRICS),
    },
  };
}

/**
 * Status requests without the DOM: one at a time, one timer at most. `open()` loads
 * once and keeps reloading every `interval` while the warmer runs; `close()` drops
 * the timer and ignores the request in flight. A failed request yields null.
 * While isHidden is true no timer runs; `visible()` then loads once.
 * @param {{
 *   load: (signal: AbortSignal) => Promise<unknown>,
 *   onResult: (status: any) => void,
 *   interval?: number,
 *   isHidden?: () => boolean,
 *   setTimer?: (callback: () => void, ms: number) => any,
 *   clearTimer?: (handle: any) => void,
 * }} options
 */
export function createStatusPoller({load, onResult, interval = STATUS_POLL_MS, isHidden = () => false, setTimer = setTimeout, clearTimer = clearTimeout}) {
  let active = false;
  /** A reload was due while the tab was hidden. */
  let missed = false;
  /** @type {AbortController | null} */
  let running = null;
  /** @type {any} */
  let handle = null;

  function clear() {
    if (handle !== null) clearTimer(handle);
    handle = null;
  }

  function schedule() {
    clear();
    if (!active) return;
    if (isHidden()) {
      missed = true;
      return;
    }
    handle = setTimer(() => {
      handle = null;
      refresh();
    }, interval);
  }

  async function refresh() {
    clear();
    if (!active || running) return;
    if (isHidden()) {
      missed = true;
      return;
    }
    const controller = new AbortController();
    running = controller;
    /** @type {any} */
    let status = null;
    try {
      status = await load(controller.signal);
    } catch {
      status = null;
    }
    if (running !== controller) return;
    running = null;
    if (!active) return;
    onResult(status);
    if (status?.state === 'running') schedule();
  }

  return {
    open() {
      if (active) return;
      active = true;
      missed = false;
      refresh();
    },
    close() {
      active = false;
      missed = false;
      clear();
      running?.abort();
      running = null;
    },
    /** The tab was hidden: drop the timer; the next `visible()` reloads. */
    hidden() {
      if (handle === null) return;
      clear();
      missed = true;
    },
    visible() {
      if (!active || !missed || isHidden()) return;
      missed = false;
      refresh();
    },
    get active() { return active; },
    get pending() { return handle !== null; },
    get loading() { return running !== null; },
  };
}

/** @param {AbortSignal} signal */
async function fetchStatus(signal) {
  const response = await fetch('/api/status', {cache: 'no-store', signal});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * @param {string} tag @param {string} [className] @param {string} [text]
 * @returns {HTMLElement}
 */
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** One tile per metric; the space keeps `147 периодов` as the accessible text. @param {Metric[]} metrics */
function metricsNode(metrics) {
  const list = element('ul', 'gallery-status-metrics');
  for (const {value, label} of metrics) {
    const tile = element('li', 'gallery-status-tile');
    tile.append(element('span', 'gallery-status-value', value), ' ', element('span', 'gallery-status-label', label));
    list.append(tile);
  }
  return list;
}

/**
 * Builds the surface inside `panel` and returns its enter/leave hooks.
 * @param {{panel: HTMLElement, load?: (signal: AbortSignal) => Promise<unknown>, now?: () => Date}} options
 */
export function createGalleryStatus({panel, load = fetchStatus, now = () => new Date()}) {
  panel.replaceChildren();
  panel.removeAttribute('aria-label');
  panel.setAttribute('aria-labelledby', 'galleryStatusTitle');
  const title = element('h1', '', 'Состояние галереи');
  title.id = 'galleryStatusTitle';
  title.tabIndex = -1;

  const section = /** @param {string} id @param {string} heading */ (id, heading) => {
    const node = element('section', 'gallery-status-section');
    node.dataset.statusSection = id;
    const h2 = element('h2', '', heading);
    h2.id = `galleryStatus-${id}`;
    node.setAttribute('aria-labelledby', h2.id);
    const body = element('div', 'gallery-status-body');
    node.append(h2, body);
    return {node, body};
  };
  const cache = section('cache', 'Кэш');
  const errors = section('errors', 'Последние ошибки');
  const memories = section('memories', 'Воспоминания');
  // Announces state changes only, not every progress tick.
  const announcer = element('p', 'visually-hidden');
  announcer.setAttribute('role', 'status');
  panel.append(title, cache.node, errors.node, memories.node, announcer);

  /** @param {StatusView} view */
  function render(view) {
    const run = element('div', 'gallery-status-run');
    run.dataset.state = view.run.state;
    run.append(element('p', 'gallery-status-line', view.run.line));
    if (view.run.started) run.append(element('p', 'gallery-status-sub', view.run.started));
    if (view.run.progress) {
      const {value, max, text} = view.run.progress;
      const bar = /** @type {HTMLProgressElement} */ (element('progress', 'gallery-status-progress'));
      bar.max = max;
      bar.value = value;
      bar.setAttribute('aria-label', 'Прогресс текущего запуска');
      const progress = element('div', 'gallery-status-progress-row');
      progress.append(bar, element('span', '', text));
      run.append(progress);
    }
    if (view.run.metrics.length) run.append(metricsNode(view.run.metrics));

    const whole = element('div', 'gallery-status-whole');
    whole.dataset.statusSection = 'whole-cache';
    whole.append(element('h3', '', 'Весь кэш'));
    if (view.cache) {
      whole.append(metricsNode(view.cache.metrics));
      if (view.cache.lastFullScan) whole.append(element('p', 'gallery-status-sub', view.cache.lastFullScan));
    } else {
      whole.append(element('p', 'gallery-status-sub', UNAVAILABLE));
    }
    cache.body.replaceChildren(run, whole);

    if (view.errors.length) {
      // Scrolls inside its card, so it takes focus for keyboard scrolling.
      const list = element('ul', 'gallery-status-errors');
      list.tabIndex = 0;
      list.setAttribute('aria-label', 'Список последних ошибок');
      for (const entry of view.errors) {
        const item = element('li');
        item.append(element('span', 'gallery-status-path', entry.path));
        if (entry.error) item.append(element('span', 'gallery-status-sub', entry.error));
        list.append(item);
      }
      errors.body.replaceChildren(list);
    } else {
      errors.body.replaceChildren(element('p', 'gallery-status-sub', 'Ошибок нет'));
    }

    const memory = element('div', 'gallery-status-run');
    memory.dataset.state = view.memories.state;
    memory.append(element('p', 'gallery-status-line', view.memories.line));
    if (view.memories.readyVersion) memory.append(element('p', 'gallery-status-sub', view.memories.readyVersion));
    if (view.memories.metrics.length) memory.append(metricsNode(view.memories.metrics));
    memories.body.replaceChildren(memory);

    const announcement = `Кэш: ${view.run.line.replace('Текущий запуск — ', '')}. Воспоминания: ${view.memories.line}.`;
    if (announcer.textContent !== announcement) announcer.textContent = announcement;
  }

  const poller = createStatusPoller({
    load,
    onResult: status => {
      panel.removeAttribute('aria-busy');
      render(describeStatus(status, now()));
    },
    isHidden: () => document.hidden,
  });
  document.addEventListener('visibilitychange', () => (document.hidden ? poller.hidden() : poller.visible()));

  return {
    enter() {
      if (!poller.active) panel.setAttribute('aria-busy', 'true');
      poller.open();
      title.focus({preventScroll: true});
    },
    leave() {
      panel.removeAttribute('aria-busy');
      poller.close();
    },
    panel,
    poller,
  };
}
