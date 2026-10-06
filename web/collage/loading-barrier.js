// @ts-check

/** @typedef {{path: string, name: string}} LoadingEntry */
/** @typedef {'loading'|'ready'|'error'} LoadingStatus */

/**
 * Small browserless state machine used while selected photos are prepared.
 * Entries keep their input order and successful sources survive unrelated
 * failures, retries, and removals.
 * @template {LoadingEntry} TEntry
 * @template TSource
 * @param {TEntry[]} initialEntries
 * @param {{minimum?: number}=} options
 */
export function createPhotoLoadingBarrier(initialEntries, options = {}) {
  const minimum = options.minimum ?? 2;
  /** @type {Map<string, {entry: TEntry, status: LoadingStatus, source: TSource|null, error: Error|null}>} */
  const records = new Map();
  for (const entry of initialEntries) {
    if (!records.has(entry.path)) records.set(entry.path, {entry, status: 'loading', source: null, error: null});
  }

  /** @param {string} path */
  const record = path => records.get(path) || null;

  return Object.freeze({
    /** @param {string} path */
    has(path) { return records.has(path); },
    /** @param {string} path */
    getEntry(path) { return record(path)?.entry || null; },
    /** @param {string} path */
    start(path) {
      const item = record(path);
      if (!item) return false;
      item.status = 'loading';
      item.source = null;
      item.error = null;
      return true;
    },
    /** @param {string} path @param {TSource} source */
    succeed(path, source) {
      const item = record(path);
      if (!item) return false;
      item.status = 'ready';
      item.source = source;
      item.error = null;
      return true;
    },
    /** @param {string} path @param {unknown} error */
    fail(path, error) {
      const item = record(path);
      if (!item) return false;
      item.status = 'error';
      item.source = null;
      item.error = error instanceof Error ? error : new Error(String(error || 'Не удалось загрузить фотографию'));
      return true;
    },
    /** @param {string} path */
    remove(path) {
      if (records.size <= minimum) return false;
      return records.delete(path);
    },
    snapshot() {
      const items = [...records.values()];
      const ready = items.filter(item => item.status === 'ready' && item.source !== null);
      const failures = items.filter(item => item.status === 'error').map(item => ({entry: item.entry, error: /** @type {Error} */ (item.error)}));
      return Object.freeze({
        entries: items.map(item => item.entry),
        sources: ready.map(item => /** @type {TSource} */ (item.source)),
        failures,
        total: items.length,
        readyCount: ready.length,
        loadingCount: items.filter(item => item.status === 'loading').length,
        canFinish: items.length >= minimum && ready.length === items.length,
        canRemove: items.length > minimum,
      });
    },
  });
}
