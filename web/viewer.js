import {apiURL} from './format.js';
import {iconLabelMarkup, iconMarkup} from './icons.js';

// Controls fade out after a pause; any pointer, touch, or key input brings them
// back. They stay visible while EXIF is open or the pointer rests on them, and
// CSS keeps the keyboard-focused control visible.
const IDLE_MS = 2500;
const SLIDESHOW_MS = 5000;
const SWIPE_PX = 60;

/**
 * Full-screen photo and video viewer bound to the #viewer dialog.
 * @param {HTMLDialogElement} dialog
 */
export function createViewer(dialog) {
  const stage = dialog.querySelector('.stage');
  const caption = dialog.querySelector('.caption');
  const slideButton = dialog.querySelector('.slideshow');
  const fullscreenButton = dialog.querySelector('.fullscreen');
  const infoButton = dialog.querySelector('.info');
  const exifPanel = dialog.querySelector('.exif-panel');
  const exifContent = dialog.querySelector('.exif-content');

  let items = [];
  let index = -1;
  let slideTimer = null;
  let idleTimer = 0;
  let touchX = null;

  /** Show `list[startIndex]`; the list is the gallery's current sorted and filtered view. */
  function open(list, startIndex) {
    items = list;
    index = startIndex;
    showCurrent();
    if (!dialog.open) {
      dialog.showModal();
      // Focus the dialog itself so no control starts with a focus ring; Tab reaches the buttons.
      dialog.focus({preventScroll: true});
    }
    wake();
  }

  function wake() {
    if (!dialog.open) return;
    dialog.dataset.idle = 'false';
    clearTimeout(idleTimer);
    idleTimer = setTimeout(hideControls, IDLE_MS);
  }

  function hideControls() {
    if (!dialog.open) return;
    if (!exifPanel.hidden || dialog.querySelector('.viewer-button:hover, footer:hover')) {
      idleTimer = setTimeout(hideControls, IDLE_MS);
      return;
    }
    dialog.dataset.idle = 'true';
  }

  function showCurrent() {
    if (index < 0 || index >= items.length) return;
    const item = items[index];
    closeEXIF();
    stage.replaceChildren();
    let element;
    if (item.kind === 'video') {
      element = document.createElement('video');
      element.controls = true;
      element.autoplay = true;
      element.playsInline = true;
    } else {
      element = document.createElement('img');
      element.alt = item.name;
    }
    element.src = apiURL('/api/media', item.path, `${item.modTime}-${item.size}`);
    infoButton.hidden = item.kind !== 'image';
    stage.append(element, fullscreenButton, infoButton, exifPanel);
    caption.textContent = `${item.name} · ${index + 1}/${items.length}`;
  }

  function move(delta) {
    if (!items.length) return;
    index = (index + delta + items.length) % items.length;
    showCurrent();
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
    const item = items[index];
    if (!item || item.kind !== 'image') return;
    exifPanel.hidden = false;
    infoButton.setAttribute('aria-expanded', 'true');
    exifContent.textContent = 'Читаю EXIF…';
    const requestedPath = item.path;
    try {
      const response = await fetch(apiURL('/api/exif', item.path, `${item.modTime}-${item.size}`));
      if (!response.ok) throw new Error('Не удалось прочитать EXIF');
      const data = await response.json();
      if (items[index]?.path !== requestedPath || exifPanel.hidden) return;
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

  function stopSlideshow() {
    clearInterval(slideTimer);
    slideTimer = null;
    slideButton.innerHTML = iconLabelMarkup('play', 'Слайд-шоу');
    slideButton.setAttribute('aria-pressed', 'false');
  }

  function toggleSlideshow() {
    if (slideTimer) return stopSlideshow();
    slideTimer = setInterval(() => move(1), SLIDESHOW_MS);
    slideButton.innerHTML = iconLabelMarkup('pause', 'Стоп');
    slideButton.setAttribute('aria-pressed', 'true');
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
      const request = stage.requestFullscreen || stage.webkitRequestFullscreen;
      if (request) await request.call(stage);
    } catch (error) {
      console.warn('Fullscreen request was rejected:', error);
    }
  }

  function updateFullscreenButton() {
    const active = Boolean(fullscreenElement());
    fullscreenButton.setAttribute('aria-label', active ? 'Выйти из полноэкранного режима' : 'На весь экран');
    fullscreenButton.setAttribute('aria-pressed', String(active));
    fullscreenButton.innerHTML = iconMarkup(active ? 'minimize' : 'maximize');
  }

  /** Keyboard handling while the viewer is open; Escape is handled by the dialog. */
  function handleKey(event) {
    wake();
    if (event.key === 'ArrowLeft') move(-1);
    if (event.key === 'ArrowRight') move(1);
    if (event.key === ' ') {
      event.preventDefault();
      toggleSlideshow();
    }
  }

  dialog.querySelector('.close').onclick = () => dialog.close();
  dialog.querySelector('.prev').onclick = () => move(-1);
  dialog.querySelector('.next').onclick = () => move(1);
  slideButton.onclick = toggleSlideshow;
  fullscreenButton.onclick = toggleFullscreen;
  infoButton.onclick = toggleEXIF;
  infoButton.setAttribute('aria-expanded', 'false');
  dialog.querySelector('.exif-close').onclick = closeEXIF;
  fullscreenButton.hidden = !(
    stage.requestFullscreen ||
    stage.webkitRequestFullscreen ||
    HTMLVideoElement.prototype.webkitEnterFullscreen
  );
  document.addEventListener('fullscreenchange', updateFullscreenButton);
  document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
  dialog.addEventListener('close', () => {
    stopSlideshow();
    closeEXIF();
    stage.replaceChildren();
    clearTimeout(idleTimer);
    delete dialog.dataset.idle;
  });
  for (const type of ['pointermove', 'pointerdown', 'focusin', 'wheel']) dialog.addEventListener(type, wake, {passive: true});
  dialog.addEventListener('pointerdown', event => { touchX = event.clientX; });
  dialog.addEventListener('pointerup', event => {
    if (touchX === null) return;
    const delta = event.clientX - touchX;
    touchX = null;
    if (Math.abs(delta) > SWIPE_PX) move(delta > 0 ? -1 : 1);
  });

  return {
    open,
    handleKey,
    get isOpen() { return dialog.open; },
  };
}
