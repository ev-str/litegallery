import {expect} from '@playwright/test';
import {getPrintDimensions} from '../../web/collage/formats.js';

export const editor = page => page.locator('#collageEditor');

export function isDesktopBrowserProject(testInfo) {
  return testInfo.project.name.endsWith('-desktop');
}

export async function openAlbum(page, album = 'Album A') {
  await page.goto('/');
  await page.getByRole('button', {name: `Открыть папку ${album}`}).click();
  await expect(page.locator('#mediaGrid .media-card.image')).toHaveCount(album === 'Album A' ? 13 : 4);
}

export async function openCollageLanding(page) {
  await page.locator('#collageMode').click();
  await expect(page.locator('#collageSurface')).toBeVisible();
}

export async function enterSelectionMode(page) {
  await openCollageLanding(page);
  await page.locator('#collageCreate').click();
  await expect(page.locator('#collageSelection')).toBeVisible();
}

export async function selectPhotos(page, count, album = 'Album A') {
  for (let index = 1; index <= count; index += 1) {
    const name = `Photo ${String(index).padStart(2, '0')}.png`;
    await page.getByRole('button', {name: `Выбрать ${name} для коллажа`}).click();
  }
  await expect(page.locator('#collageSelectionCount')).toHaveText(String(count));
}

export async function startCollage(page, count = 2) {
  await openAlbum(page);
  await enterSelectionMode(page);
  await selectPhotos(page, count);
  const start = page.getByRole('button', {name: 'Сделать коллаж'});
  await start.evaluate(element => element.focus({preventScroll: true}));
  await start.press('Enter');
  await expect(editor(page)).toBeVisible();
  await expect(editor(page).locator('[data-cell-index]')).toHaveCount(count);
  await expect(editor(page).locator('[data-quality-summary]')).toContainText('300 PPI');
}

export async function openSourceFolder(page, name) {
  const panel = editor(page);
  await panel.locator('summary').filter({hasText: name}).click();
  await expect(panel.locator('[data-gallery-folder]')).toHaveText(name);
}

export async function selectedPrintAspect(page) {
  const formatId = await editor(page).locator('[data-print-format]').inputValue();
  const orientation = await editor(page).locator('[data-print-orientation]').inputValue();
  const dimensions = getPrintDimensions(formatId, /** @type {'portrait'|'landscape'} */ (orientation), 300);
  return dimensions.trimWidthMm / dimensions.trimHeightMm;
}

export async function openTemplateList(page) {
  const panel = editor(page);
  const list = panel.locator('[data-template-list]');
  if (await list.isHidden()) await panel.locator('[data-template-accordion-toggle]').click();
  await expect(list).toBeVisible();
}

export async function readDownload(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function saveJsonProject(page) {
  await editor(page).locator('[data-save-kind]').selectOption('json');
  const pending = page.waitForEvent('download');
  await editor(page).locator('[data-command="save-project"]').click();
  const saveDialog = page.locator('[data-save-dialog]');
  await expect(saveDialog).toBeVisible();
  await saveDialog.locator('[data-command="confirm-save-project"]').click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.json$/);
  return JSON.parse((await readDownload(download)).toString('utf8'));
}

export const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
export const directory = path => ({name: path.split('/').pop(), path, kind: 'directory', modTime: '2026-01-15T12:00:00Z'});
export const scrollTop = page => page.evaluate(() => Math.round(scrollY));

/** The `/api/list` answer for a folder. */
export const listing = (path, entries) => ({json: {path: path || '.', title: 'E2E Gallery', entries}});

/**
 * Synthetic `/api/list`. Every request is recorded as `path` or `path?recursive`;
 * `answer(key, path)` gives its fulfill options when it is sent, and requests
 * matching `hold` wait until released.
 */
export async function mockListings(page, answer) {
  /** @type {{requests: string[], held: {key: string, release: () => Promise<void>}[], hold: (key: string) => boolean}} */
  const library = {requests: [], held: [], hold: () => false};
  await page.route(url => url.pathname === '/api/list', route => {
    const params = new URL(route.request().url()).searchParams;
    const path = params.get('path') ?? '';
    const key = params.has('recursive') ? `${path}?recursive` : path;
    library.requests.push(key);
    const fulfill = () => route.fulfill(answer(key, path)).catch(() => {});
    if (library.hold(key)) {
      library.held.push({key, release: fulfill});
      return undefined;
    }
    return fulfill();
  });
  return library;
}

/** Media routes answer one PNG; `/api/image-info` answers a fixed size. */
export async function stubMedia(page, paths = ['/api/thumb', '/api/video-poster', '/api/cover', '/api/media', '/api/image-info']) {
  await page.route(url => paths.includes(url.pathname), route => {
    if (new URL(route.request().url()).pathname === '/api/image-info') return route.fulfill({json: {width: 640, height: 900}});
    return route.fulfill({contentType: 'image/png', body: ONE_PIXEL_PNG});
  });
}

/** Address, gallery controls, scroll and focused tile, to compare across surface switches. */
export const galleryView = page => page.evaluate(() => ({
  url: location.pathname + location.search,
  recursive: document.querySelector('#recursiveToggle')?.getAttribute('aria-pressed'),
  filter: document.querySelector('#mediaFilter [aria-pressed="true"]')?.getAttribute('data-filter'),
  sort: /** @type {HTMLSelectElement} */ (document.querySelector('#mediaSort')).value,
  direction: document.querySelector('#mediaDirection')?.getAttribute('aria-label'),
  group: /** @type {HTMLSelectElement} */ (document.querySelector('#mediaGroup')).value,
  columns: document.body.dataset.gridColumns,
  scroll: Math.round(scrollY),
  focus: document.activeElement?.getAttribute('data-path'),
}));

/**
 * Reach a control with real Tab presses. Safari's Tab skips buttons by default,
 * so WebKit falls back to focus after a key press, which it treats as keyboard
 * focus; Chromium and Firefox take the Tab path.
 */
export async function focusWithKeyboard(page, locator, {steps = 40, fallback = 'Shift'} = {}) {
  for (let step = 0; step < steps; step += 1) {
    if (await locator.evaluate(element => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await page.keyboard.press(fallback);
  await locator.focus();
}

/** Click a header control; on the phone the gallery controls sit in the ⋯ menu, opened first and closed after. */
export async function clickHeaderControl(page, selector) {
  const more = page.locator('#topbarMore');
  const folded = await more.isVisible() && !(await page.locator(selector).isVisible());
  if (folded) await more.click();
  await page.locator(selector).click();
  if (folded && await more.getAttribute('aria-expanded') === 'true') await more.click();
}
