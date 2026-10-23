// @ts-check
// Background freshness checks of the open gallery page, without the DOM: one timer, at
// most one check in flight, and nothing while the tab is hidden. The gallery owns the
// request and decides what a check may change.

/** Pause between the end of one background check and the start of the next. */
export const LIVE_REFRESH_MS = 45_000;

/**
 * @param {{
 *   check: (signal: AbortSignal) => Promise<unknown>,
 *   canCheck?: () => boolean,
 *   isHidden?: () => boolean,
 *   interval?: number,
 *   setTimer?: (callback: () => void, ms: number) => any,
 *   clearTimer?: (handle: any) => void,
 * }} options
 *   check runs one background check and must change nothing once its signal aborts; a
 *   rejection only ends that check. canCheck is false while a check would disturb the
 *   page (a load in progress, the collage editor); that tick is skipped, not retried
 *   early. While isHidden is true no check starts and no timer runs; `hidden()` aborts
 *   the running check and `visible()` then runs one check, right after the aborted one
 *   has settled.
 */
export function createRefreshLoop({check, canCheck = () => true, isHidden = () => false, interval = LIVE_REFRESH_MS, setTimer = setTimeout, clearTimer = clearTimeout}) {
  let started = false;
  /** Controller of the check in flight; null when none runs. @type {AbortController|null} */
  let running = null;
  /** The tab was hidden since the last visible check, so the next `visible()` checks. */
  let wasHidden = false;
  /** `visible()` came while a check was still settling; run one more as soon as it ends. */
  let again = false;
  /** @type {any} */
  let handle = null;

  function clear() {
    if (handle !== null) clearTimer(handle);
    handle = null;
  }

  /** Arm the one timer, counted from now; a running check arms it when it ends. */
  function schedule() {
    clear();
    if (!started || running || isHidden()) return;
    handle = setTimer(() => {
      handle = null;
      run();
    }, interval);
  }

  async function run() {
    clear();
    if (!started || running || isHidden()) return;
    if (!canCheck()) return schedule();
    const controller = new AbortController();
    running = controller;
    try {
      await check(controller.signal);
    } catch {
      // A failed or aborted check keeps the page as it is; the next one comes after a full interval.
    } finally {
      running = null;
      if (again && !isHidden()) {
        again = false;
        run();
      } else {
        schedule();
      }
    }
  }

  return {
    start() {
      started = true;
      schedule();
    },
    stop() {
      started = false;
      again = false;
      clear();
      running?.abort();
    },
    /** Count the interval from now, e.g. after the page was loaded in full. */
    restart: schedule,
    /** Abort the running check, e.g. because a full load replaces it; that load also replaces a pending re-check. */
    abort() {
      again = false;
      running?.abort();
    },
    /** The tab was hidden: drop the timer and abort the running check, so nothing changes unseen. */
    hidden() {
      wasHidden = true;
      again = false;
      clear();
      running?.abort();
    },
    /** The tab is visible again: check once now, or once the aborted check has settled. */
    visible() {
      if (isHidden() || !wasHidden) return;
      wasHidden = false;
      if (running) again = true;
      else run();
    },
    get pending() { return handle !== null; },
    get running() { return running !== null; },
  };
}
