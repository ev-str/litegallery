import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {createSurfaces, routeSurfaceEntries, SURFACES} from '../../web/app-surfaces.js';
import {isProjectFile} from '../../web/collage-landing.js';

function fakeEntry() {
  const attributes = new Map();
  return {
    hidden: true,
    attributes,
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
  };
}

function surface(log, name) {
  return {
    panel: {hidden: true},
    entry: fakeEntry(),
    enter: previous => log.push(`enter ${name} from ${previous}`),
    leave: next => log.push(`leave ${name} to ${next}`),
  };
}

test('sections are listed in header order with the gallery first', () => {
  assert.deepEqual(SURFACES, ['gallery', 'search', 'memories', 'collage', 'status']);
});

test('a registered surface shows its entry; the gallery starts current', () => {
  const surfaces = createSurfaces();
  const gallery = surface([], 'gallery');
  const collage = surface([], 'collage');
  surfaces.register('gallery', gallery);
  surfaces.register('collage', collage);
  assert.equal(surfaces.current, 'gallery');
  assert.equal(gallery.panel.hidden, false);
  assert.equal(collage.panel.hidden, true);
  assert.equal(gallery.entry.hidden, false);
  assert.equal(collage.entry.hidden, false);
  assert.equal(gallery.entry.attributes.get('aria-current'), 'page');
  assert.equal(collage.entry.attributes.has('aria-current'), false);
  assert.equal(surfaces.has('search'), false);
});

test('switching leaves the old surface before hiding it and enters the new one after showing it', () => {
  const log = [];
  const changes = [];
  const surfaces = createSurfaces({onChange: (current, previous) => changes.push([current, previous])});
  const gallery = surface(log, 'gallery');
  const collage = surface(log, 'collage');
  gallery.leave = next => log.push(`leave gallery to ${next}, hidden ${gallery.panel.hidden}`);
  collage.enter = previous => log.push(`enter collage from ${previous}, hidden ${collage.panel.hidden}`);
  surfaces.register('gallery', gallery);
  surfaces.register('collage', collage);

  assert.equal(surfaces.show('collage'), true);
  assert.deepEqual(log, ['leave gallery to collage, hidden false', 'enter collage from gallery, hidden false']);
  assert.deepEqual(changes, [['collage', 'gallery']]);
  assert.equal(gallery.panel.hidden, true);
  assert.equal(collage.entry.attributes.get('aria-current'), 'page');
  assert.equal(gallery.entry.attributes.has('aria-current'), false);

  log.length = 0;
  assert.equal(surfaces.show('collage'), true, 'showing the current surface is a no-op');
  assert.deepEqual(log, []);
  assert.equal(surfaces.show('gallery'), true);
  assert.deepEqual(log, ['leave collage to gallery', 'enter gallery from collage']);
});

test('an unregistered surface cannot be opened and unknown names are rejected', () => {
  const surfaces = createSurfaces();
  surfaces.register('gallery', surface([], 'gallery'));
  assert.equal(surfaces.show('memories'), false);
  assert.equal(surfaces.current, 'gallery');
  assert.throws(() => surfaces.register('albums', surface([], 'albums')), /Unknown surface/);
  assert.throws(() => surfaces.register('gallery', surface([], 'gallery')), /already registered/);
});

test('a surface registered later opens like the others', () => {
  const surfaces = createSurfaces();
  surfaces.register('gallery', surface([], 'gallery'));
  const status = {panel: {hidden: true}};
  surfaces.register('status', status);
  assert.equal(surfaces.show('status'), true);
  assert.equal(status.panel.hidden, false);
});

test('project files are recognised by extension or MIME type', () => {
  assert.equal(isProjectFile({name: 'Коллаж.json', type: ''}), true);
  assert.equal(isProjectFile({name: 'COLLAGE.ZIP', type: ''}), true);
  assert.equal(isProjectFile({name: 'project', type: 'application/zip'}), true);
  assert.equal(isProjectFile({name: 'project', type: 'application/x-zip-compressed'}), true);
  assert.equal(isProjectFile({name: 'photo.png', type: 'image/png'}), false);
  assert.equal(isProjectFile({name: 'notes.json.txt', type: 'text/plain'}), false);
});

/** Header stand-in: nodes know their parent, and closest() walks up to the header. */
function fakeHeader() {
  let listener = null;
  const node = (attributes = {}, parent = null) => ({
    parent,
    attributes,
    getAttribute(name) { return this.attributes[name] ?? null; },
    closest(selector) {
      const name = selector.slice(1, -1);
      for (let current = this; current; current = current.parent) if (name in current.attributes) return current;
      return null;
    },
  });
  const header = node();
  header.addEventListener = (type, callback) => { listener = callback; };
  header.contains = target => {
    for (let current = target; current; current = current.parent) if (current === header) return true;
    return false;
  };
  return {header, node, click: target => listener({target})};
}

test('header routing opens a registered surface from an entry outside the text navigation', () => {
  const surfaces = createSurfaces();
  surfaces.register('gallery', surface([], 'gallery'));
  const {header, node, click} = fakeHeader();
  routeSurfaceEntries(header, surfaces);
  const navigation = node({}, header);
  const collageEntry = node({'data-surface-entry': 'collage'}, navigation);
  const statusEntry = node({'data-surface-entry': 'status'}, header);
  const statusIcon = node({}, statusEntry);
  const density = node({'data-density-step': '0'}, node({}, header));
  const refresh = node({}, header);

  click(statusIcon);
  assert.equal(surfaces.current, 'gallery', 'an unregistered status surface stays closed');

  const status = {panel: {hidden: true}, entry: fakeEntry()};
  surfaces.register('status', status);
  surfaces.register('collage', surface([], 'collage'));
  click(statusIcon);
  assert.equal(surfaces.current, 'status');
  assert.equal(status.panel.hidden, false);

  click(density);
  click(refresh);
  click(header);
  assert.equal(surfaces.current, 'status', 'other header controls do not switch the surface');

  click(collageEntry);
  assert.equal(surfaces.current, 'collage');
});

test('the app routes every header entry, including the separate status icon', async () => {
  const read = path => readFile(new URL(`../../web/${path}`, import.meta.url), 'utf8');
  const [index, app] = await Promise.all([read('index.html'), read('app.js')]);
  assert.match(app, /routeSurfaceEntries\(document\.querySelector\('\.topbar-actions'\), surfaces\)/);
  const actions = index.slice(index.indexOf('<div class="topbar-actions">'), index.indexOf('</header>'));
  for (const name of SURFACES) assert.match(actions, new RegExp(`data-surface-entry="${name}"`), `${name} entry must sit inside .topbar-actions`);
  assert.doesNotMatch(index.slice(index.indexOf('id="appSections"'), index.indexOf('id="gridDensity"')), /id="statusMode"/, 'status stays a separate icon');
});
