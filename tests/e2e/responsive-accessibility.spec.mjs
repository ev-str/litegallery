import {test, expect} from '@playwright/test';
import {editor, enterSelectionMode, openAlbum, selectedPrintAspect, selectPhotos, startCollage} from './helpers.mjs';

test('selection warns about very large photos using their decoded size', async ({page}, testInfo) => {
  test.skip(!testInfo.project.name.endsWith('-desktop'), 'Desktop memory-warning contract');
  await page.route('**/api/image-info?**', async route => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (path !== 'Album A/Photo 02.png') return route.continue();
    await route.fulfill({json: {width: 8000, height: 6000, size: 4_000_000, modTime: '2026-10-06T10:00:00Z', mimeType: 'image/png'}});
  });

  await openAlbum(page);
  await enterSelectionMode(page);
  const selection = page.locator('#collageSelection');
  const hint = selection.locator('.collage-selection-hint');
  await selectPhotos(page, 1);
  await expect(hint).toHaveText('Выберите от 2 до 12 фотографий');
  await expect(selection).not.toHaveAttribute('data-memory-warning', 'true');

  await page.getByRole('button', {name: 'Выбрать Photo 02.png для коллажа'}).click();
  await expect(selection).toHaveAttribute('data-memory-warning', 'true');
  await expect(hint).toHaveText('Photo 02.png: 48 Мп. Очень крупные фото могут закрыть браузер из-за нехватки памяти, особенно на телефоне или планшете');

  await page.getByRole('button', {name: 'Убрать Photo 02.png из коллажа'}).click();
  await expect(selection).not.toHaveAttribute('data-memory-warning', 'true');
});

test('export dialog warns when the format exceeds the mobile canvas limit', async ({page}, testInfo) => {
  test.skip(!testInfo.project.name.endsWith('-desktop'), 'Desktop export-dialog contract');
  await startCollage(page, 2);
  await editor(page).locator('[data-command="preflight"]').click();
  await page.locator('[data-preflight-dialog]').getByRole('button', {name: 'Настройки скачивания'}).click();
  const exportDialog = page.locator('[data-export-dialog]');
  const warning = exportDialog.locator('[data-export-canvas-warning]');
  await exportDialog.locator('[data-export-format]').selectOption('20x30');
  await expect(warning).toBeHidden();
  await exportDialog.locator('[data-export-format]').selectOption('30x45');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('может не собраться в браузере на телефоне или планшете');
});

test('editor adapts to the configured viewport without horizontal page overflow', async ({page}, testInfo) => {
  await startCollage(page, 2);
  const viewport = testInfo.project.use.viewport;
  const metrics = await page.evaluate(() => ({client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth}));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client + 1);

  if (viewport.width <= 767) {
    const navigation = editor(page).getByRole('navigation', {name: 'Раздел редактора'});
    await expect(navigation).toBeVisible();
    await navigation.getByRole('button', {name: 'Фото'}).click();
    await expect(editor(page).locator('[data-mobile-panel="photos"]')).toBeVisible();
    await navigation.getByRole('button', {name: 'Оформление'}).click();
    await expect(editor(page).locator('[data-mobile-panel="settings"]')).toBeVisible();
    await navigation.getByRole('button', {name: 'Коллаж'}).click();
    await expect(editor(page).locator('[data-mobile-panel="canvas"]')).toBeVisible();
  } else {
    await expect(editor(page).locator('[data-mobile-panel="canvas"]')).toBeVisible();
  }
});

test('desktop preview meaningfully fills its workspace and reacts to available space', async ({page}, testInfo) => {
  test.skip(!testInfo.project.name.endsWith('-desktop'), 'Desktop workspace sizing contract');
  await startCollage(page, 7);

  const previewMetrics = () => page.evaluate(() => {
    const workspace = document.querySelector('.collage-canvas-column');
    const wrap = document.querySelector('.collage-canvas-wrap');
    const canvas = document.querySelector('[data-preview]');
    if (!(workspace instanceof HTMLElement) || !(wrap instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) {
      throw new Error('Collage preview elements are missing');
    }
    const workspaceBox = workspace.getBoundingClientRect();
    const wrapBox = wrap.getBoundingClientRect();
    const canvasBox = canvas.getBoundingClientRect();
    return {
      workspace: {width: workspaceBox.width, height: workspaceBox.height},
      wrap: {left: wrapBox.left, top: wrapBox.top, right: wrapBox.right, bottom: wrapBox.bottom, width: wrapBox.width, height: wrapBox.height},
      canvas: {left: canvasBox.left, top: canvasBox.top, right: canvasBox.right, bottom: canvasBox.bottom, width: canvasBox.width, height: canvasBox.height},
      bitmap: {width: canvas.width, height: canvas.height},
    };
  });

  await expect.poll(async () => (await previewMetrics()).canvas.height).toBeGreaterThan(500);
  const initial = await previewMetrics();
  const printAspect = await selectedPrintAspect(page);
  expect(initial.wrap.width).toBeGreaterThan(initial.workspace.width * 0.9);
  expect(initial.wrap.height).toBeGreaterThan(initial.workspace.height * 0.7);
  expect(initial.canvas.width).toBeGreaterThan(300);
  expect(initial.canvas.height).toBeGreaterThan(500);
  expect(initial.canvas.width / initial.canvas.height).toBeCloseTo(printAspect, 2);
  expect(initial.bitmap.width / initial.bitmap.height).toBeCloseTo(printAspect, 2);
  expect(initial.canvas.left).toBeGreaterThanOrEqual(initial.wrap.left - 1);
  expect(initial.canvas.top).toBeGreaterThanOrEqual(initial.wrap.top - 1);
  expect(initial.canvas.right).toBeLessThanOrEqual(initial.wrap.right + 1);
  expect(initial.canvas.bottom).toBeLessThanOrEqual(initial.wrap.bottom + 1);

  await page.setViewportSize({width: 1180, height: 760});
  await expect.poll(async () => (await previewMetrics()).canvas.height).toBeLessThan(initial.canvas.height - 50);
  const compact = await previewMetrics();
  expect(compact.canvas.width / compact.canvas.height).toBeCloseTo(printAspect, 2);
  expect(compact.canvas.right).toBeLessThanOrEqual(compact.wrap.right + 1);
  expect(compact.canvas.bottom).toBeLessThanOrEqual(compact.wrap.bottom + 1);

  await page.setViewportSize({width: 1440, height: 1000});
  await expect.poll(async () => (await previewMetrics()).canvas.height).toBeGreaterThan(compact.canvas.height + 50);
  await page.locator('.collage-workspace').evaluate(element => {
    element.style.gridTemplateColumns = '500px minmax(0, 1fr) 500px';
  });
  await expect.poll(async () => (await previewMetrics()).canvas.width).toBeLessThan(initial.canvas.width - 50);
  const narrowCenter = await previewMetrics();
  expect(narrowCenter.canvas.width / narrowCenter.canvas.height).toBeCloseTo(printAspect, 2);
  expect(narrowCenter.canvas.left).toBeGreaterThanOrEqual(narrowCenter.wrap.left - 1);
  expect(narrowCenter.canvas.right).toBeLessThanOrEqual(narrowCenter.wrap.right + 1);
});

test('crop editor refits safely from desktop to a narrow Safari-like viewport', async ({page}, testInfo) => {
  test.skip(!testInfo.project.name.endsWith('-desktop'), 'Exercise the same crop layout contract in each desktop engine');
  await startCollage(page, 3);
  await editor(page).getByRole('button', {name: 'Фотография 1'}).click();
  await editor(page).locator('[data-command="crop"]').click();
  const crop = page.locator('[data-crop-dialog]');
  await expect(crop).toBeVisible();

  const cropMetrics = () => crop.evaluate(dialog => {
    const card = dialog.querySelector('.collage-crop-card');
    const stage = dialog.querySelector('.collage-crop-stage');
    const box = dialog.querySelector('.collage-crop-image-box');
    const image = dialog.querySelector('img');
    const frame = dialog.querySelector('.collage-crop-frame');
    const footer = card?.querySelector('footer');
    if (!(card instanceof HTMLElement) || !(stage instanceof HTMLElement) || !(box instanceof HTMLElement)
      || !(image instanceof HTMLImageElement) || !(frame instanceof HTMLElement) || !(footer instanceof HTMLElement)) {
      throw new Error('Crop editor elements are missing');
    }
    const rect = element => {
      const value = element.getBoundingClientRect();
      return {left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height};
    };
    return {
      viewport: {width: window.innerWidth, height: window.innerHeight},
      dialog: {...rect(dialog), clientWidth: dialog.clientWidth, scrollWidth: dialog.scrollWidth},
      card: {...rect(card), clientWidth: card.clientWidth, scrollWidth: card.scrollWidth},
      stage: rect(stage),
      box: rect(box),
      sourceRatio: image.naturalWidth / image.naturalHeight,
      frame: rect(frame),
      handles: [...frame.querySelectorAll('[data-crop-handle]')].map(handle => ({
        ...rect(handle),
        visible: getComputedStyle(handle).visibility !== 'hidden' && getComputedStyle(handle).display !== 'none',
      })),
      footer: {...rect(footer), clientWidth: footer.clientWidth, scrollWidth: footer.scrollWidth, flexWrap: getComputedStyle(footer).flexWrap},
      buttons: [...footer.querySelectorAll('button')].map(button => ({...rect(button), action: button.dataset.cropAction || button.value})),
    };
  });

  const expectSafeCropLayout = metrics => {
    expect(metrics.dialog.scrollWidth).toBeLessThanOrEqual(metrics.dialog.clientWidth + 1);
    expect(metrics.card.scrollWidth).toBeLessThanOrEqual(metrics.card.clientWidth + 1);
    expect(metrics.dialog.left).toBeGreaterThanOrEqual(-1);
    expect(metrics.dialog.right).toBeLessThanOrEqual(metrics.viewport.width + 1);
    expect(metrics.box.width / metrics.box.height).toBeCloseTo(metrics.sourceRatio, 2);
    expect(metrics.box.left).toBeGreaterThanOrEqual(metrics.stage.left + 4);
    expect(metrics.box.top).toBeGreaterThanOrEqual(metrics.stage.top + 4);
    expect(metrics.box.right).toBeLessThanOrEqual(metrics.stage.right - 4);
    expect(metrics.box.bottom).toBeLessThanOrEqual(metrics.stage.bottom - 4);
    expect(metrics.frame.left).toBeGreaterThanOrEqual(metrics.stage.left + 2);
    expect(metrics.frame.top).toBeGreaterThanOrEqual(metrics.stage.top + 2);
    expect(metrics.frame.right).toBeLessThanOrEqual(metrics.stage.right - 2);
    expect(metrics.frame.bottom).toBeLessThanOrEqual(metrics.stage.bottom - 2);
    expect(metrics.handles).toHaveLength(8);
    for (const handle of metrics.handles) {
      expect(handle.visible).toBe(true);
      expect(handle.width).toBeGreaterThan(0);
      expect(handle.height).toBeGreaterThan(0);
      expect(handle.left).toBeGreaterThanOrEqual(metrics.stage.left + 2);
      expect(handle.top).toBeGreaterThanOrEqual(metrics.stage.top + 2);
      expect(handle.right).toBeLessThanOrEqual(metrics.stage.right - 2);
      expect(handle.bottom).toBeLessThanOrEqual(metrics.stage.bottom - 2);
    }
    expect(metrics.footer.scrollWidth).toBeLessThanOrEqual(metrics.footer.clientWidth + 1);
    expect(metrics.buttons.map(button => button.action)).toEqual(['reset', 'center', 'rotate-left', 'rotate-right', 'minus', 'plus', 'cancel', 'done']);
    for (const button of metrics.buttons) {
      expect(button.left).toBeGreaterThanOrEqual(metrics.card.left - 1);
      expect(button.right).toBeLessThanOrEqual(metrics.card.right + 1);
    }
  };

  await expect.poll(async () => (await cropMetrics()).sourceRatio).toBeGreaterThan(0);
  const desktop = await cropMetrics();
  expectSafeCropLayout(desktop);

  await page.setViewportSize({width: 430, height: 740});
  await expect.poll(async () => (await cropMetrics()).stage.width).toBeLessThan(desktop.stage.width - 100);
  await expect.poll(async () => {
    const metrics = await cropMetrics();
    return metrics.box.right <= metrics.stage.right - 4 && metrics.box.bottom <= metrics.stage.bottom - 4;
  }).toBe(true);
  const narrow = await cropMetrics();
  expectSafeCropLayout(narrow);
  expect(narrow.footer.flexWrap).toBe('wrap');
  expect(narrow.box.width).toBeLessThan(desktop.box.width);
});

test('primary collage path is keyboard focusable and crop reacts to arrows', async ({page}, testInfo) => {
  await page.goto('/?path=Album%20A');
  await page.keyboard.press('Tab');
  const focused = page.locator(':focus');
  await expect(focused).toBeVisible();
  await page.getByRole('button', {name: 'Выбрать фотографии для коллажа'}).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#collageSelection')).toBeVisible();

  await page.getByRole('button', {name: 'Выбрать Photo 01.png для коллажа'}).focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', {name: 'Выбрать Photo 02.png для коллажа'}).focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', {name: 'Сделать коллаж'}).focus();
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeVisible();

  if (testInfo.project.use.viewport.width <= 767) {
    await editor(page).getByRole('button', {name: 'Коллаж', exact: true}).click();
  }
  await editor(page).getByRole('button', {name: 'Фотография 1'}).focus();
  await page.keyboard.press('Enter');
  await editor(page).locator('[data-command="crop"]').focus();
  await page.keyboard.press('Enter');
  const stage = page.locator('[data-crop-dialog] .collage-crop-stage');
  await expect(stage).toBeFocused();
  const before = await page.locator('[data-crop-dialog] .collage-crop-frame').getAttribute('style');
  await stage.press('ArrowRight');
  await expect.poll(() => page.locator('[data-crop-dialog] .collage-crop-frame').getAttribute('style')).not.toBe(before);
});
