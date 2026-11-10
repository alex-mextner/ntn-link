/**
 * Per-IP fixed-window rate limiting on the shared `Store` (spec section 7). The IP is
 * hashed before it becomes part of a key, so no raw address is ever stored; counters
 * expire with their window.
 */
import { ApiError } from './errors';
import { sha256Hex } from './crypto';
import type { Store } from './store';

export type RateLimitedAction = 'preview' | 'challenge' | 'verify' | 'links' | 'sweep';

export interface RateLimit {
  limit: number;
  windowSeconds: number;
}

/** Generous for humans, tight for scripts; verify fetches Notion so it is the strictest. */
export const RATE_LIMITS: Readonly<Record<RateLimitedAction, RateLimit>> = {
  preview: { limit: 30, windowSeconds: 60 },
  challenge: { limit: 10, windowSeconds: 600 },
  verify: { limit: 20, windowSeconds: 600 },
  links: { limit: 30, windowSeconds: 60 },
  /** Fetches Notion once per link of the namespace, so as strict as verify. */
  sweep: { limit: 10, windowSeconds: 600 },
};

export async function enforceRateLimit(
  store: Store,
  action: RateLimitedAction,
  ip: string,
  now: () => number = Date.now,
): Promise<void> {
  const { limit, windowSeconds } = RATE_LIMITS[action];
  const window = Math.floor(now() / 1000 / windowSeconds);
  const key = `rl:${action}:${(await sha256Hex(ip)).slice(0, 32)}:${window}`;
  const count = await store.increment(key, windowSeconds);
  if (count > limit) {
    const retryAfterSeconds = Math.max(1, (window + 1) * windowSeconds - Math.floor(now() / 1000));
    throw new ApiError('rate_limited', `Too many requests. Try again in ${retryAfterSeconds} s.`, {
      retryAfterSeconds,
    });
  }
}
