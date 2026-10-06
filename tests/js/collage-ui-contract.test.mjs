import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const editorUrl = new URL('../../web/collage/editor.js', import.meta.url);
const cssUrl = new URL('../../web/collage.css', import.meta.url);
const indexUrl = new URL('../../web/index.html', import.meta.url);
const appUrl = new URL('../../web/app.js', import.meta.url);

test('editor exposes two settings-panel transforms, no thumbnail overlay, and the concise download label', async () => {
  const source = await readFile(editorUrl, 'utf8');
  assert.match(source, /data-template-transform="x"[^>]*>↔ Слева \/ справа</);
  assert.match(source, /data-template-transform="y"[^>]*>↕ Сверху \/ снизу</);
  assert.doesNotMatch(source, /data-mirror-template|collage-template-mirror/);
  assert.match(source, /data-command="preflight">Скачать коллаж</);

  const count = source.indexOf('data-photo-count');
  const transforms = source.indexOf('collage-template-transforms');
  const print = source.indexOf('collage-print-settings');
  assert.ok(count >= 0 && count < transforms && transforms < print, 'transform buttons must sit between photo count and print format');
});

test('frame thickness keeps the gap control contract under its new label', async () => {
  const source = await readFile(editorUrl, 'utf8');
  assert.match(source, /<label>Толщина рамки <output data-gap-value><\/output><input[^>]*data-gap><\/label>/);
  assert.doesNotMatch(source, /Линии между фото/);
});

test('crop editor exposes clockwise and counter-clockwise 90 degree rotation controls', async () => {
  const source = await readFile(editorUrl, 'utf8');
  assert.match(source, /data-crop-action="rotate-left"[^>]*aria-label="Повернуть фотографию на 90 градусов влево"[^>]*>↶ 90°</);
  assert.match(source, /data-crop-action="rotate-right"[^>]*aria-label="Повернуть фотографию на 90 градусов вправо"[^>]*>↷ 90°</);
  assert.match(source, /event\.key === '\['/);
  assert.match(source, /event\.key === '\]'/);
});

test('folder tree owns explicit closed and expanded markers', async () => {
  const css = await readFile(cssUrl, 'utf8');
  assert.match(css, /\.collage-tree-branch summary::before\s*\{[^}]*content:\s*'>'/s);
  assert.match(css, /\.collage-tree-branch\[open\]\s*>\s*summary::before\s*\{[^}]*content:\s*'⌄'/s);
  assert.match(css, /summary::-webkit-details-marker\s*\{[^}]*display:\s*none/s);
});

test('full originals feed the canvas while gallery and session tiles remain thumbnails', async () => {
  const source = await readFile(editorUrl, 'utf8');
  assert.match(source, /collageApiUrl\('\/api\/media', source\.path\)/, 'preview must use original media');
  const thumbnailUses = source.match(/collageApiUrl\('\/api\/thumb'/g) || [];
  assert.ok(thumbnailUses.length >= 2, 'gallery and session tiles must retain lightweight thumbnails');
});

test('focus workspace exposes a collapsed template accordion, icon-only canvas focus, and large source preview', async () => {
  const source = await readFile(editorUrl, 'utf8');
  const css = await readFile(cssUrl, 'utf8');
  assert.match(source, /data-template-accordion[^>]*data-collapsed="true"/);
  assert.match(source, /data-template-accordion-toggle[^>]*aria-expanded="false"/);
  assert.match(source, /data-command="toggle-canvas-focus"[^>]*>⛶<\/button>/);
  assert.match(source, /data-command="toggle-canvas-zoom"/);
  assert.match(source, /data-canvas-zoom-value>100%/);
  assert.match(source, /data-photo-preview-dialog/);
  assert.match(source, /data-photo-preview-zoom[^>]*aria-pressed="false"/);
  assert.match(source, /data-photo-preview-zoom-value>100%/);
  assert.match(source, /data-source-preview-path/);
  assert.match(css, /data-canvas-focus="true"/);
  assert.match(css, /data-canvas-zoom="true"/);
  assert.match(css, /collage-photo-preview\[data-zoom="true"\]/);
});

test('selection bar opens JSON or ZIP projects through the shared validated input', async () => {
  const index = await readFile(indexUrl, 'utf8');
  const app = await readFile(appUrl, 'utf8');
  const editor = await readFile(editorUrl, 'utf8');
  assert.match(index, /id="collageProjectOpen"[^>]*>Открыть проект<\/button>/);
  assert.match(index, /id="collageProjectInput"[^>]*accept="application\/json,application\/zip,.json,.zip"/);
  assert.match(app, /collageProjectOpen\.addEventListener\('click'/);
  assert.match(editor, /readProjectZip\(file\)/);
  assert.match(editor, /readProjectBlob\(file\)/);
  assert.match(editor, /assertProject\(project\);/);
});

test('collage selection keeps accessible labels and rejects TIFF explicitly', async () => {
  const app = await readFile(appUrl, 'utf8');
  assert.match(app, /COLLAGE_UNSUPPORTED_EXTENSIONS = new Set\(\['\.tif', '\.tiff'\]\)/);
  assert.match(app, /TIFF пока недоступен для коллажа/);
  assert.match(app, /if \(supported\) \{[\s\S]*aria-pressed[\s\S]*aria-label[\s\S]*\} else \{/);
  assert.doesNotMatch(app, /\}\n\s*card\.setAttribute\('aria-label', `Открыть \$\{item\.name\}`\);\n\s*if \(item\.kind === 'image'\)/);
  assert.match(app, /function resetCollageSelectionHint\(\)[\s\S]*COLLAGE_SELECTION_DEFAULT_HINT/);
  assert.match(app, /function toggleCollagePhoto\([^)]*\) \{\s*resetCollageSelectionHint\(\);/);
});

test('runtime version is loaded from the server and written into saved project documents', async () => {
  const source = await readFile(editorUrl, 'utf8');
  assert.match(source, /fetch\('\/api\/config'/);
  assert.match(source, /createProject\(\{appVersion, photoCount\}\)/);
  assert.match(source, /createProjectDocument\(savedProject, appVersion\)/);
  assert.doesNotMatch(source, /createProjectDocument\(savedProject, 'dev'\)/);
});

test('opening another project protects dirty work before showing the file picker', async () => {
  const source = await readFile(editorUrl, 'utf8');
  assert.match(source, /if \(command === 'load-project'\) return requestProjectLoad\(\)/);
  assert.match(source, /function requestProjectLoad\(\) \{\s*if \(!dirty\) return openProjectPicker\(\);/);
  assert.match(source, /pendingExitAction = 'load'/);
  assert.match(source, /Открыть без сохранения/);
  assert.match(source, /Сохранить и открыть/);
});

test('collage name lives in the toolbar and filenames appear only in save and export dialogs', async () => {
  const source = await readFile(editorUrl, 'utf8');
  assert.match(source, /class="collage-project-name"[^>]*data-project-name[^>]*aria-label="Название коллажа"/);
  assert.doesNotMatch(source, />Название</);
  assert.match(source, /data-save-dialog/);
  assert.match(source, /data-project-filename/);
  assert.match(source, /data-export-filename/);
  assert.match(source, /projectFilename\(state\.title/);
  assert.match(source, /jpegFilename\(state\.title/);
});

test('JPEG export keeps the bleed checkbox attached and reserves room for quality text', async () => {
  const source = await readFile(editorUrl, 'utf8');
  const css = await readFile(cssUrl, 'utf8');
  assert.match(source, /class="collage-export-bleed"[^>]*><input[^>]*data-export-bleed>\s*<span>Запас под обрезку 2 мм<\/span>/);
  assert.match(source, /class="collage-export-weakest">Слабый кадр:/);
  assert.match(css, /\.collage-export-form > \.collage-export-bleed\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/s);
  assert.match(css, /\.collage-export-weakest, \.collage-export-bleed-state\s*\{[^}]*grid-column:\s*span 2;[^}]*white-space:\s*nowrap;/s);
});
