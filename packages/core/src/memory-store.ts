/**
 * In-memory `Store` for tests and local development. Single process only, so it is
 * trivially atomic; expiry is evaluated lazily against an injectable clock.
 */
import type { IndexedMove, SetOptions, Store } from './store';

interface Entry {
  value: string;
  expiresAt: number | null;
}

export class MemoryStore implements Store {
  readonly #entries = new Map<string, Entry>();
  readonly #sets = new Map<string, Set<string>>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #live(key: string): Entry | undefined {
    const entry = this.#entries.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.#live(key)?.value ?? null;
  }

  async set(key: string, value: string, options: SetOptions = {}): Promise<boolean> {
    if (options.ifAbsent && this.#live(key)) return false;
    const expiresAt =
      options.ttlSeconds === undefined ? null : this.#now() + options.ttlSeconds * 1000;
    this.#entries.set(key, { value, expiresAt });
    return true;
  }

  async compareAndSet(key: string, expected: string, value: string): Promise<boolean> {
    const entry = this.#live(key);
    if (entry?.value !== expected) return false;
    this.#entries.set(key, { value, expiresAt: entry.expiresAt });
    return true;
  }

  async delete(key: string): Promise<boolean> {
    const existed = this.#live(key) !== undefined;
    this.#entries.delete(key);
    return existed;
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const entry = this.#live(key);
    const next = (entry ? Number(entry.value) : 0) + 1;
    this.#entries.set(key, {
      value: String(next),
      expiresAt: entry?.expiresAt ?? this.#now() + ttlSeconds * 1000,
    });
    return next;
  }

  async createIndexed(
    key: string,
    value: string,
    setKey: string,
    member: string,
    maxMembers: number,
  ): Promise<'created' | 'exists' | 'full'> {
    if (this.#live(key)) return 'exists';
    const set = this.#sets.get(setKey) ?? new Set<string>();
    if (set.size >= maxMembers) return 'full';
    this.#entries.set(key, { value, expiresAt: null });
    set.add(member);
    this.#sets.set(setKey, set);
    return 'created';
  }

  async deleteIndexed(
    key: string,
    setKey: string,
    member: string,
    expected?: string,
  ): Promise<boolean> {
    const entry = this.#live(key);
    if (expected !== undefined && entry?.value !== expected) return false;
    this.#entries.delete(key);
    this.#sets.get(setKey)?.delete(member);
    return entry !== undefined;
  }

  async moveIndexed(move: IndexedMove): Promise<'moved' | 'missing' | 'taken'> {
    if (this.#live(move.from)?.value !== move.expectedFrom) return 'missing';
    if (this.#live(move.to)) return 'taken';
    this.#entries.set(move.to, { value: move.value, expiresAt: null });
    this.#entries.delete(move.from);
    const set = this.#sets.get(move.setKey) ?? new Set<string>();
    set.delete(move.fromMember);
    set.add(move.toMember);
    this.#sets.set(move.setKey, set);
    return 'moved';
  }

  async setMembers(key: string): Promise<string[]> {
    return [...(this.#sets.get(key) ?? [])];
  }
}
