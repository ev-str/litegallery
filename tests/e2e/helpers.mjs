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

export async function enterSelectionMode(page) {
  await page.locator('#collageMode').click();
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
  await page.getByRole('button', {name: 'Сделать коллаж'}).click();
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
