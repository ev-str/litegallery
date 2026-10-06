/** Gallery API URL with an optional cache-busting version. */
export const apiURL = (endpoint, path, version = '') => `${endpoint}?path=${encodeURIComponent(path)}${version ? `&v=${encodeURIComponent(version)}` : ''}`;

export function formatBytes(bytes) {
  if (!bytes) return '';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

/** Russian plural: formatCount(3, ['файл', 'файла', 'файлов']) → '3 файла'. */
export function formatCount(value, forms) {
  const mod10 = value % 10;
  const mod100 = value % 100;
  const form = mod10 === 1 && mod100 !== 11 ? forms[0] : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? forms[1] : forms[2];
  return `${value} ${form}`;
}
