/**
 * Small in-memory TTL cache, one per service instance.
 *
 * Why in memory and not in the Store: it holds Notion image URLs that Notion signs and
 * expires after hours, which must never be persisted (a stored one would be dead within a
 * day), and a serverless instance's lifetime is already about the right scale for a
 * seconds-long cache. A cold instance simply starts empty and refetches.
 *
 * An entry younger than `ttlMs` is served as is; an older one is never served, the caller
 * waits for a fresh load (no stale-while-revalidate: a page that was just unpublished must
 * not keep serving its image beyond the TTL). Concurrent loads of one key and page version
 * share a single call, so a burst of crawler requests for one card costs one upstream fetch.
 */

export interface CacheLoad<V> {
  value: V;
  /** False for outcomes that must not be remembered (a transient upstream failure). */
  cacheable: boolean;
}

interface Entry<V> {
  value: V;
  /** Identity of what the value belongs to; an entry for another version is ignored. */
  version: string;
  storedAt: number;
}

interface Inflight<V> {
  version: string;
  promise: Promise<V>;
}

export interface TtlCacheOptions {
  ttlMs: number;
  maxEntries: number;
  now: () => number;
}

export class TtlCache<V> {
  readonly #entries = new Map<string, Entry<V>>();
  readonly #inflight = new Map<string, Inflight<V>>();
  readonly #options: TtlCacheOptions;

  constructor(options: TtlCacheOptions) {
    this.#options = options;
  }

  async get(key: string, version: string, load: () => Promise<CacheLoad<V>>): Promise<V> {
    const entry = this.#entries.get(key);
    if (
      entry !== undefined &&
      entry.version === version &&
      this.#options.now() - entry.storedAt < this.#options.ttlMs
    ) {
      return entry.value;
    }
    return this.#load(key, version, load);
  }

  /** Forgets a key and abandons any load in flight for it, so its result is not stored. */
  delete(key: string): void {
    this.#entries.delete(key);
    this.#inflight.delete(key);
  }

  #load(key: string, version: string, load: () => Promise<CacheLoad<V>>): Promise<V> {
    const running = this.#inflight.get(key);
    // Only a load for the same page version may be shared: after the slug was recreated for
    // another page, joining the old load would pair the new record with the old page's value.
    if (running !== undefined && running.version === version) return running.promise;
    const promise: Promise<V> = load().then((result) => {
      // Not ours any more when the key was deleted or reloaded while this was running.
      if (result.cacheable && this.#inflight.get(key)?.promise === promise)
        this.#store(key, version, result.value);
      return result.value;
    });
    this.#inflight.set(key, { version, promise });
    const release = (): void => {
      if (this.#inflight.get(key)?.promise === promise) this.#inflight.delete(key);
    };
    promise.then(release, release);
    return promise;
  }

  #store(key: string, version: string, value: V): void {
    // Re-insert so the oldest entry (first in iteration order) is the one evicted.
    this.#entries.delete(key);
    this.#entries.set(key, { value, version, storedAt: this.#options.now() });
    if (this.#entries.size > this.#options.maxEntries) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
  }
}
