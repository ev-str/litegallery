/** Fake timers that record every live handle; advance lets each callback's promises settle. */
export function fakeTimers() {
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
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...live.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        live.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        await settle();
      }
      now = until;
    },
  };
}

export const settle = () => new Promise(resolve => setImmediate(resolve));
