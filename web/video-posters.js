import {apiURL} from './format.js';
import {createLoadQueue} from './load-queue.js';

/**
 * @typedef {{signal?: AbortSignal, priority?: () => number}} VideoWorkOptions
 *   signal aborts when the card is gone: queued work is dropped; priority orders
 *   the queue (see load-queue.js)
 */

// Missing video posters are rendered by the browser one at a time and uploaded
// to the server cache, so the NAS needs no video tooling.
const previewQueue = createLoadQueue({concurrency: 1});
const previews = createPosterGenerator({queue: previewQueue, generate: createVideoPreview});

/**
 * `onFailure` runs when the poster cannot be generated, now or in an earlier attempt.
 * @param {VideoWorkOptions} [options]
 */
export function queueVideoPreview(item, poster, onFailure = () => {}, options = {}) {
  previews.request(item, {
    ...options,
    onFailure,
    onReady: url => {
      poster.classList.remove('is-missing');
      poster.src = url;
    },
  });
}

/**
 * @typedef {{path: string, modTime: string, size: number}} VideoItem
 * @typedef {{onReady: (url: string) => void, onFailure: () => void, priority?: () => number}} PosterSubscriber
 */

/**
 * One poster generation and upload per video version (path, modTime, size).
 * Tiles subscribe to it; a tile whose signal aborts only unsubscribes. A queued
 * generation left without subscribers is dropped; a running one finishes and
 * delivers to the tiles subscribed by then.
 * @param {{queue: ReturnType<typeof createLoadQueue>, generate: (item: VideoItem) => Promise<string>}} options
 *   generate renders and uploads the poster and resolves to its ready URL
 */
export function createPosterGenerator({queue, generate}) {
  /** @type {Map<string, {subscribers: Set<PosterSubscriber>, controller: AbortController, started: boolean}>} */
  const pending = new Map();
  /** @type {Set<string>} */
  const failed = new Set();

  /**
   * @param {VideoItem} item
   * @param {{onReady: (url: string) => void, onFailure?: () => void, signal?: AbortSignal, priority?: () => number}} subscriber
   */
  function request(item, {onReady, onFailure = () => {}, signal, priority}) {
    const key = `${item.path}\n${item.modTime}-${item.size}`;
    if (failed.has(key)) return onFailure();
    if (signal?.aborted) return;
    /** @type {PosterSubscriber} */
    const subscriber = {onReady, onFailure, priority};
    const known = pending.get(key);
    const job = known ?? {subscribers: new Set(), controller: new AbortController(), started: false};
    job.subscribers.add(subscriber);
    signal?.addEventListener('abort', () => {
      job.subscribers.delete(subscriber);
      if (job.subscribers.size || job.started) return;
      job.controller.abort();
      pending.delete(key);
    }, {once: true});
    if (known) return;
    pending.set(key, job);
    queue.add(async () => {
      job.started = true;
      try {
        const url = await generate(item);
        for (const each of job.subscribers) each.onReady(url);
      } catch {
        failed.add(key);
        for (const each of job.subscribers) each.onFailure();
      } finally {
        pending.delete(key);
      }
    }, {
      signal: job.controller.signal,
      priority: () => Math.min(...[...job.subscribers].map(each => each.priority?.() ?? 0)),
    });
  }

  return {
    request,
    /** Video versions with a queued or running generation. */
    get pending() {
      return pending.size;
    },
  };
}

/** Pause or resume video work; reads already running finish. @param {boolean} paused */
export function pauseVideoWork(paused) {
  previewQueue.setConcurrency(paused ? 0 : 1);
  durationQueue.setConcurrency(paused ? 0 : 1);
}

/** Start queued video work whose priority changed. */
export function wakeVideoWork() {
  previewQueue.wake();
  durationQueue.wake();
}

/** Render, upload, and return the ready URL of a poster. */
async function createVideoPreview(item) {
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
    return `${apiURL('/api/video-poster', item.path, version)}&ready=1`;
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
// Jobs of an aborted card neither start a read nor call back; their reads are not cached.
const durationQueue = createLoadQueue({concurrency: 1});
const durations = new Map();

/**
 * Call `onDuration(seconds)` once the duration of a video is known.
 * @param {AbortSignal} [signal] aborted when the card leaves the grid
 * @param {() => number} [priority] queue priority, see load-queue.js
 */
export function queueVideoDuration(item, onDuration, signal, priority) {
  const key = `${item.path}\n${item.modTime}-${item.size}`;
  const deliver = () => {
    const seconds = durations.get(key);
    if (seconds && !signal?.aborted) onDuration(seconds);
  };
  if (durations.has(key)) return deliver();
  durationQueue.add(async () => {
    if (!durations.has(key)) {
      try {
        durations.set(key, await readVideoDuration(item, signal));
      } catch {
        if (!signal?.aborted) durations.set(key, 0);
      }
    }
    deliver();
  }, {signal, priority});
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
