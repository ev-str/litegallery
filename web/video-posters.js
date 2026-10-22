import {apiURL} from './format.js';

// Missing video posters are rendered by the browser one at a time and uploaded
// to the server cache, so the NAS needs no video tooling.
let queue = Promise.resolve();
const pending = new Set();
const failed = new Set();

/** `onFailure` runs when the poster cannot be generated, now or in an earlier attempt. */
export function queueVideoPreview(item, poster, onFailure = () => {}) {
  if (failed.has(item.path)) return onFailure();
  if (pending.has(item.path)) return;
  pending.add(item.path);
  queue = queue
    .then(() => createVideoPreview(item, poster))
    .catch(() => {
      failed.add(item.path);
      onFailure();
    })
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

// Durations are read from video metadata one file at a time and kept for the session.
// Jobs of an aborted render neither start a read nor call back; their reads are not cached.
let durationQueue = Promise.resolve();
const durations = new Map();

/**
 * Call `onDuration(seconds)` once the duration of a video is known.
 * @param {AbortSignal} [signal] aborted when the card's render is replaced
 */
export function queueVideoDuration(item, onDuration, signal) {
  const key = `${item.path}\n${item.modTime}-${item.size}`;
  const deliver = () => {
    const seconds = durations.get(key);
    if (seconds && !signal?.aborted) onDuration(seconds);
  };
  if (durations.has(key)) return deliver();
  durationQueue = durationQueue.then(async () => {
    if (signal?.aborted) return;
    if (!durations.has(key)) {
      try {
        durations.set(key, await readVideoDuration(item, signal));
      } catch {
        if (!signal?.aborted) durations.set(key, 0);
      }
    }
    deliver();
  });
}

function readVideoDuration(item, signal) {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'metadata';
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('video metadata timeout')), 10000);
    let done = false;
    const abort = () => finish(new Error('video metadata aborted'));
    const finish = error => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', abort);
      clearTimeout(timeout);
      const seconds = video.duration;
      video.removeAttribute('src');
      video.load();
      error ? reject(error) : resolve(Number.isFinite(seconds) ? seconds : 0);
    };
    video.addEventListener('loadedmetadata', () => finish(), {once: true});
    video.addEventListener('error', () => finish(new Error('video metadata unavailable')), {once: true});
    signal?.addEventListener('abort', abort, {once: true});
    video.src = apiURL('/api/media', item.path, `${item.modTime}-${item.size}`);
  });
}
