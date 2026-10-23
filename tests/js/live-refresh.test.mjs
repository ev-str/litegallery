import assert from 'node:assert/strict';
import test from 'node:test';

import {createRefreshLoop, LIVE_REFRESH_MS} from '../../web/live-refresh.js';
import {fakeTimers, settle} from './fake-timers.mjs';

/** A check whose answers the test releases one by one. */
function heldChecks() {
  const pending = [];
  let started = 0;
  return {
    pending,
    get started() { return started; },
    check(signal) {
      started += 1;
      return new Promise((resolve, reject) => pending.push({resolve, reject, signal}));
    },
  };
}

test('the interval is one calm fixed value between 30 and 60 seconds', () => {
  assert.ok(LIVE_REFRESH_MS >= 30_000 && LIVE_REFRESH_MS <= 60_000);
});

test('one timer and at most one check: the next interval starts when a check ends', async () => {
  const timers = fakeTimers();
  const checks = heldChecks();
  const loop = createRefreshLoop({check: checks.check, ...timers});
  loop.start();
  loop.start();
  loop.restart();
  assert.equal(timers.live.size, 1);

  await timers.advance(LIVE_REFRESH_MS);
  assert.equal(checks.started, 1);
  assert.equal(loop.running, true);
  assert.equal(timers.live.size, 0, 'no timer runs while the check is in flight');
  loop.restart();
  loop.visible();
  await timers.advance(LIVE_REFRESH_MS * 3);
  assert.equal(checks.started, 1, 'a slow check is never overlapped');

  checks.pending[0].resolve();
  await settle();
  assert.equal(loop.running, false);
  assert.equal(timers.live.size, 1);
  await timers.advance(LIVE_REFRESH_MS - 1);
  assert.equal(checks.started, 1, 'the interval counts from the end of the check');
  await timers.advance(1);
  assert.equal(checks.started, 2);

  loop.stop();
  checks.pending[1].resolve();
  await settle();
  assert.equal(timers.live.size, 0, 'a stopped loop arms nothing');
});

test('a failed check keeps the schedule and is never retried at once', async () => {
  const timers = fakeTimers();
  let calls = 0;
  const loop = createRefreshLoop({check: async () => { calls += 1; throw new Error('offline'); }, ...timers});
  loop.start();
  await timers.advance(LIVE_REFRESH_MS);
  assert.equal(calls, 1);
  assert.equal(timers.live.size, 1);
  await timers.advance(LIVE_REFRESH_MS - 1);
  assert.equal(calls, 1);
  await timers.advance(1);
  assert.equal(calls, 2);
});

test('a hidden tab checks nothing and runs no timer; becoming visible checks once', async () => {
  const timers = fakeTimers();
  let hidden = false;
  let calls = 0;
  const loop = createRefreshLoop({check: async () => { calls += 1; }, isHidden: () => hidden, ...timers});
  loop.start();
  hidden = true;
  loop.hidden();
  await timers.advance(LIVE_REFRESH_MS * 5);
  assert.equal(calls, 0);
  assert.equal(timers.live.size, 0);
  loop.visible();
  assert.equal(calls, 0, 'still hidden');

  hidden = false;
  loop.visible();
  loop.visible();
  await settle();
  assert.equal(calls, 1, 'a repeated visibility event does not check twice');
  assert.equal(timers.live.size, 1, 'the one timer resumes after the check');
  await timers.advance(LIVE_REFRESH_MS);
  assert.equal(calls, 2);

  // Hiding before the tick drops the timer instead of letting it fire unseen.
  hidden = true;
  loop.hidden();
  assert.equal(timers.live.size, 0);
});

test('hiding aborts the running check; returning before it settles checks once right after it', async () => {
  for (const settleAborted of ['resolve', 'reject']) {
    const timers = fakeTimers();
    const checks = heldChecks();
    let hidden = false;
    const loop = createRefreshLoop({check: checks.check, isHidden: () => hidden, ...timers});
    loop.start();
    await timers.advance(LIVE_REFRESH_MS);
    assert.equal(checks.started, 1);
    const old = checks.pending[0];

    hidden = true;
    loop.hidden();
    assert.equal(old.signal.aborted, true, `${settleAborted}: the hidden page may not be changed`);
    hidden = false;
    loop.visible();
    loop.visible();
    hidden = true;
    loop.hidden();
    hidden = false;
    loop.visible();
    assert.equal(checks.started, 1, `${settleAborted}: no second request while the old one settles`);
    assert.equal(timers.live.size, 0);

    old[settleAborted](new Error('aborted'));
    await settle();
    assert.equal(checks.started, 2, `${settleAborted}: exactly one new check starts at once`);
    assert.equal(checks.pending[1].signal.aborted, false);
    assert.equal(timers.live.size, 0);

    checks.pending[1].resolve();
    await settle();
    assert.equal(timers.live.size, 1);
    await timers.advance(LIVE_REFRESH_MS - 1);
    assert.equal(checks.started, 2, `${settleAborted}: the plain interval resumes`);
    await timers.advance(1);
    assert.equal(checks.started, 3);
  }
});

test('a full load that aborts the check also drops the re-check the returning tab asked for', async () => {
  const timers = fakeTimers();
  const checks = heldChecks();
  let hidden = false;
  const loop = createRefreshLoop({check: checks.check, isHidden: () => hidden, ...timers});
  loop.start();
  await timers.advance(LIVE_REFRESH_MS);
  hidden = true;
  loop.hidden();
  hidden = false;
  loop.visible();
  loop.abort();
  checks.pending[0].reject(new Error('aborted'));
  await settle();
  assert.equal(checks.started, 1, 'no check starts right after the aborted one');
  assert.equal(timers.live.size, 1, 'only the plain timer remains');
  await timers.advance(LIVE_REFRESH_MS - 1);
  assert.equal(checks.started, 1);
  await timers.advance(1);
  assert.equal(checks.started, 2);
});

test('hiding and settling while still hidden waits for the tab to return', async () => {
  const timers = fakeTimers();
  const checks = heldChecks();
  let hidden = false;
  const loop = createRefreshLoop({check: checks.check, isHidden: () => hidden, ...timers});
  loop.start();
  await timers.advance(LIVE_REFRESH_MS);
  hidden = true;
  loop.hidden();
  checks.pending[0].reject(new Error('aborted'));
  await settle();
  assert.equal(checks.started, 1);
  assert.equal(timers.live.size, 0);
  hidden = false;
  loop.visible();
  await settle();
  assert.equal(checks.started, 2);
});

test('a page that must not change skips its tick and keeps the plain interval', async () => {
  const timers = fakeTimers();
  let allowed = false;
  let calls = 0;
  const loop = createRefreshLoop({check: async () => { calls += 1; }, canCheck: () => allowed, ...timers});
  loop.start();
  await timers.advance(LIVE_REFRESH_MS * 2);
  assert.equal(calls, 0);
  assert.equal(timers.live.size, 1);
  allowed = true;
  await timers.advance(LIVE_REFRESH_MS);
  assert.equal(calls, 1);
});

test('resume checks once only when a tick was skipped meanwhile', async () => {
  const timers = fakeTimers();
  let allowed = true;
  let calls = 0;
  const loop = createRefreshLoop({check: async () => { calls += 1; }, canCheck: () => allowed, ...timers});
  loop.start();
  loop.resume();
  await settle();
  assert.equal(calls, 0, 'no tick was skipped');

  allowed = false;
  await timers.advance(LIVE_REFRESH_MS);
  allowed = true;
  loop.resume();
  loop.resume();
  await settle();
  assert.equal(calls, 1, 'one make-up check');
  assert.equal(timers.live.size, 1, 'the interval counts from it');
  await timers.advance(LIVE_REFRESH_MS);
  assert.equal(calls, 2);
});
