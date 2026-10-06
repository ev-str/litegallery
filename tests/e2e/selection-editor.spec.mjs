import {test, expect} from '@playwright/test';
import {editor, enterSelectionMode, isDesktopBrowserProject, openAlbum, saveJsonProject, selectPhotos, startCollage} from './helpers.mjs';
import {createProject} from '../../web/collage/model.js';
import {createProjectDocument} from '../../web/collage/project.js';
import {getVisibleTemplatesForCount} from '../../web/collage/templates.js';

test.beforeEach(async ({page}, testInfo) => {
  test.skip(!isDesktopBrowserProject(testInfo), 'Core flows run once per browser engine at desktop size.');
});

test('selection enforces 2..12 photos and opens matching templates', {tag: '@essential'}, async ({page}) => {
  await openAlbum(page);
  await enterSelectionMode(page);
  await expect(page.getByRole('button', {name: 'Сделать коллаж'})).toBeDisabled();
  await selectPhotos(page, 12);
  await expect(page.getByRole('button', {name: 'Сделать коллаж'})).toBeEnabled();
  await page.getByRole('button', {name: 'Выбрать Photo 13.png для коллажа'}).click();
  await expect(page.locator('#collageSelectionCount')).toHaveText('12');
  await page.getByRole('button', {name: 'Сделать коллаж'}).click();

  await expect(editor(page).locator('[data-photo-count]')).toHaveText('12');
  await expect(editor(page).locator('[data-template-id]')).toHaveCount(getVisibleTemplatesForCount(12).length);
  for (const thumbnail of await editor(page).locator('[data-template-id]').all()) {
    await expect(thumbnail.locator('i')).toHaveCount(12);
  }
});

test('selection bar opens a saved JSON project without selecting photos first', async ({page}) => {
  await openAlbum(page);
  await enterSelectionMode(page);
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', {name: 'Открыть проект'}).click();
  const chooser = await chooserPromise;
  const document = createProjectDocument(createProject({photoCount: 3}), 'test');
  await chooser.setFiles({name: 'project.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document))});
  await expect(editor(page)).toBeVisible();
  await expect(editor(page).locator('[data-cell-index]')).toHaveCount(3);
  await expect(editor(page).locator('[data-template-copy]')).toHaveText('Шаблоны для 3 фотографий');
  await expect(page.locator('#collageSelection')).toBeHidden();
});

test('template choices follow every photo count from 2 through 12', async ({page}) => {
  await startCollage(page, 2);
  const plus = editor(page).locator('[data-count="1"]');

  for (let count = 2; count <= 12; count += 1) {
    await expect(editor(page).locator('[data-photo-count]')).toHaveText(String(count));
    await expect(editor(page).locator('[data-template-id]')).toHaveCount(getVisibleTemplatesForCount(count).length);
    const thumbnails = await editor(page).locator('[data-template-id]').all();
    for (const thumbnail of thumbnails) await expect(thumbnail.locator('i')).toHaveCount(count);
    if (count < 12) await plus.click();
  }
  await plus.click();
  await expect(editor(page).locator('[data-photo-count]')).toHaveText('12');
});

test('single-folder tree shows one active folder and the same source can fill another cell', async ({page}) => {
  await startCollage(page, 2);
  const rootBranch = editor(page).locator('.collage-tree-branch').first();
  await expect(rootBranch).toHaveAttribute('open', '');
  await expect(editor(page).getByRole('checkbox')).toHaveCount(0);
  await editor(page).locator('summary').filter({hasText: 'Album A'}).click();
  await expect(editor(page).locator('[data-gallery-folder]')).toHaveText('Album A');
  await expect(editor(page).locator('[data-source-path]')).toHaveCount(13);
  await expect(editor(page).locator('summary[aria-current="true"]')).toHaveText('Album A');

  await editor(page).locator('[data-count="1"]').click();
  await editor(page).locator('[data-source-path="Album A/Photo 01.png"]').click();
  await editor(page).getByRole('button', {name: 'Пустая ячейка 3'}).click();
  await expect(editor(page).locator('.collage-cell-hit.is-empty')).toHaveCount(0);

  const document = await saveJsonProject(page);
  const placements = Object.values(document.project.placements);
  expect(placements).toHaveLength(3);
  expect(new Set(placements.map(item => item.id)).size).toBe(3);
  expect(placements.filter(item => item.sourceId === 'source:Album%20A%2FPhoto%2001.png')).toHaveLength(2);
});
