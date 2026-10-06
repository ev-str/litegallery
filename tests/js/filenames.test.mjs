import assert from 'node:assert/strict';
import test from 'node:test';

import {defaultProjectTitle, filenameBase, jpegFilename, normalizeProjectTitle, projectFilename} from '../../web/collage/filenames.js';

test('new collage titles use a readable local date instead of a random name', () => {
  assert.equal(defaultProjectTitle(new Date(2026, 9, 5)), 'Коллаж — 2026-10-05');
});

test('project and JPEG filenames preserve readable names and remove unsafe path characters', () => {
  assert.equal(normalizeProjectTitle('  Пироги   на даче  '), 'Пироги на даче');
  assert.equal(filenameBase('Пироги / май:*?'), 'Пироги май');
  assert.equal(projectFilename('Пироги / май', 'json'), 'Пироги май.json');
  assert.equal(projectFilename('Пироги / май', 'zip'), 'Пироги май.zip');
  assert.equal(jpegFilename('Пироги / май', {formatId: '13x18', ppi: 300}), 'Пироги май — 13x18 — 300ppi.jpg');
});

test('empty and control-only names fall back to a stable collage filename', () => {
  assert.equal(projectFilename('\u0000\u0007', 'json'), 'Коллаж.json');
  assert.equal(jpegFilename('', {formatId: 'A4', ppi: 300}), 'Коллаж — A4 — 300ppi.jpg');
});
