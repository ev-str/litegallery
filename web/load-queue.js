// A small priority queue for background loads (thumbnails, video metadata).
// At most `concurrency` tasks run at once; the queued task with the lowest
// priority starts next, ties in arrival order. A task with an infinite priority
// waits until `wake()` finds it eligible. A task whose signal aborts while
// queued never starts; a running task sees the abort through its own signal.

/**
 * @typedef {{run: (signal: AbortSignal) => unknown, priority: () => number, signal: AbortSignal}} QueuedTask
 */

/** @param {{concurrency: number}} options */
export function createLoadQueue({concurrency}) {
  /** @type {QueuedTask[]} */
  const queued = [];
  let limit = concurrency;
  let running = 0;

  function pump() {
    while (running < limit && queued.length) {
      let best = -1;
      let bestPriority = Infinity;
      for (let index = 0; index < queued.length; index++) {
        const priority = queued[index].priority();
        if (priority < bestPriority) {
          best = index;
          bestPriority = priority;
        }
      }
      if (best < 0) return;
      const task = queued.splice(best, 1)[0];
      running++;
      // A failing task only ends itself.
      Promise.resolve()
        .then(() => task.run(task.signal))
        .catch(() => {})
        .finally(() => {
          running--;
          pump();
        });
    }
  }

  return {
    /**
     * Queue `run`; it is skipped when `signal` aborts before it starts.
     * @param {(signal: AbortSignal) => unknown} run
     * @param {{priority?: () => number, signal?: AbortSignal}} [options]
     */
    add(run, {priority = () => 0, signal = new AbortController().signal} = {}) {
      if (signal.aborted) return;
      const task = {run, priority, signal};
      queued.push(task);
      signal.addEventListener('abort', () => {
        const index = queued.indexOf(task);
        if (index >= 0) queued.splice(index, 1);
      }, {once: true});
      pump();
    },
    /** Start eligible tasks after their priorities changed. */
    wake: pump,
    /** Change the number of tasks that may run at once; 0 pauses the queue. @param {number} value */
    setConcurrency(value) {
      limit = Math.max(0, value);
      pump();
    },
    get queued() {
      return queued.length;
    },
    get running() {
      return running;
    },
  };
}
