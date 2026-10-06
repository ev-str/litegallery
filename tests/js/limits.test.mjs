import assert from 'node:assert/strict';
import test from 'node:test';

import {PRINT_FORMATS, getPrintDimensions} from '../../web/collage/formats.js';
import {
  EXPORT_BYTES_PER_PIXEL,
  estimateExportBytes,
  exceedsSafeCanvas,
  exportMemoryBudget,
  isLargePhoto,
  maxPpiForMemory,
  megapixels,
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
          // Mirrors highestSafePpi: rounded down to 25 and capped at 600.
          const offered = Math.max(300, Math.floor(Math.min(maxPpiForMemory(format.id, orientation, bleedMm, budget), 600) / 25) * 25);
          if (offered === 300) continue;
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
