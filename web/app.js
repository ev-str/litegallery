import {createSurfaces, routeSurfaceEntries} from './app-surfaces.js';
import {createCollageLanding} from './collage-landing.js';
import {createCollageSelection} from './collage-selection.js';
import {apiURL, formatCount, formatDate, formatDuration, formatFileDetails} from './format.js';
import {createGalleryStatus} from './gallery-status.js';
import {createGalleryState, DENSITY_CHOICES, isRoot, listingURL, pageURL, readPageURL} from './gallery-state.js';
import {iconLabelMarkup, iconMarkup} from './icons.js';
import {createRefreshLoop} from './live-refresh.js';
import {createLoadQueue} from './load-queue.js';
import {createMediaWindow} from './media-window.js';
import {createSearch, relativeFolder, relativePath} from './search.js';
import {createMemories} from './memories.js';
import {pauseVideoWork, queueVideoDuration, queueVideoPreview, wakeVideoWork} from './video-posters.js';
import {createViewer} from './viewer.js';

const statusBox = document.querySelector('#status');
const crumbs = document.querySelector('#breadcrumbs');
const foldersSection = document.querySelector('#foldersSection');
const mediaSection = document.querySelector('#mediaSection');
const foldersGrid = document.querySelector('#folders');
const mediaGrid = document.querySelector('#mediaGrid');
const folderCount = document.querySelector('#folderCount');
const mediaCount = document.querySelector('#mediaCount');
const folderSort = document.querySelector('#folderSort');
const mediaSort = document.querySelector('#mediaSort');
const mediaDirection = document.querySelector('#mediaDirection');
const mediaFilter = document.querySelector('#mediaFilter');
const emptyState = document.querySelector('#emptyState');
const refreshButton = document.querySelector('#refresh');
const tvButton = document.querySelector('#tvMode');
const recursiveToggle = document.querySelector('#recursiveToggle');
const densityControl = document.querySelector('#gridDensity');
const header = document.querySelector('.topbar');
const collageEditor = document.querySelector('#collageEditor');
const main = document.querySelector('#gallerySurface');
const galleryEntry = document.querySelector('#galleryMode');

const state = createGalleryState({...readPageURL(location.search), local: localStorage, session: sessionStorage});
let directories = [];
let allMedia = [];
let media = [];
/** Header control or memories card that opened the viewer; null when a tile did. */
let viewerOpener = null;

// Fixed grid density, stored separately for phones and for desktop/TV screens.
const phoneQuery = matchMedia('(max-width: 700px)');
const deviceClass = () => (phoneQuery.matches ? 'phone' : 'desktop');
const gridColumns = () => state.columns(deviceClass());

function applyDensity() {
  const device = deviceClass();
  const columns = state.columns(device);
  document.body.dataset.gridColumns = String(columns);
  densityControl.querySelectorAll('[data-density-step]').forEach(button => {
    const value = DENSITY_CHOICES[device][Number(button.dataset.densityStep)];
    button.textContent = String(value);
    button.dataset.columns = String(value);
    button.setAttribute('aria-label', formatCount(value, ['колонка', 'колонки', 'колонок']));
    button.setAttribute('aria-pressed', String(value === columns));
  });
}

// Folder counts and video durations are fetched only for cards near the viewport.
const visibleCallbacks = new WeakMap();
const visibility = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    visibility.unobserve(entry.target);
    visibleCallbacks.get(entry.target)?.();
  }
}, {rootMargin: '300px'});

function whenVisible(element, callback) {
  visibleCallbacks.set(element, callback);
  visibility.observe(element);
}

function clearGrid(grid) {
  for (const child of grid.children) visibility.unobserve(child);
  grid.replaceChildren();
}

const FOLDER_COUNT_REQUESTS = 2;
const folderCounts = new Map();
const folderCountQueue = [];
let folderCountRequests = 0;

function loadFolderCounts(item) {
  const key = `${item.path}\n${item.modTime}`;
  if (!folderCounts.has(key)) {
    folderCounts.set(key, new Promise(resolve => folderCountQueue.push({item, key, resolve})));
    pumpFolderCounts();
  }
  return folderCounts.get(key);
}

function pumpFolderCounts() {
  while (folderCountRequests < FOLDER_COUNT_REQUESTS && folderCountQueue.length) {
    const {item, key, resolve} = folderCountQueue.shift();
    folderCountRequests++;
    fetch(apiURL('/api/list', item.path))
      .then(response => {
        if (!response.ok) throw new Error('Каталог недоступен');
        return response.json();
      })
      .then(data => resolve({
        folders: data.entries.filter(entry => entry.kind === 'directory').length,
        images: data.entries.filter(entry => entry.kind === 'image').length,
        videos: data.entries.filter(entry => entry.kind === 'video').length,
      }))
      .catch(() => {
        folderCounts.delete(key);
        resolve(null);
      })
      .finally(() => {
        folderCountRequests--;
        pumpFolderCounts();
      });
  }
}

function cancelFolderCounts() {
  for (const {key, resolve} of folderCountQueue.splice(0)) {
    folderCounts.delete(key);
    resolve(null);
  }
}

function formatFolderCounts({folders, images, videos}) {
  const parts = [
    folders && formatCount(folders, ['папка', 'папки', 'папок']),
    images && formatCount(images, ['фото', 'фото', 'фото']),
    videos && formatCount(videos, ['видео', 'видео', 'видео']),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Пустая папка';
}

function markBroken(card) {
  if (card.classList.contains('is-broken')) return;
  card.classList.add('is-broken');
  const fallback = document.createElement('span');
  fallback.className = 'thumb-fallback';
  fallback.innerHTML = `${iconMarkup('image-off')}<span>Нет превью</span>`;
  card.prepend(fallback);
}

function trackThumbnail(card, image, {broken = true} = {}) {
  card.classList.add('is-loading');
  image.addEventListener('load', () => card.classList.remove('is-loading'), {once: true});
  image.addEventListener('error', () => {
    card.classList.remove('is-loading');
    if (broken) markBroken(card);
  }, {once: true});
}

// Thumbnails load through one bounded queue: visible tiles first, then the preload
// range. A tile that leaves the grid drops its queued load and cancels a running one.
const THUMBNAIL_REQUESTS = 6;
const thumbnails = createLoadQueue({concurrency: THUMBNAIL_REQUESTS});

/** @param {{signal: AbortSignal, priority: () => number}} work */
function loadThumbnail(image, src, {signal, priority}) {
  thumbnails.add(() => new Promise(resolve => {
    const done = () => {
      signal.removeEventListener('abort', cancel);
      resolve(undefined);
    };
    const cancel = () => {
      image.removeAttribute('src');
      done();
    };
    image.addEventListener('load', done, {once: true});
    image.addEventListener('error', done, {once: true});
    signal.addEventListener('abort', cancel, {once: true});
    image.src = src;
  }), {signal, priority});
}

// The viewer's own media comes first: gallery work waits while it is open.
function pauseGalleryWork(paused) {
  thumbnails.setConcurrency(paused ? 0 : THUMBNAIL_REQUESTS);
  pauseVideoWork(paused);
}

// Latest request wins: only the newest load may touch history, the grids, and busy state.
let loadToken = 0;
let loadController = null;
let skeletonTimer = 0;
/** Entries of the listing on screen, as received; a background check that matches them changes nothing. */
let shownListing = null;

function renderSkeletons() {
  mediaWindow.clear();
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < gridColumns() * 2; index++) {
    const skeleton = document.createElement('span');
    skeleton.className = 'media-skeleton';
    skeleton.setAttribute('aria-hidden', 'true');
    fragment.append(skeleton);
  }
  mediaGrid.append(fragment);
  mediaSection.dataset.loading = 'true';
  mediaSection.hidden = false;
}

const nameCollator = new Intl.Collator('ru', {numeric: true, sensitivity: 'base'});
const viewer = createViewer(document.querySelector('#viewer'), {onClose: returnFromViewer});
const selection = createCollageSelection({onModeChange: applyMediaView, getCurrentPath: () => state.path});
const mediaWindow = createMediaWindow({
  grid: mediaGrid,
  createCard: createMediaCard,
  viewportTop: () => header.getBoundingClientRect().bottom,
  onChange: () => {
    thumbnails.wake();
    wakeVideoWork();
  },
});
const searchInput = document.querySelector('#searchInput');
const search = createSearch({
  panel: document.querySelector('#searchSurface'),
  input: searchInput,
  clear: document.querySelector('#searchClear'),
  count: document.querySelector('#searchCount'),
  scope: document.querySelector('#searchScope'),
  empty: document.querySelector('#searchEmpty'),
  grid: document.querySelector('#searchGrid'),
  // null while a listing loads; a failed load leaves nothing to search.
  getItems: () => (state.shownPath !== null ? media : loadController ? null : []),
  getScope: () => ({folder: state.shownPath ?? state.requestedPath, recursive: state.recursive, filter: state.filter}),
  createCard: (item, index, work) => createMediaCard(item, index, work, 'search'),
  viewportTop: () => header.getBoundingClientRect().bottom,
  onChange: () => {
    thumbnails.wake();
    wakeVideoWork();
  },
  onResults: syncTvButton,
});

function sortByName(items, descending) {
  const sorted = [...items].sort((left, right) => nameCollator.compare(left.name, right.name));
  return descending ? sorted.reverse() : sorted;
}

function sortMedia(items) {
  const sorted = [...items].sort((left, right) => {
    if (state.sortKey === 'date') {
      const byDate = (left.sortTime || 0) - (right.sortTime || 0);
      if (byDate !== 0) return byDate;
    }
    return nameCollator.compare(left.name, right.name);
  });
  return state.descending ? sorted.reverse() : sorted;
}

function updateSortButton(button, descending) {
  button.innerHTML = iconLabelMarkup(descending ? 'arrow-down' : 'arrow-up', descending ? 'Z–A' : 'A–Z');
  button.setAttribute('aria-pressed', String(descending));
}

function updateMediaControls() {
  mediaSort.value = state.sortKey;
  mediaFilter.querySelectorAll('[data-filter]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
  });
  mediaDirection.innerHTML = iconMarkup(state.descending ? 'arrow-down' : 'arrow-up');
  const dateDirection = state.descending ? 'Сначала новые' : 'Сначала старые';
  const nameDirection = state.descending ? 'От Z к A' : 'От A к Z';
  mediaDirection.title = state.sortKey === 'date' ? dateDirection : nameDirection;
  mediaDirection.setAttribute('aria-label', `Изменить направление сортировки. Сейчас: ${mediaDirection.title}`);
}

function applyMediaView() {
  const filtered = allMedia.filter(item => state.filter === 'all' || item.kind === state.filter);
  media = sortMedia(filtered);
  renderMedia(media);
  search.refresh();
  syncTvButton();
}

// TV plays the list of the current section: the gallery media, or the results in Найти.
function syncTvButton() {
  tvButton.disabled = (surfaces.current === 'search' ? search.results : media).length === 0;
}

/**
 * @param {string} path
 * @param {{history?: 'push'|'replace'|'none', recursive?: boolean}} options
 *   recursive defaults to the mode the folder was last shown with
 */
async function load(path, {history: address = 'push', recursive = state.recursiveFor(path)} = {}) {
  const token = ++loadToken;
  rememberView();
  state.shownPath = null;
  state.requestedPath = path;
  state.recursive = recursive && !isRoot(path);
  updateRecursiveToggle();
  loadController?.abort();
  liveRefresh.abort();
  shownListing = null;
  loadController = new AbortController();
  const {signal} = loadController;
  clearTimeout(skeletonTimer);
  statusBox.textContent = 'Загрузка…';
  cancelFolderCounts();
  clearGrid(foldersGrid);
  mediaWindow.clear();
  delete mediaSection.dataset.loading;
  foldersSection.hidden = true;
  mediaSection.hidden = true;
  emptyState.hidden = true;
  tvButton.disabled = true;
  refreshButton.classList.add('is-busy');
  refreshButton.setAttribute('aria-busy', 'true');
  skeletonTimer = setTimeout(renderSkeletons, 150);
  try {
    const response = await fetch(listingURL(path, state.recursive), {signal});
    if (!response.ok) throw new Error('Каталог недоступен');
    const data = await response.json();
    if (token !== loadToken) return;
    state.path = state.requestedPath = data.path === '.' ? '' : data.path;
    document.title = state.path ? `${data.title} — ${state.path}` : data.title;
    document.querySelector('#brand').textContent = data.title;
    // Repeating the shown folder (refresh, its breadcrumb) adds no history entry;
    // switching the recursive mode rewrites the current one.
    const target = pageURL(state.path, state.recursive);
    if (address === 'replace') history.replaceState({path: state.path, recursive: state.recursive}, '', target);
    else if (address === 'push' && location.pathname + location.search !== target) history.pushState({path: state.path, recursive: state.recursive}, '', target);
    if (state.path) state.saveView(state.path, {recursive: state.recursive});
    renderBreadcrumbs();
    clearTimeout(skeletonTimer);
    delete mediaSection.dataset.loading;
    showListing(data.entries);
    shownListing = JSON.stringify(data.entries);
    state.shownPath = state.path;
    restoreView(state.path);
  } catch (error) {
    if (token !== loadToken) return;
    clearTimeout(skeletonTimer);
    delete mediaSection.dataset.loading;
    mediaWindow.clear();
    mediaSection.hidden = true;
    statusBox.textContent = error.message;
  } finally {
    if (token === loadToken) {
      loadController = null;
      refreshButton.classList.remove('is-busy');
      refreshButton.removeAttribute('aria-busy');
      liveRefresh.restart();
    }
  }
}

function showListing(entries) {
  render(entries);
  emptyState.hidden = entries.length > 0;
  emptyState.querySelector('span').textContent = state.recursive ? 'В этой папке и её подпапках нет фотографий и видео' : 'В этой папке нет фотографий, видео и вложенных папок';
  statusBox.textContent = entries.length ? formatCount(entries.length, ['элемент', 'элемента', 'элементов']) : '';
}

// Background checks repeat the request of the page on screen quietly: no skeletons, no busy
// state, no history or saved view. A load started meanwhile aborts the check, and an answer
// for a page that has moved on is dropped. The viewer keeps the list it was opened with.
const canCheck = () => state.shownPath !== null && state.shownPath === state.requestedPath && !collageEditor.open && !selection.active && surfaces.current === 'gallery';

/** @param {AbortSignal} signal aborts when a load starts or the tab is hidden */
async function checkForChanges(signal) {
  const token = loadToken;
  const response = await fetch(listingURL(state.requestedPath, state.recursive), {signal});
  if (!response.ok) throw new Error('Каталог недоступен');
  const data = await response.json();
  if (signal.aborted || token !== loadToken || !canCheck()) return;
  const listing = JSON.stringify(data.entries);
  if (listing === shownListing) return;
  shownListing = listing;
  updateInPlace(data.entries);
}

// Re-render the changed listing where the user is: the top tile keeps its place on screen
// and a focused tile keeps focus, or passes it to the tile that took its place.
function updateInPlace(entries) {
  const top = scrollY;
  const anchor = top > 0 ? firstVisibleItem() : undefined;
  const anchorTop = anchor?.getBoundingClientRect().top ?? 0;
  const focused = main.contains(document.activeElement) ? document.activeElement.closest('.gallery-item') : null;
  const focusedMedia = focused?.classList.contains('media-card');
  const focusIndex = focused ? (focusedMedia ? media.findIndex(item => item.path === focused.dataset.path) : [...foldersGrid.children].indexOf(focused)) : -1;
  showListing(entries);
  const moved = tileFor(anchor?.dataset.path);
  scrollTo({top: moved ? scrollY + moved.getBoundingClientRect().top - anchorTop : top, behavior: 'instant'});
  mediaWindow.sync();
  if (!focused || document.activeElement !== document.body) return;
  const nearest = focusedMedia ? (media.length ? mediaWindow.revealIndex(Math.min(Math.max(focusIndex, 0), media.length - 1)) : null) : foldersGrid.children[Math.min(focusIndex, foldersGrid.children.length - 1)];
  (tileFor(focused.dataset.path) ?? nearest)?.focus({preventScroll: true});
}

const liveRefresh = createRefreshLoop({check: checkForChanges, canCheck, isHidden: () => document.hidden});

// Recursive listings name every file by its path below the opened folder; a tile
// shows that subfolder only when another file in the listing has the same name.
let subfolders = new Map();

function subfolderContext(items, folder) {
  const prefix = folder ? `${folder}/` : '';
  const names = new Map();
  for (const item of items) {
    const key = item.name.toLowerCase();
    names.set(key, (names.get(key) ?? 0) + 1);
  }
  return new Map(items.map(item => {
    const relative = item.path.startsWith(prefix) ? item.path.slice(prefix.length) : item.path;
    const parent = relative.slice(0, -item.name.length).replace(/\/$/, '');
    return [item.path, {relative, folder: names.get(item.name.toLowerCase()) > 1 ? parent || 'Эта папка' : null}];
  }));
}

function updateRecursiveToggle() {
  recursiveToggle.hidden = isRoot(state.requestedPath);
  recursiveToggle.setAttribute('aria-pressed', String(state.recursive));
}

function render(entries) {
  directories = entries.filter(item => item.kind === 'directory');
  allMedia = entries.filter(item => item.kind !== 'directory');
  subfolders = state.recursive ? subfolderContext(allMedia, state.path) : new Map();
  renderFolders(sortByName(directories, state.folderDescending));
  applyMediaView();
}

function renderFolders(items) {
  clearGrid(foldersGrid);
  foldersSection.hidden = items.length === 0;
  folderCount.textContent = formatCount(items.length, ['папка', 'папки', 'папок']);
  updateSortButton(folderSort, state.folderDescending);
  const fragment = document.createDocumentFragment();
  for (const [index, item] of items.entries()) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'folder-card gallery-item';
    card.dataset.path = item.path;
    card.setAttribute('aria-label', `Открыть папку ${item.name}`);
    const fallback = document.createElement('span');
    fallback.className = 'folder-fallback';
    fallback.textContent = '◇';
    const cover = document.createElement('img');
    cover.loading = 'lazy';
    cover.alt = '';
    cover.src = apiURL('/api/cover', item.path, item.modTime);
    cover.addEventListener('error', () => cover.classList.add('is-missing'));
    const overlay = document.createElement('span');
    overlay.className = 'folder-caption';
    overlay.innerHTML = `<span class="folder-name"></span><span class="folder-meta">…</span>`;
    overlay.querySelector('.folder-name').textContent = item.name;
    const meta = overlay.querySelector('.folder-meta');
    meta.id = `folder-meta-${index}`;
    card.setAttribute('aria-describedby', meta.id);
    whenVisible(card, () => loadFolderCounts(item).then(counts => {
      meta.textContent = counts ? formatFolderCounts(counts) : 'Открыть альбом';
    }));
    card.append(fallback, cover, overlay);
    card.addEventListener('click', () => {
      state.saveView(state.path, {focusPath: item.path});
      load(item.path);
    });
    fragment.append(card);
  }
  foldersGrid.append(fragment);
}

function renderMedia(items) {
  mediaSection.hidden = allMedia.length === 0;
  mediaCount.textContent = formatCount(items.length, ['файл', 'файла', 'файлов']);
  updateMediaControls();
  if (items.length === 0) {
    mediaWindow.clear();
    const empty = document.createElement('div');
    empty.className = 'media-empty';
    empty.textContent = 'Здесь нет файлов выбранного типа';
    mediaGrid.append(empty);
    return;
  }
  mediaWindow.setItems(items);
}

/**
 * One media tile; the window creates it when the tile comes near the viewport.
 * @param {{signal: AbortSignal, priority: () => number}} work aborts when the tile leaves the grid
 * @param {'gallery'|'search'} source grid the tile belongs to; the viewer opens its list
 */
function createMediaCard(item, index, work, source = 'gallery') {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = `media-card gallery-item ${item.kind}`;
  card.dataset.path = item.path;
  // Recursive search results always name their subfolder.
  const context = source === 'search' && state.recursive ? {relative: relativePath(item, state.path), folder: relativeFolder(item, state.path) || 'Эта папка'} : subfolders.get(item.path);
  card.title = context?.relative ?? item.name;
  if (!selection.decorateCard(card, item)) card.setAttribute('aria-label', `Открыть ${context?.relative ?? item.name}`);
  const version = `${item.modTime}-${item.size}`;
  if (item.kind === 'image') {
    const image = document.createElement('img');
    image.decoding = 'async';
    image.alt = '';
    trackThumbnail(card, image);
    loadThumbnail(image, apiURL('/api/thumb', item.path, version), work);
    card.append(image);
  } else {
    const poster = document.createElement('img');
    poster.className = 'video-poster';
    poster.decoding = 'async';
    poster.alt = '';
    trackThumbnail(card, poster, {broken: false});
    poster.addEventListener('error', () => {
      if (work.signal.aborted) return;
      poster.classList.add('is-missing');
      queueVideoPreview(item, poster, () => markBroken(card), work);
    }, {once: true});
    loadThumbnail(poster, apiURL('/api/video-poster', item.path, version), work);
    const preview = document.createElement('span');
    preview.className = 'video-preview';
    preview.innerHTML = `<span class="play">${iconMarkup('play')}</span>`;
    card.append(poster, preview);
  }
  const overlay = document.createElement('span');
  overlay.className = 'media-caption';
  overlay.id = `${source === 'search' ? 'search' : 'media'}-caption-${index}`;
  overlay.innerHTML = '<span class="media-meta"></span><span class="media-details"></span>';
  const primary = overlay.querySelector('.media-meta');
  primary.textContent = formatDate(item.sortTime);
  overlay.querySelector('.media-details').textContent = formatFileDetails(item);
  if (context?.folder) {
    const folder = document.createElement('span');
    folder.className = 'media-folder';
    folder.textContent = context.folder;
    overlay.prepend(folder);
  }
  card.setAttribute('aria-describedby', overlay.id);
  if (item.kind === 'video') {
    whenVisible(card, () => queueVideoDuration(item, seconds => {
      primary.textContent = formatDuration(seconds);
      card.classList.add('has-duration');
    }, work.signal, work.priority));
    work.signal.addEventListener('abort', () => visibility.unobserve(card), {once: true});
  }
  card.append(overlay);
  card.addEventListener('click', () => {
    if (selection.handleCardClick(item, card)) return;
    const list = source === 'search' ? search.results : media;
    const index = list.findIndex(entry => entry.path === item.path);
    state.lastOpened = {folder: state.path, path: item.path, index, source};
    if (source === 'gallery') state.saveView(state.path, {focusPath: item.path});
    viewerOpener = null;
    pauseGalleryWork(true);
    viewer.open(list, index);
  });
  return card;
}

function renderBreadcrumbs() {
  crumbs.replaceChildren();
  const root = document.createElement('button');
  root.textContent = 'Все фото';
  root.onclick = () => load('');
  crumbs.append(root);
  let path = '';
  for (const part of state.path.split('/').filter(Boolean)) {
    crumbs.append(document.createTextNode(' / '));
    path = path ? `${path}/${part}` : part;
    const target = path;
    const button = document.createElement('button');
    button.textContent = part;
    button.onclick = () => load(target);
    crumbs.append(button);
  }
  // Keep the current folder visible when the path is wider than the header.
  crumbs.scrollLeft = crumbs.scrollWidth;
}

function galleryItems() {
  return [...foldersGrid.children, ...mediaGrid.children].filter(element => element.classList.contains('gallery-item'));
}

function findItem(path) {
  return path ? main.querySelector(`.gallery-item[data-path="${CSS.escape(path)}"]`) : null;
}

// A media tile outside the rendered window is created on demand.
function tileFor(path) {
  return findItem(path) ?? mediaWindow.reveal(path);
}

// First tile not hidden by the sticky header; tiles are in layout order, so bisect.
function firstVisibleItem() {
  const items = galleryItems();
  const top = header.getBoundingClientRect().bottom;
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (items[middle].getBoundingClientRect().bottom > top) high = middle;
    else low = middle + 1;
  }
  return items[low];
}

// Scroll is remembered by its anchor tile, so a density change or a file added above
// still brings back the same tiles; the raw offset is the fallback.
function rememberView() {
  if (state.shownPath === null) return;
  const anchor = scrollY > 0 ? firstVisibleItem() : undefined;
  state.saveView(state.shownPath, {
    scrollY: Math.round(scrollY),
    anchorPath: anchor?.dataset.path ?? null,
    anchorOffset: anchor ? Math.round(anchor.getBoundingClientRect().top) : 0,
  });
}

// Called right after a render: scrollTo forces the layout of the new grid.
function restoreView(path) {
  const view = state.view(path);
  const anchor = tileFor(view?.anchorPath);
  const top = anchor ? scrollY + anchor.getBoundingClientRect().top - view.anchorOffset : view?.scrollY ?? 0;
  scrollTo({top, behavior: 'instant'});
  mediaWindow.sync();
  // The grids were rebuilt, so focus that was on a tile is lost; other focus stays.
  if (document.activeElement === document.body) tileFor(view?.focusPath)?.focus({preventScroll: true});
}

// Re-render without a jump: the anchor keeps its place on screen.
function keepInPlace(anchor, update) {
  const before = anchor?.getBoundingClientRect().top;
  update();
  if (anchor?.isConnected) scrollBy({top: anchor.getBoundingClientRect().top - before, behavior: 'instant'});
}

function flashLastOpened(tile) {
  tile.classList.remove('is-last-opened');
  void tile.offsetWidth;
  tile.classList.add('is-last-opened');
  const done = event => {
    if (event.target !== tile || !event.animationName.startsWith('gallery-last-opened')) return;
    tile.classList.remove('is-last-opened');
    tile.removeEventListener('animationend', done);
  };
  tile.addEventListener('animationend', done);
}

// After the viewer: focus the header TV button if TV started there; else the tile it was
// opened from, else its nearest neighbour, else the refresh button in the sticky header.
function returnFromViewer() {
  pauseGalleryWork(surfaces.current !== 'gallery' && surfaces.current !== 'search');
  if (viewerOpener) {
    viewerOpener.focus({preventScroll: true});
    viewerOpener = null;
    return;
  }
  const opened = state.lastOpened;
  if (!opened) return;
  const sameFolder = opened.folder === state.shownPath;
  const fromSearch = opened.source === 'search' && surfaces.current === 'search';
  const list = fromSearch ? search.results : media;
  const tile = sameFolder ? (fromSearch ? search.tileFor(opened.path) : tileFor(opened.path)) : null;
  const neighbour = sameFolder && list.length ? (fromSearch ? search : mediaWindow).revealIndex(Math.min(opened.index, list.length - 1)) : null;
  const target = tile || neighbour || (fromSearch ? searchInput : galleryItems()[0] || refreshButton);
  target.focus({preventScroll: true});
  // Pointer users get no :focus-visible after a programmatic focus; show the ring anyway.
  target.classList.add('is-return-focus');
  target.addEventListener('blur', () => target.classList.remove('is-return-focus'), {once: true});
  if (target === refreshButton || target === searchInput) return;
  target.scrollIntoView({block: 'nearest', inline: 'nearest'});
  if (target === tile) flashLastOpened(tile);
}

// Arrow keys move focus to the nearest gallery card in that direction (TV remotes).
// Inside the media grid the move follows the list, so it crosses the rendered window.
function focusInDirection(key) {
  const active = document.activeElement;
  if (!active?.classList.contains('gallery-item')) return false;
  const inSearch = search.owns(active);
  const next = active.classList.contains('media-card') ? (inSearch ? search : mediaWindow).neighbour(active, key) : null;
  if (next) {
    next.focus({preventScroll: true});
    next.scrollIntoView({block: 'nearest', inline: 'nearest', behavior: 'smooth'});
    return true;
  }
  // The search grid holds media cards only: its edge is the end of the move.
  if (inSearch) return false;
  const cards = [...document.querySelectorAll('.gallery-item:not([hidden])')];
  const from = active.getBoundingClientRect();
  const fx = from.left + from.width / 2;
  const fy = from.top + from.height / 2;
  const direction = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[key];
  if (!direction) return false;
  let best = null;
  let bestScore = Infinity;
  for (const card of cards) {
    if (card === active) continue;
    const rect = card.getBoundingClientRect();
    const dx = rect.left + rect.width / 2 - fx;
    const dy = rect.top + rect.height / 2 - fy;
    if (dx * direction[0] + dy * direction[1] <= 0) continue;
    const primary = Math.abs(direction[0] ? dx : dy);
    const secondary = Math.abs(direction[0] ? dy : dx);
    const score = primary + secondary * 2.5;
    if (score < bestScore) { best = card; bestScore = score; }
  }
  best?.focus({preventScroll: true});
  best?.scrollIntoView({block: 'nearest', inline: 'nearest', behavior: 'smooth'});
  return Boolean(best);
}

// Sorting and filtering keep their section heading in place; density keeps the top tile.
const foldersHeading = foldersSection.querySelector('.section-heading');
const mediaHeading = mediaSection.querySelector('.section-heading');

folderSort.addEventListener('click', () => keepInPlace(foldersHeading, () => {
  state.toggleFolderOrder();
  renderFolders(sortByName(directories, state.folderDescending));
}));

mediaSort.addEventListener('change', () => keepInPlace(mediaHeading, () => {
  state.setSortKey(mediaSort.value);
  applyMediaView();
}));

mediaDirection.addEventListener('click', () => keepInPlace(mediaHeading, () => {
  state.toggleDescending();
  applyMediaView();
}));

mediaFilter.addEventListener('click', event => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  keepInPlace(mediaHeading, () => {
    state.setFilter(button.dataset.filter);
    applyMediaView();
  });
});

densityControl.addEventListener('click', event => {
  const button = event.target.closest('[data-columns]');
  if (!button) return;
  keepInPlace(firstVisibleItem(), () => {
    state.setColumns(deviceClass(), Number(button.dataset.columns));
    applyDensity();
    mediaWindow.relayout();
  });
});
phoneQuery.addEventListener('change', () => keepInPlace(firstVisibleItem(), () => {
  applyDensity();
  mediaWindow.relayout();
}));

main.addEventListener('focusin', event => {
  const item = event.target.closest('.gallery-item');
  if (item && state.shownPath !== null) state.saveView(state.shownPath, {focusPath: item.dataset.path});
});
addEventListener('pagehide', rememberView);
document.addEventListener('visibilitychange', () => (document.hidden ? liveRefresh.hidden() : liveRefresh.visible()));
history.scrollRestoration = 'manual';

// After an interrupted navigation or a failed load the address catches up.
refreshButton.onclick = () => load(state.requestedPath, {recursive: state.recursive});
// TV shows the current selection, filter and sort applied, from its first item; in Найти it
// shows the results. The viewer requests fullscreen synchronously inside this click.
tvButton.onclick = () => {
  const list = surfaces.current === 'search' ? search.results : media;
  if (!list.length || viewer.isOpen) return;
  viewerOpener = tvButton;
  pauseGalleryWork(true);
  viewer.openTV(list, 0);
};
recursiveToggle.addEventListener('click', () => load(state.requestedPath, {history: 'replace', recursive: !state.recursive}));
addEventListener('popstate', () => {
  const {path, recursive} = readPageURL(location.search);
  surfaces.show('gallery');
  load(path, {history: 'none', recursive});
});
addEventListener('keydown', event => {
  if (viewer.isOpen) {
    viewer.handleKey(event);
    return;
  }
  if (focusInDirection(event.key)) event.preventDefault();
  if ((event.key === 'Escape' || event.key === 'Backspace') && state.path && surfaces.current === 'gallery') {
    event.preventDefault();
    load(state.path.split('/').slice(0, -1).join('/'));
  }
});

// Application sections. The gallery stays rendered while another section is open:
// leaving it remembers scroll and focus, coming back restores them without a reload.
const surfaces = createSurfaces({onChange: current => { document.body.dataset.surface = current; }});

function leaveGallery() {
  rememberView();
  selection.cancel();
  pauseGalleryWork(true);
}

function enterGallery() {
  pauseGalleryWork(false);
  syncTvButton();
  restoreGallery();
}

// Scroll by the remembered anchor tile, then focus the tile the user left.
function restoreGallery() {
  const view = state.shownPath === null ? null : state.view(state.shownPath);
  if (view) restoreView(state.shownPath);
  const visible = document.activeElement !== document.body && document.activeElement?.closest('[hidden]') === null;
  const target = tileFor(view?.focusPath) ?? (visible ? null : galleryItems()[0] ?? galleryEntry);
  target?.focus({preventScroll: true});
}

surfaces.register('gallery', {panel: main, entry: galleryEntry, leave: leaveGallery, enter: enterGallery});
// Найти searches the list on screen: no request, and the gallery keeps its grid, scroll, and focus.
surfaces.register('search', {
  panel: document.querySelector('#searchSurface'),
  entry: document.querySelector('#searchMode'),
  enter: () => {
    pauseGalleryWork(false);
    search.enter();
    syncTvButton();
    searchInput.focus({preventScroll: true});
  },
  leave: () => {
    search.leave();
    pauseGalleryWork(true);
  },
});
surfaces.register('collage', {panel: document.querySelector('#collageSurface'), entry: document.querySelector('#collageMode')});
// Memories open their event in the same viewer; closing it returns to the event card.
// Registering shows the entry, so the module, which hides it until events exist, comes after.
surfaces.register('memories', {panel: document.querySelector('#memoriesSurface'), entry: document.querySelector('#memoriesMode'), enter: () => memories.enter()});
const memories = createMemories({
  panel: document.querySelector('#memoriesSurface'),
  entry: document.querySelector('#memoriesMode'),
  openViewer: (items, {tv, returnFocus}) => {
    if (viewer.isOpen || !items.length) return;
    viewerOpener = returnFocus;
    pauseGalleryWork(true);
    if (tv) viewer.openTV(items, 0);
    else viewer.open(items, 0);
  },
});
const galleryStatus = createGalleryStatus({panel: document.querySelector('#statusSurface')});
surfaces.register('status', {panel: galleryStatus.panel, entry: document.querySelector('#statusMode'), enter: galleryStatus.enter, leave: galleryStatus.leave});
// Section entries sit in the text navigation and as separate header icons.
routeSurfaceEntries(document.querySelector('.topbar-actions'), surfaces);

const collageLanding = createCollageLanding({
  createCard: document.querySelector('#collageCreate'),
  openCard: document.querySelector('#collageOpenProject'),
  status: document.querySelector('#collageLandingStatus'),
  projectInput: document.querySelector('#collageProjectInput'),
  onCreate: () => {
    surfaces.show('gallery');
    // Selection mode re-renders the grid, which drops the restored position.
    selection.enter();
    restoreGallery();
  },
  isActive: () => surfaces.current === 'collage' && !collageEditor.open,
});
// Leaving the editor, however it was opened, lands on the collage screen.
collageEditor.addEventListener('close', () => {
  surfaces.show('collage');
  collageLanding.returnFocus();
});

applyDensity();
liveRefresh.start();
memories.refresh();
load(state.path, {history: 'none', recursive: state.recursive});
