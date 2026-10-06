import {test, expect} from '@playwright/test';
import {enterSelectionMode, isDesktopBrowserProject} from './helpers.mjs';

// Fixtures from fixtures/orientation/generate.go: stored pixels are 160×120 with
// red, green, blue, and yellow quadrants; only the EXIF orientation differs.
// Quadrants are listed as top-left, top-right, bottom-left, bottom-right.
const ORIENTATIONS = {
  1: {width: 160, height: 120, quadrants: ['red', 'green', 'blue', 'yellow']},
  5: {width: 120, height: 160, quadrants: ['red', 'blue', 'green', 'yellow']},
  6: {width: 120, height: 160, quadrants: ['blue', 'red', 'yellow', 'green']},
};

const PALETTE = {
  red: [220, 40, 40],
  green: [40, 180, 60],
  blue: [40, 70, 220],
  yellow: [230, 200, 40],
};

/** @param {number[]} rgb */
function nearestColor(rgb) {
  let best = '';
  let bestDistance = Infinity;
  for (const [name, reference] of Object.entries(PALETTE)) {
    const distance = reference.reduce((sum, value, index) => sum + (value - rgb[index]) ** 2, 0);
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
}

test.beforeEach(async ({page}, testInfo) => {
  test.skip(!isDesktopBrowserProject(testInfo), 'Decoder behaviour is checked once per desktop browser engine.');
});

for (const [orientation, expected] of Object.entries(ORIENTATIONS)) {
  test(`EXIF orientation ${orientation} matches in image-info, server thumbnails, and the export decoder`, {tag: '@essential'}, async ({page}) => {
    const path = `Album C/Orientation ${orientation}.jpg`;
    await page.goto('/');

    const info = await (await page.request.get(`/api/image-info?path=${encodeURIComponent(path)}`)).json();
    expect([info.width, info.height]).toEqual([expected.width, expected.height]);

    // /api/media is decoded by the browser exactly as preview and JPEG export do;
    // /api/thumb is rotated by the server and carries no EXIF.
    for (const endpoint of ['/api/media', '/api/thumb']) {
      const sample = await page.evaluate(async url => {
        const {fetchImageBitmap} = await import('/collage/canvas-renderer.js');
        const bitmap = await fetchImageBitmap({id: 'fixture', url});
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
        context.drawImage(bitmap, 0, 0);
        const at = (/** @type {number} */ x, /** @type {number} */ y) => [...context.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data.slice(0, 3)];
        return {width: canvas.width, height: canvas.height, quadrants: [at(0.25, 0.25), at(0.75, 0.25), at(0.25, 0.75), at(0.75, 0.75)]};
      }, `${endpoint}?path=${encodeURIComponent(path)}`);

      expect(sample.width / sample.height, endpoint).toBeCloseTo(expected.width / expected.height, 2);
      expect(sample.quadrants.map(nearestColor), endpoint).toEqual(expected.quadrants);
    }
  });
}

test('TIFF cards stay visible but cannot be selected for a collage', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Открыть папку Album C'}).click();
  await expect(page.locator('#mediaGrid .media-card.image')).toHaveCount(4);
  await enterSelectionMode(page);

  const count = page.locator('#collageSelectionCount');
  const hint = page.locator('#collageSelection .collage-selection-hint');
  const tiff = page.locator('#mediaGrid .media-card[data-path="Album C/Scan.tif"]');
  await expect(tiff).toHaveAttribute('aria-disabled', 'true');
  // aria-disabled does not block real clicks, but Playwright treats it as disabled.
  await tiff.click({force: true});
  await expect(count).toHaveText('0');
  await expect(hint).toHaveText('TIFF пока недоступен для коллажа');

  await page.getByRole('button', {name: 'Выбрать Orientation 1.jpg для коллажа'}).click();
  await expect(count).toHaveText('1');
  await expect(hint).toHaveText('Выберите от 2 до 12 фотографий');
});
