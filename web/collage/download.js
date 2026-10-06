// @ts-check

/**
 * Universal HTTP-compatible save path. It deliberately does not depend on
 * secure-context File System Access APIs.
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
  const anchor = document.createElement('a');
  const url = URL.createObjectURL(blob);
  anchor.href = url;
  anchor.download = safeDownloadName(filename);
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** @param {string} name */
export function safeDownloadName(name) {
  const safe = name.replace(/[\\/\u0000-\u001f<>:"|?*]/g, '_').trim();
  return safe && safe !== '.' && safe !== '..' ? safe : 'collage.jpg';
}

/** @param {number} bytes */
export function formatDownloadSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} Б`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
}
