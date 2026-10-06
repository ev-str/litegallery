import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import test from 'node:test';

import {iconLabelMarkup, iconMarkup} from '../../web/icons.js';

const read = path => readFile(new URL(`../../web/${path}`, import.meta.url), 'utf8');

test('every referenced icon exists in the index.html sprite', async () => {
  const index = await read('index.html');
  const defined = new Set([...index.matchAll(/<symbol id="icon-([a-z-]+)"/g)].map(match => match[1]));
  assert.ok(defined.size > 0, 'sprite must define symbols');

  const scripts = [
    ...(await readdir(new URL('../../web/', import.meta.url))).filter(name => name.endsWith('.js')),
    ...(await readdir(new URL('../../web/collage/', import.meta.url))).filter(name => name.endsWith('.js')).map(name => `collage/${name}`),
  ];
  const sources = [index, ...(await Promise.all(scripts.map(read)))].join('\n');
  // Lower-case literals inside iconMarkup(...) / iconLabelMarkup(...) calls are icon names,
  // including both branches of a ternary; labels never match [a-z-]+.
  const callArguments = [...sources.matchAll(/icon(?:Label)?Markup\(([^)]*)\)/g)].map(match => match[1]);
  const referenced = new Set([
    ...[...sources.matchAll(/href="#icon-([a-z-]+)"/g)].map(match => match[1]),
    ...callArguments.flatMap(args => [...args.matchAll(/'([a-z-]+)'/g)].map(match => match[1])),
  ]);
  assert.ok(referenced.size >= 15, `expected many icon references, found ${referenced.size}`);
  for (const name of referenced) assert.ok(defined.has(name), `missing sprite symbol: icon-${name}`);
});

test('icon markup is decorative and labels are escaped', () => {
  assert.equal(iconMarkup('x'), '<svg class="icon" aria-hidden="true" focusable="false"><use href="#icon-x"></use></svg>');
  assert.match(iconLabelMarkup('play', '<b>&"'), /<span>&lt;b&gt;&amp;&quot;<\/span>$/);
});
