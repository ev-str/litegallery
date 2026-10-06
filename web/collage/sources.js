// @ts-check

import {createPhotoSource} from './model.js';
import {isCollageSupportedPath} from './support.js';

export {isCollageSupportedPath};

/** @typedef {import('./types.js').PhotoSource} PhotoSource */
/** @typedef {{path: string, name: string, kind: string, size?: number, modTime?: string}} SourceEntry */
/** @typedef {{entries: SourceEntry[]}} SourceListing */

/** @param {string} endpoint @param {string} path */
export function collageApiUrl(endpoint, path) {
  return `${endpoint}?path=${encodeURIComponent(path)}`;
}

/** @param {string} path */
export async function listSourceDirectory(path) {
  const response = await fetch(collageApiUrl('/api/list', path), {credentials: 'same-origin'});
  if (!response.ok) throw new Error('Не удалось открыть папку');
  return response.json();
}

/**
 * Resolve dimensions through the dedicated endpoint when available, then keep
 * compatibility with older LiteGallery servers.
 * @param {{path: string, name?: string, size?: number, modTime?: string}} entry
 * @returns {Promise<PhotoSource>}
 */
export async function resolvePhotoSource(entry) {
  let info = null;
  const infoResponse = await fetch(collageApiUrl('/api/image-info', entry.path), {credentials: 'same-origin'}).catch(() => null);
  if (infoResponse?.ok) info = await infoResponse.json();
  if (!(info?.width > 0) || !(info?.height > 0)) {
    const exifResponse = await fetch(collageApiUrl('/api/exif', entry.path), {credentials: 'same-origin'}).catch(() => null);
    if (exifResponse?.ok) {
      const exif = await exifResponse.json();
      if (exif.width > 0 && exif.height > 0) info = exif;
    }
  }
  if (!(info?.width > 0) || !(info?.height > 0)) {
    // The fallback intentionally decodes the preview thumbnail, not every
    // original. Newer servers provide exact dimensions through image-info.
    info = await dimensionsFromImage(collageApiUrl('/api/thumb', entry.path));
  }
  return createPhotoSource({...entry, width: info.width, height: info.height, mimeType: info.mimeType});
}

/**
 * Resolve source metadata and fully decode the original before the source
 * enters canonical project state. The editor calls this sequentially so large
 * camera files do not accumulate in memory during initial placement.
 * @param {{path: string, name?: string, size?: number, modTime?: string}} entry
 * @returns {Promise<PhotoSource>}
 */
export async function preparePhotoSource(entry) {
  const source = await resolvePhotoSource(entry);
  await decodeSourceImage(collageApiUrl('/api/media', entry.path));
  return source;
}

/**
 * Safari-safe image readiness barrier. `decode()` is preferred because load
 * alone can fire before pixels are ready; older Safari falls back to load.
 * @param {string} url
 * @returns {Promise<void>}
 */
export function decodeSourceImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    let settled = false;
    /** @param {Error=} error */
    const finish = (error) => {
      if (settled) return;
      settled = true;
      image.onload = null;
      image.onerror = null;
      error ? reject(error) : resolve();
    };
    image.onerror = () => finish(new Error('Не удалось загрузить фотографию'));
    image.onload = () => {
      if (typeof image.decode !== 'function') finish();
    };
    image.src = url;
    if (typeof image.decode === 'function') {
      image.decode().then(() => finish(), () => finish(new Error('Не удалось декодировать фотографию')));
    }
  });
}

/** @param {string} url */
function dimensionsFromImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({width: image.naturalWidth, height: image.naturalHeight});
    image.onerror = () => reject(new Error('Не удалось определить размер фотографии'));
    image.src = url;
  });
}

/**
 * Lazy single-folder navigator. Expanding the tree never changes the collage;
 * activating a branch only replaces the gallery photos shown below it.
 * @param {HTMLElement} container
 * @param {{onFolderChanged: (folder: {path: string, title: string, entries: any[]}) => void}} options
 */
export function createSourceTree(container, options) {
  container.replaceChildren();
  const tree = document.createElement('div');
  tree.className = 'collage-source-tree';
  container.append(tree);

  /** @type {Map<string, {details: HTMLDetailsElement, summary: HTMLElement, ensureLoaded: () => Promise<SourceListing>, title: string}>} */
  const branches = new Map();
  let activePath = '';
  let activationRevision = 0;

  /** @param {string} path */
  async function activate(path) {
    const branch = branches.get(path);
    if (!branch) return;
    const revision = ++activationRevision;
    const listing = await branch.ensureLoaded();
    if (revision !== activationRevision) return;
    activePath = path;
    for (const [branchPath, item] of branches) {
      const active = branchPath === path;
      item.summary.classList.toggle('is-active', active);
      item.summary.setAttribute('aria-current', active ? 'true' : 'false');
    }
    options.onFolderChanged({path, title: branch.title, entries: listing.entries.filter(entry => entry.kind === 'image' && isCollageSupportedPath(entry.path))});
  }

  /** @param {string} path @param {string} title @param {HTMLElement} parent */
  function addBranch(path, title, parent) {
    const details = document.createElement('details');
    details.className = 'collage-tree-branch';
    const summary = document.createElement('summary');
    const label = document.createElement('span');
    label.textContent = title;
    summary.append(label);
    const children = document.createElement('div');
    children.className = 'collage-tree-children';
    details.append(summary, children);
    parent.append(details);
    let loaded = false;
    /** @type {Promise<SourceListing>|null} */
    let loading = null;
    /** @type {SourceListing|null} */
    let listing = null;

    /** @returns {Promise<SourceListing>} */
    const ensureLoaded = async () => {
      if (loaded && listing) return listing;
      if (loading) return loading;
      loading = (async () => {
        children.textContent = 'Загрузка…';
        listing = /** @type {SourceListing} */ (await listSourceDirectory(path));
        loaded = true;
        children.replaceChildren();
        const folders = listing.entries.filter((entry) => entry.kind === 'directory');
        for (const folder of folders) addBranch(folder.path, folder.name, children);
        return listing;
      })();
      try {
        return await loading;
      } finally {
        loading = null;
      }
    };

    branches.set(path, {details, summary, ensureLoaded, title});

    details.addEventListener('toggle', () => {
      if (details.open) ensureLoaded().catch(error => { children.textContent = error.message; });
    });
    summary.addEventListener('click', () => {
      activate(path).catch(error => { children.textContent = error instanceof Error ? error.message : 'Папка недоступна'; });
    });
  }

  addBranch('', 'Все фото', tree);
  const root = branches.get('');
  if (root) {
    root.details.open = true;
    activate('').catch(error => { tree.textContent = error instanceof Error ? error.message : 'Галерея недоступна'; });
  }

  return Object.freeze({
    getActivePath: () => activePath,
    clear() {
      const branch = branches.get('');
      if (branch) {
        branch.details.open = true;
        activate('').catch(() => {});
      }
    },
  });
}
