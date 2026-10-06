import assert from 'node:assert/strict';
import test from 'node:test';

import {PRINT_FORMATS, getPrintDimensions} from '../../web/collage/formats.js';
import {
  EXPORT_BYTES_PER_PIXEL,
  estimateExportBytes,
  exceedsSafeCanvas,
  exportMemoryBudget,
  isLargePhoto,
  MAX_EXPORT_PPI,
  MIN_EXPORT_PPI,
  maxPpiForMemory,
  megapixels,
  recommendedExportPpi,
} from '../../web/collage/limits.js';

const MiB = 1024 * 1024;

test('export memory budget scales with device memory and stays within 128–512 MiB', () => {
  assert.equal(exportMemoryBudget(0.5), 128 * MiB);
  assert.equal(exportMemoryBudget(2), 256 * MiB);
  assert.equal(exportMemoryBudget(0), 512 * MiB, 'unknown devices count as 4 GiB');
  assert.equal(exportMemoryBudget(16), 512 * MiB);
  assert.equal(estimateExportBytes(100.2, 50), 101 * 50 * EXPORT_BYTES_PER_PIXEL);
});

test('every PPI the chooser can offer above 300 fits the export memory budget', () => {
  for (const budget of [128 * MiB, 256 * MiB, 512 * MiB]) {
    for (const format of PRINT_FORMATS) {
      for (const orientation of /** @type {const} */ (['portrait', 'landscape'])) {
        for (const bleedMm of [0, 2]) {
          const offered = recommendedExportPpi(10_000, format.id, orientation, bleedMm, budget);
          if (offered === MIN_EXPORT_PPI) continue;
          const dimensions = getPrintDimensions(format.id, orientation, offered, bleedMm);
          assert.ok(
            estimateExportBytes(dimensions.widthPx, dimensions.heightPx) <= budget,
            `${format.id} ${orientation} bleed ${bleedMm} at ${offered} PPI exceeds ${budget / MiB} MiB`,
          );
        }
      }
    }
  }
});

test('recommended PPI follows the weakest photo, rounds down to 25, and stays within 300–600', () => {
  const budget = 512 * MiB;
  assert.equal(recommendedExportPpi(null, '10x15', 'portrait', 0, budget), MIN_EXPORT_PPI, 'no placed photos');
  assert.equal(recommendedExportPpi(250, '10x15', 'portrait', 0, budget), MIN_EXPORT_PPI, '300 is always offered');
  assert.equal(recommendedExportPpi(349.9, '10x15', 'portrait', 0, budget), 325);
  assert.equal(recommendedExportPpi(350, '10x15', 'portrait', 0, budget), 350);
  assert.equal(recommendedExportPpi(5_000, '10x15', 'portrait', 0, budget), MAX_EXPORT_PPI);
  for (const weakest of [301, 333, 410, 599]) {
    assert.ok(recommendedExportPpi(weakest, '10x15', 'portrait', 0, budget) <= weakest, `never above the weakest photo (${weakest})`);
  }
});

test('memory caps the recommendation for large formats', () => {
  const budget = 128 * MiB;
  const memoryLimit = maxPpiForMemory('30x45', 'portrait', 0, budget);
  assert.ok(memoryLimit < MAX_EXPORT_PPI);
  const offered = recommendedExportPpi(5_000, '30x45', 'portrait', 0, budget);
  assert.ok(offered <= Math.max(MIN_EXPORT_PPI, memoryLimit));
});

test('large print formats are flagged against the mobile canvas limit', () => {
  const large = getPrintDimensions('30x45', 'portrait', 300);
  const medium = getPrintDimensions('20x30', 'portrait', 300);
  const a4 = getPrintDimensions('a4', 'landscape', 300, 2);
  assert.equal(exceedsSafeCanvas(large.widthPx, large.heightPx), true);
  assert.equal(exceedsSafeCanvas(medium.widthPx, medium.heightPx), false);
  assert.equal(exceedsSafeCanvas(a4.widthPx, a4.heightPx), false);
});

test('photos above 40 megapixels are considered large', () => {
  assert.equal(megapixels(4000, 3000), 12);
  assert.equal(isLargePhoto(4000, 3000), false);
  assert.equal(isLargePhoto(8000, 6000), true);
});
