// @ts-check

export const MAX_PROJECT_TITLE_LENGTH = 80;

/** @param {Date=} date */
export function defaultProjectTitle(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `Коллаж — ${year}-${month}-${day}`;
}

/** @param {unknown} value */
export function normalizeProjectTitle(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PROJECT_TITLE_LENGTH)
    .trim();
}

/** @param {unknown} value */
export function filenameBase(value) {
  const title = normalizeProjectTitle(value) || 'Коллаж';
  const safe = title
    .replace(/[\\/<>:"|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  return safe && safe !== '.' && safe !== '..' ? safe : 'Коллаж';
}

/** @param {unknown} title @param {'json'|'zip'|string} kind */
export function projectFilename(title, kind) {
  return `${filenameBase(title)}.${kind === 'zip' ? 'zip' : 'json'}`;
}

/** @param {unknown} title @param {{formatId: string, ppi: number}} print */
export function jpegFilename(title, print) {
  return `${filenameBase(title)} — ${print.formatId} — ${print.ppi}ppi.jpg`;
}
