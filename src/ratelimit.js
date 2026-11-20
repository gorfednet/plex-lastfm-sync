// Spaces calls so no more than `perSecond` start in any one second.
export function createLimiter(perSecond, { now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const gap = Math.ceil(1000 / perSecond);
  let next = 0;
  return async function wait() {
    const t = now();
    const start = Math.max(t, next);
    next = start + gap;
    if (start > t) await sleep(start - t);
  };
}
