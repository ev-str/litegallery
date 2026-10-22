// @ts-check
// Slideshow state without the DOM: the order items are shown in and the one autoplay
// timer. The viewer owns the elements; manual Previous/Next and autoplay share this model.

export const INTERVALS = [5, 10, 30];
export const DEFAULT_INTERVAL = 5;
export const INTERVAL_KEY = 'viewer-slideshow-interval';

/** Stored interval in seconds; anything unknown or unreadable falls back to the default. @param {Pick<Storage, 'getItem'>|null|undefined} storage */
export function readInterval(storage) {
  try {
    const stored = Number(storage?.getItem(INTERVAL_KEY));
    return INTERVALS.includes(stored) ? stored : DEFAULT_INTERVAL;
  } catch {
    return DEFAULT_INTERVAL;
  }
}

/** @param {Pick<Storage, 'setItem'>|null|undefined} storage @param {number} seconds */
export function writeInterval(storage, seconds) {
  if (!INTERVALS.includes(seconds)) return;
  try {
    storage?.setItem(INTERVAL_KEY, String(seconds));
  } catch {
    // Private browsing may refuse storage; the interval still applies to this session.
  }
}

/**
 * Navigation order over `length` items. In order mode Next and Previous step through the
 * list. In shuffle mode the walk is remembered: Previous retraces it, Next replays it before
 * choosing anything new, and a new choice prefers items not yet shown in this round and is
 * never the current item while another one is available.
 * @param {{random?: () => number}} [options]
 */
export function createPlaylist({random = Math.random} = {}) {
  let length = 0;
  let shuffle = false;
  /** @type {number[]} */
  let history = [];
  let position = 0;
  /** @type {Set<number>} */
  let seen = new Set();

  const current = () => history[position] ?? -1;

  /** Start over from `start`, e.g. when the viewer opens or the order changes. */
  function reset(/** @type {number} */ count, /** @type {number} */ start) {
    length = count;
    history = [start];
    position = 0;
    seen = new Set([start]);
  }

  /** A random unseen item other than the current one, or null if there is none. @param {Set<number>} skip */
  function pick(skip) {
    const all = Array.from({length}, (_, index) => index).filter(index => index !== current() && !skip.has(index));
    let pool = all.filter(index => !seen.has(index));
    if (!pool.length) {
      seen = new Set([current()]);
      pool = all;
    }
    if (!pool.length) return null;
    return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  }

  /**
   * The next item, never one in `skip`; null when every item is skipped.
   * @param {Set<number>} [skip] items autoplay must not show, such as known broken media
   */
  function next(skip = new Set()) {
    if (!length) return null;
    if (!shuffle) {
      for (let step = 1; step <= length; step += 1) {
        const index = (current() + step) % length;
        if (!skip.has(index)) {
          reset(length, index);
          return index;
        }
      }
      return null;
    }
    while (position < history.length - 1) {
      position += 1;
      if (!skip.has(current())) return current();
    }
    const chosen = pick(skip);
    if (chosen === null) return skip.has(current()) ? null : current();
    history.push(chosen);
    position = history.length - 1;
    seen.add(chosen);
    return chosen;
  }

  /** The previous item: one step back in order, or back along the shuffle history. */
  function previous() {
    if (!length) return null;
    if (!shuffle) {
      const index = (current() - 1 + length) % length;
      reset(length, index);
      return index;
    }
    if (position > 0) {
      position -= 1;
      return current();
    }
    // Before the first remembered item a new one is prepended, so Next still leads back.
    const chosen = pick(new Set());
    if (chosen === null) return current();
    history.unshift(chosen);
    seen.add(chosen);
    return chosen;
  }

  return {
    reset,
    next,
    previous,
    get current() { return current(); },
    get shuffle() { return shuffle; },
    /** Switching the order keeps the current item and starts a new history from it. */
    set shuffle(value) {
      shuffle = Boolean(value);
      reset(length, current());
    },
  };
}

/**
 * The one autoplay timer. `onTick` runs when the interval elapses; the caller shows the next
 * item and calls `schedule()` again. Every call clears the pending timer first, so starting,
 * restarting, or changing the interval never leaves a second timer behind.
 * @param {() => void} onTick
 * @param {{seconds?: number, setTimer?: (callback: () => void, ms: number) => any, clearTimer?: (handle: any) => void}} [options]
 */
export function createAutoplay(onTick, {seconds = DEFAULT_INTERVAL, setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
  let playing = false;
  let delay = seconds * 1000;
  /** @type {any} */
  let handle = null;

  function clear() {
    if (handle !== null) clearTimer(handle);
    handle = null;
  }

  function schedule() {
    clear();
    if (!playing) return;
    handle = setTimer(() => {
      handle = null;
      if (playing) onTick();
    }, delay);
  }

  return {
    get playing() { return playing; },
    get seconds() { return delay / 1000; },
    get pending() { return handle !== null; },
    start() {
      playing = true;
      schedule();
    },
    stop() {
      playing = false;
      clear();
    },
    schedule,
    /** The new interval times the next transition, counted from now. */
    setSeconds(/** @type {number} */ value) {
      delay = value * 1000;
      if (playing) schedule();
    },
  };
}
