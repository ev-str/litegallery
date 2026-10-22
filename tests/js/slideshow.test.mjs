import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAutoplay, createPlaylist, DEFAULT_INTERVAL, INTERVAL_KEY, INTERVALS, readInterval, writeInterval,
} from '../../web/slideshow.js';

/** Fake timers that record every live handle. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const live = new Map();
  return {
    live,
    setTimer(callback, ms) {
      const id = nextId++;
      live.set(id, {at: now + ms, callback});
      return id;
    },
    clearTimer(id) { live.delete(id); },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...live.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        live.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = until;
    },
  };
}

/** Deterministic random sequence. */
const sequence = values => {
  let index = 0;
  return () => values[index++ % values.length];
};

test('autoplay keeps exactly one timer through repeated Start/Stop and manual restarts', () => {
  const timers = fakeTimers();
  let ticks = 0;
  const autoplay = createAutoplay(() => { ticks += 1; autoplay.schedule(); }, timers);
  autoplay.start();
  autoplay.start();
  autoplay.schedule();
  assert.equal(timers.live.size, 1);
  timers.advance(DEFAULT_INTERVAL * 1000 * 3);
  assert.equal(ticks, 3);
  assert.equal(timers.live.size, 1);

  autoplay.stop();
  autoplay.stop();
  assert.equal(timers.live.size, 0);
  assert.equal(autoplay.playing, false);
  timers.advance(60_000);
  assert.equal(ticks, 3);

  // Scheduling while stopped never arms a timer.
  autoplay.schedule();
  assert.equal(timers.live.size, 0);
});

test('a new interval times the next transition without a second timer', () => {
  const timers = fakeTimers();
  let ticks = 0;
  const autoplay = createAutoplay(() => { ticks += 1; autoplay.schedule(); }, {...timers, seconds: 5});
  autoplay.start();
  timers.advance(4_000);
  autoplay.setSeconds(10);
  assert.equal(timers.live.size, 1);
  timers.advance(9_000);
  assert.equal(ticks, 0, 'the old 5 s deadline was cancelled');
  timers.advance(1_000);
  assert.equal(ticks, 1);
  timers.advance(10_000);
  assert.equal(ticks, 2);

  // Changing the interval while stopped only stores it.
  autoplay.stop();
  autoplay.setSeconds(30);
  assert.equal(timers.live.size, 0);
  assert.equal(autoplay.seconds, 30);
});

test('the interval is stored, and unknown or unreadable values fall back to the default', () => {
  const store = new Map();
  const storage = {getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value)};
  assert.equal(readInterval(storage), DEFAULT_INTERVAL);
  writeInterval(storage, 30);
  assert.equal(store.get(INTERVAL_KEY), '30');
  assert.equal(readInterval(storage), 30);
  writeInterval(storage, 7);
  assert.equal(readInterval(storage), 30, 'only offered intervals are stored');
  store.set(INTERVAL_KEY, 'soon');
  assert.equal(readInterval(storage), DEFAULT_INTERVAL);
  const broken = {getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }};
  assert.equal(readInterval(broken), DEFAULT_INTERVAL);
  assert.doesNotThrow(() => writeInterval(broken, 10));
  assert.deepEqual(INTERVALS, [5, 10, 30]);
});

test('order mode steps through the list and wraps around', () => {
  const playlist = createPlaylist();
  playlist.reset(3, 2);
  assert.equal(playlist.next(), 0);
  assert.equal(playlist.previous(), 2);
  assert.equal(playlist.previous(), 1);
});

test('shuffle remembers its walk: Previous retraces it and Next replays it before choosing anew', () => {
  const playlist = createPlaylist({random: sequence([0.99, 0, 0.5, 0.2])});
  playlist.reset(6, 0);
  playlist.shuffle = true;
  const walk = [0, playlist.next(), playlist.next(), playlist.next()];
  assert.equal(new Set(walk).size, 4, 'no item repeats while unseen ones remain');

  assert.equal(playlist.previous(), walk[2]);
  assert.equal(playlist.previous(), walk[1]);
  assert.equal(playlist.next(), walk[2], 'Next after Previous moves forward along the history');
  assert.equal(playlist.next(), walk[3]);
  const fresh = playlist.next();
  assert.ok(!walk.includes(fresh), 'only past the end of the history is a new item chosen');
  assert.equal(playlist.previous(), walk[3]);
});

test('shuffle never repeats the current item while another is available', () => {
  const playlist = createPlaylist({random: () => 0});
  playlist.reset(2, 0);
  playlist.shuffle = true;
  let last = 0;
  for (let step = 0; step < 10; step += 1) {
    const index = playlist.next();
    assert.notEqual(index, last);
    last = index;
  }
  const single = createPlaylist();
  single.reset(1, 0);
  single.shuffle = true;
  assert.equal(single.next(), 0, 'a one-item list stays on its item');
  assert.equal(single.previous(), 0);
});

test('every item is shown once per shuffle round', () => {
  const playlist = createPlaylist({random: sequence([0.3, 0.7, 0.1, 0.9])});
  playlist.reset(5, 4);
  playlist.shuffle = true;
  const round = [4, ...Array.from({length: 4}, () => playlist.next())];
  assert.deepEqual([...round].sort(), [0, 1, 2, 3, 4]);
});

test('Previous at the start of the shuffle history prepends an item that Next leads back from', () => {
  const playlist = createPlaylist({random: () => 0});
  playlist.reset(4, 2);
  playlist.shuffle = true;
  const before = playlist.previous();
  assert.notEqual(before, 2);
  assert.equal(playlist.next(), 2);
});

test('toggling shuffle keeps the current item and starts a fresh history', () => {
  const playlist = createPlaylist({random: () => 0.5});
  playlist.reset(5, 3);
  playlist.shuffle = true;
  playlist.next();
  const here = playlist.current;
  playlist.shuffle = false;
  assert.equal(playlist.current, here);
  assert.equal(playlist.next(), (here + 1) % 5);
});

test('skipping broken items terminates even when every item is broken', () => {
  for (const shuffle of [false, true]) {
    const playlist = createPlaylist({random: () => 0});
    playlist.reset(4, 0);
    playlist.shuffle = shuffle;
    const broken = new Set([1, 2]);
    const index = playlist.next(broken);
    assert.ok(index === 3 || index === 0, `${shuffle}: a broken item is never chosen`);
    assert.equal(playlist.next(new Set([0, 1, 2, 3])), null, `${shuffle}: all broken stops`);
  }

  // Replaying the shuffle history also passes over broken entries.
  const playlist = createPlaylist({random: sequence([0, 0, 0])});
  playlist.reset(4, 0);
  playlist.shuffle = true;
  const first = playlist.next();
  const second = playlist.next();
  playlist.previous();
  playlist.previous();
  assert.equal(playlist.next(new Set([first])), second);
});
