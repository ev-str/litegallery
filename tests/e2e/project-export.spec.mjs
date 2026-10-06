import {test, expect} from '@playwright/test';
import {editor, isDesktopBrowserProject, openSourceFolder, readDownload, saveJsonProject, startCollage} from './helpers.mjs';

test.beforeEach(async ({page}, testInfo) => {
  test.skip(!isDesktopBrowserProject(testInfo), 'Core flows run once per browser engine at desktop size.');
  await startCollage(page, 2);
});

test('JSON save/load keeps the schema and rejects a newer version', {tag: '@essential'}, async ({page}) => {
  const configResponse = await page.request.get('/api/config');
  expect(configResponse.ok()).toBe(true);
  const config = await configResponse.json();
  await editor(page).locator('[data-project-name]').fill('Пироги / май');
  await editor(page).locator('[data-project-name]').blur();
  const document = await saveJsonProject(page);
  expect(document).toMatchObject({format: 'litegallery-collage', formatVersion: 1, appVersion: config.version});
  expect(document.project).toMatchObject({formatVersion: 1, appVersion: config.version});
  expect(document.project.title).toBe('Пироги / май');
  expect(document.project.layout.order).toHaveLength(2);

  await page.locator('#collageProjectInput').setInputFiles({
    name: 'project.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(document)),
  });
  await expect(editor(page).locator('[data-toast]')).toContainText('Проект загружен');
  await expect(editor(page).locator('[data-history-count]')).toHaveText('0 из 20');

  const future = structuredClone(document);
  future.formatVersion = 999;
  await page.locator('#collageProjectInput').setInputFiles({
    name: 'future-project.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(future)),
  });
  await expect(editor(page).locator('[data-toast]')).toContainText('более новой версии');
});

test('opening a project protects dirty work and resets undo history after replacement', async ({page}) => {
  const document = await saveJsonProject(page);
  const changedBackground = editor(page).locator('[data-background-color]').nth(2);
  await changedBackground.click();
  await expect(changedBackground).toHaveAttribute('aria-pressed', 'true');

  await editor(page).locator('[data-command="load-project"]').click();
  const exit = page.locator('[data-exit-dialog]');
  await expect(exit).toBeVisible();
  await expect(exit.locator('[data-exit-heading]')).toHaveText('Открыть другой проект?');
  await exit.locator('[data-exit="stay"]').click();
  await expect(exit).toBeHidden();
  await expect(changedBackground).toHaveAttribute('aria-pressed', 'true');

  await editor(page).locator('[data-command="load-project"]').click();
  await expect(exit).toBeVisible();
  const chooserPromise = page.waitForEvent('filechooser');
  await exit.locator('[data-exit="discard"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'project.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(document)),
  });

  await expect(editor(page).locator('[data-toast]')).toContainText('Проект загружен');
  await expect(editor(page).locator('[data-history-count]')).toHaveText('0 из 20');
  await expect(editor(page).locator('[data-command="undo"]')).toBeDisabled();
});

test('preflight issues can be ignored and restored', async ({page}) => {
  await editor(page).locator('[data-command="preflight"]').click();
  const preflight = page.locator('[data-preflight-dialog]');
  await expect(preflight).toBeVisible();
  const issue = preflight.locator('[data-ignore-issue]').first();
  await expect(issue).toHaveText('Игнорировать');
  await issue.click();
  const ignored = preflight.locator('.collage-ignored');
  await expect(ignored.locator('summary')).toHaveText('Проигнорировано · 1');
  await expect(ignored.locator('[data-ignore-issue]').first()).toHaveText('Вернуть');
  await ignored.locator('[data-ignore-issue]').first().click();
  await expect(ignored).toHaveCount(0);
});

test('export downloads a print JPEG over plain HTTP', {tag: '@essential'}, async ({page}) => {
  await editor(page).locator('[data-project-name]').fill('Пироги / май');
  await editor(page).locator('[data-project-name]').blur();
  await editor(page).locator('[data-command="preflight"]').click();
  await page.locator('[data-preflight-dialog]').getByRole('button', {name: 'Настройки скачивания'}).click();
  const exportDialog = page.locator('[data-export-dialog]');
  await expect(exportDialog).toBeVisible();
  await exportDialog.locator('[data-export-format]').selectOption('10x15');
  await expect(exportDialog.locator('[data-export-summary]')).toContainText('10 × 15 см');
  await expect(exportDialog.locator('[data-export-summary]')).toContainText('300 PPI');
  await expect(exportDialog.locator('[data-export-filename]')).toHaveText('Пироги май — 10x15 — 300ppi.jpg');

  const pending = page.waitForEvent('download');
  await exportDialog.getByRole('button', {name: 'Скачать на устройство'}).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('Пироги май — 10x15 — 300ppi.jpg');
  const jpeg = await readDownload(download);
  expect(jpeg.length).toBeGreaterThan(1_000);
  expect([...jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
  await expect(exportDialog.locator('[data-export-status]')).toContainText('Готово');
});

test('ZIP save/load restores duplicate placements from embedded object URLs', {tag: '@essential'}, async ({page}) => {
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await editor(page).locator('[data-count="1"]').click();
  await openSourceFolder(page, 'Album A');
  await editor(page).locator('[data-source-path="Album A/Photo 01.png"]').click();
  await editor(page).getByRole('button', {name: 'Пустая ячейка 3'}).click();
  await expect(editor(page).locator('.collage-cell-hit.is-empty')).toHaveCount(0);

  await editor(page).locator('[data-save-kind]').selectOption('zip');
  const pending = page.waitForEvent('download');
  await editor(page).locator('[data-command="save-project"]').click();
  const saveDialog = page.locator('[data-save-dialog]');
  await expect(saveDialog.locator('[data-project-filename]')).toHaveText(/\.zip$/);
  await saveDialog.locator('[data-command="confirm-save-project"]').click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/^Коллаж — \d{4}-\d{2}-\d{2}\.zip$/);
  const zip = await readDownload(download);
  expect([...zip.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);

  await page.route(/\/api\/media\?/, route => route.abort());
  await page.route(/\/api\/thumb\?/, route => route.abort());
  await editor(page).locator('[data-background-color]').nth(3).click();
  await editor(page).locator('[data-command="load-project"]').click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('[data-exit-dialog]').locator('[data-exit="discard"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'collage-project.zip',
    mimeType: 'application/zip',
    buffer: zip,
  });

  await expect(editor(page).locator('[data-toast]')).toContainText('ZIP-проект загружен · 2 фотографии');
  await expect(editor(page).locator('[data-history-count]')).toHaveText('0 из 20');
  await expect(editor(page).locator('[data-cell-index]')).toHaveCount(3);
  await expect(editor(page).locator('.collage-cell-hit.is-empty')).toHaveCount(0);
  const sourceImages = editor(page).locator('[data-session-grid] img');
  await expect(sourceImages).toHaveCount(2);
  for (const image of await sourceImages.all()) {
    await expect(image).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => image.evaluate(element => (
      element.complete && element.naturalWidth > 0 && element.naturalHeight > 0
    ))).toBe(true);
  }

  await expect.poll(async () => editor(page).locator('[data-preview]').evaluate(canvas => {
    const context = canvas.getContext('2d');
    if (!context || !canvas.width || !canvas.height) return false;
    const pixel = context.getImageData(Math.floor(canvas.width * .25), Math.floor(canvas.height * .5), 1, 1).data;
    return pixel[3] === 255 && !(pixel[0] === 243 && pixel[1] === 231 && pixel[2] === 220);
  })).toBe(true);
  expect(browserErrors.filter(message => message.includes('Failed to fetch'))).toEqual([]);

  const restored = await saveJsonProject(page);
  const placements = Object.values(restored.project.placements);
  expect(placements).toHaveLength(3);
  expect(new Set(placements.map(item => item.id)).size).toBe(3);
  expect(placements.filter(item => item.sourceId === 'source:Album%20A%2FPhoto%2001.png')).toHaveLength(2);
});
