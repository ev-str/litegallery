import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BACKGROUND_PALETTE,
  createFramePalette,
  normalizeHexColor,
} from '../../web/collage/palette.js';

const normalized = colors => colors.map(normalizeHexColor);

test('HEX normalization makes short, long, and mixed-case colors comparable', () => {
  assert.equal(normalizeHexColor('#abc'), '#AABBCC');
  assert.equal(normalizeHexColor(' #aAbBcC '), '#AABBCC');
  assert.throws(() => normalizeHexColor('#abcd'), /Invalid colour/);
  assert.throws(() => normalizeHexColor('rgb(1, 2, 3)'), /Invalid colour/);
});

test('default frame palettes contain eleven normalized case-insensitive unique colors', () => {
  for (const background of BACKGROUND_PALETTE) {
    const palette = createFramePalette(background.color);
    const colors = normalized(palette);
    assert.equal(colors.length, 11, `${background.id} must retain the intended palette size`);
    assert.equal(new Set(colors).size, 11, `${background.id} contains duplicate frame colors`);
    assert.deepEqual(palette, colors, `${background.id} must expose canonical uppercase HEX values`);
  }
});

test('frame palette order is deterministic and stable when requesting a shorter prefix', () => {
  for (const background of ['#f4e3d0', '#202120', '#ABC']) {
    const full = createFramePalette(background, 11);
    assert.deepEqual(createFramePalette(background.toUpperCase(), 11), full);
    assert.deepEqual(createFramePalette(background, 5), full.slice(0, 5));
  }
});

test('a selected frame color matches exactly one visible palette swatch', () => {
  for (const background of BACKGROUND_PALETTE) {
    const palette = createFramePalette(background.color);
    const selected = palette.at(-1).toLowerCase();
    const visibleMatches = palette.filter(color => normalizeHexColor(color) === normalizeHexColor(selected));
    assert.equal(visibleMatches.length, 1, `${background.id} renders the selected color more than once`);
  }
});

test('requested palette size is retained with unique colors wherever the eleven-color ring allows it', () => {
  for (let count = 1; count <= 11; count += 1) {
    const palette = normalized(createFramePalette('#DDE8E8', count));
    assert.equal(palette.length, count);
    assert.equal(new Set(palette).size, count, `requested ${count} colors but received duplicates`);
  }
});
