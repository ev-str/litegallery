import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPTIONAL_BLEED_MM,
  PRINT_FORMATS,
  estimateRgbaBytes,
  getPrintDimensions,
  getPrintFormat,
  mmToPixels,
} from '../../web/collage/formats.js';
import {
  COLLAGE_TEMPLATES,
  assertTemplatePartition,
  getDefaultTemplate,
  getTemplate,
  getTemplatesForCount,
} from '../../web/collage/templates.js';

const EXPECTED_FORMATS = [
  ['10x15', 100, 150],
  ['13x18', 130, 180],
  ['15x20', 150, 200],
  ['20x30', 200, 300],
  ['30x45', 300, 450],
  ['a4', 210, 297],
];

test('print formats expose the approved physical sizes and exact A4 dimensions', () => {
  assert.deepEqual(
    PRINT_FORMATS.map(({id, widthMm, heightMm}) => [id, widthMm, heightMm]),
    EXPECTED_FORMATS,
  );
  assert.deepEqual(getPrintFormat('a4'), {
    id: 'a4',
    label: 'A4 · 21 × 29,7 см',
    widthMm: 210,
    heightMm: 297,
  });
  assert.throws(() => getPrintFormat('letter'), /Unknown print format/);
});

test('millimetres are converted to pixels by rounding only the final result', () => {
  assert.equal(mmToPixels(210, 300), 2480);
  assert.equal(mmToPixels(297, 300), 3508);
  assert.equal(mmToPixels(300, 450), 5315);
  assert.throws(() => mmToPixels(-1, 300), RangeError);
  assert.throws(() => mmToPixels(100, 0), RangeError);
});

test('2 mm bleed is added on every side and trim remains the requested size', () => {
  assert.equal(OPTIONAL_BLEED_MM, 2);
  assert.deepEqual(getPrintDimensions('a4', 'portrait', 300, OPTIONAL_BLEED_MM), {
    trimWidthMm: 210,
    trimHeightMm: 297,
    outputWidthMm: 214,
    outputHeightMm: 301,
    widthPx: 2528,
    heightPx: 3555,
    trimOffsetPx: 24,
    ppi: 300,
    bleedMm: 2,
  });

  const landscape = getPrintDimensions('10x15', 'landscape', 300, 2);
  assert.deepEqual(
    [landscape.trimWidthMm, landscape.trimHeightMm, landscape.outputWidthMm, landscape.outputHeightMm],
    [150, 100, 154, 104],
  );
  assert.equal(landscape.widthPx, mmToPixels(154, 300));
  assert.equal(landscape.heightPx, mmToPixels(104, 300));
  assert.throws(() => getPrintDimensions('a4', 'square', 300), /orientation/i);
  assert.throws(() => getPrintDimensions('a4', 'portrait', 300, -1), /bleed/i);
});

test('RGBA memory estimate uses four bytes per output pixel', () => {
  assert.equal(estimateRgbaBytes(2528, 3555), 2528 * 3555 * 4);
  assert.equal(estimateRgbaBytes(10.1, 20.1), 11 * 21 * 4);
});

test('every count from 2 through 12 has immutable, full-canvas templates', () => {
  const allIds = new Set();
  for (let count = 2; count <= 12; count += 1) {
    const templates = getTemplatesForCount(count);
    assert.ok(templates.length >= 2, `${count} photos should offer multiple layouts`);
    assert.equal(getDefaultTemplate(count), templates[0]);
    for (const template of templates) {
      assert.equal(template.photoCount, count);
      assert.equal(template.cells.length, count);
      assert.equal(Object.isFrozen(template), true);
      assert.equal(Object.isFrozen(template.cells), true);
      assert.doesNotThrow(() => assertTemplatePartition(template));
      assert.equal(allIds.has(template.id), false, `duplicate template id ${template.id}`);
      allIds.add(template.id);

      const totalArea = template.cells.reduce((sum, cell) => sum + cell.rect.width * cell.rect.height, 0);
      assert.ok(Math.abs(totalArea - 1) < 1e-7, `${template.id} leaves empty canvas space`);
      for (const cell of template.cells) {
        assert.match(cell.id, /^cell-\d+$/);
        assert.ok(['portrait', 'landscape', 'square'].includes(cell.preferredOrientation));
      }
      assert.equal(getTemplate(template.id), template);
    }
  }
  assert.equal(allIds.size, COLLAGE_TEMPLATES.length);
  assert.deepEqual(getTemplatesForCount(1), []);
  assert.deepEqual(getTemplatesForCount(13), []);
  assert.throws(() => getDefaultTemplate(1), /2 to 12/);
  assert.throws(() => getTemplate('missing-template'), /Unknown collage template/);
});

test('template validator rejects gaps, overlaps, and out-of-bounds cells', () => {
  const cell = (id, x, y, width, height) => ({id, rect: {x, y, width, height}, preferredOrientation: 'square'});
  assert.throws(
    () => assertTemplatePartition({id: 'gap', photoCount: 1, family: 'test', cells: [cell('a', 0, 0, 0.9, 1)]}),
    /does not fill/,
  );
  assert.throws(
    () => assertTemplatePartition({
      id: 'overlap',
      photoCount: 2,
      family: 'test',
      cells: [cell('a', 0, 0, 0.6, 1), cell('b', 0.4, 0, 0.4, 1)],
    }),
    /does not fill|overlapping/,
  );
  assert.throws(
    () => assertTemplatePartition({id: 'outside', photoCount: 1, family: 'test', cells: [cell('a', -0.1, 0, 1.1, 1)]}),
    /does not fill|invalid cell/,
  );
});

test('portrait-first templates cover counts three through twelve with exact partitions and at most three frames per column', () => {
  assert.equal(getTemplatesForCount(2).some(template => template.family === 'portrait'), false);
  for (let count = 3; count <= 12; count += 1) {
    const portraitTemplates = getTemplatesForCount(count).filter(template => template.family === 'portrait');
    assert.ok(portraitTemplates.length > 0, `missing portrait-first template for ${count} photos`);
    for (const template of portraitTemplates) {
      assert.doesNotThrow(() => assertTemplatePartition(template));
      const area = template.cells.reduce((sum, cell) => sum + cell.rect.width * cell.rect.height, 0);
      assert.ok(Math.abs(area - 1) < 1e-7, `${template.id} must fill the canvas exactly`);
      const portraitCanvasAspect = 2 / 3;
      assert.equal(
        template.cells.every(cell => portraitCanvasAspect * cell.rect.width / cell.rect.height < 0.85),
        true,
        `${template.id} is not clearly portrait-oriented on a 2:3 canvas`,
      );

      const cellsPerColumn = new Map();
      for (const cell of template.cells) {
        const column = cell.rect.x.toFixed(7);
        cellsPerColumn.set(column, (cellsPerColumn.get(column) || 0) + 1);
      }
      assert.ok(
        Math.max(...cellsPerColumn.values()) <= 3,
        `${template.id} stacks more than three rows in one column`,
      );
    }
  }
});
