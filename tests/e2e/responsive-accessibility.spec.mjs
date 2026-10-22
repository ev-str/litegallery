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

test('offered export PPI follows the weakest photo shown in the summary', async ({page}, testInfo) => {
  test.skip(!testInfo.project.name.endsWith('-desktop'), 'Desktop export-dialog contract');
  // Twelve small cells give the 640×900 fixtures more than 300 PPI on small formats.
  await startCollage(page, 12);
  await editor(page).locator('[data-command="preflight"]').click();
  await page.locator('[data-preflight-dialog]').getByRole('button', {name: 'Настройки скачивания'}).click();
  const exportDialog = page.locator('[data-export-dialog]');
  let highestOffered = 0;
  for (const format of ['10x15', '13x18', '20x30']) {
    await exportDialog.locator('[data-export-format]').selectOption(format);
    const weakestText = await exportDialog.locator('.collage-export-weakest').textContent();
    const weakest = Number(weakestText?.match(/(\d+) PPI/)?.[1]);
    const offered = await exportDialog.locator('[data-export-ppi] option').evaluateAll(options => options.map(option => Number(option.value)));
    expect(weakest, format).toBeGreaterThan(0);
    expect(offered[0], format).toBe(300);
    expect(Math.max(...offered), format).toBeLessThanOrEqual(Math.max(300, weakest));
    expect(Math.max(...offered) % 25, format).toBe(0);
    highestOffered = Math.max(highestOffered, ...offered);
  }
  expect(highestOffered, 'at least one format must offer more than 300 PPI').toBeGreaterThan(300);
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

/** Multi-finger touch input through CDP; Playwright's touchscreen only taps. Touch projects are Chromium. */
async function touchInput(page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, points) => cdp.send('Input.dispatchTouchEvent', {type, touchPoints: points.map(([x, y], id) => ({x, y, id}))});
  const lerp = (from, to, t) => from.map((value, axis) => value + (to[axis] - value) * t);
  return {
    /** Move every finger from `from[i]` to `to[i]` in a few steps, then lift them all. */
    async gesture(from, to, steps = 6) {
      await send('touchStart', from);
      for (let step = 1; step <= steps; step += 1) await send('touchMove', from.map((point, index) => lerp(point, to[index], step / steps)));
      await send('touchEnd', []);
    },
    async doubleTap(point) {
      for (let tap = 0; tap < 2; tap += 1) {
        await send('touchStart', [point]);
        await send('touchEnd', []);
      }
    },
  };
}

async function openTouchPhoto(page) {
  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.goto(`/?path=${encodeURIComponent('Album A')}`);
  await page.locator('#mediaGrid .media-card[data-path="Album A/Photo 07.png"]').click();
  const viewer = page.locator('#viewer');
  await expect(viewer.locator('.stage')).toHaveAttribute('data-photo', 'ready');
  return viewer;
}

const photoRect = viewer => viewer.locator('.stage img').evaluate(image => {
  const {left, top, width, height} = image.getBoundingClientRect();
  return {left, top, width, height};
});

test('touch: pinch and double-tap zoom, drag pans without swiping, Fit swipes again', {tag: '@essential'}, async ({page}, testInfo) => {
  test.skip(!testInfo.project.use.hasTouch, 'Touch gesture contract');
  const viewer = await openTouchPhoto(page);
  const stage = viewer.locator('.stage');
  const caption = viewer.locator('.caption');
  const opened = await caption.textContent();
  const {width, height} = page.viewportSize() ?? {width: 0, height: 0};
  const centre = [width / 2, height / 2];
  const touch = await touchInput(page);
  const fitted = await photoRect(viewer);

  await touch.gesture([[centre[0] - 40, centre[1]], [centre[0] + 40, centre[1]]], [[centre[0] - 100, centre[1]], [centre[0] + 100, centre[1]]]);
  await expect(stage).toHaveAttribute('data-view', 'zoom');
  const pinched = await photoRect(viewer);
  expect(pinched.width / fitted.width).toBeCloseTo(200 / 80, 1);
  await expect(caption).toHaveText(opened ?? '');

  // A horizontal drag on the zoomed photo pans it and does not change photos.
  await touch.gesture([[centre[0] + 60, centre[1]]], [[centre[0] - 60, centre[1] + 20]]);
  const panned = await photoRect(viewer);
  expect(panned.left).toBeCloseTo(pinched.left - 120, 0);
  await expect(caption).toHaveText(opened ?? '');

  await touch.doubleTap(centre);
  await expect(stage).toHaveAttribute('data-view', 'fit');
  expect(await photoRect(viewer)).toEqual(fitted);
  await touch.doubleTap(centre);
  await expect(stage).toHaveAttribute('data-view', 'zoom');
  await expect(stage).toHaveAttribute('data-pannable', 'true');
  await touch.doubleTap(centre);
  await expect(stage).toHaveAttribute('data-view', 'fit');

  await touch.gesture([[centre[0] + 100, centre[1]]], [[centre[0] - 100, centre[1]]]);
  await expect(caption).not.toHaveText(opened ?? '');
  await expect(stage).toHaveAttribute('data-view', 'fit');
});

test('viewer photo tools fit the touch viewport and clear the EXIF panel', async ({page}, testInfo) => {
  test.skip(!testInfo.project.use.hasTouch, 'Touch layout contract');
  const viewer = await openTouchPhoto(page);
  const {width} = page.viewportSize() ?? {width: 0};
  const controls = viewer.locator('.photo-tools button, .viewer-actions > *');
  await expect(controls).toHaveCount(8);
  const boxes = await controls.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(width);
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(40);
  }
  // No two controls overlap.
  for (const [index, a] of boxes.entries()) {
    for (const b of boxes.slice(index + 1)) expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
  }
  // The EXIF panel leaves the photo tools usable.
  await viewer.getByRole('button', {name: 'Информация о фотографии'}).click();
  const panel = await viewer.locator('.exif-panel').evaluate(element => element.getBoundingClientRect().toJSON());
  const tools = await viewer.locator('.photo-tools').evaluate(element => element.getBoundingClientRect().toJSON());
  expect(panel.bottom <= tools.top || panel.right <= tools.left || panel.left >= tools.right).toBe(true);
});
