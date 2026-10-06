import {isLargePhoto, megapixels} from './collage/limits.js';
import {isCollageSupportedPath} from './collage/support.js';
import {apiURL} from './format.js';

const MAX_PHOTOS = 12;
const DEFAULT_HINT = 'Выберите от 2 до 12 фотографий';
const TIFF_HINT = 'TIFF пока недоступен для коллажа';

/**
 * Collage selection mode of the gallery: the selection bar, card states, and
 * the hand-off to the collage editor through window events.
 * @param {{onModeChange: () => void, getCurrentPath: () => string}} options
 *   onModeChange re-renders the media grid; getCurrentPath is the open folder.
 */
export function createCollageSelection({onModeChange, getCurrentPath}) {
  const modeButton = document.querySelector('#collageMode');
  const bar = document.querySelector('#collageSelection');
  const count = document.querySelector('#collageSelectionCount');
  const start = document.querySelector('#collageSelectionStart');
  const cancel = document.querySelector('#collageSelectionCancel');
  const projectOpen = document.querySelector('#collageProjectOpen');
  const projectInput = document.querySelector('#collageProjectInput');
  const hint = bar.querySelector('.collage-selection-hint');

  let active = false;
  const selection = new Map();
  const photoSizes = new Map();

  const isSupported = item => item?.kind === 'image' && isCollageSupportedPath(item.path || item.name || '');
  const cardLabel = item => `${selection.has(item.path) ? 'Убрать' : 'Выбрать'} ${item.name} ${selection.has(item.path) ? 'из' : 'для'} коллажа`;

  function resetHint() {
    hint.textContent = DEFAULT_HINT;
    delete bar.dataset.memoryWarning;
  }

  function updateHint() {
    resetHint();
    if (!active) return;
    let largest = null;
    for (const item of selection.values()) {
      const size = photoSizes.get(item.path);
      if (!size || !isLargePhoto(size.width, size.height)) continue;
      const value = megapixels(size.width, size.height);
      if (!largest || value > largest.megapixels) largest = {name: item.name, megapixels: value};
    }
    if (!largest) return;
    bar.dataset.memoryWarning = 'true';
    hint.textContent = `${largest.name}: ${Math.round(largest.megapixels)} Мп. Очень крупные фото могут закрыть браузер из-за нехватки памяти, особенно на телефоне или планшете`;
  }

  // Dimensions come from /api/image-info, so the warning reflects decoded size rather than file size.
  function requestPhotoSize(item) {
    if (photoSizes.has(item.path)) return;
    photoSizes.set(item.path, null);
    fetch(apiURL('/api/image-info', item.path, `${item.modTime}-${item.size}`))
      .then(response => (response.ok ? response.json() : null))
      .then(info => {
        if (info?.width > 0 && info?.height > 0) photoSizes.set(item.path, {width: info.width, height: info.height});
        if (selection.has(item.path)) updateHint();
      })
      .catch(() => photoSizes.delete(item.path));
  }

  function updateBar() {
    count.textContent = String(selection.size);
    start.disabled = selection.size < 2;
    bar.hidden = !active;
    modeButton.setAttribute('aria-pressed', String(active));
    updateHint();
  }

  function toggle(item, card) {
    resetHint();
    if (selection.has(item.path)) selection.delete(item.path);
    else if (selection.size < MAX_PHOTOS) {
      selection.set(item.path, item);
      requestPhotoSize(item);
    }
    card.classList.toggle('is-collage-selected', selection.has(item.path));
    card.setAttribute('aria-pressed', String(selection.has(item.path)));
    card.setAttribute('aria-label', cardLabel(item));
    updateBar();
  }

  function leave() {
    active = false;
    selection.clear();
    resetHint();
    updateBar();
    onModeChange();
  }

  /**
   * Apply selection state to a freshly rendered media card.
   * @returns {boolean} true when the card is labelled for selection mode
   */
  function decorateCard(card, item) {
    card.classList.toggle('is-collage-selected', selection.has(item.path));
    if (!active || item.kind !== 'image') return false;
    const supported = isSupported(item);
    card.classList.toggle('is-collage-unsupported', !supported);
    card.setAttribute('aria-disabled', String(!supported));
    if (supported) {
      card.setAttribute('aria-pressed', String(selection.has(item.path)));
      card.setAttribute('aria-label', cardLabel(item));
    } else {
      card.setAttribute('aria-label', `${item.name}: ${TIFF_HINT}`);
      card.title = TIFF_HINT;
    }
    return true;
  }

  /**
   * Handle a media-card click in selection mode.
   * @returns {boolean} true when selection mode consumed the click
   */
  function handleCardClick(item, card) {
    if (!active) return false;
    if (item.kind !== 'image') return true;
    if (!isSupported(item)) {
      hint.textContent = TIFF_HINT;
      return true;
    }
    toggle(item, card);
    return true;
  }

  modeButton.addEventListener('click', () => {
    active = !active;
    if (!active) selection.clear();
    resetHint();
    updateBar();
    onModeChange();
  });
  cancel.addEventListener('click', leave);
  projectOpen.addEventListener('click', () => {
    resetHint();
    projectInput.value = '';
    projectInput.click();
  });
  start.addEventListener('click', () => {
    if (selection.size < 2) return;
    window.dispatchEvent(new CustomEvent('litegallery:open-collage', {detail: {photos: [...selection.values()], path: getCurrentPath()}}));
    leave();
  });
  window.addEventListener('litegallery:project-loaded', leave);
  window.addEventListener('litegallery:project-load-error', event => {
    hint.textContent = event.detail?.message || 'Не удалось открыть проект';
  });

  return {decorateCard, handleCardClick};
}
