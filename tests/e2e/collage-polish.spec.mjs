import {test, expect} from '@playwright/test';
import {editor, isDesktopBrowserProject, openTemplateList, startCollage} from './helpers.mjs';

test.beforeEach(async ({page}, testInfo) => {
  test.skip(!isDesktopBrowserProject(testInfo), 'Collage polish controls run once per browser engine at desktop size.');
});

test('template flips live in settings, combine independently, and never overlay thumbnails', async ({page}) => {
  await startCollage(page, 4);
  const panel = editor(page);
  await openTemplateList(page);
  await panel.locator('[data-template-id="4-magazine-corner"]').click();

  const horizontal = panel.getByRole('button', {name: '↔ Слева / справа'});
  const vertical = panel.getByRole('button', {name: '↕ Сверху / снизу'});
  await expect(horizontal).toBeEnabled();
  await expect(vertical).toBeEnabled();
  await expect(horizontal).toHaveAttribute('aria-pressed', 'false');
  await expect(vertical).toHaveAttribute('aria-pressed', 'false');
  await expect(panel.locator('[data-mirror-template], .collage-template-mirror')).toHaveCount(0);

  await horizontal.click();
  await expect(horizontal).toHaveAttribute('aria-pressed', 'true');
  await expect(vertical).toHaveAttribute('aria-pressed', 'false');
  await vertical.click();
  await expect(horizontal).toHaveAttribute('aria-pressed', 'true');
  await expect(vertical).toHaveAttribute('aria-pressed', 'true');
  await horizontal.click();
  await expect(horizontal).toHaveAttribute('aria-pressed', 'false');
  await expect(vertical).toHaveAttribute('aria-pressed', 'true');
});

test('download command and both perforation controls are discoverable', async ({page}) => {
  await startCollage(page, 4);
  const panel = editor(page);
  await expect(panel.getByRole('button', {name: 'Скачать коллаж'})).toBeVisible();
  const stamp = panel.getByRole('button', {name: 'Марка'});
  await expect(stamp).toBeVisible();
  await stamp.click();
  await expect(stamp).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.locator('[data-depth]').locator('..')).toBeVisible();
  await expect(panel.locator('[data-frequency-row]')).toBeVisible();

  const perforated = panel.getByRole('button', {name: 'Перфорация'});
  await expect(perforated).toBeVisible();
  await perforated.click();
  await expect(perforated).toHaveAttribute('aria-pressed', 'true');
  await expect(stamp).toHaveAttribute('aria-pressed', 'false');
  await expect(panel.locator('[data-depth]').locator('..')).toBeVisible();
  await expect(panel.locator('[data-frequency-row]')).toBeVisible();
});

test('folder markers expose collapsed and expanded state', async ({page}) => {
  await startCollage(page, 2);
  const branch = editor(page).locator('.collage-tree-branch').filter({hasText: 'Album B'}).first();
  await expect(branch).toHaveAttribute('open', '');
  await branch.locator(':scope > summary').click();
  await expect(branch).not.toHaveAttribute('open', '');
  await branch.locator(':scope > summary').click();
  await expect(branch).toHaveAttribute('open', '');
});

test('focus mode collapses templates, enlarges the canvas, and opens a full photo preview', async ({page}) => {
  await startCollage(page, 4);
  const panel = editor(page);
  const templateToggle = panel.locator('[data-template-accordion-toggle]');
  await expect(templateToggle).toBeVisible();
  await expect(panel.locator('[data-template-list]')).toBeHidden();
  await templateToggle.click();
  await expect(panel.locator('[data-template-list]')).toBeVisible();
  await expect(templateToggle).toHaveAccessibleName('Свернуть список шаблонов');
  await templateToggle.click();

  const canvas = panel.locator('[data-preview]');
  const before = await canvas.boundingBox();
  const focus = panel.locator('[data-command="toggle-canvas-focus"]');
  await expect(focus).toHaveText('⛶');
  await focus.click();
  await expect(panel).toHaveAttribute('data-canvas-focus', 'true');
  await expect(panel.locator('.collage-sources-panel')).toBeHidden();
  await expect(panel.locator('.collage-settings')).toBeHidden();
  await expect.poll(async () => (await canvas.boundingBox())?.height || 0).toBeGreaterThan(before.height);
  await focus.click();
  await expect(panel).toHaveAttribute('data-canvas-focus', 'false');

  await panel.locator('.collage-tree-branch summary').filter({hasText: 'Album A'}).click();
  await expect(panel.locator('[data-source-preview-path]')).not.toHaveCount(0);
  await panel.locator('[data-source-preview-path]').first().click();
  const preview = page.locator('[data-photo-preview-dialog]');
  await expect(preview).toBeVisible();
  await expect(preview.locator('img')).toHaveJSProperty('complete', true);
  const photoZoom = preview.locator('[data-photo-preview-zoom]');
  const photoStage = preview.locator('.collage-photo-preview-stage');
  await photoZoom.click();
  await expect(preview).toHaveAttribute('data-zoom', 'true');
  await photoStage.hover();
  await page.mouse.wheel(0, -500);
  await expect.poll(async () => photoZoom.locator('[data-photo-preview-zoom-value]').textContent()).not.toBe('100%');
  await photoStage.dblclick();
  await expect(photoZoom.locator('[data-photo-preview-zoom-value]')).toHaveText('100%');
  await photoZoom.click();
  await expect(preview).toHaveAttribute('data-zoom', 'false');
  await preview.getByRole('button', {name: 'Закрыть просмотр фотографии'}).click();
  await expect(preview).toBeHidden();
});

test('canvas view mode zooms with the wheel, pans by dragging, and resets on double click', async ({page}) => {
  await startCollage(page, 4);
  const panel = editor(page);
  const zoom = panel.locator('[data-command="toggle-canvas-zoom"]');
  const stage = panel.locator('.collage-canvas-wrap');
  const surface = panel.locator('[data-canvas-surface]');

  await zoom.click();
  await expect(panel).toHaveAttribute('data-canvas-zoom', 'true');
  await expect(zoom).toHaveAttribute('aria-pressed', 'true');
  await stage.hover();
  await page.mouse.wheel(0, -500);
  await expect.poll(async () => zoom.locator('[data-canvas-zoom-value]').textContent()).not.toBe('100%');

  const beforePan = await surface.evaluate(element => element.style.transform);
  const box = await stage.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 35);
  await page.mouse.up();
  await expect.poll(async () => surface.evaluate(element => element.style.transform)).not.toBe(beforePan);

  await stage.dblclick({position: {x: box.width / 2, y: box.height / 2}});
  await expect(zoom.locator('[data-canvas-zoom-value]')).toHaveText('100%');
  await zoom.click();
  await expect(panel).toHaveAttribute('data-canvas-zoom', 'false');
});
