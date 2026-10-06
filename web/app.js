import {isCollageSupportedPath} from './collage/support.js';

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
const collageModeButton = document.querySelector('#collageMode');
const collageSelectionBar = document.querySelector('#collageSelection');
const collageSelectionCount = document.querySelector('#collageSelectionCount');
const collageSelectionStart = document.querySelector('#collageSelectionStart');
const collageSelectionCancel = document.querySelector('#collageSelectionCancel');
const collageProjectOpen = document.querySelector('#collageProjectOpen');
const collageProjectInput = document.querySelector('#collageProjectInput');
const collageSelectionHint = collageSelectionBar.querySelector('.collage-selection-hint');
const viewer = document.querySelector('#viewer');
const stage = viewer.querySelector('.stage');
const caption = viewer.querySelector('.caption');
const slideButton = viewer.querySelector('.slideshow');
const fullscreenButton = viewer.querySelector('.fullscreen');
const infoButton = viewer.querySelector('.info');
const exifPanel = viewer.querySelector('.exif-panel');
const exifContent = viewer.querySelector('.exif-content');
let currentPath = new URLSearchParams(location.search).get('path') || '';
let directories = [];
let allMedia = [];
let media = [];
let currentIndex = -1;
let slideTimer = null;
let videoPreviewQueue = Promise.resolve();
const pendingVideoPreviews = new Set();
const failedVideoPreviews = new Set();
let folderDescending = localStorage.getItem('gallery-folder-order') !== 'asc';
let mediaDescending = localStorage.getItem('gallery-media-order') !== 'asc';
let mediaSortKey = localStorage.getItem('gallery-media-sort') || 'date';
let mediaFilterKey = localStorage.getItem('gallery-media-filter') || 'all';
let collageSelectionMode = false;
const collageSelection = new Map();
const COLLAGE_SELECTION_DEFAULT_HINT = 'Выберите от 2 до 12 фотографий';
const COLLAGE_MEMORY_WARNING_BYTES = 50 * 1024 * 1024;

function resetCollageSelectionHint() {
  collageSelectionHint.textContent = COLLAGE_SELECTION_DEFAULT_HINT;
  delete collageSelectionBar.dataset.memoryWarning;
}

function updateCollageSelectionHint() {
  resetCollageSelectionHint();
  const selectedBytes = [...collageSelection.values()].reduce((total, item) => total + Number(item.size || 0), 0);
  if (!collageSelectionMode || selectedBytes <= COLLAGE_MEMORY_WARNING_BYTES) return;
  collageSelectionBar.dataset.memoryWarning = 'true';
  collageSelectionHint.textContent = `Выбрано ${formatBytes(selectedBytes)}. Браузер может закрыться из-за нехватки памяти, особенно на телефоне или планшете`;
}

if (!['date', 'name'].includes(mediaSortKey)) mediaSortKey = 'date';
if (!['all', 'image', 'video'].includes(mediaFilterKey)) mediaFilterKey = 'all';

const nameCollator = new Intl.Collator('ru', {numeric: true, sensitivity: 'base'});

function isCollagePhotoSupported(item) {
  return item?.kind === 'image' && isCollageSupportedPath(item.path || item.name || '');
}

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
  button.textContent = descending ? 'Z–A ↓' : 'A–Z ↑';
  button.setAttribute('aria-pressed', String(descending));
}

function updateMediaControls() {
  mediaSort.value = mediaSortKey;
  mediaFilter.querySelectorAll('[data-filter]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.filter === mediaFilterKey));
  });
  mediaDirection.textContent = mediaDescending ? '↓' : '↑';
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

const apiURL = (endpoint, path, version = '') => `${endpoint}?path=${encodeURIComponent(path)}${version ? `&v=${encodeURIComponent(version)}` : ''}`;

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

function renderFolders(directories) {
  foldersGrid.replaceChildren();
  foldersSection.hidden = directories.length === 0;
  folderCount.textContent = formatCount(directories.length, ['папка', 'папки', 'папок']);
  updateSortButton(folderSort, folderDescending);
  const fragment = document.createDocumentFragment();
  for (const item of directories) {
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
    card.classList.toggle('is-collage-selected', collageSelection.has(item.path));
    if (collageSelectionMode && item.kind === 'image') {
      const supported = isCollagePhotoSupported(item);
      card.classList.toggle('is-collage-unsupported', !supported);
      card.setAttribute('aria-disabled', String(!supported));
      if (supported) {
        card.setAttribute('aria-pressed', String(collageSelection.has(item.path)));
        card.setAttribute('aria-label', `${collageSelection.has(item.path) ? 'Убрать' : 'Выбрать'} ${item.name} ${collageSelection.has(item.path) ? 'из' : 'для'} коллажа`);
      } else {
        card.setAttribute('aria-label', `${item.name}: TIFF пока недоступен для коллажа`);
        card.title = 'TIFF пока недоступен для коллажа';
      }
    } else {
      card.setAttribute('aria-label', `Открыть ${item.name}`);
    }
    if (item.kind === 'image') {
      const image = document.createElement('img');
      image.loading = 'lazy';
      image.alt = '';
      image.src = apiURL('/api/thumb', item.path, `${item.modTime}-${item.size}`);
      card.append(image);
    } else {
      const poster = document.createElement('img');
      poster.className = 'video-poster';
      poster.loading = 'lazy';
      poster.alt = '';
      poster.src = apiURL('/api/video-poster', item.path, `${item.modTime}-${item.size}`);
      poster.addEventListener('error', () => {
        poster.classList.add('is-missing');
        queueVideoPreview(item, poster);
      }, {once: true});
      const preview = document.createElement('span');
      preview.className = 'video-preview';
      preview.innerHTML = '<span class="play">▶</span>';
      card.append(poster, preview);
    }
    const overlay = document.createElement('span');
    overlay.className = 'media-caption';
    overlay.innerHTML = '<span class="media-name"></span><span class="media-meta"></span>';
    overlay.querySelector('.media-name').textContent = item.name;
    overlay.querySelector('.media-meta').textContent = `${item.kind === 'video' ? 'Видео' : 'Фото'} · ${formatBytes(item.size)}`;
    card.append(overlay);
    card.addEventListener('click', () => {
      if (collageSelectionMode && item.kind === 'image') {
        if (!isCollagePhotoSupported(item)) {
          collageSelectionHint.textContent = 'TIFF пока недоступен для коллажа';
          return;
        }
        toggleCollagePhoto(item, card);
        return;
      }
      if (!collageSelectionMode) openMedia(item.path);
    });
    fragment.append(card);
  }
  mediaGrid.append(fragment);
}

function updateCollageSelection() {
  collageSelectionCount.textContent = String(collageSelection.size);
  collageSelectionStart.disabled = collageSelection.size < 2;
  collageSelectionBar.hidden = !collageSelectionMode;
  collageModeButton.setAttribute('aria-pressed', String(collageSelectionMode));
  updateCollageSelectionHint();
}

function toggleCollagePhoto(item, card) {
  resetCollageSelectionHint();
  if (collageSelection.has(item.path)) collageSelection.delete(item.path);
  else if (collageSelection.size < 12) collageSelection.set(item.path, item);
  card.classList.toggle('is-collage-selected', collageSelection.has(item.path));
  card.setAttribute('aria-pressed', String(collageSelection.has(item.path)));
  card.setAttribute('aria-label', `${collageSelection.has(item.path) ? 'Убрать' : 'Выбрать'} ${item.name} ${collageSelection.has(item.path) ? 'из' : 'для'} коллажа`);
  updateCollageSelection();
}

function leaveCollageSelection() {
  collageSelectionMode = false;
  collageSelection.clear();
  resetCollageSelectionHint();
  updateCollageSelection();
  applyMediaView();
}

collageModeButton.addEventListener('click', () => {
  collageSelectionMode = !collageSelectionMode;
  if (!collageSelectionMode) collageSelection.clear();
  resetCollageSelectionHint();
  updateCollageSelection();
  applyMediaView();
});
collageSelectionCancel.addEventListener('click', leaveCollageSelection);
collageProjectOpen.addEventListener('click', () => {
  resetCollageSelectionHint();
  collageProjectInput.value = '';
  collageProjectInput.click();
});
collageSelectionStart.addEventListener('click', () => {
  if (collageSelection.size < 2) return;
  window.dispatchEvent(new CustomEvent('litegallery:open-collage', {detail: {photos: [...collageSelection.values()], path: currentPath}}));
  leaveCollageSelection();
});
window.addEventListener('litegallery:project-loaded', leaveCollageSelection);
window.addEventListener('litegallery:project-load-error', event => {
  collageSelectionHint.textContent = event.detail?.message || 'Не удалось открыть проект';
});
function queueVideoPreview(item, poster) {
  if (pendingVideoPreviews.has(item.path) || failedVideoPreviews.has(item.path)) return;
  pendingVideoPreviews.add(item.path);
  videoPreviewQueue = videoPreviewQueue
    .then(() => createVideoPreview(item, poster))
    .catch(() => failedVideoPreviews.add(item.path))
    .finally(() => pendingVideoPreviews.delete(item.path));
}

async function createVideoPreview(item, poster) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = apiURL('/api/media', item.path, `${item.modTime}-${item.size}`);
  try {
    await waitForVideoFrame(video);
    const scale = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const jpeg = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('cannot encode poster')), 'image/jpeg', .82));
    const response = await fetch(apiURL('/api/video-poster', item.path, `${item.modTime}-${item.size}`), {
      method: 'PUT',
      headers: {'Content-Type': 'image/jpeg'},
      body: jpeg,
    });
    if (!response.ok) throw new Error('cannot cache poster');
    poster.classList.remove('is-missing');
    poster.src = `${apiURL('/api/video-poster', item.path, `${item.modTime}-${item.size}`)}&ready=1`;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

function waitForVideoFrame(video) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('video preview timeout')), 15000);
    const finish = error => {
      clearTimeout(timeout);
      video.removeEventListener('loadeddata', loaded);
      video.removeEventListener('error', failed);
      error ? reject(error) : resolve();
    };
    const loaded = () => finish();
    const failed = () => finish(new Error('video preview unavailable'));
    video.addEventListener('loadeddata', loaded, {once: true});
    video.addEventListener('error', failed, {once: true});
    video.load();
  });
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

function renderBreadcrumbs() {
  crumbs.replaceChildren();
  const root = document.createElement('button'); root.textContent = 'Все фото'; root.onclick = () => load(''); crumbs.append(root);
  let path = '';
  for (const part of currentPath.split('/').filter(Boolean)) {
    crumbs.append(document.createTextNode(' / '));
    path = path ? `${path}/${part}` : part;
    const target = path;
    const button = document.createElement('button'); button.textContent = part; button.onclick = () => load(target); crumbs.append(button);
  }
}

function openMedia(path) {
  currentIndex = media.findIndex(item => item.path === path);
  showCurrent();
  if (!viewer.open) viewer.showModal();
}

function showCurrent() {
  if (currentIndex < 0 || currentIndex >= media.length) return;
  const item = media[currentIndex];
  closeEXIF();
  stage.replaceChildren();
  let element;
  if (item.kind === 'video') {
    element = document.createElement('video'); element.controls = true; element.autoplay = true; element.playsInline = true;
  } else {
    element = document.createElement('img'); element.alt = item.name;
  }
  element.src = apiURL('/api/media', item.path, `${item.modTime}-${item.size}`);
  infoButton.hidden = item.kind !== 'image';
  stage.append(element, fullscreenButton, infoButton, exifPanel);
  caption.textContent = `${item.name} · ${currentIndex + 1}/${media.length}`;
}

function closeEXIF() {
  exifPanel.hidden = true;
  exifContent.replaceChildren();
  infoButton.setAttribute('aria-expanded', 'false');
}

function addEXIFRow(label, value) {
  if (!value) return;
  const row = document.createElement('div');
  row.className = 'exif-row';
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value;
  row.append(term, description);
  exifContent.append(row);
}

async function toggleEXIF() {
  if (!exifPanel.hidden) return closeEXIF();
  const item = media[currentIndex];
  if (!item || item.kind !== 'image') return;
  exifPanel.hidden = false;
  infoButton.setAttribute('aria-expanded', 'true');
  exifContent.textContent = 'Читаю EXIF…';
  const requestedPath = item.path;
  try {
    const response = await fetch(apiURL('/api/exif', item.path, `${item.modTime}-${item.size}`));
    if (!response.ok) throw new Error('Не удалось прочитать EXIF');
    const data = await response.json();
    if (media[currentIndex]?.path !== requestedPath || exifPanel.hidden) return;
    exifContent.replaceChildren();
    if (!data.hasMetadata) {
      exifContent.textContent = 'В этом файле EXIF не найден.';
      return;
    }
    addEXIFRow('Снято', data.capturedAt);
    addEXIFRow('Камера', data.camera);
    addEXIFRow('Объектив', data.lens);
    addEXIFRow('Выдержка', data.exposure ? `${data.exposure} с` : '');
    addEXIFRow('Диафрагма', data.aperture);
    addEXIFRow('ISO', data.iso ? String(data.iso) : '');
    addEXIFRow('Фокусное', data.focalLength);
    addEXIFRow('Размер', data.width && data.height ? `${data.width} × ${data.height}` : '');
    addEXIFRow('Координаты', data.position ? `${data.position.latitude.toFixed(6)}, ${data.position.longitude.toFixed(6)}` : '');
    addEXIFRow('Высота', data.position?.altitude ? `${data.position.altitude.toFixed(1)} м` : '');
  } catch (error) {
    exifContent.textContent = error.message;
  }
}

function move(delta) {
  if (!media.length) return;
  currentIndex = (currentIndex + delta + media.length) % media.length;
  showCurrent();
}

function stopSlideshow() { clearInterval(slideTimer); slideTimer = null; slideButton.textContent = '▶ Слайд-шоу'; }
function toggleSlideshow() {
  if (slideTimer) return stopSlideshow();
  slideTimer = setInterval(() => move(1), 5000); slideButton.textContent = '⏸ Стоп';
}

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement;
}

async function toggleFullscreen(event) {
  event?.preventDefault();
  event?.stopPropagation();
  try {
    if (fullscreenElement()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) await exit.call(document);
      return;
    }

    const mediaElement = stage.querySelector('video, img');
    if (mediaElement?.tagName === 'VIDEO' && typeof mediaElement.webkitEnterFullscreen === 'function') {
      mediaElement.webkitEnterFullscreen();
      return;
    }

    const target = stage;
    const request = target.requestFullscreen || target.webkitRequestFullscreen;
    if (request) await request.call(target);
  } catch (error) {
    console.warn('Fullscreen request was rejected:', error);
  }
}

function updateFullscreenButton() {
  fullscreenButton.setAttribute('aria-label', fullscreenElement() ? 'Выйти из полноэкранного режима' : 'На весь экран');
  fullscreenButton.setAttribute('aria-pressed', String(Boolean(fullscreenElement())));
}

function formatBytes(bytes) {
  if (!bytes) return '';
  const units = ['Б','КБ','МБ','ГБ']; let value=bytes, i=0;
  while (value>=1024 && i<units.length-1) { value/=1024; i++; }
  return `${value.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function formatCount(value, forms) {
  const mod10 = value % 10;
  const mod100 = value % 100;
  const form = mod10 === 1 && mod100 !== 11 ? forms[0] : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? forms[1] : forms[2];
  return `${value} ${form}`;
}

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

viewer.querySelector('.close').onclick = () => viewer.close();
viewer.querySelector('.prev').onclick = () => move(-1);
viewer.querySelector('.next').onclick = () => move(1);
slideButton.onclick = toggleSlideshow;
fullscreenButton.onclick = toggleFullscreen;
infoButton.onclick = toggleEXIF;
infoButton.setAttribute('aria-expanded', 'false');
viewer.querySelector('.exif-close').onclick = closeEXIF;
fullscreenButton.hidden = !(
  stage.requestFullscreen ||
  stage.webkitRequestFullscreen ||
  HTMLVideoElement.prototype.webkitEnterFullscreen
);
document.addEventListener('fullscreenchange', updateFullscreenButton);
document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
viewer.addEventListener('close', () => { stopSlideshow(); closeEXIF(); stage.replaceChildren(); });
document.querySelector('#refresh').onclick = () => load(currentPath, false);
addEventListener('popstate', event => load(event.state?.path || new URLSearchParams(location.search).get('path') || '', false));
addEventListener('keydown', event => {
  if (viewer.open) {
    if (event.key === 'ArrowLeft') move(-1);
    if (event.key === 'ArrowRight') move(1);
    if (event.key === ' ') { event.preventDefault(); toggleSlideshow(); }
    return;
  }
  if (focusInDirection(event.key)) event.preventDefault();
  if ((event.key === 'Escape' || event.key === 'Backspace') && currentPath) {
    event.preventDefault();
    load(currentPath.split('/').slice(0, -1).join('/'));
  }
});
let touchX = null;
viewer.addEventListener('pointerdown', event => { touchX = event.clientX; });
viewer.addEventListener('pointerup', event => { if (touchX === null) return; const delta=event.clientX-touchX; touchX=null; if (Math.abs(delta)>60) move(delta>0?-1:1); });
load(currentPath, false);
