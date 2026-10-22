import assert from 'node:assert/strict';
import test from 'node:test';

import {formatBytes, formatDate, formatDuration, formatFileDetails, formatFileType} from '../../web/format.js';

test('file type labels come from the extension, videos are labelled as video', () => {
  assert.equal(formatFileType({kind: 'image', name: 'a.JPG'}), 'JPEG');
  assert.equal(formatFileType({kind: 'image', name: 'scan.tif'}), 'TIFF');
  assert.equal(formatFileType({kind: 'image', name: 'b.png'}), 'PNG');
  assert.equal(formatFileType({kind: 'video', name: 'c.mov'}), 'Видео');
});

test('file details join type and size and skip an unknown size', () => {
  const size = 3_250_000;
  assert.equal(formatFileDetails({kind: 'image', name: 'a.jpeg', size}), `JPEG · ${formatBytes(size)}`);
  assert.equal(formatFileDetails({kind: 'video', name: 'c.mp4'}), 'Видео');
});

test('durations use m:ss or h:mm:ss and ignore unusable values', () => {
  assert.equal(formatDuration(42.4), '0:42');
  assert.equal(formatDuration(725), '12:05');
  assert.equal(formatDuration(3729), '1:02:09');
  assert.equal(formatDuration(Number.NaN), '');
  assert.equal(formatDuration(Infinity), '');
  assert.equal(formatDuration(0), '');
});

test('dates are empty without a timestamp', () => {
  assert.equal(formatDate(0), '');
  assert.match(formatDate(Date.UTC(2026, 0, 15, 12) / 1000), /2026/);
});
