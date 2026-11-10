/**
 * How long the page waits for a read (preview, list) before it stops the spinner and shows a
 * retryable error. Every route may run 60 s (`maxDuration`: a 10 s database warm-up plus
 * Notion calls), so the page waits longer than the server: it only gives up on a connection
 * that never answers, never on a slow cold start. A hung request must never leave a button
 * busy for good.
 */
export const REQUEST_TIMEOUT_MS = 65_000;

/**
 * The same for a call that changes server state. Verify, create and sweep can use all of the
 * route's 60 s, and a verify that rotates a key returns the new key only once, so the margin
 * over the server (upload, cold start of the function) is wide: giving up early would lose it.
 */
export const WRITE_TIMEOUT_MS = 90_000;

/** The clipboard waits on a permission prompt, not on a server: give up sooner. */
export const CLIPBOARD_TIMEOUT_MS = 10_000;

/** Thrown by `raceDeadline` when the promise did not settle in time. */
export class DeadlineError extends Error {
  constructor() {
    super('deadline');
    this.name = 'DeadlineError';
  }
}

/** Settles like `promise`, or rejects with DeadlineError after `ms` (for calls with no abort signal). */
export function raceDeadline<T>(promise: Promise<T>, ms: number = REQUEST_TIMEOUT_MS): Promise<T> {
  // `new Promise`, not Promise.withResolvers: that needs Safari 17.4+ / Chrome 119+, and a
  // missing API would fail every request on an older phone.
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError()), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
