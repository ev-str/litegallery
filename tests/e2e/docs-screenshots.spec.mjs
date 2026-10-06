import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {test, expect} from '@playwright/test';
import {editor} from './helpers.mjs';

const enabled = process.env.LITEGALLERY_DOC_SCREENSHOTS === '1';
const screenshots = resolve('docs/screenshots');

test.describe('documentation screenshots', () => {
  test.skip(!enabled, 'Run with npm run screenshots:docs');

  test.beforeAll(async () => {
    await mkdir(screenshots, {recursive: true});
  });

  test('capture the public README views from demo fixtures', async ({page}) => {
    await page.goto('/');
    await expect(page.getByRole('button', {name: /Открыть папку/})).toHaveCount(2);
    await page.screenshot({path: resolve(screenshots, 'gallery.png')});

    await page.getByRole('button', {name: 'Открыть папку Nature'}).click();
    await expect(page.locator('#mediaGrid .media-card.image')).toHaveCount(5);
    await page.locator('#collageMode').click();
    const photoButtons = page.locator('#mediaGrid .media-card.image');
    await expect(photoButtons).toHaveCount(5);
    for (let index = 0; index < 5; index += 1) await photoButtons.nth(index).click();
    await expect(page.locator('#collageSelectionCount')).toHaveText('5');
    await page.getByRole('button', {name: 'Сделать коллаж'}).click();
    const panel = editor(page);
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-cell-index]')).toHaveCount(5);
    await panel.getByLabel('Название коллажа').fill('Демо-коллаж');
    await panel.getByLabel('Название коллажа').blur();
    await panel.getByRole('button', {name: 'Белая', exact: true}).click();
    await panel.getByRole('button', {name: 'Марка', exact: true}).click();
    await panel.locator('[data-frequency]').fill('10');
    await panel.getByRole('button', {name: 'Цвет фона #DDE8E8'}).click();
    await expect(panel.locator('[data-preview]')).toBeVisible();
    await expect(panel.locator('[data-preview-busy]')).toBeHidden();
    await panel.locator('.collage-settings').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({path: resolve(screenshots, 'collage-editor.png')});

    await panel.getByRole('button', {name: 'Фотография 1'}).click();
    await panel.locator('[data-command="crop"]').click();
    const crop = page.locator('[data-crop-dialog]');
    await expect(crop).toBeVisible();
    await crop.getByRole('button', {name: 'Повернуть фотографию на 90 градусов вправо'}).click();
    await expect(crop.locator('.collage-crop-image-box')).toHaveAttribute('data-rotation', '90');
    await page.screenshot({path: resolve(screenshots, 'crop-editor.png')});
    await crop.getByRole('button', {name: 'Отмена'}).click();

    await panel.locator('[data-command="preflight"]').click();
    const preflight = page.locator('[data-preflight-dialog]');
    await expect(preflight).toBeVisible();
    await preflight.getByRole('button', {name: 'Настройки скачивания'}).click();
    const exportDialog = page.locator('[data-export-dialog]');
    await expect(exportDialog).toBeVisible();
    await exportDialog.locator('[data-export-format]').selectOption('13x18');
    await expect(exportDialog.locator('[data-export-summary]')).toContainText('300 PPI');
    await page.screenshot({path: resolve(screenshots, 'jpeg-export.png')});
  });
});
