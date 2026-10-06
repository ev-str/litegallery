import {test, expect} from '@playwright/test';
import {editor, saveJsonProject, startCollage} from './helpers.mjs';

test.beforeEach(async ({page}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'Focused rendering contracts run once in Chromium desktop.');
});

test('print format and orientation sit below photo count and update footer and canvas', async ({page}) => {
  await startCollage(page, 3);
  const settings = editor(page).locator('.collage-settings');
  const photoCountSection = settings.locator('[data-photo-count]').locator('xpath=ancestor::section[1]');
  const printSection = settings.locator('[data-print-format]').locator('xpath=ancestor::section[1]');
  await expect(settings.locator('[data-print-format]')).toBeVisible();
  await expect(settings.locator('[data-print-orientation]')).toBeVisible();
  await expect(settings.locator('[data-print-size]')).toBeVisible();
  const photoCountBox = await photoCountSection.boundingBox();
  const printBox = await printSection.boundingBox();
  expect(photoCountBox).not.toBeNull();
  expect(printBox).not.toBeNull();
  expect(printBox.y).toBeGreaterThan(photoCountBox.y + photoCountBox.height);

  const quality = editor(page).locator('[data-quality-summary]');
  await expect(quality).toHaveClass(/collage-quality-pill/);
  await expect(quality.locator('[data-quality-size]')).toHaveText('13 × 18 см');
  await expect(quality.locator('[data-quality-ppi]')).toContainText('300 PPI');
  await expect(quality.locator('.collage-quality-dot')).toHaveAttribute('aria-hidden', 'true');
  await expect(quality.locator('[data-quality-pixels]')).toContainText(/\d+ × \d+ px/);
  const qualityStyle = await quality.evaluate(node => ({
    display: getComputedStyle(node).display,
    borderRadius: parseFloat(getComputedStyle(node).borderRadius),
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));
  expect(['flex', 'inline-flex']).toContain(qualityStyle.display);
  expect(qualityStyle.borderRadius).toBeGreaterThan(10);
  expect(qualityStyle.scrollWidth).toBeLessThanOrEqual(qualityStyle.clientWidth + 1);

  const canvas = editor(page).locator('[data-preview]');
  await settings.locator('[data-print-format]').selectOption('a4');
  await expect(settings.locator('[data-print-size]')).toContainText(/21 × 29[,.]7 см/);
  await expect(quality.locator('[data-quality-size]')).toContainText(/21 × 29[,.]7 см/);
  await expect(quality.locator('[data-quality-ppi]')).toContainText('300 PPI');
  await expect(quality.locator('[data-quality-pixels]')).toContainText(/2480 × 3508 px/);
  await expect.poll(async () => canvas.evaluate(node => node.width < node.height)).toBe(true);

  await settings.locator('[data-print-orientation]').selectOption('landscape');
  await expect(quality.locator('[data-quality-size]')).toContainText(/29[,.]7 × 21 см/);
  await expect(quality.locator('[data-quality-pixels]')).toContainText(/3508 × 2480 px/);
  await expect.poll(async () => canvas.evaluate(node => node.width > node.height)).toBe(true);
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  expect(box.width).toBeGreaterThan(box.height);

  await page.setViewportSize({width: 900, height: 700});
  await expect(quality).toBeVisible();
  const compact = await quality.evaluate(node => ({clientWidth: node.clientWidth, scrollWidth: node.scrollWidth}));
  expect(compact.scrollWidth).toBeLessThanOrEqual(compact.clientWidth + 1);
});

test('right inspector stays compact without changing its controls or rail width', async ({page}) => {
  await startCollage(page, 5);
  const settings = editor(page).locator('.collage-settings');
  const metrics = await settings.evaluate(node => {
    const rect = element => element.getBoundingClientRect();
    const sections = [...node.querySelectorAll(':scope > section')];
    const count = node.querySelector('[data-photo-count]').closest('section');
    const transforms = node.querySelector('.collage-template-transforms');
    const fields = node.querySelector('.collage-print-fields');
    const fieldLabels = [...fields.querySelectorAll(':scope > label')].map(rect);
    const autofill = node.querySelector('[data-command="autofill"]');
    const edge = node.querySelector('[data-edge-grid]');
    return {
      width: rect(node).width,
      sectionSpacing: sections.map(section => ({
        marginBottom: parseFloat(getComputedStyle(section).marginBottom),
        paddingBottom: parseFloat(getComputedStyle(section).paddingBottom),
      })),
      count: rect(count),
      countDisplay: getComputedStyle(count.querySelector('.collage-setting-title')).display,
      stepperButtons: [...count.querySelectorAll('button')].map(element => rect(element).height),
      transformButtons: [...transforms.querySelectorAll('button')].map(element => rect(element).height),
      printDisplay: getComputedStyle(fields).display,
      fieldLabels,
      printSizeWeight: Number(getComputedStyle(node.querySelector('[data-print-size]')).fontWeight),
      printSizeText: node.querySelector('[data-print-size]').textContent,
      autofillHeight: rect(autofill).height,
      edgeColumns: getComputedStyle(edge).gridTemplateColumns.split(' ').length,
      edgeCount: edge.querySelectorAll('button').length,
      backgroundColors: node.querySelectorAll('[data-background-color]').length,
      sliders: node.querySelectorAll('input[type="range"]').length,
    };
  });
  expect(metrics.width).toBeGreaterThanOrEqual(285);
  expect(metrics.width).toBeLessThanOrEqual(295);
  for (const spacing of metrics.sectionSpacing) {
    expect(spacing.marginBottom).toBeLessThanOrEqual(12);
    expect(spacing.paddingBottom).toBeLessThanOrEqual(12);
  }
  expect(metrics.count.height).toBeLessThanOrEqual(52);
  expect(metrics.countDisplay).toBe('flex');
  expect(Math.max(...metrics.stepperButtons)).toBeLessThanOrEqual(34);
  expect(Math.max(...metrics.transformButtons)).toBeLessThanOrEqual(36);
  expect(metrics.printDisplay).toBe('grid');
  expect(metrics.fieldLabels).toHaveLength(2);
  expect(metrics.fieldLabels[1].top).toBeGreaterThan(metrics.fieldLabels[0].top);
  expect(Math.abs(metrics.fieldLabels[0].left - metrics.fieldLabels[1].left)).toBeLessThanOrEqual(1);
  expect(metrics.printSizeWeight).toBeGreaterThanOrEqual(600);
  expect(metrics.printSizeText).toContain('13 × 18 см');
  expect(metrics.autofillHeight).toBeLessThanOrEqual(46);
  expect(metrics.edgeColumns).toBe(4);
  expect(metrics.edgeCount).toBe(10);
  expect(metrics.backgroundColors).toBe(11);
  expect(metrics.sliders).toBe(3);
});

test('template rail exposes portrait variants whose geometry has at most three vertical levels', async ({page}) => {
  await startCollage(page, 5);
  const portraitButtons = editor(page).locator('[data-template-family="portrait"]');
  await expect(portraitButtons).not.toHaveCount(0);
  for (const button of await portraitButtons.all()) {
    await expect(button).toHaveAttribute('data-template-id', /^5-portrait-/);
    await expect(button.locator('i')).toHaveCount(5);
  }

  const audit = await page.evaluate(async () => {
    const {getTemplatesForCount} = await import('/collage/templates.js');
    const epsilon = 1e-9;
    return Array.from({length: 11}, (_, index) => index + 2).flatMap(count =>
      getTemplatesForCount(count)
        .filter(template => template.family === 'portrait')
        .map(template => {
          const boundaries = [...new Set(template.cells.flatMap(cell => [cell.rect.x, cell.rect.x + cell.rect.width]))].sort((a, b) => a - b);
          const verticalLevels = boundaries.slice(0, -1).map((left, index) => {
            const right = boundaries[index + 1];
            const x = (left + right) / 2;
            return template.cells.filter(cell => cell.rect.x <= x + epsilon && cell.rect.x + cell.rect.width >= x - epsilon).length;
          });
          const area = template.cells.reduce((sum, cell) => sum + cell.rect.width * cell.rect.height, 0);
          return {id: template.id, count, maxVerticalLevels: Math.max(...verticalLevels), area};
        }),
    );
  });
  expect(audit.length).toBeGreaterThanOrEqual(11);
  for (const result of audit) {
    expect(result.id).toMatch(new RegExp(`^${result.count}-portrait(?:-|$)`));
    expect(result.area).toBeCloseTo(1, 8);
    expect(result.maxVerticalLevels).toBeLessThanOrEqual(3);
  }
});

test('rapid redraws cannot let an older preview overwrite the current canvas', async ({page}) => {
  await page.addInitScript(() => {
    const original = window.createImageBitmap?.bind(window);
    if (!original) return;
    const control = {delays: [], pending: 0, calls: 0};
    Object.defineProperty(window, '__previewBitmapControl', {value: control, configurable: false});
    window.createImageBitmap = async (...args) => {
      control.calls += 1;
      control.pending += 1;
      const delay = control.delays.shift() || 0;
      try {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        return await original(...args);
      } finally {
        control.pending -= 1;
      }
    };
  });
  await startCollage(page, 3);
  await expect.poll(() => page.evaluate(() => window.__previewBitmapControl?.pending ?? 0)).toBe(0);

  await editor(page).getByRole('button', {name: 'Фотография 1'}).click();
  await editor(page).locator('[data-command="crop"]').click();
  const crop = page.locator('[data-crop-dialog]');
  await crop.locator('[data-crop-action="plus"]').click();
  const swatches = editor(page).locator('[data-background-color]');
  const callsBeforeRace = await page.evaluate(() => window.__previewBitmapControl.calls);
  await page.evaluate(() => { window.__previewBitmapControl.delays = [350, 0, 0, 0, 0, 0]; });
  await crop.getByRole('button', {name: 'Готово'}).click();
  const busy = editor(page).locator('[data-preview-busy]');
  await expect(busy).toBeVisible();
  await expect(busy.locator('.collage-preview-spinner')).toHaveAttribute('aria-hidden', 'true');
  await expect(busy.locator('strong')).toHaveText('Обновляем превью…');
  const busyStyle = await busy.evaluate(node => ({
    fontWeight: getComputedStyle(node.querySelector('strong')).fontWeight,
    backgroundColor: getComputedStyle(node).backgroundColor,
    boxShadow: getComputedStyle(node).boxShadow,
  }));
  expect(Number(busyStyle.fontWeight)).toBeGreaterThanOrEqual(600);
  expect(busyStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(busyStyle.boxShadow).not.toBe('none');
  await swatches.nth(2).click();
  await expect(swatches.nth(2)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.__previewBitmapControl.calls)).toBeGreaterThanOrEqual(callsBeforeRace + 2);
  await expect.poll(() => page.evaluate(() => window.__previewBitmapControl.pending)).toBe(0);
  const raced = await editor(page).locator('[data-preview]').evaluate(canvas => canvas.toDataURL('image/png'));

  await swatches.nth(2).click();
  await expect.poll(() => page.evaluate(() => window.__previewBitmapControl.pending)).toBe(0);
  const stable = await editor(page).locator('[data-preview]').evaluate(canvas => canvas.toDataURL('image/png'));
  expect(raced).toBe(stable);
});

test('proportional crop finishes at zero distortion and matches rendered cell aspect', async ({page}) => {
  await startCollage(page, 3);
  const firstCell = editor(page).getByRole('button', {name: 'Фотография 1'});
  await firstCell.click();
  await editor(page).locator('[data-command="crop"]').click();
  const crop = page.locator('[data-crop-dialog]');
  await crop.getByLabel('Сохранять пропорции').check();
  await crop.locator('[data-crop-action="plus"]').click();
  await crop.locator('.collage-crop-stage').press('ArrowRight');
  await expect(crop.locator('[data-crop-quality]')).toContainText('искажение 0.0%');
  await crop.getByRole('button', {name: 'Готово'}).click();
  await expect(crop).not.toBeVisible();

  const document = await saveJsonProject(page);
  const placementId = document.project.layout.order[0];
  const placement = document.project.placements[placementId];
  const source = document.project.sources[placement.sourceId];
  const sourceCropAspect = source.width * placement.crop.width / (source.height * placement.crop.height);
  const cellBox = await firstCell.boundingBox();
  expect(cellBox).not.toBeNull();
  expect(cellBox.width / cellBox.height).toBeCloseTo(sourceCropAspect, 2);
  expect(placement.cropMode).toBe('proportional');
});
