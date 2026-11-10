/**
 * Storage seam. Values are opaque strings; typed records and their validation live in
 * records.ts. The surface is exactly the atomic primitives the design relies on:
 * `set` with `ifAbsent` (Redis SET NX) for namespace claims, `compareAndSet` for
 * read-modify-write of link records, `createIndexed`/`deleteIndexed` for link records
 * together with the per-namespace index, `delete` reporting whether the key existed
 * (challenge single-use), `increment` (attempt cap, rate limits) and set reads.
 */

export interface SetOptions {
  ttlSeconds?: number;
  /** Only set when the key does not exist; resolves false when it already does. */
  ifAbsent?: boolean;
}

export interface IndexedMove {
  from: string;
  to: string;
  setKey: string;
  fromMember: string;
  toMember: string;
  expectedFrom: string;
  value: string;
}

export interface Store {
  get(key: string): Promise<string | null>;
  /** Resolves true when the value was written. */
  set(key: string, value: string, options?: SetOptions): Promise<boolean>;
  /** Writes `value` only while the key still holds exactly `expected`; resolves true when it did. */
  compareAndSet(key: string, expected: string, value: string): Promise<boolean>;
  /** Resolves true only for the caller that actually removed an existing key. */
  delete(key: string): Promise<boolean>;
  /** Atomic counter; the TTL is applied when the counter is created. Returns the new value. */
  increment(key: string, ttlSeconds: number): Promise<number>;
  /**
   * SET NX of `key` and, only when it was created, SADD of `member` into `setKey`, as one
   * atomic step that also refuses to grow the set beyond `maxMembers`: 'exists' when the key
   * is taken, 'full' when the set already holds `maxMembers`, otherwise 'created'.
   */
  createIndexed(
    key: string,
    value: string,
    setKey: string,
    member: string,
    maxMembers: number,
  ): Promise<'created' | 'exists' | 'full'>;
  /**
   * DEL of `key` and SREM of `member` from `setKey` as one atomic step, so the index can
   * never lose a member whose record was recreated in between. With `expected`, nothing
   * happens unless the key still holds exactly that value. Resolves true when a key was removed.
   */
  deleteIndexed(key: string, setKey: string, member: string, expected?: string): Promise<boolean>;
  /**
   * Renames a record and its index entry in one atomic step: `to` is created with `value` and
   * `from` removed, only while `from` still holds exactly `expectedFrom` and `to` is free.
   */
  moveIndexed(move: IndexedMove): Promise<'moved' | 'missing' | 'taken'>;
  setMembers(key: string): Promise<string[]>;
}
