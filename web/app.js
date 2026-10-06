import {createCollageSelection} from './collage-selection.js';
import {apiURL, formatBytes, formatCount} from './format.js';
import {iconLabelMarkup, iconMarkup} from './icons.js';
import {queueVideoPreview} from './video-posters.js';
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

let currentPath = new URLSearchParams(location.search).get('path') || '';
let directories = [];
let allMedia = [];
let media = [];
let folderDescending = localStorage.getItem('gallery-folder-order') !== 'asc';
let mediaDescending = localStorage.getItem('gallery-media-order') !== 'asc';
let mediaSortKey = localStorage.getItem('gallery-media-sort') || 'date';
let mediaFilterKey = localStorage.getItem('gallery-media-filter') || 'all';

if (!['date', 'name'].includes(mediaSortKey)) mediaSortKey = 'date';
if (!['all', 'image', 'video'].includes(mediaFilterKey)) mediaFilterKey = 'all';

const nameCollator = new Intl.Collator('ru', {numeric: true, sensitivity: 'base'});
const viewer = createViewer(document.querySelector('#viewer'));
const selection = createCollageSelection({onModeChange: applyMediaView, getCurrentPath: () => currentPath});

function sortByName(items, descending) {
  const sorted = [...items].sort((left, right) => nameCollator.compare(left.name, right.name));
  return descending ? sorted.reverse() : sorted;
}

function sortMedia(items) {
  const sorted = [...items].sort((left, right) => {
    if (mediaSortKey === 'date') {
      const byDate = (left.sortTime || 0) - (right.sortTime || 0);
      if (byDate !== 0) return byDate;
    }
    return nameCollator.compare(left.name, right.name);
  });
  return mediaDescending ? sorted.reverse() : sorted;
}

function updateSortButton(button, descending) {
  button.innerHTML = iconLabelMarkup(descending ? 'arrow-down' : 'arrow-up', descending ? 'Z–A' : 'A–Z');
  button.setAttribute('aria-pressed', String(descending));
}

function updateMediaControls() {
  mediaSort.value = mediaSortKey;
  mediaFilter.querySelectorAll('[data-filter]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.filter === mediaFilterKey));
  });
  mediaDirection.innerHTML = iconMarkup(mediaDescending ? 'arrow-down' : 'arrow-up');
  const dateDirection = mediaDescending ? 'Сначала новые' : 'Сначала старые';
  const nameDirection = mediaDescending ? 'От Z к A' : 'От A к Z';
  mediaDirection.title = mediaSortKey === 'date' ? dateDirection : nameDirection;
  mediaDirection.setAttribute('aria-label', `Изменить направление сортировки. Сейчас: ${mediaDirection.title}`);
}

function applyMediaView() {
  const filtered = allMedia.filter(item => mediaFilterKey === 'all' || item.kind === mediaFilterKey);
  media = sortMedia(filtered);
  renderMedia(media);
}

async function load(path, push = true) {
  statusBox.textContent = 'Загрузка…';
  foldersGrid.replaceChildren();
  mediaGrid.replaceChildren();
  foldersSection.hidden = true;
  mediaSection.hidden = true;
  try {
    const response = await fetch(apiURL('/api/list', path));
    if (!response.ok) throw new Error('Каталог недоступен');
    const data = await response.json();
    currentPath = data.path === '.' ? '' : data.path;
    document.title = currentPath ? `${data.title} — ${currentPath}` : data.title;
    document.querySelector('#brand').textContent = data.title;
    if (push) history.pushState({path: currentPath}, '', currentPath ? `?path=${encodeURIComponent(currentPath)}` : '/');
    renderBreadcrumbs();
    render(data.entries);
    statusBox.textContent = data.entries.length ? formatCount(data.entries.length, ['элемент', 'элемента', 'элементов']) : 'Папка пуста';
  } catch (error) {
    statusBox.textContent = error.message;
  }
}

function render(entries) {
  directories = entries.filter(item => item.kind === 'directory');
  allMedia = entries.filter(item => item.kind !== 'directory');
  renderFolders(sortByName(directories, folderDescending));
  applyMediaView();
}

function renderFolders(items) {
  foldersGrid.replaceChildren();
  foldersSection.hidden = items.length === 0;
  folderCount.textContent = formatCount(items.length, ['папка', 'папки', 'папок']);
  updateSortButton(folderSort, folderDescending);
  const fragment = document.createDocumentFragment();
  for (const item of items) {
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
    overlay.innerHTML = `<span class="folder-name"></span><span class="folder-meta">Открыть альбом</span>`;
    overlay.querySelector('.folder-name').textContent = item.name;
    card.append(fallback, cover, overlay);
    card.addEventListener('click', () => load(item.path));
    fragment.append(card);
  }
  foldersGrid.append(fragment);
}

function renderMedia(items) {
  mediaGrid.replaceChildren();
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
  for (const item of items) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `media-card gallery-item ${item.kind}`;
    card.dataset.path = item.path;
    if (!selection.decorateCard(card, item)) card.setAttribute('aria-label', `Открыть ${item.name}`);
    const version = `${item.modTime}-${item.size}`;
    if (item.kind === 'image') {
      const image = document.createElement('img');
      image.loading = 'lazy';
      image.alt = '';
      image.src = apiURL('/api/thumb', item.path, version);
      card.append(image);
    } else {
      const poster = document.createElement('img');
      poster.className = 'video-poster';
      poster.loading = 'lazy';
      poster.alt = '';
      poster.src = apiURL('/api/video-poster', item.path, version);
      poster.addEventListener('error', () => {
        poster.classList.add('is-missing');
        queueVideoPreview(item, poster);
      }, {once: true});
      const preview = document.createElement('span');
      preview.className = 'video-preview';
      preview.innerHTML = `<span class="play">${iconMarkup('play')}</span>`;
      card.append(poster, preview);
    }
    const overlay = document.createElement('span');
    overlay.className = 'media-caption';
    overlay.innerHTML = '<span class="media-name"></span><span class="media-meta"></span>';
    overlay.querySelector('.media-name').textContent = item.name;
    overlay.querySelector('.media-meta').textContent = `${item.kind === 'video' ? 'Видео' : 'Фото'} · ${formatBytes(item.size)}`;
    card.append(overlay);
    card.addEventListener('click', () => {
      if (selection.handleCardClick(item, card)) return;
      viewer.open(media, media.findIndex(entry => entry.path === item.path));
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
  for (const part of currentPath.split('/').filter(Boolean)) {
    crumbs.append(document.createTextNode(' / '));
    path = path ? `${path}/${part}` : part;
    const target = path;
    const button = document.createElement('button');
    button.textContent = part;
    button.onclick = () => load(target);
    crumbs.append(button);
  }
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

folderSort.addEventListener('click', () => {
  folderDescending = !folderDescending;
  localStorage.setItem('gallery-folder-order', folderDescending ? 'desc' : 'asc');
  renderFolders(sortByName(directories, folderDescending));
});

mediaSort.addEventListener('change', () => {
  mediaSortKey = mediaSort.value;
  localStorage.setItem('gallery-media-sort', mediaSortKey);
  applyMediaView();
});

mediaDirection.addEventListener('click', () => {
  mediaDescending = !mediaDescending;
  localStorage.setItem('gallery-media-order', mediaDescending ? 'desc' : 'asc');
  applyMediaView();
});

mediaFilter.addEventListener('click', event => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  mediaFilterKey = button.dataset.filter;
  localStorage.setItem('gallery-media-filter', mediaFilterKey);
  applyMediaView();
});

document.querySelector('#refresh').onclick = () => load(currentPath, false);
addEventListener('popstate', event => load(event.state?.path || new URLSearchParams(location.search).get('path') || '', false));
addEventListener('keydown', event => {
  if (viewer.isOpen) {
    viewer.handleKey(event);
    return;
  }
  if (focusInDirection(event.key)) event.preventDefault();
  if ((event.key === 'Escape' || event.key === 'Backspace') && currentPath) {
    event.preventDefault();
    load(currentPath.split('/').slice(0, -1).join('/'));
  }
});

load(currentPath, false);
