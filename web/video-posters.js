import {apiURL} from './format.js';

// Missing video posters are rendered by the browser one at a time and uploaded
// to the server cache, so the NAS needs no video tooling.
let queue = Promise.resolve();
const pending = new Set();
const failed = new Set();

export function queueVideoPreview(item, poster) {
  if (pending.has(item.path) || failed.has(item.path)) return;
  pending.add(item.path);
  queue = queue
    .then(() => createVideoPreview(item, poster))
    .catch(() => failed.add(item.path))
    .finally(() => pending.delete(item.path));
}

async function createVideoPreview(item, poster) {
  const version = `${item.modTime}-${item.size}`;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = apiURL('/api/media', item.path, version);
  try {
    await waitForVideoFrame(video);
    const scale = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const jpeg = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('cannot encode poster')), 'image/jpeg', .82));
    const response = await fetch(apiURL('/api/video-poster', item.path, version), {
      method: 'PUT',
      headers: {'Content-Type': 'image/jpeg'},
      body: jpeg,
    });
    if (!response.ok) throw new Error('cannot cache poster');
    poster.classList.remove('is-missing');
    poster.src = `${apiURL('/api/video-poster', item.path, version)}&ready=1`;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

function waitForVideoFrame(video) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('video preview timeout')), 15000);
    const finish = error => {
      clearTimeout(timeout);
      video.removeEventListener('loadeddata', loaded);
      video.removeEventListener('error', failedLoad);
      error ? reject(error) : resolve();
    };
    const loaded = () => finish();
    const failedLoad = () => finish(new Error('video preview unavailable'));
    video.addEventListener('loadeddata', loaded, {once: true});
    video.addEventListener('error', failedLoad, {once: true});
    video.load();
  });
}
