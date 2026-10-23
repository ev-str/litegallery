import {apiURL, formatBytes, formatFileType} from './format.js';
import {iconLabelMarkup, iconMarkup} from './icons.js';
import {createAutoplay, createPlaylist, readInterval, writeInterval} from './slideshow.js';
import {canPan, initialView, panBy, rotate, scaleLimits, setMode, settle, toggleZoom, zoomAt, ZOOM_STEP} from './viewer-transform.js';

// Controls fade out after a pause; any pointer, touch, or key input brings them
// back. They stay visible while EXIF is open or the pointer rests on them, and
// CSS keeps the keyboard-focused control visible.
const IDLE_MS = 2500;
const NOTICE_MS = 4000;
const SWIPE_PX = 60;
const TAP_PX = 10;
const DOUBLE_TAP_MS = 300;

/**
 * Full-screen photo and video viewer bound to the #viewer dialog.
 * @param {HTMLDialogElement} dialog
 * @param {{onClose?: () => void}} [options] onClose runs after the dialog has closed.
 */
export function createViewer(dialog, {onClose = () => {}} = {}) {
  const stage = dialog.querySelector('.stage');
  const caption = dialog.querySelector('.caption');
  const slideButton = dialog.querySelector('.slideshow');
  const fullscreenButton = dialog.querySelector('.fullscreen');
  const infoButton = dialog.querySelector('.info');
  const exifPanel = dialog.querySelector('.exif-panel');
  const exifContent = dialog.querySelector('.exif-content');
  const photoTools = dialog.querySelector('.photo-tools');
  const zoomOutButton = dialog.querySelector('.zoom-out');
  const zoomInButton = dialog.querySelector('.zoom-in');
  const zoomLevel = dialog.querySelector('.zoom-level');
  const fitButton = dialog.querySelector('.fit');
  const originalButton = dialog.querySelector('.original');
  const downloadLink = dialog.querySelector('.download');
  const shuffleButton = dialog.querySelector('.shuffle');
  const intervalSelect = dialog.querySelector('.slideshow-interval');
  const tvButton = dialog.querySelector('.tv');
  const notice = dialog.querySelector('.viewer-notice');
  // A <dialog> cannot itself be fullscreen, so TV mode enlarges the frame holding all of its content.
  const viewerFrame = dialog.querySelector('.viewer-frame');

  let items = [];
  let index = -1;
  let idleTimer = 0;
  let noticeTimer = 0;
  // Manual Previous/Next and autoplay walk the same playlist; autoplay skips media known to fail.
  const playlist = createPlaylist();
  const failed = new Set();
  const storage = (() => {
    try { return localStorage; } catch { return null; }
  })();
  const autoplay = createAutoplay(advance, {seconds: readInterval(storage)});
  // TV mode lives exactly as long as the viewer frame is the fullscreen element.
  let tv = false;
  let tvRequested = false;
  // Display-only transform of the current photo; every newly shown item starts in Fit.
  let view = initialView();
  // Accumulated quarter turns, so the CSS rotation animates the short way across 0°/360°.
  let turns = 0;
  /** The decoded photo on the stage; null for videos and until the photo has loaded. @type {HTMLImageElement|null} */
  let photo = null;
  /** Pointers on the stage and the gesture they make: swipe in Fit, pan when zoomed, pinch with two. */
  const pointers = new Map();
  let gesture = null;
  let lastTap = null;
  let lastPointerType = '';

  /** Show `list[startIndex]`; the list is the gallery's current sorted and filtered view. */
  function open(list, startIndex) {
    items = list;
    index = startIndex;
    failed.clear();
    playlist.reset(items.length, index);
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
    // On a TV the whole chrome stays while a remote or keyboard is on one of its controls.
    if (!exifPanel.hidden || (tv && keyboardOnControl()) || dialog.querySelector('.viewer-button:hover, footer:hover')) {
      idleTimer = setTimeout(hideControls, IDLE_MS);
      return;
    }
    dialog.dataset.idle = 'true';
  }

  /** Keyboard focus on a real control; the dialog, frame, and stage surfaces do not count. */
  function keyboardOnControl() {
    const active = document.activeElement;
    return active instanceof Element && dialog.contains(active) && active.matches(':focus-visible') &&
      Boolean(active.closest('button, a, select, input, textarea, video'));
  }

  /** @param {boolean} [byAutoplay] media that fails while autoplay shows it is skipped */
  function showCurrent(byAutoplay = false) {
    if (index < 0 || index >= items.length) return;
    const item = items[index];
    closeEXIF();
    stage.replaceChildren();
    resetView();
    const source = apiURL('/api/media', item.path, `${item.modTime}-${item.size}`);
    let element;
    if (item.kind === 'video') {
      element = document.createElement('video');
      element.controls = true;
      element.autoplay = true;
      element.playsInline = true;
    } else {
      const image = document.createElement('img');
      image.alt = item.name;
      image.draggable = false;
      image.addEventListener('load', () => {
        if (image.parentNode !== stage || !image.naturalWidth) return;
        photo = image;
        stage.dataset.photo = 'ready';
        view = settle(view, frame());
        render(false);
      }, {once: true});
      element = image;
    }
    const shown = element;
    element.addEventListener('error', () => mediaFailed(shown, item, byAutoplay), {once: true});
    element.src = source;
    stage.dataset.kind = item.kind;
    infoButton.hidden = item.kind !== 'image';
    photoTools.hidden = item.kind !== 'image';
    // The original file from /api/media, never a thumbnail.
    downloadLink.href = source;
    downloadLink.download = item.name;
    stage.append(element, fullscreenButton, infoButton, exifPanel);
    caption.textContent = `${item.name} · ${index + 1}/${items.length}`;
    render(false);
  }

  function resetView() {
    view = initialView();
    turns = 0;
    photo = null;
    pointers.clear();
    gesture = null;
    lastTap = null;
    delete stage.dataset.photo;
    delete stage.dataset.gesture;
    delete stage.dataset.error;
  }

  /** A broken item stays open with a calm error state; autoplay moves on and says so. */
  function mediaFailed(element, item, byAutoplay) {
    if (element.parentNode !== stage) return;
    failed.add(index);
    stage.dataset.error = 'true';
    const message = document.createElement('p');
    message.className = 'stage-error';
    message.innerHTML = iconLabelMarkup('image-off', 'Не удалось открыть файл');
    stage.append(message);
    if (!byAutoplay || !autoplay.playing) return;
    showNotice(`Пропущен файл ${item.name}: не удалось открыть`);
    advance();
  }

  function showNotice(text) {
    notice.textContent = text;
    notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(hideNotice, NOTICE_MS);
  }

  function hideNotice() {
    clearTimeout(noticeTimer);
    notice.hidden = true;
    notice.textContent = '';
  }

  /** Fit fills the stage's content box; panning is bounded by the whole stage. */
  function frame() {
    const style = getComputedStyle(stage);
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    return {
      image: {width: photo?.naturalWidth ?? 0, height: photo?.naturalHeight ?? 0},
      fit: {
        width: width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        height: height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
      },
      stage: {width, height},
    };
  }

  /** Stage-centre coordinates of a pointer or wheel event. */
  function stagePoint({clientX, clientY}) {
    const rect = stage.getBoundingClientRect();
    return {x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2};
  }

  /** Apply a new view; `animate` is for discrete steps (buttons, keys, double-click), not for gestures. */
  function update(next, animate = true) {
    if (!photo) return;
    if (next.rotation !== view.rotation) turns += ((next.rotation - view.rotation + 540) % 360 - 180) / 90;
    view = next;
    render(animate);
  }

  function render(animate) {
    stage.dataset.view = view.mode;
    stage.dataset.rotation = String(view.rotation);
    const ready = Boolean(photo);
    for (const button of photoTools.querySelectorAll('button')) button.setAttribute('aria-disabled', String(!ready));
    fitButton.setAttribute('aria-pressed', String(ready && view.mode === 'fit'));
    originalButton.setAttribute('aria-pressed', String(ready && view.mode === 'original'));
    zoomLevel.value = ready ? `${Math.round(view.scale * 100)}%` : '';
    if (!photo) {
      stage.dataset.pannable = 'false';
      return;
    }
    const current = frame();
    const limits = scaleLimits(current, view.rotation);
    // aria-disabled instead of disabled keeps keyboard focus on a button that reaches its limit.
    if (view.scale <= limits.min + 1e-3) zoomOutButton.setAttribute('aria-disabled', 'true');
    if (view.scale >= limits.max - 1e-3) zoomInButton.setAttribute('aria-disabled', 'true');
    stage.dataset.pannable = String(canPan(view, current));
    photo.classList.toggle('is-animated', animate);
    photo.style.width = `${current.image.width}px`;
    photo.style.height = `${current.image.height}px`;
    photo.style.transform = `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) rotate(${turns * 90}deg) scale(${view.scale})`;
  }

  function zoomBy(factor, point, animate = true) {
    if (photo) update(zoomAt(view, frame(), view.scale * factor, point), animate);
  }

  function showMode(mode) {
    if (photo) update(setMode(view, frame(), mode));
  }

  function turn(quarterTurns) {
    if (photo) update(rotate(view, frame(), quarterTurns));
  }

  /** Manual Previous/Next; a running slideshow gives the new item a full interval. */
  function move(delta) {
    if (!items.length) return;
    const next = delta > 0 ? playlist.next() : playlist.previous();
    if (next === null) return;
    index = next;
    showCurrent();
    autoplay.schedule();
  }

  /** One autoplay step: the next item that is not known to fail, or a stop when none is left. */
  function advance() {
    const next = playlist.next(failed);
    if (next === null) {
      stopSlideshow();
      showNotice('Слайд-шоу остановлено: не удалось открыть ни один файл');
      return;
    }
    index = next;
    showCurrent(true);
    autoplay.schedule();
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

  // Format and size come from the listing, so they show even without EXIF.
  function addFileRows(item) {
    addEXIFRow('Формат', formatFileType(item));
    addEXIFRow('Файл', formatBytes(item.size));
  }

  function addEXIFNote(text) {
    const note = document.createElement('p');
    note.className = 'exif-note';
    note.textContent = text;
    exifContent.append(note);
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
      addFileRows(item);
      if (!data.hasMetadata) return addEXIFNote('В этом файле EXIF не найден.');
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
      if (items[index]?.path !== requestedPath || exifPanel.hidden) return;
      exifContent.replaceChildren();
      addFileRows(item);
      addEXIFNote(error.message);
    }
  }

  function renderSlideshow() {
    slideButton.innerHTML = autoplay.playing ? iconLabelMarkup('pause', 'Стоп') : iconLabelMarkup('play', 'Слайд-шоу');
    slideButton.setAttribute('aria-pressed', String(autoplay.playing));
  }

  function stopSlideshow() {
    autoplay.stop();
    renderSlideshow();
  }

  function toggleSlideshow() {
    if (autoplay.playing) autoplay.stop();
    else autoplay.start();
    renderSlideshow();
  }

  function toggleShuffle() {
    playlist.shuffle = !playlist.shuffle;
    shuffleButton.setAttribute('aria-pressed', String(playlist.shuffle));
  }

  function changeInterval() {
    const seconds = Number(intervalSelect.value);
    writeInterval(storage, seconds);
    autoplay.setSeconds(seconds);
  }

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement;
  }

  async function exitFullscreen() {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    try {
      if (fullscreenElement() && exit) await exit.call(document);
    } catch (error) {
      console.warn('Leaving fullscreen failed:', error);
    }
  }

  /** TV mode puts the whole viewer, controls included, into fullscreen. */
  async function toggleTV() {
    if (tv) {
      leaveTV();
      return exitFullscreen();
    }
    const request = viewerFrame.requestFullscreen || viewerFrame.webkitRequestFullscreen;
    if (!request) return showNotice('Режим TV недоступен: браузер не поддерживает полный экран');
    tvRequested = true;
    try {
      await request.call(viewerFrame);
    } catch (error) {
      tvRequested = false;
      console.warn('Fullscreen request was rejected:', error);
      return showNotice('Режим TV недоступен: браузер не разрешил полный экран');
    }
    // Older WebKit enters fullscreen later and reports it through the change event.
    if (fullscreenElement() === viewerFrame) enterTV();
  }

  function enterTV() {
    tvRequested = false;
    if (tv) return;
    tv = true;
    dialog.dataset.tv = 'true';
    tvButton.setAttribute('aria-pressed', 'true');
    tvButton.setAttribute('aria-label', 'Выйти из режима TV');
    // Remote arrows act on the viewer surface, not on the button that started TV mode. The frame
    // takes focus because some browsers keep focus out of a fullscreen element's ancestors.
    viewerFrame.focus({preventScroll: true});
    wake();
  }

  /** Leaving fullscreen ends TV mode and pauses the slideshow. */
  function leaveTV() {
    tvRequested = false;
    if (!tv) return;
    tv = false;
    delete dialog.dataset.tv;
    tvButton.setAttribute('aria-pressed', 'false');
    tvButton.setAttribute('aria-label', 'Режим TV');
    stopSlideshow();
    wake();
  }

  function fullscreenChanged() {
    updateFullscreenButton();
    if (fullscreenElement() === viewerFrame) {
      if (tvRequested) enterTV();
    } else {
      leaveTV();
    }
  }

  function fullscreenFailed() {
    if (!tvRequested) return;
    tvRequested = false;
    showNotice('Режим TV недоступен: браузер не разрешил полный экран');
  }

  async function toggleFullscreen(event) {
    event?.preventDefault();
    event?.stopPropagation();
    try {
      if (fullscreenElement()) return await exitFullscreen();
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
    // A focused control or video keeps its native keys; shortcuts apply to the dialog surface.
    if (event.target instanceof Element && event.target.closest('button, a, input, select, textarea, video')) return;
    if (event.key === 'ArrowLeft') move(-1);
    if (event.key === 'ArrowRight') move(1);
    if (event.key === ' ' || event.key === 'MediaPlayPause') {
      event.preventDefault();
      toggleSlideshow();
    }
    // Browser shortcuts such as Ctrl+R and Ctrl+plus keep working.
    if (!photo || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === '+' || event.key === '=') zoomBy(ZOOM_STEP);
    else if (event.key === '-' || event.key === '_') zoomBy(1 / ZOOM_STEP);
    else if (event.key === '0') showMode('fit');
    else if (event.key === '1') showMode('original');
    // The physical R key, so a Russian layout (К) works too.
    else if (event.code === 'KeyR') turn(event.shiftKey ? -1 : 1);
  }

  // Controls and the EXIF panel keep their own pointer and wheel behaviour; the footer's
  // transparent gradient over the photo does not.
  const isControl = target => Boolean(target.closest?.('button, a, output, select, .caption, .exif-panel'));

  function startGesture(event) {
    lastPointerType = event.pointerType;
    if ((event.pointerType === 'mouse' && event.button !== 0) || isControl(event.target)) return;
    pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
    dialog.setPointerCapture?.(event.pointerId);
    if (pointers.size === 2 && photo) {
      const [first, second] = pointers.values();
      gesture = {kind: 'pinch', start: view, distance: Math.hypot(second.x - first.x, second.y - first.y), mid: midpoint(first, second)};
      stage.dataset.gesture = 'pinch';
    } else if (pointers.size === 1) {
      const kind = photo && canPan(view, frame()) ? 'pan' : 'swipe';
      gesture = {kind, startX: event.clientX, startY: event.clientY, last: {x: event.clientX, y: event.clientY}, travel: 0, time: event.timeStamp};
      if (kind === 'pan') stage.dataset.gesture = 'pan';
    }
  }

  const midpoint = (a, b) => ({x: (a.x + b.x) / 2, y: (a.y + b.y) / 2});

  function moveGesture(event) {
    if (!pointers.has(event.pointerId) || !gesture) return;
    pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
    if (gesture.kind === 'pinch' && pointers.size === 2) {
      const [first, second] = pointers.values();
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const mid = midpoint(first, second);
      const current = frame();
      const zoomed = zoomAt(gesture.start, current, gesture.start.scale * distance / (gesture.distance || 1), stagePoint({clientX: gesture.mid.x, clientY: gesture.mid.y}));
      update(panBy(zoomed, current, mid.x - gesture.mid.x, mid.y - gesture.mid.y), false);
      return;
    }
    if (pointers.size !== 1 || !('last' in gesture)) return;
    const dx = event.clientX - gesture.last.x;
    const dy = event.clientY - gesture.last.y;
    gesture.last = {x: event.clientX, y: event.clientY};
    gesture.travel += Math.hypot(dx, dy);
    if (gesture.kind === 'pan') update(panBy(view, frame(), dx, dy), false);
  }

  function endGesture(event) {
    if (!pointers.delete(event.pointerId) || !gesture) return;
    const finished = gesture;
    if (finished.kind === 'pinch') {
      // The finger left after a pinch may keep panning, but it never swipes.
      const rest = [...pointers.values()][0];
      gesture = rest && photo && canPan(view, frame()) ? {kind: 'pan', last: rest, travel: TAP_PX, time: event.timeStamp} : {kind: 'none'};
      stage.dataset.gesture = gesture.kind === 'pan' ? 'pan' : 'pinch';
    }
    if (pointers.size) return;
    gesture = null;
    delete stage.dataset.gesture;
    if (event.type !== 'pointerup' || !('startX' in finished)) return;
    const dx = event.clientX - finished.startX;
    const dy = event.clientY - finished.startY;
    if (finished.kind === 'swipe' && Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
      lastTap = null;
      move(dx > 0 ? -1 : 1);
      return;
    }
    // Touch has no reliable dblclick, so two quick taps toggle the zoom here.
    if (event.pointerType !== 'touch' || finished.travel > TAP_PX || !photo) return;
    if (lastTap && event.timeStamp - lastTap.time < DOUBLE_TAP_MS && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < SWIPE_PX / 2) {
      lastTap = null;
      update(toggleZoom(view, frame(), stagePoint(event)));
    } else {
      lastTap = {time: event.timeStamp, x: event.clientX, y: event.clientY};
    }
  }

  dialog.querySelector('.close').onclick = () => dialog.close();
  dialog.querySelector('.prev').onclick = () => move(-1);
  dialog.querySelector('.next').onclick = () => move(1);
  slideButton.onclick = toggleSlideshow;
  shuffleButton.onclick = toggleShuffle;
  intervalSelect.value = String(autoplay.seconds);
  intervalSelect.onchange = changeInterval;
  tvButton.onclick = toggleTV;
  fullscreenButton.onclick = toggleFullscreen;
  infoButton.onclick = toggleEXIF;
  infoButton.setAttribute('aria-expanded', 'false');
  dialog.querySelector('.exif-close').onclick = closeEXIF;
  zoomOutButton.onclick = () => zoomBy(1 / ZOOM_STEP);
  zoomInButton.onclick = () => zoomBy(ZOOM_STEP);
  fitButton.onclick = () => showMode('fit');
  originalButton.onclick = () => showMode('original');
  dialog.querySelector('.rotate-left').onclick = () => turn(-1);
  dialog.querySelector('.rotate-right').onclick = () => turn(1);
  fullscreenButton.hidden = !(
    stage.requestFullscreen ||
    stage.webkitRequestFullscreen ||
    HTMLVideoElement.prototype.webkitEnterFullscreen
  );
  document.addEventListener('fullscreenchange', fullscreenChanged);
  document.addEventListener('webkitfullscreenchange', fullscreenChanged);
  document.addEventListener('fullscreenerror', fullscreenFailed);
  document.addEventListener('webkitfullscreenerror', fullscreenFailed);
  dialog.addEventListener('close', () => {
    if (tv || fullscreenElement() === viewerFrame) exitFullscreen();
    leaveTV();
    stopSlideshow();
    hideNotice();
    closeEXIF();
    stage.replaceChildren();
    resetView();
    clearTimeout(idleTimer);
    delete dialog.dataset.idle;
    onClose();
  });
  for (const type of ['pointermove', 'pointerdown', 'focusin', 'wheel']) dialog.addEventListener(type, wake, {passive: true});
  dialog.addEventListener('pointerdown', startGesture);
  dialog.addEventListener('pointermove', moveGesture);
  dialog.addEventListener('pointerup', endGesture);
  dialog.addEventListener('pointercancel', endGesture);
  dialog.addEventListener('dblclick', event => {
    if (lastPointerType === 'touch' || !photo || isControl(event.target)) return;
    update(toggleZoom(view, frame(), stagePoint(event)));
  });
  dialog.addEventListener('wheel', event => {
    if (!photo || isControl(event.target)) return;
    event.preventDefault();
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1);
    // A trackpad pinch arrives as a ctrl+wheel with small deltas.
    zoomBy(Math.exp(-pixels * (event.ctrlKey ? 0.01 : 0.002)), stagePoint(event), false);
  }, {passive: false});
  // Window resizes, fullscreen, and the phone toolbar change the stage; Fit follows them.
  new ResizeObserver(() => {
    if (!photo) return;
    view = settle(view, frame());
    render(false);
  }).observe(stage);

  /**
   * Open `list[startIndex]` straight into TV mode. Call it from the user's click or key press:
   * the fullscreen request is made synchronously, before anything is awaited.
   */
  function openTV(list, startIndex) {
    open(list, startIndex);
    if (!tv) toggleTV();
  }

  return {
    open,
    openTV,
    handleKey,
    get isOpen() { return dialog.open; },
  };
}
