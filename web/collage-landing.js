const PROJECT_TYPES = new Set(['application/json', 'application/zip', 'application/x-zip-compressed']);

/**
 * A collage project file is recognised by its extension or MIME type; the
 * editor validates the contents.
 * @param {{name: string, type?: string}} file
 */
export function isProjectFile(file) {
  return /\.(json|zip)$/i.test(file.name) || PROJECT_TYPES.has(file.type ?? '');
}

/** @param {DragEvent} event */
const carriesFiles = event => [...(event.dataTransfer?.types ?? [])].includes('Files');

/**
 * Collage landing screen: `Создать коллаж` hands over to the gallery selection
 * flow, `Открыть проект` feeds the shared project input by click or by drop.
 * Files reach the editor only through that input, so loading stays in one place.
 * @param {{
 *   createCard: HTMLButtonElement,
 *   openCard: HTMLButtonElement,
 *   status: HTMLElement,
 *   projectInput: HTMLInputElement,
 *   onCreate: () => void,
 *   isActive: () => boolean,
 * }} options isActive is true while the landing is on screen and the editor is closed
 */
export function createCollageLanding({createCard, openCard, status, projectInput, onCreate, isActive}) {
  /** Card to focus when the editor closes. */
  let returnCard = createCard;
  let dragDepth = 0;

  /** @param {string} message */
  function showError(message) {
    status.textContent = message;
    status.hidden = !message;
  }

  /** @param {FileList} files */
  function openFiles(files) {
    if (!files.length) return;
    if (files.length > 1) return showError('Перетащите один файл проекта');
    const [file] = files;
    if (!isProjectFile(file)) return showError(`Файл «${file.name}» не является проектом коллажа. Подойдёт файл .json или .zip`);
    showError('');
    const transfer = new DataTransfer();
    transfer.items.add(file);
    projectInput.files = transfer.files;
    projectInput.dispatchEvent(new Event('change'));
  }

  /** @param {boolean} active */
  function setDropActive(active) {
    if (active) openCard.dataset.dropActive = 'true';
    else delete openCard.dataset.dropActive;
  }

  createCard.addEventListener('click', () => {
    returnCard = createCard;
    showError('');
    onCreate();
  });
  openCard.addEventListener('click', () => {
    returnCard = openCard;
    showError('');
    projectInput.value = '';
    projectInput.click();
  });

  openCard.addEventListener('dragenter', event => {
    if (!isActive() || !carriesFiles(event)) return;
    dragDepth += 1;
    setDropActive(true);
  });
  openCard.addEventListener('dragleave', event => {
    if (!carriesFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) setDropActive(false);
  });
  // Outside the card a dropped file is refused, so the browser does not open it either.
  document.addEventListener('dragover', event => {
    if (!isActive() || !carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = openCard.contains(/** @type {Node} */ (event.target)) ? 'copy' : 'none';
  });
  document.addEventListener('drop', event => {
    if (!isActive() || !carriesFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    setDropActive(false);
    if (!openCard.contains(/** @type {Node} */ (event.target))) return;
    returnCard = openCard;
    openFiles(event.dataTransfer?.files ?? new DataTransfer().files);
  });

  window.addEventListener('litegallery:project-loaded', () => showError(''));
  window.addEventListener('litegallery:project-load-error', event => {
    if (isActive()) showError(/** @type {CustomEvent} */ (event).detail?.message || 'Не удалось открыть проект');
  });

  return {
    /** Focus the card that led to the editor. */
    returnFocus() { returnCard.focus({preventScroll: true}); },
  };
}
