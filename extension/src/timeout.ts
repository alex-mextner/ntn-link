/**
 * Deadline helper. A hung fetch that ignores its AbortSignal (or a test double that never
 * settles) must still release the caller, so the deadline races the work instead of
 * relying on abort alone.
 */
export const TIMED_OUT = Symbol('timed out');

export async function withTimeout<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T | typeof TIMED_OUT> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(TIMED_OUT);
    }, ms);
  });
  // `work` may reject after the deadline already won; that late rejection must not
  // surface as an unhandled rejection.
  const running = work(controller.signal);
  running.catch(() => undefined);
  try {
    return await Promise.race([running, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
