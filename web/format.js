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

const imageFormats = {jpg: 'JPEG', jpeg: 'JPEG', png: 'PNG', gif: 'GIF', bmp: 'BMP', tif: 'TIFF', tiff: 'TIFF'};

/** Short file type label: 'JPEG', 'PNG', … for photos, 'Видео' for videos. */
export function formatFileType(item) {
  if (item.kind === 'video') return 'Видео';
  const extension = (item.name || '').split('.').pop()?.toLowerCase() || '';
  return imageFormats[extension] || extension.toUpperCase() || 'Фото';
}

/** Secondary tile line: 'JPEG · 3.1 МБ'. */
export const formatFileDetails = item => [formatFileType(item), formatBytes(item.size)].filter(Boolean).join(' · ');

const dateFormatter = new Intl.DateTimeFormat('ru', {day: 'numeric', month: 'short', year: 'numeric'});

/** Capture (or file creation) date from a Unix timestamp in seconds. */
export const formatDate = seconds => (seconds ? dateFormatter.format(new Date(seconds * 1000)) : '');

/** Video duration: '0:42', '12:05', '1:02:09'. */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}
