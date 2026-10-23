// The one owner of gallery view state. Controls persist in localStorage under the
// keys used since v0.2; per-folder views (scroll anchor, focus target) live for the
// tab in sessionStorage, so they survive refresh and reload but not a new tab.
// The recursive mode of a folder is part of its view and of the page address;
// the library root never lists recursively.

import {GROUP_STORAGE_KEY, normalizeGroupMode} from './date-groups.js';

export const DENSITY_CHOICES = {desktop: [3, 5, 7], phone: [1, 2, 3]};
export const DEFAULT_DENSITY = {desktop: 5, phone: 2};
export const VIEWS_KEY = 'gallery-views';
const MAX_VIEWS = 200;

/** The root is "" or ".", optionally followed by slashes; ".." and longer dot names are folders. @param {string} folder */
export const isRoot = folder => ['', '.'].includes(folder.replace(/\/+$/, ''));

/** Listing request for a folder; the root always gets the plain listing. @param {string} folder @param {boolean} recursive */
export const listingURL = (folder, recursive) => `/api/list?path=${encodeURIComponent(folder)}${recursive && !isRoot(folder) ? '&recursive=1' : ''}`;

/** Page address of a folder view. @param {string} folder @param {boolean} recursive */
export const pageURL = (folder, recursive) => (folder ? `/?path=${encodeURIComponent(folder)}${recursive && !isRoot(folder) ? '&recursive=1' : ''}` : '/');

/** Folder and recursive mode named by a page query string. @param {string} search */
export function readPageURL(search) {
  const params = new URLSearchParams(search);
  const path = params.get('path') || '';
  return {path, recursive: params.get('recursive') === '1' && !isRoot(path)};
}

/**
 * @typedef {'desktop'|'phone'} DeviceClass
 * @typedef {{scrollY?: number, anchorPath?: string|null, anchorOffset?: number, focusPath?: string, recursive?: boolean}} FolderView
 * @typedef {{folder: string, path: string, index: number}} OpenedItem
 * @typedef {Pick<Storage, 'getItem'|'setItem'>} KeyValueStorage
 */

/**
 * @param {{path?: string, recursive?: boolean, local: KeyValueStorage, session: KeyValueStorage}} options
 */
export function createGalleryState({path = '', recursive = false, local, session}) {
  const sortKey = local.getItem('gallery-media-sort');
  const filter = local.getItem('gallery-media-filter');
  /** @type {Map<string, FolderView>} */
  const views = new Map();
  try {
    for (const [key, view] of Object.entries(JSON.parse(session.getItem(VIEWS_KEY) || '{}'))) views.set(key, view);
  } catch {
    // A damaged entry only loses remembered scroll positions.
  }

  const state = {
    /** Folder of the last successful load. */
    path,
    /** Folder of the newest load, successful or not; refresh repeats it. */
    requestedPath: path,
    /** Folder whose listing is on screen; null while loading or after an error. @type {string|null} */
    shownPath: null,
    /** Recursive mode of the newest load; never true for the root. */
    recursive: recursive && !isRoot(path),
    sortKey: sortKey === 'name' ? 'name' : 'date',
    filter: filter === 'image' || filter === 'video' ? filter : 'all',
    descending: local.getItem('gallery-media-order') !== 'asc',
    folderDescending: local.getItem('gallery-folder-order') !== 'asc',
    /** Date grouping of the media list. @type {import('./date-groups.js').GroupMode} */
    groupBy: normalizeGroupMode(local.getItem(GROUP_STORAGE_KEY)),
    /** Media item opened in the viewer; focus returns to its tile. @type {OpenedItem|null} */
    lastOpened: null,

    /** @param {DeviceClass} device */
    columns(device) {
      const stored = Number(local.getItem(`gallery-density-${device}`));
      return DENSITY_CHOICES[device].includes(stored) ? stored : DEFAULT_DENSITY[device];
    },
    /** @param {DeviceClass} device @param {number} columns */
    setColumns(device, columns) {
      if (DENSITY_CHOICES[device].includes(columns)) local.setItem(`gallery-density-${device}`, String(columns));
    },
    /** @param {string} value */
    setFilter(value) {
      if (!['all', 'image', 'video'].includes(value)) return;
      state.filter = /** @type {'all'|'image'|'video'} */ (value);
      local.setItem('gallery-media-filter', value);
    },
    /** @param {string} value */
    setSortKey(value) {
      if (value !== 'date' && value !== 'name') return;
      state.sortKey = value;
      local.setItem('gallery-media-sort', value);
    },
    /** @param {string} value */
    setGroupBy(value) {
      state.groupBy = normalizeGroupMode(value);
      local.setItem(GROUP_STORAGE_KEY, state.groupBy);
    },
    toggleDescending() {
      state.descending = !state.descending;
      local.setItem('gallery-media-order', state.descending ? 'desc' : 'asc');
    },
    toggleFolderOrder() {
      state.folderDescending = !state.folderDescending;
      local.setItem('gallery-folder-order', state.folderDescending ? 'desc' : 'asc');
    },
    /** Mode a folder opens in: the one it was last shown with. @param {string} folder */
    recursiveFor(folder) {
      return !isRoot(folder) && views.get(folder)?.recursive === true;
    },
    /** @param {string} folder @returns {FolderView|undefined} */
    view(folder) {
      return views.get(folder);
    },
    /** Merge into a folder's view; the most recently touched folders are kept. @param {string} folder @param {FolderView} patch */
    saveView(folder, patch) {
      const view = {...views.get(folder), ...patch};
      views.delete(folder);
      views.set(folder, view);
      while (views.size > MAX_VIEWS) views.delete(views.keys().next().value ?? '');
      try {
        session.setItem(VIEWS_KEY, JSON.stringify(Object.fromEntries(views)));
      } catch {
        // Storage may be full or disabled; the in-memory views still work.
      }
    },
  };
  return state;
}
