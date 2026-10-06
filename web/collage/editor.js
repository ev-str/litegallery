// @ts-check

import {renderCanvas, fetchImageBitmap} from './canvas-renderer.js';
import {centreCrop, cropFromKey, resizeCrop} from './crop-controller.js';
import {downloadBlob, formatDownloadSize} from './download.js';
import {exportJpeg} from './export.js';
import {EDGE_PRESETS} from './frames.js';
import {jpegFilename, projectFilename} from './filenames.js';
import {getPrintDimensions, getPrintFormat, PRINT_FORMATS} from './formats.js';
import {iconMarkup} from '../icons.js';
import {exceedsSafeCanvas, maxPpiForMemory} from './limits.js';
import {centeredCrop, clampCrop, cropDistortionPercent, effectiveCropPpi, normalizePhotoRotation, rectToPixels, refitCropAroundCenter, rotatedSourceDimensions} from './geometry.js';
import {assertProject, createPlacementId, createProject, getCellAspect, validateProject} from './model.js';
import {BACKGROUND_PALETTE, createFramePalette} from './palette.js';
import {runPreflight, setIssueIgnored} from './preflight.js';
import {createPhotoLoadingBarrier} from './loading-barrier.js';
import {commitPreviewFrame} from './preview.js';
import {createProjectDocument, projectJsonBlob, projectZipBlob, readProjectBlob, readProjectZip} from './project.js';
import {buildRenderPlan, resolveFrameLineColor, sourceUrl as runtimeSourceUrl} from './render-plan.js';
import {actions, collageReducer, createCollageStore} from './store.js';
import {getCanonicalTemplateId, getDefaultTemplate, getTemplate, getTemplateTransformState, getTransformedTemplateId, getVisibleTemplatesForCount, isTemplateAxisSymmetric} from './templates.js';
import {collageApiUrl, createSourceTree, preparePhotoSource} from './sources.js';

/** @typedef {import('./types.js').PhotoSource} PhotoSource */
/** @typedef {import('./types.js').ProjectState} ProjectState */
/** @typedef {import('./types.js').EdgeStyle} EdgeStyle */
/** @typedef {{path: string, name: string, size?: number, modTime?: string, sourceUrl?: string}} SourceEntry */

const dialog = /** @type {HTMLDialogElement} */ (document.querySelector('#collageEditor'));
const projectInput = /** @type {HTMLInputElement} */ (document.querySelector('#collageProjectInput'));
let appVersion = 'dev';
const appConfigReady = fetch('/api/config', {credentials: 'same-origin'})
  .then(response => response.ok ? response.json() : null)
  .then(config => {
    if (typeof config?.version === 'string' && config.version) appVersion = config.version;
  })
  .catch(() => {});

dialog.innerHTML = `
  <div class="collage-shell">
    <header class="collage-toolbar">
      <button type="button" data-command="close" aria-label="Закрыть редактор">${iconMarkup('arrow-left')}</button>
      <input class="collage-project-name" data-project-name type="text" maxlength="80" aria-label="Название коллажа" placeholder="Название коллажа">
      <div class="collage-toolbar-spacer"></div>
      <button type="button" data-command="undo" title="Отменить" aria-label="Отменить последнее действие">${iconMarkup('undo')}</button>
      <button type="button" data-command="redo" title="Повторить" aria-label="Повторить отменённое действие">${iconMarkup('redo')}</button>
      <details class="collage-history"><summary>История · <span data-history-count>0 из 20</span></summary><ol data-history-list></ol></details>
      <button type="button" data-command="load-project">Открыть</button>
      <div class="collage-save-group"><select data-save-kind aria-label="Формат проекта"><option value="json">Только разметка</option><option value="zip">Разметка и фото</option></select><button type="button" data-command="save-project">Сохранить</button></div>
      <button type="button" class="primary" data-command="preflight">Скачать коллаж</button>
    </header>
    <section class="collage-templates" aria-label="Шаблоны" data-template-accordion data-collapsed="true">
      <button type="button" class="collage-template-accordion-toggle" data-template-accordion-toggle aria-expanded="false" aria-controls="collage-template-list"><strong data-template-copy>Шаблоны для 2 фотографий</strong><span class="collage-accordion-icon">${iconMarkup('chevron-right')}</span></button>
      <div class="collage-template-list" id="collage-template-list" data-template-list hidden></div>
    </section>
    <main class="collage-workspace">
      <aside class="collage-panel collage-sources-panel" data-mobile-panel="photos">
        <section class="collage-gallery-block" data-source-accordion="gallery" data-collapsed="false">
          <header><span><strong>Галерея</strong><small data-gallery-folder>Все фото</small></span><button type="button" class="collage-accordion-toggle" data-source-accordion-toggle="gallery" aria-expanded="true" aria-controls="collage-gallery-content" aria-label="Свернуть галерею">${iconMarkup('chevron-down')}</button></header>
          <div class="collage-source-panel-content" id="collage-gallery-content"><div data-source-tree></div><div class="collage-source-grid" data-source-grid></div></div>
        </section>
        <section class="collage-session-block" data-source-accordion="session" data-collapsed="false">
          <header><span><strong>В коллаже · <span data-session-count>0</span></strong><small>Фотографии этой сессии</small></span><button type="button" class="collage-accordion-toggle" data-source-accordion-toggle="session" aria-expanded="true" aria-controls="collage-session-content" aria-label="Свернуть фотографии этой сессии">${iconMarkup('chevron-down')}</button></header>
          <div class="collage-session-grid collage-source-panel-content" id="collage-session-content" data-session-grid></div>
        </section>
      </aside>
      <section class="collage-canvas-column" data-mobile-panel="canvas">
        <div class="collage-canvas-view-controls">
          <button type="button" class="collage-canvas-zoom-toggle" data-command="toggle-canvas-zoom" title="Включить масштабирование и перемещение" aria-label="Включить масштабирование и перемещение" aria-pressed="false">${iconMarkup('search')}<span data-canvas-zoom-value>100%</span></button>
          <button type="button" class="collage-canvas-focus-toggle" data-command="toggle-canvas-focus" title="Показать коллаж на весь экран" aria-label="Показать коллаж на весь экран">${iconMarkup('maximize')}</button>
        </div>
        <div class="collage-cell-actions" data-cell-actions hidden>
          <button type="button" data-command="crop">Кроп</button>
          <button type="button" data-command="move">Переместить</button>
          <button type="button" data-command="remove">Убрать</button>
        </div>
        <div class="collage-canvas-wrap"><div class="collage-canvas-surface" data-canvas-surface><canvas data-preview></canvas><div class="collage-cell-overlay" data-cell-overlay></div></div><div class="collage-preview-busy" data-preview-busy role="status" aria-live="polite" hidden><span class="collage-preview-spinner" aria-hidden="true"></span><strong>Обновляем превью…</strong></div><div class="collage-preview-error" data-preview-error role="alert" hidden></div></div>
        <div class="collage-toast" data-toast role="status" aria-live="polite" hidden></div>
        <footer data-quality-summary></footer>
      </section>
      <aside class="collage-panel collage-settings" data-mobile-panel="settings">
        <section><div class="collage-setting-title"><strong>Фотографий</strong><div class="collage-stepper"><button type="button" data-count="-1" aria-label="Уменьшить количество фотографий">−</button><span data-photo-count>2</span><button type="button" data-count="1" aria-label="Увеличить количество фотографий">+</button></div></div></section>
        <section class="collage-template-transforms" aria-label="Отражение шаблона"><button type="button" data-template-transform="x">${iconMarkup('flip-horizontal')}<span>Слева / справа</span></button><button type="button" data-template-transform="y">${iconMarkup('flip-vertical')}<span>Сверху / снизу</span></button></section>
        <section class="collage-print-settings"><strong>Формат печати</strong><div class="collage-print-fields"><label>Размер<select data-print-format aria-label="Формат печати">${PRINT_FORMATS.map(format => `<option value="${format.id}">${format.label}</option>`).join('')}</select></label><label>Ориентация<select data-print-orientation aria-label="Ориентация печати"><option value="portrait">Вертикально</option><option value="landscape">Горизонтально</option></select></label></div><p data-print-size aria-live="polite"></p></section>
        <section><strong>Рамка фотографии</strong><div class="collage-segments" data-frame-modes><button data-frame-mode="none">Нет</button><button data-frame-mode="white">Белая</button><button data-frame-mode="color">Цвет</button></div><details class="collage-frame-colors"><summary>Цвет</summary><div class="collage-swatches" data-frame-palette></div><input type="color" data-frame-picker aria-label="Свой цвет рамки"></details></section>
        <section><strong>Форма края</strong><div class="collage-edge-grid" data-edge-grid></div></section>
        <section><strong>Фон коллажа</strong><div class="collage-swatches" data-background-palette></div><label class="collage-color-picker">Свой цвет <input type="color" data-background-picker></label></section>
        <section><label>Толщина рамки <output data-gap-value></output><input type="range" min="0" max="10" step="0.5" data-gap></label></section>
        <section><label><span data-depth-label>Глубина края</span> <output data-depth-value></output><input type="range" min="0" max="100" data-depth></label><label data-frequency-row>Частота элементов <output data-frequency-value></output><input type="range" min="0" max="100" data-frequency></label></section>
        <button type="button" class="collage-autofill" data-command="autofill">⤨ Автозаполнить заново</button>
      </aside>
    </main>
    <nav class="collage-mobile-nav" aria-label="Раздел редактора"><button data-show-panel="photos">Фото</button><button data-show-panel="canvas" aria-pressed="true">Коллаж</button><button data-show-panel="settings">Оформление</button></nav>
  </div>
  <section class="collage-loading-overlay" data-loading-overlay role="status" aria-live="polite" aria-busy="true" hidden><div class="collage-loading-card"><span class="collage-loading-spinner" aria-hidden="true"></span><strong data-loading-status></strong><div class="collage-loading-failures" data-loading-failures></div></div></section>`;

const auxiliary = document.createElement('div');
auxiliary.innerHTML = `
  <dialog class="collage-modal" data-crop-dialog><form method="dialog" class="collage-modal-card collage-crop-card"><header><strong>Кроп фотографии</strong><button value="cancel" aria-label="Закрыть">${iconMarkup('x')}</button></header><div class="collage-crop-tools"><label><input type="radio" name="crop-mode" value="proportional" checked> Сохранять пропорции</label><label><input type="radio" name="crop-mode" value="free"> Искажать пропорции</label></div><div class="collage-crop-stage" tabindex="0" aria-label="Область кропа. Стрелки двигают рамку, плюс и минус меняют масштаб, квадратные скобки поворачивают фото"><div class="collage-crop-image-box"><img alt="Редактируемая фотография"><div class="collage-crop-frame"><i data-crop-handle="nw"></i><i data-crop-handle="n"></i><i data-crop-handle="ne"></i><i data-crop-handle="e"></i><i data-crop-handle="se"></i><i data-crop-handle="s"></i><i data-crop-handle="sw"></i><i data-crop-handle="w"></i></div></div></div><div class="collage-crop-quality" data-crop-quality role="status" aria-live="polite"></div><footer><button type="button" data-crop-action="reset">Сбросить</button><button type="button" data-crop-action="center">По центру</button><span class="collage-crop-rotation" role="group" aria-label="Поворот фотографии"><button type="button" data-crop-action="rotate-left" aria-label="Повернуть фотографию на 90 градусов влево">${iconMarkup('rotate-ccw')}<span>90°</span></button><button type="button" data-crop-action="rotate-right" aria-label="Повернуть фотографию на 90 градусов вправо">${iconMarkup('rotate-cw')}<span>90°</span></button></span><button type="button" data-crop-action="minus" aria-label="Уменьшить масштаб рамки">−</button><button type="button" data-crop-action="plus" aria-label="Увеличить масштаб рамки">+</button><span></span><button value="cancel">Отмена</button><button type="button" class="primary" data-crop-action="done">Готово</button></footer></form></dialog>
  <dialog class="collage-modal" data-preflight-dialog><div class="collage-modal-card"><header><strong>Проверка перед печатью</strong><button type="button" data-modal-close aria-label="Закрыть">${iconMarkup('x')}</button></header><div data-preflight-content></div><footer><button type="button" data-modal-close>Вернуться</button><button type="button" class="primary" data-command="open-export">Настройки скачивания</button></footer></div></dialog>
  <dialog class="collage-modal" data-save-dialog><div class="collage-modal-card collage-save-card"><header><strong>Сохранить проект</strong><button type="button" data-save-close aria-label="Закрыть">${iconMarkup('x')}</button></header><p>Файл проекта будет сохранён как</p><strong class="collage-save-filename" data-project-filename></strong><footer><button type="button" data-save-close>Отмена</button><button type="button" class="primary" data-command="confirm-save-project">Сохранить</button></footer></div></dialog>
  <dialog class="collage-modal" data-export-dialog><div class="collage-modal-card"><header><strong>Скачать JPEG</strong><button type="button" data-modal-close aria-label="Закрыть">${iconMarkup('x')}</button></header><div class="collage-export-form"><label>Формат<select data-export-format></select></label><label>Ориентация<select data-export-orientation><option value="portrait">Вертикально</option><option value="landscape">Горизонтально</option></select></label><label>Качество<select data-export-ppi><option value="300">300 PPI · для печати</option></select></label><label class="collage-export-bleed"><input type="checkbox" data-export-bleed> <span>Запас под обрезку 2 мм</span></label><div class="collage-export-summary" data-export-summary></div><p class="collage-export-warning" data-export-canvas-warning role="note" hidden>Этот формат может не собраться в браузере на телефоне или планшете. На компьютере ограничений нет.</p><div class="collage-save-filename" data-export-filename></div><progress data-export-progress max="1" value="0" aria-label="Прогресс подготовки JPEG" hidden></progress><p data-export-status role="status" aria-live="polite"></p></div><footer><button type="button" data-command="cancel-export" hidden>Отменить</button><span></span><button type="button" class="primary" data-command="export">Скачать на устройство</button></footer></div></dialog>
  <dialog class="collage-modal" data-exit-dialog><div class="collage-modal-card collage-exit-card"><header><strong data-exit-heading>Сохранить изменения?</strong></header><p data-exit-message>В проекте есть несохранённые изменения.</p><label>Сохранить проект<select data-exit-save-kind><option value="json">Только разметка</option><option value="zip">Разметка и фото</option></select></label><strong class="collage-save-filename" data-exit-filename></strong><p data-exit-size></p><footer><button type="button" data-exit="stay">Остаться</button><button type="button" data-exit="discard">Выйти без сохранения</button><button type="button" class="primary" data-exit="save">Сохранить и выйти</button></footer></div></dialog>
  <dialog class="collage-modal collage-photo-preview" data-photo-preview-dialog><div class="collage-modal-card"><header><strong data-photo-preview-name>Просмотр фотографии</strong><span></span><button type="button" data-photo-preview-zoom title="Включить масштабирование и перемещение" aria-label="Включить масштабирование и перемещение" aria-pressed="false">${iconMarkup('search')}<span data-photo-preview-zoom-value>100%</span></button><button type="button" data-photo-preview-close aria-label="Закрыть просмотр фотографии">${iconMarkup('x')}</button></header><div class="collage-photo-preview-stage"><span class="collage-preview-spinner" aria-hidden="true"></span><img alt=""></div></div></dialog>`;
document.body.append(...auxiliary.children);

const canvas = /** @type {HTMLCanvasElement} */ (dialog.querySelector('[data-preview]'));
const previewStage = /** @type {HTMLElement} */ (dialog.querySelector('.collage-canvas-wrap'));
const canvasSurface = /** @type {HTMLElement} */ (dialog.querySelector('[data-canvas-surface]'));
const overlay = /** @type {HTMLElement} */ (dialog.querySelector('[data-cell-overlay]'));
const cropDialog = /** @type {HTMLDialogElement} */ (document.querySelector('[data-crop-dialog]'));
const preflightDialog = /** @type {HTMLDialogElement} */ (document.querySelector('[data-preflight-dialog]'));
const saveDialog = /** @type {HTMLDialogElement} */ (document.querySelector('[data-save-dialog]'));
const exportDialog = /** @type {HTMLDialogElement} */ (document.querySelector('[data-export-dialog]'));
const exitDialog = /** @type {HTMLDialogElement} */ (document.querySelector('[data-exit-dialog]'));
const photoPreviewDialog = /** @type {HTMLDialogElement} */ (document.querySelector('[data-photo-preview-dialog]'));
const shell = /** @type {HTMLElement} */ (dialog.querySelector('.collage-shell'));
const loadingOverlay = /** @type {HTMLElement} */ (dialog.querySelector('[data-loading-overlay]'));
const previewBusy = /** @type {HTMLElement} */ (dialog.querySelector('[data-preview-busy]'));
const previewError = /** @type {HTMLElement} */ (dialog.querySelector('[data-preview-error]'));

/** @type {ReturnType<typeof createCollageStore>|null} */
let store = null;
/** @type {SourceEntry[]} */
let visibleSourceEntries = [];
/** @type {Set<string>} */
let sessionSourceIds = new Set();
/** @type {Map<string, number>} */
const sessionPlacementCursor = new Map();
let selectedCell = -1;
let pendingSourceId = '';
let moveFrom = -1;
let dirty = false;
/** @type {'close'|'load'} */
let pendingExitAction = 'close';
/** @type {string[]} */
let ignoredIssues = [];
let previewRevision = 0;
let previewResizeFrame = 0;
/** @type {AbortController|null} */
let exportAbort = null;
let toastTimer = 0;
/** @type {Set<string>} */
const embeddedObjectUrls = new Set();
let editorReady = false;
let openingRevision = 0;
/** @type {ReturnType<typeof createPhotoLoadingBarrier>|null} */
let openingBarrier = null;
/** @type {Map<string, 'loading'|'ready'|'error'>} */
const sourcePreviewStates = new Map();
let galleryPanelOpen = true;
let sessionPanelOpen = true;
let templatePanelOpen = false;
let canvasFocusOpen = false;
let canvasZoomOpen = false;
let canvasZoom = 1;
let canvasPanX = 0;
let canvasPanY = 0;
/** @type {{pointerId: number, x: number, y: number, startX: number, startY: number}|null} */
let canvasPanDrag = null;
let photoPreviewZoomOpen = false;
let photoPreviewZoom = 1;
let photoPreviewPanX = 0;
let photoPreviewPanY = 0;
/** @type {{pointerId: number, x: number, y: number, startX: number, startY: number}|null} */
let photoPreviewPanDrag = null;

const previewResizeObserver = new ResizeObserver(() => {
  window.cancelAnimationFrame(previewResizeFrame);
  previewResizeFrame = window.requestAnimationFrame(() => {
    previewResizeFrame = 0;
    if (dialog.open && store) drawPreview(store.getState());
  });
});
previewResizeObserver.observe(previewStage);

/** @type {Record<EdgeStyle, string>} */
const edgeMap = {straight: 'straight', rounded: 'rounded', zigzag: 'zigzag', wave: 'wave', lightning: 'lightning', deckle: 'deckle', stamp: 'stamp', perforated: 'perforated', 'old-photo': 'old-photo', polaroid: 'polaroid'};
const reverseEdgeMap = Object.fromEntries(Object.entries(edgeMap).map(([left, right]) => [right, left]));
const edgeLabels = Object.freeze({
  straight: 'Ровный',
  rounded: 'Скруглённый',
  zigzag: 'Зигзаг',
  wave: 'Волна',
  lightning: 'Молния',
  deckle: 'Рваный край',
  stamp: 'Марка',
  perforated: 'Перфорация',
  'old-photo': 'Старое фото',
  polaroid: 'Полароид',
});

const tree = createSourceTree(/** @type {HTMLElement} */ (dialog.querySelector('[data-source-tree]')), {
  onFolderChanged(folder) {
    visibleSourceEntries = [...folder.entries];
    setText('[data-gallery-folder]', folder.title);
    renderSourceGrid();
  },
});

window.addEventListener('litegallery:open-collage', async event => {
  const photos = /** @type {CustomEvent} */ (event).detail?.photos || [];
  await openEditor(photos);
});

/** @param {SourceEntry[]} entries */
async function openEditor(entries) {
  const revision = ++openingRevision;
  await appConfigReady;
  if (revision !== openingRevision) return;
  revokeEmbeddedPhotos();
  const photoCount = Math.max(2, Math.min(12, entries.length || 2));
  const project = createProject({appVersion, photoCount});
  store = createCollageStore(project);
  store.subscribe(() => { dirty = editorReady; renderEditor(); });
  openingBarrier = createPhotoLoadingBarrier(entries);
  sourcePreviewStates.clear();
  for (const entry of entries) sourcePreviewStates.set(entry.path, 'loading');
  sessionSourceIds = new Set();
  sessionPlacementCursor.clear();
  galleryPanelOpen = true;
  sessionPanelOpen = true;
  templatePanelOpen = false;
  canvasFocusOpen = false;
  canvasZoomOpen = false;
  resetCanvasView();
  renderTemplateAccordion();
  renderCanvasFocus();
  renderCanvasZoom();
  renderSourceAccordions();
  selectedCell = -1;
  pendingSourceId = '';
  moveFrom = -1;
  ignoredIssues = [];
  setEditorReady(false);
  dialog.showModal();
  renderEditor();
  renderSourceGrid();
  renderSessionTray();
  renderLoadingBarrier();
  for (const entry of entries) {
    if (revision !== openingRevision) break;
    await prepareOpeningEntry(entry, revision);
  }
  if (revision === openingRevision) finishOpeningIfReady();
}

/** @param {boolean} ready */
function setEditorReady(ready) {
  editorReady = ready;
  dialog.dataset.ready = String(ready);
  shell.inert = !ready;
  loadingOverlay.hidden = ready;
  loadingOverlay.setAttribute('aria-busy', String(!ready));
}

/** @param {SourceEntry} entry @param {number} revision */
async function prepareOpeningEntry(entry, revision) {
  if (!openingBarrier?.start(entry.path)) return;
  sourcePreviewStates.set(entry.path, 'loading');
  renderLoadingBarrier();
  renderSourceGrid();
  try {
    const source = await preparePhotoSource(entry);
    if (revision !== openingRevision || !openingBarrier?.has(entry.path)) return;
    openingBarrier.succeed(entry.path, source);
    sourcePreviewStates.set(entry.path, 'ready');
  } catch (error) {
    if (revision !== openingRevision || !openingBarrier?.has(entry.path)) return;
    openingBarrier.fail(entry.path, error);
    sourcePreviewStates.set(entry.path, 'error');
  }
  renderLoadingBarrier();
  renderSourceGrid();
  finishOpeningIfReady();
}

function finishOpeningIfReady() {
  if (!store || editorReady || !openingBarrier) return;
  const snapshot = openingBarrier.snapshot();
  if (!snapshot.canFinish) return;
  const sources = /** @type {PhotoSource[]} */ (snapshot.sources);
  const photoCount = Math.max(2, Math.min(12, sources.length));
  let hydrated = createProject({appVersion, photoCount});
  hydrated = collageReducer(hydrated, actions.registerSources(sources));
  hydrated = collageReducer(hydrated, actions.autofill(sources.slice(0, photoCount).map(source => ({id: createPlacementId(), sourceId: source.id}))));
  sessionSourceIds = new Set(sources.map(source => source.id));
  setEditorReady(true);
  store.dispatch(actions.replaceProject(hydrated));
  dirty = false;
}

function renderLoadingBarrier() {
  if (editorReady || !openingBarrier) return;
  const snapshot = openingBarrier.snapshot();
  setText('[data-loading-status]', `Загружаем фотографии · ${snapshot.readyCount} из ${snapshot.total}`);
  const failures = /** @type {HTMLElement} */ (dialog.querySelector('[data-loading-failures]'));
  failures.replaceChildren();
  if (snapshot.total < 2) {
    const minimum = document.createElement('p');
    minimum.className = 'collage-loading-minimum';
    minimum.textContent = 'Для коллажа нужно минимум 2 фотографии.';
    failures.append(minimum);
  }
  for (const {entry, error} of snapshot.failures) {
    const row = document.createElement('div');
    row.className = 'collage-loading-failure';
    row.dataset.loadingPath = entry.path;
    const copy = document.createElement('div');
    const name = document.createElement('strong');
    name.dataset.loadingName = '';
    name.textContent = entry.name;
    const message = document.createElement('small');
    message.textContent = error.message;
    copy.append(name, message);
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.dataset.loadingRetry = entry.path;
    retry.textContent = 'Повторить';
    retry.setAttribute('aria-label', `Повторить загрузку ${entry.name}`);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.dataset.loadingRemove = entry.path;
    remove.textContent = 'Убрать';
    remove.disabled = !snapshot.canRemove;
    remove.setAttribute('aria-label', `Убрать ${entry.name}`);
    row.append(copy, retry, remove);
    failures.append(row);
  }
}

loadingOverlay.addEventListener('click', event => {
  const target = /** @type {HTMLElement} */ (event.target);
  const retryPath = target.closest('[data-loading-retry]')?.getAttribute('data-loading-retry');
  if (retryPath) {
    const entry = openingBarrier?.getEntry(retryPath);
    if (entry) prepareOpeningEntry(entry, openingRevision);
    return;
  }
  const removePath = target.closest('[data-loading-remove]')?.getAttribute('data-loading-remove');
  if (!removePath || !openingBarrier?.remove(removePath)) return;
  sourcePreviewStates.delete(removePath);
  renderLoadingBarrier();
  renderSourceGrid();
  finishOpeningIfReady();
});

function renderEditor() {
  if (!store) return;
  const state = store.getState();
  const titleInput = /** @type {HTMLInputElement|null} */ (dialog.querySelector('[data-project-name]'));
  if (titleInput && document.activeElement !== titleInput) titleInput.value = state.title || 'Коллаж';
  const template = getTemplate(state.layout.templateId);
  const history = store.getHistory();
  setText('[data-history-count]', `${history.past.length} из ${history.limit}`);
  const historyList = dialog.querySelector('[data-history-list]');
  if (historyList) historyList.innerHTML = history.past.slice(-8).reverse().map(label => `<li>${escapeHtml(label)}</li>`).join('') || '<li>Изменений пока нет</li>';
  const undo = /** @type {HTMLButtonElement} */ (dialog.querySelector('[data-command="undo"]'));
  const redo = /** @type {HTMLButtonElement} */ (dialog.querySelector('[data-command="redo"]'));
  undo.disabled = !store.canUndo();
  redo.disabled = !store.canRedo();
  setText('[data-photo-count]', String(template.photoCount));
  setText('[data-template-copy]', `Шаблоны для ${template.photoCount} фотографий`);
  const dimensions = getPrintDimensions(state.print.formatId, state.print.orientation, state.print.ppi, state.print.bleedMm);
  renderQualitySummary(dimensions, state.print.ppi);
  renderTemplates(state);
  renderCellOverlay(state);
  renderSettings(state);
  renderSessionTray(state);
  updateSaveSizes(state);
  if (editorReady) drawPreview(state);
}

/** @param {ReturnType<typeof getPrintDimensions>} dimensions @param {number} ppi */
function renderQualitySummary(dimensions, ppi) {
  const footer = dialog.querySelector('[data-quality-summary]');
  if (!footer) return;
  footer.className = 'collage-quality-pill';
  const size = document.createElement('span');
  size.dataset.qualitySize = '';
  size.textContent = `${dimensions.outputWidthMm / 10} × ${dimensions.outputHeightMm / 10} см`;
  const quality = document.createElement('span');
  quality.className = 'collage-quality-ppi';
  quality.dataset.qualityPpi = '';
  const dot = document.createElement('i');
  dot.className = 'collage-quality-dot';
  dot.setAttribute('aria-hidden', 'true');
  quality.append(dot, document.createTextNode(`${ppi} PPI`));
  const pixels = document.createElement('span');
  pixels.className = 'collage-quality-pixels';
  pixels.dataset.qualityPixels = '';
  pixels.textContent = `${dimensions.widthPx} × ${dimensions.heightPx} px`;
  const divider = () => {
    const item = document.createElement('i');
    item.className = 'collage-quality-divider';
    item.setAttribute('aria-hidden', 'true');
    return item;
  };
  footer.replaceChildren(size, divider(), quality, divider(), pixels);
}

/** @param {ProjectState} state */
function renderTemplates(state) {
  const list = dialog.querySelector('[data-template-list]');
  if (!list) return;
  list.replaceChildren();
  const selectedTemplate = getTemplate(state.layout.templateId);
  const selectedCanonicalId = getCanonicalTemplateId(selectedTemplate.id);
  for (const template of getVisibleTemplatesForCount(getTemplate(state.layout.templateId).photoCount)) {
    const item = document.createElement('div');
    item.className = 'collage-template-item';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'collage-template-thumb';
    button.dataset.templateId = template.id;
    button.dataset.templateFamily = template.family;
    button.title = 'Выбрать шаблон';
    button.setAttribute('aria-label', `Выбрать шаблон ${template.id}`);
    const selected = template.id === selectedCanonicalId;
    button.setAttribute('aria-pressed', String(selected));
    for (const cell of template.cells) {
      const tile = document.createElement('i');
      Object.assign(tile.style, {left: `${cell.rect.x * 100}%`, top: `${cell.rect.y * 100}%`, width: `${cell.rect.width * 100}%`, height: `${cell.rect.height * 100}%`});
      button.append(tile);
    }
    item.append(button);
    list.append(item);
  }
}

/** @param {ProjectState} state */
function renderCellOverlay(state) {
  const template = getTemplate(state.layout.templateId);
  overlay.replaceChildren();
  template.cells.forEach((cell, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.cellIndex = String(index);
    button.className = 'collage-cell-hit';
    const occupied = Boolean(state.layout.order[index]);
    button.classList.toggle('is-selected', index === selectedCell);
    button.classList.toggle('is-empty', !occupied);
    button.classList.toggle('is-target', moveFrom >= 0 && index !== moveFrom || Boolean(pendingSourceId) && !occupied);
    button.setAttribute('aria-label', occupied ? `Фотография ${index + 1}` : `Пустая ячейка ${index + 1}`);
    Object.assign(button.style, {left: `${cell.rect.x * 100}%`, top: `${cell.rect.y * 100}%`, width: `${cell.rect.width * 100}%`, height: `${cell.rect.height * 100}%`});
    if (!occupied) button.innerHTML = '<span>Добавить фото</span>';
    if (occupied) {
      const placementId = state.layout.order[index];
      const placement = placementId ? state.placements[placementId] : null;
      const source = placement && state.sources[placement.sourceId];
      if (placement && source) {
        const dimensions = getPrintDimensions(state.print.formatId, state.print.orientation, state.print.ppi, state.print.bleedMm);
        const pixels = rectToPixels(cell.rect, dimensions.widthPx, dimensions.heightPx);
        const ppi = effectiveCropPpi(placement.crop, source.width, source.height, pixels.width, pixels.height, state.print.ppi);
        if (ppi < 300) {
          const warning = document.createElement('span');
          warning.className = 'collage-cell-warning';
          warning.textContent = `${ppi} PPI`;
          warning.setAttribute('aria-label', `Недостаточное качество ${ppi} PPI`);
          button.append(warning);
        }
      }
    }
    overlay.append(button);
  });
  const cellActions = /** @type {HTMLElement} */ (dialog.querySelector('[data-cell-actions]'));
  cellActions.hidden = selectedCell < 0 || !state.layout.order[selectedCell];
}

/** @param {ProjectState} state */
function renderSettings(state) {
  const printFormat = /** @type {HTMLSelectElement} */ (dialog.querySelector('[data-print-format]'));
  const printOrientation = /** @type {HTMLSelectElement} */ (dialog.querySelector('[data-print-orientation]'));
  printFormat.value = state.print.formatId;
  printOrientation.value = state.print.orientation;
  const printDimensions = getPrintDimensions(state.print.formatId, state.print.orientation, state.print.ppi, state.print.bleedMm);
  setText('[data-print-size]', `${printDimensions.trimWidthMm / 10} × ${printDimensions.trimHeightMm / 10} см`);
  const transformState = getTemplateTransformState(state.layout.templateId);
  dialog.querySelectorAll('[data-template-transform]').forEach(element => {
    const button = /** @type {HTMLButtonElement} */ (element);
    const axis = /** @type {'x'|'y'} */ (button.dataset.templateTransform);
    button.disabled = isTemplateAxisSymmetric(state.layout.templateId, axis);
    button.setAttribute('aria-pressed', String(axis === 'x' ? transformState.flipX : transformState.flipY));
  });
  dialog.querySelectorAll('[data-frame-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.getAttribute('data-frame-mode') === state.appearance.frame.mode)));
  const edges = dialog.querySelector('[data-edge-grid]');
  if (edges && !edges.children.length) {
    for (const preset of EDGE_PRESETS) {
      const button = document.createElement('button');
      const label = edgeLabels[preset.id];
      button.type = 'button';
      button.dataset.edge = reverseEdgeMap[preset.id] || preset.id;
      button.dataset.tooltip = label;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.innerHTML = `<i class="edge-preview edge-${preset.id}"></i>`;
      edges.append(button);
    }
  }
  dialog.querySelectorAll('[data-edge]').forEach(button => button.setAttribute('aria-pressed', String(button.getAttribute('data-edge') === state.appearance.frame.edgeStyle)));
  const backgrounds = dialog.querySelector('[data-background-palette]');
  if (backgrounds) renderSwatches(backgrounds, BACKGROUND_PALETTE.map(item => item.color), state.appearance.backgroundColor, 'background');
  const frames = dialog.querySelector('[data-frame-palette]');
  if (frames) renderSwatches(frames, createFramePalette(state.appearance.backgroundColor), state.appearance.frame.color, 'frame');
  setInput('[data-background-picker]', state.appearance.backgroundColor);
  setInput('[data-frame-picker]', state.appearance.frame.color);
  setInput('[data-gap]', String(state.appearance.gapMm));
  setInput('[data-depth]', String(Math.round(state.appearance.frame.depth * 100)));
  setInput('[data-frequency]', String(Math.round(state.appearance.frame.frequency * 100)));
  setText('[data-gap-value]', `${state.appearance.gapMm} мм`);
  setText('[data-depth-value]', `${Math.round(state.appearance.frame.depth * 100)}%`);
  setText('[data-frequency-value]', `${Math.round(state.appearance.frame.frequency * 100)}%`);
  const preset = EDGE_PRESETS.find(item => item.id === edgeMap[state.appearance.frame.edgeStyle]);
  setText('[data-depth-label]', preset?.id === 'old-photo' || preset?.id === 'polaroid' ? 'Ширина рамки' : 'Глубина края');
  const frequencyRow = /** @type {HTMLElement} */ (dialog.querySelector('[data-frequency-row]'));
  frequencyRow.hidden = !preset?.supportsFrequency;
}

/** @param {Element} container @param {readonly string[]} colors @param {string} active @param {'background'|'frame'} kind */
function renderSwatches(container, colors, active, kind) {
  container.replaceChildren();
  for (const color of colors) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset[`${kind}Color`] = color;
    button.style.background = color;
    button.title = color;
    button.setAttribute('aria-label', `${kind === 'background' ? 'Цвет фона' : 'Цвет рамки'} ${color}`);
    button.setAttribute('aria-pressed', String(color.toUpperCase() === active.toUpperCase()));
    container.append(button);
  }
}

function renderSourceGrid() {
  const grid = dialog.querySelector('[data-source-grid]');
  if (!grid) return;
  grid.replaceChildren();
  for (const entry of visibleSourceEntries) {
    const item = document.createElement('div');
    item.className = 'collage-source-photo-item';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'collage-source-photo';
    button.dataset.sourcePath = entry.path;
    button.title = entry.name;
    button.setAttribute('aria-label', `Выбрать фотографию ${entry.name}`);
    const state = sourcePreviewStates.get(entry.path) || 'loading';
    button.classList.add(`is-${state}`);
    const image = document.createElement('img');
    image.loading = 'lazy';
    image.alt = '';
    const name = document.createElement('span');
    name.className = 'collage-source-name';
    name.textContent = entry.name;
    const status = document.createElement('em');
    status.className = 'collage-source-status';
    status.textContent = state === 'error' ? 'Ошибка превью' : state === 'ready' ? 'Готово' : 'Загрузка…';
    const sourceUrl = typeof entry.sourceUrl === 'string'
      ? runtimeSourceUrl(/** @type {PhotoSource} */ (/** @type {unknown} */ (entry)))
      : collageApiUrl('/api/thumb', entry.path);
    image.addEventListener('load', () => {
      if (!editorReady && openingBarrier?.has(entry.path)) return;
      sourcePreviewStates.set(entry.path, 'ready');
      button.classList.remove('is-loading', 'is-error');
      button.classList.add('is-ready');
      status.textContent = 'Готово';
    });
    image.addEventListener('error', () => {
      if (!editorReady && openingBarrier?.has(entry.path)) return;
      sourcePreviewStates.set(entry.path, 'error');
      button.classList.remove('is-loading', 'is-ready');
      button.classList.add('is-error');
      status.textContent = 'Ошибка превью';
    });
    image.src = sourceUrl;
    button.append(image, name, status);
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'collage-source-preview';
    preview.dataset.sourcePreviewPath = entry.path;
    preview.title = `Показать ${entry.name} крупно`;
    preview.setAttribute('aria-label', preview.title);
    preview.textContent = '⌕';
    item.append(button, preview);
    grid.append(item);
  }
}

/** @param {ProjectState=} requestedState */
function renderSessionTray(requestedState) {
  const grid = dialog.querySelector('[data-session-grid]');
  if (!grid) return;
  const state = requestedState || store?.getState();
  grid.replaceChildren();
  setText('[data-session-count]', String(sessionSourceIds.size));
  if (!state || !sessionSourceIds.size) {
    const empty = document.createElement('p');
    empty.className = 'collage-session-empty';
    empty.textContent = 'Добавленные фотографии появятся здесь';
    grid.append(empty);
    return;
  }
  for (const sourceId of sessionSourceIds) {
    const source = state.sources[sourceId];
    if (!source) continue;
    const placementIndexes = state.layout.order.flatMap((placementId, index) => {
      const placement = placementId ? state.placements[placementId] : null;
      return placement?.sourceId === sourceId ? [index] : [];
    });
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'collage-source-photo collage-session-photo';
    button.dataset.sessionSourceId = sourceId;
    button.title = placementIndexes.length ? `Выбрать ${source.name}` : `Добавить ${source.name} ещё раз`;
    button.setAttribute('aria-label', button.title);
    button.classList.toggle('is-selected', pendingSourceId === sourceId || placementIndexes.includes(selectedCell));
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.src = typeof source.sourceUrl === 'string' ? runtimeSourceUrl(source) : collageApiUrl('/api/thumb', source.path);
    const name = document.createElement('span');
    name.className = 'collage-source-name';
    name.textContent = source.name;
    button.append(image, name);
    if (placementIndexes.length > 1) {
      const badge = document.createElement('em');
      badge.className = 'collage-session-usage';
      badge.textContent = `×${placementIndexes.length}`;
      button.append(badge);
    }
    grid.append(button);
  }
}

/** @param {ProjectState} state */
async function drawPreview(state) {
  if (!editorReady) return;
  const revision = ++previewRevision;
  const dimensions = toPrintSettings(state);
  const availableWidth = Math.floor(previewStage.clientWidth);
  const availableHeight = Math.floor(previewStage.clientHeight);
  if (availableWidth <= 0 || availableHeight <= 0) return;
  previewBusy.hidden = false;
  previewError.hidden = true;
  const scale = Math.min(availableWidth / dimensions.widthMm, availableHeight / dimensions.heightMm);
  const width = Math.max(1, Math.round(dimensions.widthMm * scale));
  const height = Math.max(1, Math.round(dimensions.heightMm * scale));
  // A regular detached canvas is supported by Safari and keeps partially
  // rendered or stale frames away from the visible preview.
  const buffer = document.createElement('canvas');
  buffer.width = width;
  buffer.height = height;
  const project = toRenderProject(state, true, Math.max(0, state.appearance.gapMm * scale));
  const plan = buildRenderPlan(project, dimensions, {pixelWidth: width, pixelHeight: height});
  const context = buffer.getContext('2d', {alpha: false});
  if (!context) {
    previewBusy.hidden = true;
    previewError.textContent = 'Не удалось обновить превью: canvas недоступен';
    previewError.hidden = false;
    return;
  }
  try {
    await renderCanvas(context, plan, fetchImageBitmap);
    if (!commitPreviewFrame(canvas, buffer, revision, previewRevision)) return;
    canvas.style.aspectRatio = `${width} / ${height}`;
    canvasSurface.style.width = `${width}px`;
    canvasSurface.style.height = `${height}px`;
    overlay.style.width = `${width}px`;
    overlay.style.height = `${height}px`;
    overlay.style.aspectRatio = canvas.style.aspectRatio;
    updateCanvasTransform();
    previewBusy.hidden = true;
    previewError.hidden = true;
  } catch (error) {
    if (revision === previewRevision) {
      const message = error instanceof Error ? error.message : 'Не удалось показать превью';
      previewBusy.hidden = true;
      previewError.textContent = `Не удалось обновить превью: ${message}`;
      previewError.hidden = false;
      showToast(message);
    }
  }
}

/** @param {ProjectState} state @param {boolean} preview @param {number} lineWidth */
function toRenderProject(state, preview, lineWidth) {
  const template = getTemplate(state.layout.templateId);
  const frame = {
    preset: edgeMap[state.appearance.frame.edgeStyle] || 'straight',
    depth: state.appearance.frame.depth * .18,
    frequency: 2 + Math.round(state.appearance.frame.frequency * 46),
    radius: state.appearance.frame.depth * .5,
  };
  return {
    layout: {id: template.id, cells: template.cells.map(cell => ({id: cell.id, ...cell.rect}))},
    placements: state.layout.order.flatMap((placementId, index) => {
      if (!placementId) return [];
      const placement = state.placements[placementId];
      const source = placement && state.sources[placement.sourceId];
      if (!placement || !source) return [];
      const embeddedUrl = typeof source.sourceUrl === 'string' ? source.sourceUrl : '';
      return [{cellId: template.cells[index].id, sourceId: source.id, sourceUrl: embeddedUrl || collageApiUrl('/api/media', source.path), crop: placement.crop, rotation: placement.rotation ?? 0, frame}];
    }),
    background: state.appearance.backgroundColor,
    lines: {width: lineWidth, color: resolveFrameLineColor(state.appearance)},
    frame,
  };
}

/** @param {ProjectState} state */
function toPrintSettings(state) {
  const format = getPrintFormat(state.print.formatId);
  return {
    widthMm: state.print.orientation === 'portrait' ? format.widthMm : format.heightMm,
    heightMm: state.print.orientation === 'portrait' ? format.heightMm : format.widthMm,
    ppi: state.print.ppi,
    bleedMm: state.print.bleedMm,
  };
}

dialog.addEventListener('click', async event => {
  const target = /** @type {HTMLElement} */ (event.target);
  const command = target.closest('[data-command]')?.getAttribute('data-command');
  if (command) await runCommand(command);
  const transformAxis = target.closest('[data-template-transform]')?.getAttribute('data-template-transform');
  if ((transformAxis === 'x' || transformAxis === 'y') && store) {
    store.dispatch(actions.setTemplate(getTransformedTemplateId(store.getState().layout.templateId, transformAxis)));
    showToast('Шаблон отражён', true);
  }
  const templateId = target.closest('[data-template-id]')?.getAttribute('data-template-id');
  if (templateId && store) { store.dispatch(actions.setTemplate(templateId)); showToast('Шаблон изменён', true); }
  if (target.closest('[data-template-accordion-toggle]')) toggleTemplateAccordion();
  const cellIndexRaw = target.closest('[data-cell-index]')?.getAttribute('data-cell-index');
  if (cellIndexRaw !== null && cellIndexRaw !== undefined) handleCellClick(Number(cellIndexRaw));
  const sourcePath = target.closest('[data-source-path]')?.getAttribute('data-source-path');
  if (sourcePath) await selectSource(sourcePath);
  const sourcePreviewPath = target.closest('[data-source-preview-path]')?.getAttribute('data-source-preview-path');
  if (sourcePreviewPath) openPhotoPreview(sourcePreviewPath);
  const sourceAccordion = target.closest('[data-source-accordion-toggle]')?.getAttribute('data-source-accordion-toggle');
  if (sourceAccordion === 'gallery' || sourceAccordion === 'session') toggleSourceAccordion(sourceAccordion);
  const sessionSourceId = target.closest('[data-session-source-id]')?.getAttribute('data-session-source-id');
  if (sessionSourceId) selectSessionSource(sessionSourceId);
  const countDelta = target.closest('[data-count]')?.getAttribute('data-count');
  if (countDelta && store) changePhotoCount(Number(countDelta));
  const frameMode = target.closest('[data-frame-mode]')?.getAttribute('data-frame-mode');
  if (frameMode && store) store.dispatch(actions.setFrame({mode: /** @type {any} */ (frameMode)}));
  const edge = target.closest('[data-edge]')?.getAttribute('data-edge');
  if (edge && store) store.dispatch(actions.setFrame({edgeStyle: /** @type {any} */ (edge)}));
  const background = target.closest('[data-background-color]')?.getAttribute('data-background-color');
  if (background && store) store.dispatch(actions.setBackground(background));
  const frameColor = target.closest('[data-frame-color]')?.getAttribute('data-frame-color');
  if (frameColor && store) store.dispatch(actions.setFrame({mode: 'color', color: frameColor}));
  const panel = target.closest('[data-show-panel]')?.getAttribute('data-show-panel');
  if (panel) showMobilePanel(panel);
});

/** @param {'gallery'|'session'} panel */
function toggleSourceAccordion(panel) {
  if (panel === 'gallery') {
    if (galleryPanelOpen && !sessionPanelOpen) return;
    galleryPanelOpen = !galleryPanelOpen;
  } else {
    if (sessionPanelOpen && !galleryPanelOpen) return;
    sessionPanelOpen = !sessionPanelOpen;
  }
  renderSourceAccordions();
}

function renderSourceAccordions() {
  for (const panel of /** @type {const} */ (['gallery', 'session'])) {
    const open = panel === 'gallery' ? galleryPanelOpen : sessionPanelOpen;
    const otherOpen = panel === 'gallery' ? sessionPanelOpen : galleryPanelOpen;
    const section = /** @type {HTMLElement|null} */ (dialog.querySelector(`[data-source-accordion="${panel}"]`));
    const button = /** @type {HTMLButtonElement|null} */ (dialog.querySelector(`[data-source-accordion-toggle="${panel}"]`));
    const content = /** @type {HTMLElement|null} */ (dialog.querySelector(`#collage-${panel === 'gallery' ? 'gallery' : 'session'}-content`));
    if (!section || !button || !content) continue;
    section.dataset.collapsed = String(!open);
    content.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', `${open ? 'Свернуть' : 'Развернуть'} ${panel === 'gallery' ? 'галерею' : 'фотографии этой сессии'}`);
    button.innerHTML = iconMarkup(open ? 'chevron-down' : 'chevron-right');
    button.disabled = open && !otherOpen;
  }
}

function toggleTemplateAccordion() {
  templatePanelOpen = !templatePanelOpen;
  renderTemplateAccordion();
}

function renderTemplateAccordion() {
  const section = /** @type {HTMLElement|null} */ (dialog.querySelector('[data-template-accordion]'));
  const button = /** @type {HTMLButtonElement|null} */ (dialog.querySelector('[data-template-accordion-toggle]'));
  const list = /** @type {HTMLElement|null} */ (dialog.querySelector('[data-template-list]'));
  if (!section || !button || !list) return;
  section.dataset.collapsed = String(!templatePanelOpen);
  list.hidden = !templatePanelOpen;
  button.setAttribute('aria-expanded', String(templatePanelOpen));
  button.setAttribute('aria-label', templatePanelOpen ? 'Свернуть список шаблонов' : 'Развернуть список шаблонов');
  const icon = button.querySelector('.collage-accordion-icon');
  if (icon) icon.innerHTML = iconMarkup(templatePanelOpen ? 'chevron-down' : 'chevron-right');
}

function toggleCanvasFocus() {
  canvasFocusOpen = !canvasFocusOpen;
  renderCanvasFocus();
}

function renderCanvasFocus() {
  dialog.dataset.canvasFocus = String(canvasFocusOpen);
  const button = /** @type {HTMLButtonElement|null} */ (dialog.querySelector('.collage-canvas-focus-toggle'));
  if (!button) return;
  button.innerHTML = iconMarkup(canvasFocusOpen ? 'x' : 'maximize');
  button.title = canvasFocusOpen ? 'Выйти из полноэкранного просмотра' : 'Показать коллаж на весь экран';
  button.setAttribute('aria-label', button.title);
  window.requestAnimationFrame(() => { if (store) drawPreview(store.getState()); });
}

function toggleCanvasZoom() {
  canvasZoomOpen = !canvasZoomOpen;
  if (!canvasZoomOpen) resetCanvasView();
  renderCanvasZoom();
}

function resetCanvasView() {
  canvasZoom = 1;
  canvasPanX = 0;
  canvasPanY = 0;
  canvasPanDrag = null;
  updateCanvasTransform();
}

function clampCanvasPan() {
  const maxX = Math.max(0, (canvasSurface.offsetWidth * canvasZoom - previewStage.clientWidth) / 2);
  const maxY = Math.max(0, (canvasSurface.offsetHeight * canvasZoom - previewStage.clientHeight) / 2);
  canvasPanX = Math.max(-maxX, Math.min(maxX, canvasPanX));
  canvasPanY = Math.max(-maxY, Math.min(maxY, canvasPanY));
}

function updateCanvasTransform() {
  clampCanvasPan();
  canvasSurface.style.transform = `translate(${canvasPanX}px, ${canvasPanY}px) scale(${canvasZoom})`;
  const value = dialog.querySelector('[data-canvas-zoom-value]');
  if (value) value.textContent = `${Math.round(canvasZoom * 100)}%`;
}

function renderCanvasZoom() {
  dialog.dataset.canvasZoom = String(canvasZoomOpen);
  const button = /** @type {HTMLButtonElement|null} */ (dialog.querySelector('.collage-canvas-zoom-toggle'));
  if (!button) return;
  button.setAttribute('aria-pressed', String(canvasZoomOpen));
  button.title = canvasZoomOpen ? 'Выключить масштабирование и перемещение' : 'Включить масштабирование и перемещение';
  button.setAttribute('aria-label', button.title);
  updateCanvasTransform();
}

/** @param {string} path */
function openPhotoPreview(path) {
  const state = store?.getState();
  const entry = visibleSourceEntries.find(item => item.path === path);
  const source = state && Object.values(state.sources).find(item => item.path === path);
  if (!entry && !source) return;
  const image = /** @type {HTMLImageElement} */ (photoPreviewDialog.querySelector('img'));
  const stage = /** @type {HTMLElement} */ (photoPreviewDialog.querySelector('.collage-photo-preview-stage'));
  const name = entry?.name || source?.name || 'Фотография';
  const url = source ? runtimeSourceUrl(source) : entry?.sourceUrl ? entry.sourceUrl : collageApiUrl('/api/media', path);
  setModalText(photoPreviewDialog, '[data-photo-preview-name]', name);
  resetPhotoPreviewZoom();
  stage.dataset.loading = 'true';
  image.onload = () => { stage.dataset.loading = 'false'; };
  image.onerror = () => { stage.dataset.loading = 'error'; };
  image.src = url;
  photoPreviewDialog.showModal();
}

photoPreviewDialog.addEventListener('click', event => {
  const target = /** @type {HTMLElement} */ (event.target);
  if (target.closest('[data-photo-preview-close]')) photoPreviewDialog.close();
  if (target.closest('[data-photo-preview-zoom]')) togglePhotoPreviewZoom();
});
photoPreviewDialog.addEventListener('close', resetPhotoPreviewZoom);

function togglePhotoPreviewZoom() {
  photoPreviewZoomOpen = !photoPreviewZoomOpen;
  if (!photoPreviewZoomOpen) resetPhotoPreviewTransform();
  renderPhotoPreviewZoom();
}

function resetPhotoPreviewZoom() {
  photoPreviewZoomOpen = false;
  resetPhotoPreviewTransform();
  renderPhotoPreviewZoom();
}

function resetPhotoPreviewTransform() {
  photoPreviewZoom = 1;
  photoPreviewPanX = 0;
  photoPreviewPanY = 0;
  photoPreviewPanDrag = null;
  updatePhotoPreviewTransform();
}

function clampPhotoPreviewPan() {
  const stage = /** @type {HTMLElement} */ (photoPreviewDialog.querySelector('.collage-photo-preview-stage'));
  const image = /** @type {HTMLImageElement} */ (stage.querySelector('img'));
  const maxX = Math.max(0, (image.clientWidth * photoPreviewZoom - stage.clientWidth) / 2);
  const maxY = Math.max(0, (image.clientHeight * photoPreviewZoom - stage.clientHeight) / 2);
  photoPreviewPanX = Math.max(-maxX, Math.min(maxX, photoPreviewPanX));
  photoPreviewPanY = Math.max(-maxY, Math.min(maxY, photoPreviewPanY));
}

function updatePhotoPreviewTransform() {
  const image = /** @type {HTMLImageElement} */ (photoPreviewDialog.querySelector('.collage-photo-preview-stage img'));
  clampPhotoPreviewPan();
  image.style.transform = `translate(${photoPreviewPanX}px, ${photoPreviewPanY}px) scale(${photoPreviewZoom})`;
  const value = photoPreviewDialog.querySelector('[data-photo-preview-zoom-value]');
  if (value) value.textContent = `${Math.round(photoPreviewZoom * 100)}%`;
}

function renderPhotoPreviewZoom() {
  const button = /** @type {HTMLButtonElement} */ (photoPreviewDialog.querySelector('[data-photo-preview-zoom]'));
  photoPreviewDialog.dataset.zoom = String(photoPreviewZoomOpen);
  button.setAttribute('aria-pressed', String(photoPreviewZoomOpen));
  button.title = photoPreviewZoomOpen ? 'Выключить масштабирование и перемещение' : 'Включить масштабирование и перемещение';
  button.setAttribute('aria-label', button.title);
  updatePhotoPreviewTransform();
}

const photoPreviewStage = /** @type {HTMLElement} */ (photoPreviewDialog.querySelector('.collage-photo-preview-stage'));
photoPreviewStage.addEventListener('wheel', event => {
  if (!photoPreviewZoomOpen) return;
  event.preventDefault();
  const previous = photoPreviewZoom;
  const next = Math.max(1, Math.min(3, previous * Math.exp(-event.deltaY * .0015)));
  const bounds = photoPreviewStage.getBoundingClientRect();
  const pointX = event.clientX - bounds.left - bounds.width / 2;
  const pointY = event.clientY - bounds.top - bounds.height / 2;
  const ratio = next / previous;
  photoPreviewPanX = pointX - (pointX - photoPreviewPanX) * ratio;
  photoPreviewPanY = pointY - (pointY - photoPreviewPanY) * ratio;
  photoPreviewZoom = next;
  updatePhotoPreviewTransform();
}, {passive: false});
photoPreviewStage.addEventListener('pointerdown', event => {
  if (!photoPreviewZoomOpen || event.button !== 0) return;
  photoPreviewPanDrag = {pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: photoPreviewPanX, startY: photoPreviewPanY};
  photoPreviewStage.setPointerCapture(event.pointerId);
  photoPreviewDialog.dataset.panning = 'true';
});
photoPreviewStage.addEventListener('pointermove', event => {
  if (!photoPreviewPanDrag || photoPreviewPanDrag.pointerId !== event.pointerId) return;
  photoPreviewPanX = photoPreviewPanDrag.startX + event.clientX - photoPreviewPanDrag.x;
  photoPreviewPanY = photoPreviewPanDrag.startY + event.clientY - photoPreviewPanDrag.y;
  updatePhotoPreviewTransform();
});
/** @param {PointerEvent} event */
const stopPhotoPreviewPan = event => {
  if (!photoPreviewPanDrag || photoPreviewPanDrag.pointerId !== event.pointerId) return;
  photoPreviewPanDrag = null;
  photoPreviewDialog.dataset.panning = 'false';
};
photoPreviewStage.addEventListener('pointerup', stopPhotoPreviewPan);
photoPreviewStage.addEventListener('pointercancel', stopPhotoPreviewPan);
photoPreviewStage.addEventListener('dblclick', () => { if (photoPreviewZoomOpen) resetPhotoPreviewTransform(); });

previewStage.addEventListener('wheel', event => {
  if (!canvasZoomOpen) return;
  event.preventDefault();
  const previous = canvasZoom;
  const next = Math.max(.25, Math.min(2, previous * Math.exp(-event.deltaY * .0015)));
  const bounds = previewStage.getBoundingClientRect();
  const pointX = event.clientX - bounds.left - bounds.width / 2;
  const pointY = event.clientY - bounds.top - bounds.height / 2;
  const ratio = next / previous;
  canvasPanX = pointX - (pointX - canvasPanX) * ratio;
  canvasPanY = pointY - (pointY - canvasPanY) * ratio;
  canvasZoom = next;
  updateCanvasTransform();
}, {passive: false});

previewStage.addEventListener('pointerdown', event => {
  if (!canvasZoomOpen || event.button !== 0) return;
  canvasPanDrag = {pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: canvasPanX, startY: canvasPanY};
  previewStage.setPointerCapture(event.pointerId);
  dialog.dataset.canvasPanning = 'true';
});
previewStage.addEventListener('pointermove', event => {
  if (!canvasPanDrag || canvasPanDrag.pointerId !== event.pointerId) return;
  canvasPanX = canvasPanDrag.startX + event.clientX - canvasPanDrag.x;
  canvasPanY = canvasPanDrag.startY + event.clientY - canvasPanDrag.y;
  updateCanvasTransform();
});
/** @param {PointerEvent} event */
const stopCanvasPan = event => {
  if (!canvasPanDrag || canvasPanDrag.pointerId !== event.pointerId) return;
  canvasPanDrag = null;
  dialog.dataset.canvasPanning = 'false';
};
previewStage.addEventListener('pointerup', stopCanvasPan);
previewStage.addEventListener('pointercancel', stopCanvasPan);
previewStage.addEventListener('dblclick', () => { if (canvasZoomOpen) resetCanvasView(); });

dialog.addEventListener('input', event => {
  if (!store || !(event.target instanceof HTMLInputElement)) return;
  const input = event.target;
  if (input.matches('[data-project-name]')) store.dispatch(actions.setTitle(input.value));
  if (input.matches('[data-background-picker]')) store.dispatch(actions.setBackground(input.value));
  if (input.matches('[data-frame-picker]')) store.dispatch(actions.setFrame({mode: 'color', color: input.value}));
  if (input.matches('[data-gap]')) store.dispatch(actions.setGap(Number(input.value)));
  if (input.matches('[data-depth]')) store.dispatch(actions.setFrame({depth: Number(input.value) / 100}, 'frame-depth'));
  if (input.matches('[data-frequency]')) store.dispatch(actions.setFrame({frequency: Number(input.value) / 100}, 'frame-frequency'));
});

dialog.addEventListener('change', event => {
  if (!store) return;
  if (!(event.target instanceof HTMLSelectElement)) return;
  if (event.target.matches('[data-print-format]')) store.dispatch(actions.setPrint({formatId: event.target.value}));
  if (event.target.matches('[data-print-orientation]')) store.dispatch(actions.setPrint({orientation: /** @type {any} */ (event.target.value)}));
});

dialog.addEventListener('pointerdown', event => {
  if (!store || !(event.target instanceof HTMLInputElement) || event.target.type !== 'range') return;
  try { store.beginTransaction(event.target.dataset.gap !== undefined ? 'gap' : event.target.dataset.depth !== undefined ? 'frame-depth' : 'frame-frequency', 'Настройка оформления'); } catch {}
}, true);
dialog.addEventListener('pointerup', event => {
  if (!store || !(event.target instanceof HTMLInputElement) || event.target.type !== 'range') return;
  store.endTransaction();
}, true);

dialog.addEventListener('cancel', event => {
  event.preventDefault();
  if (canvasFocusOpen) { canvasFocusOpen = false; renderCanvasFocus(); return; }
  requestClose();
});
window.addEventListener('beforeunload', event => { if (dialog.open && dirty) event.preventDefault(); });

/** @param {string} command */
async function runCommand(command) {
  if (!store) return;
  if (command === 'close') return requestClose();
  if (command === 'toggle-canvas-focus') return toggleCanvasFocus();
  if (command === 'toggle-canvas-zoom') return toggleCanvasZoom();
  if (command === 'undo') return store.undo();
  if (command === 'redo') return store.redo();
  if (command === 'load-project') return requestProjectLoad();
  if (command === 'save-project') return openSaveDialog();
  if (command === 'crop') return openCropEditor();
  if (command === 'move') { moveFrom = selectedCell; showToast('Нажмите целевую ячейку'); return renderCellOverlay(store.getState()); }
  if (command === 'remove') {
    const id = store.getState().layout.order[selectedCell];
    selectedCell = -1;
    if (id) store.dispatch(actions.removePlacement(id));
    return;
  }
  if (command === 'autofill') return autofill();
  if (command === 'preflight') return openPreflight();
}

/** @param {number} index */
function handleCellClick(index) {
  if (!store) return;
  const state = store.getState();
  if (moveFrom >= 0) {
    store.dispatch(actions.movePlacement(moveFrom, index));
    moveFrom = -1;
    selectedCell = index;
    return;
  }
  if (!state.layout.order[index] && pendingSourceId) {
    store.dispatch(actions.addPlacement({id: createPlacementId(), sourceId: pendingSourceId, cellIndex: index}));
    sessionPlacementCursor.delete(pendingSourceId);
    selectedCell = index;
    renderSessionTray(store.getState());
    return;
  }
  selectedCell = index;
  renderCellOverlay(state);
  renderSessionTray(state);
}

/** @param {string} path */
async function selectSource(path) {
  if (!store) return;
  const entry = visibleSourceEntries.find(item => item.path === path);
  if (!entry) return;
  let source = Object.values(store.getState().sources).find(item => item.path === path);
  if (!source) {
    sourcePreviewStates.set(path, 'loading');
    renderSourceGrid();
    try {
      source = await preparePhotoSource(entry);
      store.dispatch(actions.registerSources([source]));
      sourcePreviewStates.set(path, 'ready');
    } catch (error) {
      sourcePreviewStates.set(path, 'error');
      renderSourceGrid();
      return showToast(error instanceof Error ? error.message : 'Фотография недоступна');
    }
    renderSourceGrid();
  }
  sessionSourceIds.add(source.id);
  pendingSourceId = source.id;
  dialog.querySelectorAll('[data-source-path]').forEach(button => button.classList.toggle('is-selected', button.getAttribute('data-source-path') === path));
  showToast('Теперь выберите пустую ячейку');
  renderCellOverlay(store.getState());
  renderSessionTray(store.getState());
}

/** @param {string} sourceId */
function selectSessionSource(sourceId) {
  if (!store || !sessionSourceIds.has(sourceId)) return;
  const state = store.getState();
  const placementIndexes = state.layout.order.flatMap((placementId, index) => {
    const placement = placementId ? state.placements[placementId] : null;
    return placement?.sourceId === sourceId ? [index] : [];
  });
  if (placementIndexes.length) {
    const cursor = sessionPlacementCursor.get(sourceId) || 0;
    selectedCell = placementIndexes[cursor % placementIndexes.length];
    sessionPlacementCursor.set(sourceId, cursor + 1);
    // A placed tray photo stays armed: an empty-cell click adds it again.
    pendingSourceId = sourceId;
    if (state.layout.order.some(placementId => !placementId)) showToast('Нажмите пустую ячейку, чтобы добавить фото ещё раз');
    renderCellOverlay(state);
    renderSessionTray(state);
    return;
  }
  pendingSourceId = sourceId;
  selectedCell = -1;
  showToast('Теперь выберите пустую ячейку');
  renderCellOverlay(state);
  renderSessionTray(state);
}

/** @param {number} delta */
function changePhotoCount(delta) {
  if (!store) return;
  const count = getTemplate(store.getState().layout.templateId).photoCount;
  const next = Math.max(2, Math.min(12, count + delta));
  if (next !== count) store.dispatch(actions.setTemplate(getDefaultTemplate(next).id));
}

function autofill() {
  if (!store) return;
  const state = store.getState();
  const sources = Object.values(state.sources);
  if (!sources.length) return showToast('Сначала добавьте фотографии');
  store.dispatch(actions.autofill(state.layout.order.map((_, index) => ({id: createPlacementId(), sourceId: sources[index % sources.length].id}))));
}

function openCropEditor() {
  if (!store || selectedCell < 0) return;
  const state = store.getState();
  const id = state.layout.order[selectedCell];
  const placement = id && state.placements[id];
  const source = placement && state.sources[placement.sourceId];
  if (!placement || !source) return;
  let draft = {...placement.crop};
  let mode = placement.cropMode;
  let rotation = normalizePhotoRotation(placement.rotation);
  const image = /** @type {HTMLImageElement} */ (cropDialog.querySelector('img'));
  const box = /** @type {HTMLElement} */ (cropDialog.querySelector('.collage-crop-image-box'));
  const frame = /** @type {HTMLElement} */ (cropDialog.querySelector('.collage-crop-frame'));
  const stage = /** @type {HTMLElement} */ (cropDialog.querySelector('.collage-crop-stage'));
    image.src = runtimeSourceUrl(source);
  const rotatedDimensions = () => rotatedSourceDimensions(source.width, source.height, rotation);
  const applyImageRotation = () => {
    const dimensions = rotatedDimensions();
    box.style.aspectRatio = `${dimensions.width} / ${dimensions.height}`;
    box.dataset.rotation = String(rotation);
    image.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
    const sideways = rotation === 90 || rotation === 270;
    image.style.width = sideways ? `${box.clientHeight}px` : '100%';
    image.style.height = sideways ? `${box.clientWidth}px` : '100%';
  };
  let resizeFrame = 0;
  const fitImageBox = () => {
    const styles = getComputedStyle(stage);
    const horizontalPadding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
    const verticalPadding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
    const availableWidth = Math.max(1, stage.clientWidth - horizontalPadding);
    const availableHeight = Math.max(1, stage.clientHeight - verticalPadding);
    const dimensions = rotatedDimensions();
    const sourceAspect = dimensions.width / dimensions.height;
    const availableAspect = availableWidth / availableHeight;
    const width = sourceAspect >= availableAspect ? availableWidth : availableHeight * sourceAspect;
    const height = sourceAspect >= availableAspect ? availableWidth / sourceAspect : availableHeight;
    box.style.width = `${Math.floor(width)}px`;
    box.style.height = `${Math.floor(height)}px`;
    applyImageRotation();
  };
  const cropResizeObserver = new ResizeObserver(() => {
    window.cancelAnimationFrame(resizeFrame);
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0;
      fitImageBox();
      paint();
    });
  });
  cropDialog.querySelectorAll('[name="crop-mode"]').forEach(input => { if (input instanceof HTMLInputElement) input.checked = input.value === mode; });
  const paint = () => {
    Object.assign(frame.style, {left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.width * 100}%`, height: `${draft.height * 100}%`});
    const dimensions = getPrintDimensions(state.print.formatId, state.print.orientation, state.print.ppi, state.print.bleedMm);
    const cell = getTemplate(state.layout.templateId).cells[selectedCell];
    const pixels = rectToPixels(cell.rect, dimensions.widthPx, dimensions.heightPx);
    const rotated = rotatedDimensions();
    const ppi = effectiveCropPpi(draft, rotated.width, rotated.height, pixels.width, pixels.height, state.print.ppi);
    const distortion = cropDistortionPercent(draft, rotated.width, rotated.height, getCellAspect(state, selectedCell));
    const quality = cropDialog.querySelector('[data-crop-quality]');
    if (quality) quality.textContent = `${ppi} PPI · искажение ${distortion.toFixed(1)}%`;
  };
  /** @type {{x: number, y: number, crop: import('./types.js').CropRect, handle: string}|null} */
  let drag = null;
  frame.onpointerdown = event => {
    const handle = /** @type {HTMLElement} */ (event.target).closest('[data-crop-handle]')?.getAttribute('data-crop-handle') || '';
    drag = {x: event.clientX, y: event.clientY, crop: {...draft}, handle};
    frame.setPointerCapture(event.pointerId);
  };
  frame.onpointermove = event => {
    if (!drag) return;
    const dx = (event.clientX - drag.x) / box.clientWidth;
    const dy = (event.clientY - drag.y) / box.clientHeight;
    if (drag.handle) {
      const handle = drag.handle;
      const base = drag.crop;
      const dimensions = rotatedDimensions();
      const aspect = getCellAspect(state, selectedCell) / (dimensions.width / dimensions.height);
      if (mode === 'proportional') {
        const horizontalDelta = handle.includes('w') ? -dx : handle.includes('e') ? dx : 0;
        const verticalDelta = handle.includes('n') ? -dy : handle.includes('s') ? dy : 0;
        const width = horizontalDelta ? base.width + horizontalDelta : base.width + verticalDelta * aspect;
        const height = width / aspect;
        const x = handle.includes('w') ? base.x + base.width - width : handle.includes('e') ? base.x : base.x + (base.width - width) / 2;
        const y = handle.includes('n') ? base.y + base.height - height : handle.includes('s') ? base.y : base.y + (base.height - height) / 2;
        draft = clampCrop({x, y, width, height});
      } else {
        let left = base.x;
        let right = base.x + base.width;
        let top = base.y;
        let bottom = base.y + base.height;
        if (handle.includes('w')) left += dx;
        if (handle.includes('e')) right += dx;
        if (handle.includes('n')) top += dy;
        if (handle.includes('s')) bottom += dy;
        if (right - left < .01) handle.includes('w') ? left = right - .01 : right = left + .01;
        if (bottom - top < .01) handle.includes('n') ? top = bottom - .01 : bottom = top + .01;
        draft = clampCrop({x: left, y: top, width: right - left, height: bottom - top});
      }
    } else {
      draft = {...drag.crop, x: Math.max(0, Math.min(1 - drag.crop.width, drag.crop.x + dx)), y: Math.max(0, Math.min(1 - drag.crop.height, drag.crop.y + dy))};
    }
    paint();
  };
  frame.onpointerup = () => { drag = null; };
  cropDialog.onchange = event => {
    if (!(event.target instanceof HTMLInputElement) || event.target.name !== 'crop-mode') return;
    const nextMode = /** @type {import('./types.js').CropMode} */ (event.target.value);
    if (mode === 'free' && nextMode === 'proportional') {
      const dimensions = rotatedDimensions();
      draft = refitCropAroundCenter(draft, dimensions.width, dimensions.height, getCellAspect(state, selectedCell));
    }
    mode = nextMode;
    paint();
  };
  stage.onkeydown = event => {
    if (event.key === '[' || event.key === ']') {
      event.preventDefault();
      rotateDraft(event.key === '[' ? -90 : 90);
      return;
    }
    const dimensions = rotatedDimensions();
    const next = cropFromKey(draft, event.key, {mode, aspectRatio: getCellAspect(state, selectedCell) / (dimensions.width / dimensions.height)});
    if (JSON.stringify(next) !== JSON.stringify(draft)) { event.preventDefault(); draft = next; paint(); }
  };
  cropDialog.onclick = event => {
    const action = /** @type {HTMLElement} */ (event.target).closest('[data-crop-action]')?.getAttribute('data-crop-action');
    if (action === 'reset') {
      rotation = 0;
      draft = centeredCrop(source.width, source.height, getCellAspect(state, selectedCell));
      fitImageBox();
    }
    if (action === 'center') draft = centreCrop(draft);
    if (action === 'rotate-left') rotateDraft(-90);
    if (action === 'rotate-right') rotateDraft(90);
    const dimensions = rotatedDimensions();
    if (action === 'plus') draft = resizeCrop(draft, {width: draft.width - .03, height: draft.height - .03, mode, aspectRatio: getCellAspect(state, selectedCell) / (dimensions.width / dimensions.height)});
    if (action === 'minus') draft = resizeCrop(draft, {width: draft.width + .03, height: draft.height + .03, mode, aspectRatio: getCellAspect(state, selectedCell) / (dimensions.width / dimensions.height)});
    if (action === 'done') { store?.dispatch(actions.setCrop(placement.id, draft, mode, rotation)); cropDialog.close(); }
    paint();
  };
  /** @param {number} delta */
  const rotateDraft = (delta) => {
    rotation = normalizePhotoRotation((rotation + delta + 360) % 360);
    const dimensions = rotatedDimensions();
    draft = mode === 'proportional'
      ? centeredCrop(dimensions.width, dimensions.height, getCellAspect(state, selectedCell))
      : centreCrop(draft);
    fitImageBox();
    paint();
  };
  cropDialog.showModal();
  fitImageBox();
  paint();
  cropResizeObserver.observe(stage);
  cropDialog.addEventListener('close', () => {
    cropResizeObserver.disconnect();
    window.cancelAnimationFrame(resizeFrame);
  }, {once: true});
  stage.focus();
}

async function openPreflight() {
  if (!store) return;
  const state = store.getState();
  const availability = await Promise.all(Object.values(state.sources).map(async source => {
    if (source.available === true && typeof source.sourceUrl === 'string') return [source.id, {width: source.width, height: source.height, available: true}];
    const response = await fetch(collageApiUrl('/api/media', source.path), {method: 'HEAD', credentials: 'same-origin'}).catch(() => null);
    return [source.id, {width: source.width, height: source.height, available: Boolean(response?.ok)}];
  }));
  const result = runPreflight(toRenderProject(state, false, 0), toPrintSettings(state), Object.fromEntries(availability), ignoredIssues);
  const content = /** @type {HTMLElement|null} */ (preflightDialog.querySelector('[data-preflight-content]'));
  if (!content) return;
  const active = result.issues.filter(issue => !issue.ignored);
  /** @param {ReturnType<typeof runPreflight>['issues'][number]} issue @param {boolean} ignored */
  const row = (issue, ignored) => `<li class="${issue.severity}"><span>${escapeHtml(issue.message)}</span><button type="button" data-focus-cell="${escapeHtml(issue.cellId)}">Показать</button>${issue.kind === 'missing' && !ignored ? `<button type="button" data-fix-cell="${escapeHtml(issue.cellId)}">Исправить</button>` : ''}<button type="button" data-ignore-issue="${escapeHtml(issue.id)}">${ignored ? 'Вернуть' : 'Игнорировать'}</button></li>`;
  content.innerHTML = active.length || result.ignored.length
    ? `${active.length ? `<section><h3>Нужно проверить · ${active.length}</h3><ul class="collage-issue-list">${active.map(issue => row(issue, false)).join('')}</ul></section>` : '<div class="collage-all-good">✓ Активных замечаний нет</div>'}${result.ignored.length ? `<details class="collage-ignored" open><summary>Проигнорировано · ${result.ignored.length}</summary><ul class="collage-issue-list">${result.ignored.map(issue => row(issue, true)).join('')}</ul></details>` : ''}`
    : '<div class="collage-all-good">✓ Коллаж готов к печати</div>';
  content.onclick = event => {
    const target = /** @type {HTMLElement} */ (event.target);
    const issueId = target.closest('[data-ignore-issue]')?.getAttribute('data-ignore-issue');
    if (issueId) { ignoredIssues = setIssueIgnored(ignoredIssues, issueId, !ignoredIssues.includes(issueId)); openPreflight(); }
    const cellId = target.closest('[data-focus-cell]')?.getAttribute('data-focus-cell');
    if (cellId) { selectedCell = getTemplate(state.layout.templateId).cells.findIndex(cell => cell.id === cellId); preflightDialog.close(); renderCellOverlay(state); }
    const fixCellId = target.closest('[data-fix-cell]')?.getAttribute('data-fix-cell');
    if (fixCellId && store) {
      selectedCell = getTemplate(state.layout.templateId).cells.findIndex(cell => cell.id === fixCellId);
      const placementId = state.layout.order[selectedCell];
      if (placementId) store.dispatch(actions.removePlacement(placementId));
      preflightDialog.close();
      showMobilePanel('photos');
      showToast('Выберите фотографию для пустой ячейки');
    }
  };
  if (!preflightDialog.open) preflightDialog.showModal();
}

document.querySelectorAll('[data-modal-close]').forEach(button => button.addEventListener('click', () => /** @type {HTMLDialogElement} */ (button.closest('dialog')).close()));
document.querySelector('[data-command="open-export"]')?.addEventListener('click', () => { preflightDialog.close(); openExport(); });

function openExport() {
  if (!store) return;
  const state = store.getState();
  const formats = /** @type {HTMLSelectElement} */ (exportDialog.querySelector('[data-export-format]'));
  formats.innerHTML = PRINT_FORMATS.map(format => `<option value="${format.id}">${format.label}</option>`).join('');
  formats.value = state.print.formatId;
  setModalValue(exportDialog, '[data-export-orientation]', state.print.orientation);
  const bleed = /** @type {HTMLInputElement} */ (exportDialog.querySelector('[data-export-bleed]'));
  bleed.checked = state.print.bleedMm === 2;
  updatePpiOptions(state.print.ppi);
  updateExportSummary();
  exportDialog.showModal();
}

exportDialog.addEventListener('change', event => {
  if (!(event.target instanceof HTMLSelectElement) || !event.target.matches('[data-export-ppi]')) updatePpiOptions();
  updateExportSummary();
});
exportDialog.addEventListener('click', async event => {
  const command = /** @type {HTMLElement} */ (event.target).closest('[data-command]')?.getAttribute('data-command');
  if (command === 'cancel-export') exportAbort?.abort();
  if (command === 'retry-300') {
    setModalValue(exportDialog, '[data-export-ppi]', '300');
    updateExportSummary();
    return executeExport();
  }
  if (command === 'export') return executeExport();
});

async function executeExport() {
  if (!store) return;
  const print = readExportSettings();
  store.dispatch(actions.setPrint({formatId: print.formatId, orientation: print.orientation, ppi: print.ppi, bleedMm: print.bleedMm}));
  const state = store.getState();
  const physical = toPrintSettings(state);
  const lineWidth = state.appearance.gapMm / 25.4 * physical.ppi;
  const progress = /** @type {HTMLProgressElement} */ (exportDialog.querySelector('[data-export-progress]'));
  const status = /** @type {HTMLElement} */ (exportDialog.querySelector('[data-export-status]'));
  const cancel = /** @type {HTMLButtonElement} */ (exportDialog.querySelector('[data-command="cancel-export"]'));
  progress.hidden = false; progress.value = 0; cancel.hidden = false; status.textContent = 'Подготавливаем фотографии…';
  exportAbort = new AbortController();
  try {
    let actualPpi = physical.ppi;
    const blob = await exportJpeg(toRenderProject(state, false, lineWidth), physical, {
      signal: exportAbort.signal,
      onProgress(completed, total) { progress.value = total ? completed / total : 0; status.textContent = `Обработано ${completed} из ${total}`; },
      onPpiFallback(_requested, actual) { actualPpi = actual; },
    });
    downloadBlob(blob, jpegFilename(state.title, {...state.print, ppi: actualPpi}));
    status.textContent = actualPpi === physical.ppi
      ? `Готово · ${formatDownloadSize(blob.size)}`
      : `Готово в ${actualPpi} PPI: для ${physical.ppi} PPI не хватает памяти · ${formatDownloadSize(blob.size)}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof DOMException && error.name === 'AbortError') {
      status.textContent = 'Скачивание отменено';
    } else if (physical.ppi > 300) {
      status.replaceChildren(`Не удалось собрать JPEG в ${physical.ppi} PPI: ${message}. `);
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.dataset.command = 'retry-300';
      retry.textContent = 'Повторить в 300 PPI';
      status.append(retry);
    } else {
      status.textContent = `Не удалось собрать JPEG: ${message}`;
    }
  } finally {
    cancel.hidden = true;
    exportAbort = null;
  }
}

function readExportSettings() {
  return {
    formatId: /** @type {HTMLSelectElement} */ (exportDialog.querySelector('[data-export-format]')).value,
    orientation: /** @type {any} */ (/** @type {HTMLSelectElement} */ (exportDialog.querySelector('[data-export-orientation]')).value),
    ppi: Number(/** @type {HTMLSelectElement} */ (exportDialog.querySelector('[data-export-ppi]')).value),
    bleedMm: /** @type {HTMLInputElement} */ (exportDialog.querySelector('[data-export-bleed]')).checked ? /** @type {const} */ (2) : /** @type {const} */ (0),
  };
}

function updateExportSummary() {
  const settings = readExportSettings();
  const dimensions = getPrintDimensions(settings.formatId, settings.orientation, settings.ppi, settings.bleedMm);
  const estimatedBytes = dimensions.widthPx * dimensions.heightPx * .18;
  let weakest = '—';
  if (store) {
    const state = store.getState();
    const preflight = runPreflight(toRenderProject(state, false, 0), {widthMm: dimensions.trimWidthMm, heightMm: dimensions.trimHeightMm, ppi: settings.ppi, bleedMm: settings.bleedMm}, Object.fromEntries(Object.values(state.sources).map(source => [source.id, {width: source.width, height: source.height, available: true}])));
    weakest = preflight.weakestPpi ? `${Math.round(preflight.weakestPpi)} PPI` : '—';
  }
  const summary = exportDialog.querySelector('[data-export-summary]');
  if (summary) summary.innerHTML = `<strong>${dimensions.outputWidthMm / 10} × ${dimensions.outputHeightMm / 10} см</strong><span>${dimensions.widthPx} × ${dimensions.heightPx} px</span><span>${settings.ppi} PPI</span><span>≈ ${formatDownloadSize(estimatedBytes)}</span><span class="collage-export-weakest">Слабый кадр: ${weakest}</span><span class="collage-export-bleed-state">${settings.bleedMm ? 'Запас 2 мм' : 'Без запаса'}</span>`;
  const canvasWarning = /** @type {HTMLElement|null} */ (exportDialog.querySelector('[data-export-canvas-warning]'));
  if (canvasWarning) canvasWarning.hidden = !exceedsSafeCanvas(dimensions.widthPx, dimensions.heightPx);
  if (store) setModalText(exportDialog, '[data-export-filename]', jpegFilename(store.getState().title, settings));
}

function openSaveDialog() {
  if (!store) return;
  const kind = /** @type {HTMLSelectElement} */ (dialog.querySelector('[data-save-kind]')).value;
  setModalText(saveDialog, '[data-project-filename]', projectFilename(store.getState().title, kind));
  saveDialog.showModal();
}

saveDialog.addEventListener('click', async event => {
  const target = /** @type {HTMLElement} */ (event.target);
  if (target.closest('[data-save-close]')) return saveDialog.close();
  if (!target.closest('[data-command="confirm-save-project"]')) return;
  const kind = /** @type {HTMLSelectElement} */ (dialog.querySelector('[data-save-kind]')).value;
  if (await saveProject(kind)) saveDialog.close();
});

/** @param {number=} preferred */
function updatePpiOptions(preferred) {
  if (!store) return;
  const formatId = /** @type {HTMLSelectElement} */ (exportDialog.querySelector('[data-export-format]')).value;
  const orientation = /** @type {any} */ (/** @type {HTMLSelectElement} */ (exportDialog.querySelector('[data-export-orientation]')).value);
  const bleedMm = /** @type {HTMLInputElement} */ (exportDialog.querySelector('[data-export-bleed]')).checked ? 2 : 0;
  const recommended = highestSafePpi(store.getState(), formatId, orientation, bleedMm);
  const select = /** @type {HTMLSelectElement} */ (exportDialog.querySelector('[data-export-ppi]'));
  const values = [300, ...(recommended > 300 ? [recommended] : [])];
  select.innerHTML = values.map(ppi => `<option value="${ppi}">${ppi} PPI · ${ppi === recommended && ppi > 300 ? 'лучшее доступное качество' : 'для печати'}</option>`).join('');
  const requested = preferred ?? recommended;
  select.value = values.includes(requested) ? String(requested) : String(recommended);
}

/** @param {ProjectState} state @param {string} formatId @param {'portrait'|'landscape'} orientation @param {number} bleedMm */
function highestSafePpi(state, formatId, orientation, bleedMm) {
  const format = getPrintFormat(formatId);
  const widthMm = orientation === 'portrait' ? format.widthMm : format.heightMm;
  const heightMm = orientation === 'portrait' ? format.heightMm : format.widthMm;
  const template = getTemplate(state.layout.templateId);
  let sourceLimit = Infinity;
  state.layout.order.forEach((placementId, index) => {
    if (!placementId) return;
    const placement = state.placements[placementId];
    const source = placement && state.sources[placement.sourceId];
    const cell = template.cells[index];
    if (!placement || !source || !cell) return;
    const dimensions = rotatedSourceDimensions(source.width, source.height, placement.rotation);
    const horizontal = dimensions.width * placement.crop.width / (widthMm * cell.rect.width / 25.4);
    const vertical = dimensions.height * placement.crop.height / (heightMm * cell.rect.height / 25.4);
    sourceLimit = Math.min(sourceLimit, horizontal, vertical);
  });
  const memoryLimit = maxPpiForMemory(formatId, orientation, bleedMm);
  const raw = Math.min(Number.isFinite(sourceLimit) ? sourceLimit : 300, memoryLimit, 600);
  return Math.max(300, Math.floor(raw / 25) * 25);
}

/** @param {string} kind */
async function saveProject(kind) {
  if (!store) return false;
  const state = store.getState();
  const savedProject = serializableProject(state);
  savedProject.appVersion = appVersion;
  const document = createProjectDocument(savedProject, appVersion);
  try {
    if (kind === 'zip') {
      const sources = Object.keys(savedProject.sources).map(sourceId => state.sources[sourceId]).filter(Boolean);
      /** @type {Array<{sourceId: string, name: string, blob: Blob}>} */
      const photos = [];
      for (let index = 0; index < sources.length; index++) {
        const source = sources[index];
        showToast(`Добавляем фотографии в ZIP · ${index + 1} из ${sources.length}`);
        const url = typeof source.sourceUrl === 'string' ? source.sourceUrl : collageApiUrl('/api/media', source.path);
        const response = await fetch(url, {credentials: 'same-origin'});
        if (!response.ok) throw new Error(`Не удалось загрузить ${source.name}`);
        photos.push({sourceId: source.id, name: source.name, blob: await response.blob()});
      }
      const blob = await projectZipBlob(document, photos);
      downloadBlob(blob, projectFilename(state.title, 'zip'));
      showToast(`Проект сохранён · ${formatDownloadSize(blob.size)}`);
    } else {
      const blob = projectJsonBlob(document);
      downloadBlob(blob, projectFilename(state.title, 'json'));
      showToast(`Проект сохранён · ${formatDownloadSize(blob.size)}`);
    }
    dirty = false;
    updateSaveSizes(state);
    return true;
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Не удалось сохранить проект');
    return false;
  }
}

projectInput.addEventListener('change', async () => {
  const file = projectInput.files?.[0];
  projectInput.value = '';
  if (!file) return;
  const openedFromGallery = !store;
  try {
    let project;
    /** @type {Map<string, {entryName: string, blob: Blob}>} */
    let embedded = new Map();
    const isZip = file.type === 'application/zip' || file.name.toLowerCase().endsWith('.zip');
    if (isZip) {
      const archive = await readProjectZip(file);
      project = archive.project;
      embedded = archive.photosBySource;
    } else {
      const result = await readProjectBlob(file);
      if (!result.ok) throw new Error(result.message);
      project = result.project;
    }
    assertProject(project);
    if (!store) openImportedProjectEditor(project);
    const activeStore = store;
    if (!activeStore) throw new Error('Редактор проекта недоступен');
    /** @type {ProjectState} */
    const hydrated = structuredClone(project);
    /** @type {string[]} */
    const nextUrls = [];
    for (const [sourceId, photo] of embedded) {
      const source = hydrated.sources[sourceId];
      if (!source) continue;
      const url = URL.createObjectURL(photo.blob);
      nextUrls.push(url);
      hydrated.sources[sourceId] = {...source, size: photo.blob.size, sourceUrl: url, available: true};
    }
    revokeEmbeddedPhotos();
    nextUrls.forEach(url => embeddedObjectUrls.add(url));
    activeStore.dispatch(actions.replaceProject(hydrated));
    dirty = false;
    sessionSourceIds = new Set(Object.keys(hydrated.sources));
    sessionPlacementCursor.clear();
    pendingSourceId = '';
    selectedCell = -1;
    renderSessionTray(hydrated);
    showToast(isZip ? `ZIP-проект загружен · ${embedded.size} ${photoWord(embedded.size)}` : 'Проект загружен');
    if (openedFromGallery) window.dispatchEvent(new CustomEvent('litegallery:project-loaded'));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось загрузить проект';
    if (openedFromGallery) window.dispatchEvent(new CustomEvent('litegallery:project-load-error', {detail: {message}}));
    else showToast(message);
  }
});

/** @param {ProjectState} project */
function openImportedProjectEditor(project) {
  openingRevision += 1;
  revokeEmbeddedPhotos();
  const photoCount = getTemplate(project.layout.templateId).photoCount;
  store = createCollageStore(createProject({appVersion, photoCount}));
  store.subscribe(() => { dirty = editorReady; renderEditor(); });
  openingBarrier = null;
  sourcePreviewStates.clear();
  visibleSourceEntries = [];
  sessionSourceIds = new Set();
  sessionPlacementCursor.clear();
  galleryPanelOpen = true;
  sessionPanelOpen = true;
  templatePanelOpen = false;
  canvasFocusOpen = false;
  canvasZoomOpen = false;
  resetCanvasView();
  selectedCell = -1;
  pendingSourceId = '';
  moveFrom = -1;
  ignoredIssues = [];
  setEditorReady(true);
  renderSourceAccordions();
  renderTemplateAccordion();
  renderCanvasFocus();
  renderCanvasZoom();
  dialog.showModal();
  renderEditor();
  renderSourceGrid();
  renderSessionTray();
}

/** @param {ProjectState} state */
function updateSaveSizes(state) {
  const savedProject = serializableProject(state);
  savedProject.appVersion = appVersion;
  const document = createProjectDocument(savedProject, appVersion);
  const jsonBytes = new Blob([JSON.stringify(document)]).size;
  const uniqueSources = Object.values(savedProject.sources);
  const photoBytes = uniqueSources.reduce((sum, source) => sum + source.size, 0);
  const select = /** @type {HTMLSelectElement} */ (dialog.querySelector('[data-save-kind]'));
  select.options[0].textContent = `JSON · ${formatDownloadSize(jsonBytes)}`;
  select.options[1].textContent = `ZIP с фото · ≈ ${formatDownloadSize(jsonBytes + photoBytes)}`;
  const exitSelect = /** @type {HTMLSelectElement} */ (exitDialog.querySelector('[data-exit-save-kind]'));
  exitSelect.options[0].textContent = select.options[0].textContent;
  exitSelect.options[1].textContent = select.options[1].textContent;
  const size = exitDialog.querySelector('[data-exit-size]');
  if (size) size.textContent = exitSelect.value === 'zip' ? `${uniqueSources.length} ${photoWord(uniqueSources.length)} + JSON · ≈ ${formatDownloadSize(jsonBytes + photoBytes)}` : `JSON-разметка · ${formatDownloadSize(jsonBytes)}`;
  setModalText(exitDialog, '[data-exit-filename]', projectFilename(state.title, exitSelect.value));
}

function requestClose() {
  if (!dirty) return closeEditor();
  pendingExitAction = 'close';
  configureExitDialog();
  if (store) updateSaveSizes(store.getState());
  exitDialog.showModal();
}

function requestProjectLoad() {
  if (!dirty) return openProjectPicker();
  pendingExitAction = 'load';
  configureExitDialog();
  if (store) updateSaveSizes(store.getState());
  exitDialog.showModal();
}

function configureExitDialog() {
  const loading = pendingExitAction === 'load';
  setModalText(exitDialog, '[data-exit-heading]', loading ? 'Открыть другой проект?' : 'Сохранить изменения?');
  setModalText(exitDialog, '[data-exit-message]', loading ? 'Текущий проект содержит несохранённые изменения.' : 'В проекте есть несохранённые изменения.');
  setModalText(exitDialog, '[data-exit="discard"]', loading ? 'Открыть без сохранения' : 'Выйти без сохранения');
  setModalText(exitDialog, '[data-exit="save"]', loading ? 'Сохранить и открыть' : 'Сохранить и выйти');
}

function openProjectPicker() {
  projectInput.value = '';
  projectInput.click();
}

function finishPendingExitAction() {
  exitDialog.close();
  if (pendingExitAction === 'load') openProjectPicker();
  else closeEditor();
}

exitDialog.addEventListener('change', () => { if (store) updateSaveSizes(store.getState()); });
exitDialog.addEventListener('click', async event => {
  const action = /** @type {HTMLElement} */ (event.target).closest('[data-exit]')?.getAttribute('data-exit');
  if (action === 'stay') exitDialog.close();
  if (action === 'discard') finishPendingExitAction();
  if (action === 'save') {
    const saved = await saveProject(/** @type {HTMLSelectElement} */ (exitDialog.querySelector('[data-exit-save-kind]')).value);
    if (saved) finishPendingExitAction();
  }
});

function closeEditor() {
  openingRevision += 1;
  openingBarrier = null;
  editorReady = false;
  sourcePreviewStates.clear();
  sessionSourceIds.clear();
  sessionPlacementCursor.clear();
  templatePanelOpen = false;
  canvasFocusOpen = false;
  canvasZoomOpen = false;
  resetCanvasView();
  previewBusy.hidden = true;
  previewError.hidden = true;
  tree.clear();
  revokeEmbeddedPhotos();
  store = null;
  dirty = false;
  dialog.close();
}

/** @param {ProjectState} state */
function serializableProject(state) {
  const project = structuredClone(state);
  const activePlacementIds = new Set(project.layout.order.filter(Boolean));
  for (const placementId of Object.keys(project.placements)) {
    if (!activePlacementIds.has(placementId)) delete project.placements[placementId];
  }
  const referencedSourceIds = new Set(Object.values(project.placements).map(placement => placement.sourceId));
  for (const sourceId of Object.keys(project.sources)) {
    if (!referencedSourceIds.has(sourceId)) delete project.sources[sourceId];
  }
  for (const source of Object.values(project.sources)) {
    delete source.sourceUrl;
    delete source.available;
  }
  return project;
}

function revokeEmbeddedPhotos() {
  for (const url of embeddedObjectUrls) URL.revokeObjectURL(url);
  embeddedObjectUrls.clear();
}

/** @param {string} panel */
function showMobilePanel(panel) {
  dialog.dataset.mobilePanel = panel;
  dialog.querySelectorAll('[data-show-panel]').forEach(button => button.setAttribute('aria-pressed', String(button.getAttribute('data-show-panel') === panel)));
}

window.addEventListener('keydown', event => {
  if (!dialog.open || !editorReady || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
  event.preventDefault();
  if (event.shiftKey) store?.redo();
  else store?.undo();
});

/** @param {string} message @param {boolean} [offerUndo] */
function showToast(message, offerUndo = false) {
  const toast = /** @type {HTMLElement} */ (dialog.querySelector('[data-toast]'));
  toast.replaceChildren(document.createTextNode(message));
  if (offerUndo && store?.canUndo()) {
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.textContent = 'Отменить';
    undo.addEventListener('click', () => { store?.undo(); toast.hidden = true; });
    toast.append(undo);
  }
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3500);
}

/** @param {string} selector @param {string} value */
function setText(selector, value) { const element = dialog.querySelector(selector); if (element) element.textContent = value; }
/** @param {string} selector @param {string} value */
function setInput(selector, value) { const element = dialog.querySelector(selector); if (element instanceof HTMLInputElement) element.value = value; }
/** @param {ParentNode} root @param {string} selector @param {string} value */
function setModalValue(root, selector, value) { const element = root.querySelector(selector); if (element instanceof HTMLSelectElement || element instanceof HTMLInputElement) element.value = value; }
/** @param {ParentNode} root @param {string} selector @param {string} value */
function setModalText(root, selector, value) { const element = root.querySelector(selector); if (element) element.textContent = value; }
/** @param {unknown} value */
function escapeHtml(value) { const span = document.createElement('span'); span.textContent = String(value); return span.innerHTML; }
/** @param {number} count */
function photoWord(count) { const last = count % 10; const lastTwo = count % 100; return last === 1 && lastTwo !== 11 ? 'фотография' : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'фотографии' : 'фотографий'; }
