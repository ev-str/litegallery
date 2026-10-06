// @ts-check

import {validateProject} from './model.js';
import {isCollageSupportedPath} from './support.js';

export const PROJECT_FORMAT = 'litegallery-collage';
export const PROJECT_FORMAT_VERSION = 1;

/** @typedef {{ok: true, project: Record<string, any>}|{ok: false, reason: 'invalid'|'newer-version'|'older-version', message: string, formatVersion?: number}} ProjectValidation */

/**
 * @param {Record<string, any>} state
 * @param {string} appVersion
 */
export function createProjectDocument(state, appVersion) {
  return {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    appVersion,
    createdAt: new Date().toISOString(),
    project: structuredClone(state),
  };
}

/** @param {unknown} input @returns {ProjectValidation} */
export function validateProjectDocument(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('Файл проекта повреждён');
  const document = /** @type {Record<string, any>} */ (input);
  if (document.format !== PROJECT_FORMAT || !Number.isInteger(document.formatVersion)) return invalid('Неизвестный формат проекта');
  if (document.formatVersion > PROJECT_FORMAT_VERSION) {
    return {ok: false, reason: 'newer-version', formatVersion: document.formatVersion, message: 'Проект создан в более новой версии LiteGallery'};
  }
  if (document.formatVersion < PROJECT_FORMAT_VERSION) {
    return {ok: false, reason: 'older-version', formatVersion: document.formatVersion, message: 'Для проекта требуется миграция'};
  }
  if (!document.project || typeof document.project !== 'object' || !isValidProject(document.project)) return invalid('В проекте отсутствуют обязательные поля');
  const unsupported = Object.values(document.project.sources ?? {}).filter(source => !isCollageSupportedPath(source?.path ?? ''));
  if (unsupported.length) {
    return invalid(`Проект содержит фото в формате, который нельзя использовать в коллаже (TIFF): ${unsupported.map(source => source.name || source.path).join(', ')}`);
  }
  return {ok: true, project: structuredClone(document.project)};
}

/** @param {Blob} blob */
export async function readProjectBlob(blob) {
  if (blob.size > 10 * 1024 * 1024) return invalid('Файл разметки слишком большой');
  try {
    return validateProjectDocument(JSON.parse(await blob.text()));
  } catch {
    return invalid('Не удалось прочитать JSON проекта');
  }
}

/** @param {Record<string, any>} document */
export function projectJsonBlob(document) {
  const validation = validateProjectDocument(document);
  if (!validation.ok && validation.reason !== 'older-version') throw new TypeError(validation.message);
  return new Blob([JSON.stringify(document, null, 2)], {type: 'application/json'});
}

/**
 * ZIP implementation is injected so LiteGallery can vendor one audited,
 * CSP-compatible implementation later without coupling project state to it.
 * @param {Record<string, any>} document
 * @param {Array<{name: string, blob: Blob, sourceId?: string}>} photos
 * @param {{create: (entries: Array<{name: string, blob: Blob}>) => Promise<Blob>}} adapter
 */
export async function projectZipBlob(document, photos, adapter = {create: createStoredZip}) {
  const used = new Set(['project.json']);
  const sourceIds = Object.keys(document.project?.sources ?? {}).sort();
  /** @type {Record<string, string>} */
  const photoMap = {};
  /** @type {Array<{name: string, blob: Blob}>} */
  const photoEntries = [];
  /** @type {TypeError|null} */
  let coverageError = null;
  for (let index = 0; index < photos.length; index++) {
    const photo = photos[index];
    const safeName = uniqueSafeName(photo.name, used, index);
    const entryName = `photos/${safeName}`;
    const sourceId = photo.sourceId ?? sourceIds[index];
    if (sourceId) {
      if (!document.project?.sources?.[sourceId]) throw new TypeError(`Unknown photo source: ${sourceId}`);
      if (photoMap[sourceId]) throw new TypeError(`Duplicate photo source: ${sourceId}`);
      photoMap[sourceId] = entryName;
    } else if (!coverageError) {
      coverageError = new TypeError(`Unexpected embedded photo without a project source: ${photo.name}`);
    }
    photoEntries.push({name: entryName, blob: photo.blob});
  }
  const missingSourceIds = sourceIds.filter(sourceId => !photoMap[sourceId]);
  if (missingSourceIds.length > 0 && !coverageError) {
    coverageError = new TypeError(`ZIP project is missing photo mappings for sources: ${missingSourceIds.join(', ')}`);
  }
  const archiveDocument = structuredClone(document);
  archiveDocument.assets = {photos: photoMap};
  const manifest = projectJsonBlob(archiveDocument);
  const entries = [{name: 'project.json', blob: manifest}, ...photoEntries];
  const result = await adapter.create(entries);
  if (!(result instanceof Blob) || result.type !== 'application/zip') throw new TypeError('ZIP adapter returned an invalid Blob');
  if (coverageError) throw coverageError;
  return result;
}

/** @param {any} project */
function isValidProject(project) {
  const result = validateProject(project);
  return result.valid && (project.print?.bleedMm === 0 || project.print?.bleedMm === 2);
}

/** @param {string} message @returns {ProjectValidation} */
function invalid(message) {
  return {ok: false, reason: 'invalid', message};
}

/** @param {string} name @param {Set<string>} used @param {number} index */
function uniqueSafeName(name, used, index) {
  const base = name.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+/, '') || `photo-${index + 1}.jpg`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${suffix++}-${base}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Dependency-free ZIP store writer. JPEG files are already compressed, so the
 * store method avoids wasting memory and CPU on ineffective recompression.
 * Entry bytes are read only to compute CRC32; the archive references the
 * original Blobs, so each photo is not held twice while the ZIP is assembled.
 * @param {Array<{name: string, blob: Blob}>} entries
 */
export async function createStoredZip(entries) {
  if (entries.length > 65_535) throw new RangeError('ZIP contains too many files');
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const size = entry.blob.size;
    if (name.length > 65_535 || size > 0xffffffff || offset > 0xffffffff) throw new RangeError('ZIP32 size limit exceeded');
    const checksum = crc32(new Uint8Array(await entry.blob.arrayBuffer()));
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, size, true);
    localView.setUint32(22, size, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    locals.push(local, entry.blob);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, size, true);
    centralView.setUint32(24, size, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length + size;
  }
  const centralOffset = offset;
  const centralSize = centrals.reduce((sum, value) => sum + value.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  return new Blob([...locals, ...centrals, end], {type: 'application/zip'});
}

export const DEFAULT_ZIP_LIMITS = Object.freeze({
  maxArchiveBytes: 1024 * 1024 * 1024,
  maxCentralDirectoryBytes: 16 * 1024 * 1024,
  maxFiles: 100,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalUncompressedBytes: 1024 * 1024 * 1024,
  maxProjectBytes: 10 * 1024 * 1024,
});

/**
 * Read the deliberately small ZIP32 STORE subset emitted by createStoredZip.
 * The central directory is validated before any file payload is allocated.
 * @param {Blob} archive
 * @param {Partial<typeof DEFAULT_ZIP_LIMITS>} [requestedLimits]
 * @returns {Promise<{
 *   document: Record<string, any>,
 *   project: Record<string, any>,
 *   entries: Array<{name: string, blob: Blob}>,
 *   photosBySource: Map<string, {entryName: string, blob: Blob}>
 * }>}
 */
export async function readProjectZip(archive, requestedLimits = {}) {
  const limits = normalizeZipLimits(requestedLimits);
  if (!(archive instanceof Blob)) throw new TypeError('ZIP project must be a Blob');
  if (archive.size < 22) throw zipError('ZIP archive is truncated');
  if (archive.size > limits.maxArchiveBytes) throw zipError('ZIP archive is too large');

  const eocd = await findEndOfCentralDirectory(archive);
  if (eocd.diskNumber !== 0 || eocd.centralDisk !== 0 || eocd.entriesOnDisk !== eocd.entryCount) {
    throw zipError('Multi-disk ZIP archives are not supported');
  }
  if (eocd.entryCount === 0xffff || eocd.centralSize === 0xffffffff || eocd.centralOffset === 0xffffffff) {
    throw zipError('ZIP64 archives are not supported');
  }
  if (eocd.entryCount > limits.maxFiles) throw zipError('ZIP contains too many files');
  if (eocd.centralSize > limits.maxCentralDirectoryBytes) throw zipError('ZIP central directory is too large');
  if (eocd.centralOffset + eocd.centralSize > eocd.offset || eocd.centralOffset + eocd.centralSize > archive.size) {
    throw zipError('ZIP central directory is outside the archive');
  }

  const centralBytes = new Uint8Array(await archive.slice(eocd.centralOffset, eocd.centralOffset + eocd.centralSize).arrayBuffer());
  const decoder = new TextDecoder('utf-8', {fatal: true});
  /** @type {Array<{name: string, flags: number, method: number, crc: number, compressedSize: number, uncompressedSize: number, localOffset: number}>} */
  const metadata = [];
  const names = new Set();
  let totalUncompressed = 0;
  let cursor = 0;
  for (let index = 0; index < eocd.entryCount; index++) {
    if (cursor + 46 > centralBytes.length) throw zipError('ZIP central directory entry is truncated');
    const view = new DataView(centralBytes.buffer, centralBytes.byteOffset + cursor, 46);
    if (view.getUint32(0, true) !== 0x02014b50) throw zipError('Invalid ZIP central directory signature');
    const flags = view.getUint16(8, true);
    const method = view.getUint16(10, true);
    const crc = view.getUint32(16, true);
    const compressedSize = view.getUint32(20, true);
    const uncompressedSize = view.getUint32(24, true);
    const nameLength = view.getUint16(28, true);
    const extraLength = view.getUint16(30, true);
    const commentLength = view.getUint16(32, true);
    const diskStart = view.getUint16(34, true);
    const localOffset = view.getUint32(42, true);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > centralBytes.length) throw zipError('ZIP central directory variable fields are truncated');
    if (diskStart !== 0) throw zipError('Multi-disk ZIP entries are not supported');
    if ((flags & 0x0001) !== 0) throw zipError('Encrypted ZIP entries are not supported');
    if ((flags & 0x0008) !== 0) throw zipError('ZIP data descriptors are not supported');
    if ((flags & 0x0800) === 0) throw zipError('ZIP entry names must be UTF-8');
    if (method !== 0) throw zipError('Only ZIP STORE entries are supported');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw zipError('ZIP64 entries are not supported');
    if (compressedSize !== uncompressedSize) throw zipError('Invalid STORE entry sizes');
    if (uncompressedSize > limits.maxEntryBytes) throw zipError('ZIP entry is too large');
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > limits.maxTotalUncompressedBytes) throw zipError('ZIP uncompressed size limit exceeded');
    let name;
    try {
      name = decoder.decode(centralBytes.subarray(cursor + 46, cursor + 46 + nameLength));
    } catch {
      throw zipError('ZIP entry name is not valid UTF-8');
    }
    const extraStart = cursor + 46 + nameLength;
    if (containsZip64Extra(centralBytes.subarray(extraStart, extraStart + extraLength))) throw zipError('ZIP64 entries are not supported');
    assertSafeZipPath(name);
    const normalizedName = name.toLowerCase();
    if (names.has(normalizedName)) throw zipError(`Duplicate ZIP entry: ${name}`);
    names.add(normalizedName);
    metadata.push({name, flags, method, crc, compressedSize, uncompressedSize, localOffset});
    cursor = end;
  }
  if (cursor !== centralBytes.length) throw zipError('ZIP central directory size does not match its entries');

  const projectEntries = metadata.filter(entry => entry.name === 'project.json');
  if (projectEntries.length !== 1) throw zipError('ZIP project must contain exactly one project.json');
  if (projectEntries[0].uncompressedSize > limits.maxProjectBytes) throw zipError('project.json is too large');

  /** @type {Array<{name: string, blob: Blob}>} */
  const entries = [];
  for (const entry of metadata) {
    const blob = await readStoredEntry(archive, entry, eocd.centralOffset);
    entries.push({name: entry.name, blob});
  }
  const projectEntry = entries.find(entry => entry.name === 'project.json');
  if (!projectEntry) throw zipError('project.json is missing');
  let document;
  try {
    const bytes = new Uint8Array(await projectEntry.blob.arrayBuffer());
    document = JSON.parse(decoder.decode(bytes));
  } catch {
    throw zipError('project.json is not valid UTF-8 JSON');
  }
  const validation = validateProjectDocument(document);
  if (!validation.ok) throw zipError(validation.message);

  const assets = document.assets?.photos;
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) throw zipError('ZIP project has no source-to-photo mapping');
  const byName = new Map(entries.map(entry => [entry.name, entry.blob]));
  /** @type {Map<string, {entryName: string, blob: Blob}>} */
  const photosBySource = new Map();
  const mappedPhotoEntries = new Set();
  for (const [sourceId, entryName] of Object.entries(assets)) {
    if (!document.project.sources?.[sourceId]) throw zipError(`Photo mapping refers to an unknown source: ${sourceId}`);
    if (typeof entryName !== 'string' || !entryName.startsWith('photos/')) throw zipError(`Invalid photo entry mapping: ${sourceId}`);
    const blob = byName.get(entryName);
    if (!blob) throw zipError(`Mapped photo is missing: ${entryName}`);
    if (mappedPhotoEntries.has(entryName)) throw zipError(`Duplicate photo mapping for ZIP entry: ${entryName}`);
    mappedPhotoEntries.add(entryName);
    photosBySource.set(sourceId, {entryName, blob});
  }
  for (const sourceId of Object.keys(document.project.sources ?? {})) {
    if (!Object.hasOwn(assets, sourceId)) throw zipError(`Photo mapping is missing for source: ${sourceId}`);
  }
  const unreferencedPhoto = entries.find(entry => entry.name.startsWith('photos/') && !mappedPhotoEntries.has(entry.name));
  if (unreferencedPhoto) throw zipError(`Embedded photo is not mapped to a source: ${unreferencedPhoto.name}`);
  return {document, project: validation.project, entries, photosBySource};
}

/** @param {Partial<typeof DEFAULT_ZIP_LIMITS>} requested */
function normalizeZipLimits(requested) {
  const limits = {...DEFAULT_ZIP_LIMITS, ...requested};
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid ZIP limit: ${name}`);
  }
  return limits;
}

/** @param {Blob} archive */
async function findEndOfCentralDirectory(archive) {
  const tailLength = Math.min(archive.size, 22 + 65_535);
  const tailOffset = archive.size - tailLength;
  const tail = new Uint8Array(await archive.slice(tailOffset).arrayBuffer());
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    const view = new DataView(tail.buffer, tail.byteOffset + offset, tail.length - offset);
    if (view.getUint32(0, true) !== 0x06054b50) continue;
    const commentLength = view.getUint16(20, true);
    if (offset + 22 + commentLength !== tail.length) continue;
    return {
      offset: tailOffset + offset,
      diskNumber: view.getUint16(4, true),
      centralDisk: view.getUint16(6, true),
      entriesOnDisk: view.getUint16(8, true),
      entryCount: view.getUint16(10, true),
      centralSize: view.getUint32(12, true),
      centralOffset: view.getUint32(16, true),
    };
  }
  throw zipError('ZIP end-of-central-directory record was not found');
}

/**
 * @param {Blob} archive
 * @param {{name: string, flags: number, method: number, crc: number, compressedSize: number, uncompressedSize: number, localOffset: number}} entry
 * @param {number} centralOffset
 */
async function readStoredEntry(archive, entry, centralOffset) {
  if (entry.localOffset + 30 > centralOffset) throw zipError(`Local ZIP header is outside file data: ${entry.name}`);
  const fixed = new Uint8Array(await archive.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
  if (fixed.length !== 30) throw zipError(`Local ZIP header is truncated: ${entry.name}`);
  const view = new DataView(fixed.buffer, fixed.byteOffset, fixed.byteLength);
  if (view.getUint32(0, true) !== 0x04034b50) throw zipError(`Invalid local ZIP signature: ${entry.name}`);
  const flags = view.getUint16(6, true);
  const method = view.getUint16(8, true);
  const crc = view.getUint32(14, true);
  const compressedSize = view.getUint32(18, true);
  const uncompressedSize = view.getUint32(22, true);
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  if (flags !== entry.flags || method !== entry.method || crc !== entry.crc || compressedSize !== entry.compressedSize || uncompressedSize !== entry.uncompressedSize) {
    throw zipError(`ZIP local and central metadata differ: ${entry.name}`);
  }
  const nameStart = entry.localOffset + 30;
  const dataStart = nameStart + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > centralOffset || dataEnd > archive.size) throw zipError(`ZIP entry data is outside the archive: ${entry.name}`);
  const localNameBytes = new Uint8Array(await archive.slice(nameStart, nameStart + nameLength).arrayBuffer());
  let localName;
  try {
    localName = new TextDecoder('utf-8', {fatal: true}).decode(localNameBytes);
  } catch {
    throw zipError(`Local ZIP entry name is not valid UTF-8: ${entry.name}`);
  }
  if (localName !== entry.name) throw zipError(`ZIP local and central names differ: ${entry.name}`);
  const localExtra = new Uint8Array(await archive.slice(nameStart + nameLength, dataStart).arrayBuffer());
  if (containsZip64Extra(localExtra)) throw zipError(`ZIP64 entry is not supported: ${entry.name}`);
  const data = new Uint8Array(await archive.slice(dataStart, dataEnd).arrayBuffer());
  if (crc32(data) !== entry.crc) throw zipError(`ZIP CRC32 mismatch: ${entry.name}`);
  return new Blob([data], {type: mimeForZipEntry(entry.name)});
}

/** @param {string} name */
function assertSafeZipPath(name) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw zipError(`Unsafe ZIP entry path: ${name}`);
  }
  const segments = name.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) throw zipError(`Unsafe ZIP entry path: ${name}`);
}

/** @param {Uint8Array} extra */
function containsZip64Extra(extra) {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) throw zipError('ZIP extra field is truncated');
    const view = new DataView(extra.buffer, extra.byteOffset + offset, 4);
    const id = view.getUint16(0, true);
    const size = view.getUint16(2, true);
    if (offset + 4 + size > extra.length) throw zipError('ZIP extra field payload is truncated');
    if (id === 0x0001) return true;
    offset += 4 + size;
  }
  return false;
}

/** @param {string} name */
function mimeForZipEntry(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

/** @param {string} message */
function zipError(message) {
  const error = new Error(message);
  error.name = 'InvalidProjectZipError';
  return error;
}

/** @param {Uint8Array} bytes */
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
