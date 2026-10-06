import {test, expect} from '@playwright/test';
import {editor, isDesktopBrowserProject, openTemplateList, saveJsonProject, startCollage} from './helpers.mjs';

test.beforeEach(async ({page}, testInfo) => {
  test.skip(!isDesktopBrowserProject(testInfo), 'Core flows run once per browser engine at desktop size.');
  await startCollage(page, 3);
});

test('move, remove, undo and redo are visible in the 20-step history', {tag: '@essential'}, async ({page}) => {
  const cells = editor(page).locator('[data-cell-index]');
  await cells.nth(0).click();
  await editor(page).locator('[data-command="move"]').click();
  await cells.nth(1).click();
  await expect(editor(page).locator('[data-history-count]')).toContainText('1 из 20');

  await cells.nth(1).click();
  await editor(page).locator('[data-command="remove"]').click();
  await expect(editor(page).locator('.collage-cell-hit.is-empty')).toHaveCount(1);
  await expect(editor(page).locator('[data-history-count]')).toContainText('2 из 20');

  await editor(page).locator('[data-command="undo"]').click();
  await expect(editor(page).locator('.collage-cell-hit.is-empty')).toHaveCount(0);
  await expect(editor(page).locator('[data-command="redo"]')).toBeEnabled();
  await editor(page).locator('[data-command="redo"]').click();
  await expect(editor(page).locator('.collage-cell-hit.is-empty')).toHaveCount(1);
});

test('crop editor supports both modes, keyboard movement, zoom, and saved rotation', {tag: '@essential'}, async ({page}) => {
  await editor(page).getByRole('button', {name: 'Фотография 1'}).click();
  await editor(page).locator('[data-command="crop"]').click();
  const crop = page.locator('[data-crop-dialog]');
  await expect(crop).toBeVisible();
  await expect(crop.locator('.collage-crop-stage')).toBeFocused();
  await crop.getByLabel('Искажать пропорции').check();
  await crop.locator('.collage-crop-stage').press('ArrowRight');
  await crop.locator('[data-crop-action="plus"]').click();
  await crop.getByRole('button', {name: 'Повернуть фотографию на 90 градусов вправо'}).click();
  await expect(crop.locator('.collage-crop-image-box')).toHaveAttribute('data-rotation', '90');
  await expect(crop.locator('[data-crop-quality]')).toContainText('PPI');
  await expect(crop.locator('[data-crop-quality]')).toContainText('искажение');
  await crop.getByRole('button', {name: 'Готово'}).click();
  await expect(crop).not.toBeVisible();
  await expect(editor(page).locator('[data-history-list]')).toContainText('Кроп фотографии');
  const project = await saveJsonProject(page);
  const placementId = project.project.layout.order[0];
  expect(project.project.placements[placementId].rotation).toBe(90);
});

test('template and styling controls update state and coalesce slider history', async ({page}) => {
  await openTemplateList(page);
  const templates = editor(page).locator('[data-template-id]');
  await templates.nth(1).click();
  await expect(templates.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(editor(page).locator('[data-toast]')).toContainText('Шаблон изменён');

  await editor(page).locator('[data-frame-mode="color"]').click();
  await editor(page).locator('[data-edge="zigzag"]').click();
  const swatches = editor(page).locator('[data-background-color]');
  await swatches.nth(3).click();
  await expect(swatches.nth(3)).toHaveAttribute('aria-pressed', 'true');

  const gap = editor(page).locator('[data-gap]');
  await gap.dispatchEvent('pointerdown');
  await gap.fill('8');
  await gap.dispatchEvent('pointerup');
  await expect(editor(page).locator('[data-gap-value]')).toHaveText('8 мм');
  await expect(editor(page).locator('[data-history-list]')).toContainText('Настройка оформления');
});

test('dirty editor asks before exit and keeps work recoverable', {tag: '@essential'}, async ({page}) => {
  await editor(page).locator('[data-background-color]').nth(2).click();
  await editor(page).locator('[data-command="close"]').click();
  const exit = page.locator('[data-exit-dialog]');
  await expect(exit).toBeVisible();
  await expect(exit.locator('[data-exit-size]')).toContainText('JSON-разметка');
  await exit.getByRole('button', {name: 'Остаться'}).click();
  await expect(editor(page)).toBeVisible();
  await expect(exit).toBeHidden();

  await editor(page).locator('[data-command="close"]').click();
  await expect(exit).toBeVisible();
  await exit.getByRole('button', {name: 'Выйти без сохранения'}).click();
  await expect(editor(page)).not.toBeVisible();
});
