import {createCollageSelection} from './collage-selection.js';
import {apiURL, formatCount, formatDate, formatDuration, formatFileDetails} from './format.js';
import {createGalleryState, DENSITY_CHOICES} from './gallery-state.js';
import {iconLabelMarkup, iconMarkup} from './icons.js';
import {queueVideoDuration, queueVideoPreview} from './video-posters.js';
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
const densityControl = document.querySelector('#gridDensity');
const header = document.querySelector('.topbar');
const main = document.querySelector('main');

const urlPath = () => new URLSearchParams(location.search).get('path') || '';
const state = createGalleryState({path: urlPath(), local: localStorage, session: sessionStorage});
let directories = [];
let allMedia = [];
let media = [];

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

// Background work of a media render (video durations) stops when the grid is rebuilt.
let mediaRender = new AbortController();

function resetMediaRender() {
  mediaRender.abort();
  mediaRender = new AbortController();
  return mediaRender.signal;
}

// Latest request wins: only the newest load may touch history, the grids, and busy state.
let loadToken = 0;
let loadController = null;
let skeletonTimer = 0;

function renderSkeletons() {
  clearGrid(mediaGrid);
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
}

async function load(path, push = true) {
  const token = ++loadToken;
  rememberView();
  state.shownPath = null;
  state.requestedPath = path;
  loadController?.abort();
  loadController = new AbortController();
  const {signal} = loadController;
  clearTimeout(skeletonTimer);
  statusBox.textContent = 'Загрузка…';
  cancelFolderCounts();
  resetMediaRender();
  clearGrid(foldersGrid);
  clearGrid(mediaGrid);
  delete mediaSection.dataset.loading;
  foldersSection.hidden = true;
  mediaSection.hidden = true;
  emptyState.hidden = true;
  refreshButton.classList.add('is-busy');
  refreshButton.setAttribute('aria-busy', 'true');
  skeletonTimer = setTimeout(renderSkeletons, 150);
  try {
    const response = await fetch(apiURL('/api/list', path), {signal});
    if (!response.ok) throw new Error('Каталог недоступен');
    const data = await response.json();
    if (token !== loadToken) return;
    state.path = state.requestedPath = data.path === '.' ? '' : data.path;
    document.title = state.path ? `${data.title} — ${state.path}` : data.title;
    document.querySelector('#brand').textContent = data.title;
    // Repeating the shown folder (refresh, its breadcrumb) adds no history entry.
    if (push && urlPath() !== state.path) history.pushState({path: state.path}, '', state.path ? `?path=${encodeURIComponent(state.path)}` : '/');
    renderBreadcrumbs();
    clearTimeout(skeletonTimer);
    delete mediaSection.dataset.loading;
    render(data.entries);
    emptyState.hidden = data.entries.length > 0;
    statusBox.textContent = data.entries.length ? formatCount(data.entries.length, ['элемент', 'элемента', 'элементов']) : '';
    state.shownPath = state.path;
    restoreView(state.path);
  } catch (error) {
    if (token !== loadToken) return;
    clearTimeout(skeletonTimer);
    delete mediaSection.dataset.loading;
    clearGrid(mediaGrid);
    mediaSection.hidden = true;
    statusBox.textContent = error.message;
  } finally {
    if (token === loadToken) {
      loadController = null;
      refreshButton.classList.remove('is-busy');
      refreshButton.removeAttribute('aria-busy');
    }
  }
}

function render(entries) {
  directories = entries.filter(item => item.kind === 'directory');
  allMedia = entries.filter(item => item.kind !== 'directory');
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
  const signal = resetMediaRender();
  clearGrid(mediaGrid);
  mediaSection.hidden = allMedia.length === 0;
  mediaCount.textContent = formatCount(items.length, ['файл', 'файла', 'файлов']);
  updateMediaControls();
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'media-empty';
    empty.textContent = 'Здесь нет файлов выбранного типа';
    mediaGrid.append(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const [index, item] of items.entries()) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `media-card gallery-item ${item.kind}`;
    card.dataset.path = item.path;
    card.title = item.name;
    if (!selection.decorateCard(card, item)) card.setAttribute('aria-label', `Открыть ${item.name}`);
    const version = `${item.modTime}-${item.size}`;
    if (item.kind === 'image') {
      const image = document.createElement('img');
      image.loading = 'lazy';
      image.alt = '';
      image.src = apiURL('/api/thumb', item.path, version);
      trackThumbnail(card, image);
      card.append(image);
    } else {
      const poster = document.createElement('img');
      poster.className = 'video-poster';
      poster.loading = 'lazy';
      poster.alt = '';
      poster.src = apiURL('/api/video-poster', item.path, version);
      trackThumbnail(card, poster, {broken: false});
      poster.addEventListener('error', () => {
        poster.classList.add('is-missing');
        queueVideoPreview(item, poster, () => markBroken(card));
      }, {once: true});
      const preview = document.createElement('span');
      preview.className = 'video-preview';
      preview.innerHTML = `<span class="play">${iconMarkup('play')}</span>`;
      card.append(poster, preview);
    }
    const overlay = document.createElement('span');
    overlay.className = 'media-caption';
    overlay.id = `media-caption-${index}`;
    overlay.innerHTML = '<span class="media-meta"></span><span class="media-details"></span>';
    const primary = overlay.querySelector('.media-meta');
    primary.textContent = formatDate(item.sortTime);
    overlay.querySelector('.media-details').textContent = formatFileDetails(item);
    card.setAttribute('aria-describedby', overlay.id);
    if (item.kind === 'video') {
      whenVisible(card, () => queueVideoDuration(item, seconds => {
        primary.textContent = formatDuration(seconds);
        card.classList.add('has-duration');
      }, signal));
    }
    card.append(overlay);
    card.addEventListener('click', () => {
      if (selection.handleCardClick(item, card)) return;
      const index = media.findIndex(entry => entry.path === item.path);
      state.lastOpened = {folder: state.path, path: item.path, index};
      state.saveView(state.path, {focusPath: item.path});
      viewer.open(media, index);
    });
    fragment.append(card);
  }
  mediaGrid.append(fragment);
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
  const anchor = findItem(view?.anchorPath);
  const top = anchor ? scrollY + anchor.getBoundingClientRect().top - view.anchorOffset : view?.scrollY ?? 0;
  scrollTo({top, behavior: 'instant'});
  // The grids were rebuilt, so focus that was on a tile is lost; other focus stays.
  if (document.activeElement === document.body) findItem(view?.focusPath)?.focus({preventScroll: true});
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

// After the viewer: focus the tile it was opened from, else its nearest neighbour,
// else the refresh button in the sticky header.
function returnFromViewer() {
  const opened = state.lastOpened;
  if (!opened) return;
  const sameFolder = opened.folder === state.shownPath;
  const tile = sameFolder ? findItem(opened.path) : null;
  const cards = mediaGrid.querySelectorAll('.media-card');
  const target = tile || (sameFolder ? cards[Math.min(opened.index, cards.length - 1)] : null) || galleryItems()[0] || refreshButton;
  target.focus({preventScroll: true});
  // Pointer users get no :focus-visible after a programmatic focus; show the ring anyway.
  target.classList.add('is-return-focus');
  target.addEventListener('blur', () => target.classList.remove('is-return-focus'), {once: true});
  if (target === refreshButton) return;
  target.scrollIntoView({block: 'nearest', inline: 'nearest'});
  if (target === tile) flashLastOpened(tile);
}

// Arrow keys move focus to the nearest gallery card in that direction (TV remotes).
function focusInDirection(key) {
  const active = document.activeElement;
  if (!active?.classList.contains('gallery-item')) return false;
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
  });
});
phoneQuery.addEventListener('change', () => keepInPlace(firstVisibleItem(), applyDensity));

main.addEventListener('focusin', event => {
  const item = event.target.closest('.gallery-item');
  if (item && state.shownPath !== null) state.saveView(state.shownPath, {focusPath: item.dataset.path});
});
addEventListener('pagehide', rememberView);
history.scrollRestoration = 'manual';

// After an interrupted navigation or a failed load the address catches up.
refreshButton.onclick = () => load(state.requestedPath);
addEventListener('popstate', event => load(event.state?.path || urlPath(), false));
addEventListener('keydown', event => {
  if (viewer.isOpen) {
    viewer.handleKey(event);
    return;
  }
  if (focusInDirection(event.key)) event.preventDefault();
  if ((event.key === 'Escape' || event.key === 'Backspace') && state.path) {
    event.preventDefault();
    load(state.path.split('/').slice(0, -1).join('/'));
  }
});

applyDensity();
load(state.path, false);
