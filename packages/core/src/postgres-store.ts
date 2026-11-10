/**
 * `Store` over PostgreSQL (production: Neon, through the HTTP driver; see sql-executor.ts).
 *
 * Schema: `ntn_kv` holds every string value with an optional expiry, `ntn_set_members` holds
 * the members of the sets that `createIndexed`/`deleteIndexed`/`moveIndexed` keep in step with
 * their records. `ensureSchema` runs lazily, once per store instance, as idempotent
 * `CREATE ... IF NOT EXISTS` under an advisory lock (concurrent cold starts cannot collide).
 *
 * Atomicity, the boring way: every operation is ONE SQL statement. Row races are settled by
 * the row itself (`INSERT ... ON CONFLICT`, `UPDATE ... WHERE value = expected` re-checks its
 * predicate after waiting for a concurrent writer under READ COMMITTED). The three operations
 * that touch a set (cap check, member add/remove) additionally take a transaction-scoped
 * advisory lock on the set key first, as a two-statement batch run as one transaction: the
 * second statement starts after the lock was granted, so it sees every earlier committed
 * index change, which a cap check or a record-recreated-in-between guarantee needs. The lock is
 * per set, so unrelated namespaces never wait for each other.
 *
 * Expiry is lazy and uses the DATABASE clock (`clock_timestamp()`), never the application's,
 * so skew between serverless instances cannot resurrect or kill a key: every read and write
 * treats a row whose `expires_at` has passed as absent, and a write over such a row replaces
 * it. Expired rows are physically removed by a bounded purge that one TTL-carrying write per
 * `purgeIntervalMs` per instance runs opportunistically (its failure never fails the write).
 *
 * Semantics follow UpstashStore/MemoryStore: plain `set` replaces value AND expiry,
 * `compareAndSet` keeps the expiry, `increment` applies its TTL when the counter has none,
 * records written by createIndexed/moveIndexed never expire, set members never expire.
 */
import {
  MalformedReplyError,
  type SqlExecutor,
  type SqlParam,
  type SqlRow,
  type SqlStatement,
} from './sql-executor';
import {
  DEFAULT_TIMEOUT_MS,
  StorageFailureLog,
  storageFailed,
  unexpectedReply,
  type FailureKind,
} from './storage-failure';
import type { IndexedMove, SetOptions, Store } from './store';

export interface PostgresConfig {
  executor: SqlExecutor;
  /** Per-request deadline in ms (default 3000); the schema step and every operation get their own. */
  timeoutMs?: number;
  /** Minimum gap between opportunistic purges of expired rows, per instance (default 60 s). */
  purgeIntervalMs?: number;
}

/** Reads the pooled connection string from an env-like object; null when none is configured. */
export function databaseUrlFromEnv(env: {
  readonly [name: string]: string | undefined;
}): string | null {
  const url = env.DATABASE_URL?.trim();
  return url ? url : null;
}

const DEFAULT_PURGE_INTERVAL_MS = 60_000;
const PURGE_BATCH = 200;

/** Expired rows are invisible to every statement below. */
const LIVE = '(expires_at IS NULL OR expires_at > clock_timestamp())';

const SCHEMA_LOCK_KEY = 'ntn-link:ensure-schema';

const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ntn_kv (
     key text PRIMARY KEY,
     value text NOT NULL,
     expires_at timestamptz
   )`,
  `CREATE INDEX IF NOT EXISTS ntn_kv_expires_at_idx ON ntn_kv (expires_at) WHERE expires_at IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS ntn_set_members (
     set_key text NOT NULL,
     member text NOT NULL,
     PRIMARY KEY (set_key, member)
   )`,
];

const lockStatement = (lockKey: string): SqlStatement => ({
  text: 'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
  params: [lockKey],
});

/**
 * Probed first: a database that is already provisioned is used as it is, so a runtime role
 * with table access but no right to create objects works, and a warm start costs one query.
 */
const SCHEMA_PRESENT_SQL = `SELECT CASE WHEN to_regclass('ntn_kv') IS NOT NULL
  AND to_regclass('ntn_kv_expires_at_idx') IS NOT NULL
  AND to_regclass('ntn_set_members') IS NOT NULL THEN 'present' ELSE 'absent' END AS outcome`;

const SCHEMA_BATCH: readonly SqlStatement[] = [
  lockStatement(SCHEMA_LOCK_KEY),
  ...SCHEMA_STATEMENTS.map((text) => ({ text, params: [] })),
];

const GET_SQL = `SELECT value FROM ntn_kv WHERE key = $1::text AND ${LIVE}`;

/** Plain SET: replaces value and expiry (a missing ttl clears it), like Redis SET. */
const SET_SQL = `INSERT INTO ntn_kv (key, value, expires_at)
VALUES ($1::text, $2::text, CASE WHEN $3::double precision IS NULL THEN NULL
                                 ELSE clock_timestamp() + make_interval(secs => $3::double precision) END)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
RETURNING 'ok' AS outcome`;

/** SET NX: a row that exists but has expired counts as absent and is replaced. */
const SET_IF_ABSENT_SQL = `INSERT INTO ntn_kv (key, value, expires_at)
VALUES ($1::text, $2::text, CASE WHEN $3::double precision IS NULL THEN NULL
                                 ELSE clock_timestamp() + make_interval(secs => $3::double precision) END)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
  WHERE ntn_kv.expires_at IS NOT NULL AND ntn_kv.expires_at <= clock_timestamp()
RETURNING 'ok' AS outcome`;

/** The UPDATE re-checks `value` after waiting for a concurrent writer, so one caller wins. */
const COMPARE_AND_SET_SQL = `UPDATE ntn_kv SET value = $3::text
WHERE key = $1::text AND value = $2::text AND ${LIVE}
RETURNING 'ok' AS outcome`;

const DELETE_SQL = `DELETE FROM ntn_kv WHERE key = $1::text
RETURNING CASE WHEN ${LIVE} THEN 'live' ELSE 'expired' END AS outcome`;

/**
 * A counter that expired starts over at 1 with a fresh window; otherwise it counts on and
 * gets the window if it has none, so it can never outlive its window. Both columns must agree
 * on whether the counter expired, so every clock reading here is `now()` (constant for the
 * statement), not `clock_timestamp()`, which could move past the expiry between the two.
 */
const INCREMENT_SQL = `INSERT INTO ntn_kv (key, value, expires_at)
VALUES ($1::text, '1', now() + make_interval(secs => $2::double precision))
ON CONFLICT (key) DO UPDATE SET
  value = CASE WHEN ntn_kv.expires_at IS NOT NULL AND ntn_kv.expires_at <= now()
               THEN '1' ELSE (ntn_kv.value::bigint + 1)::text END,
  expires_at = CASE WHEN ntn_kv.expires_at IS NOT NULL AND ntn_kv.expires_at <= now()
                    THEN EXCLUDED.expires_at ELSE COALESCE(ntn_kv.expires_at, EXCLUDED.expires_at) END
RETURNING value AS outcome`;

/**
 * Runs after the set's advisory lock was granted. 'exists' wins over 'full'; an expired row
 * under `key` is replaced (records created here never expire).
 */
const CREATE_INDEXED_SQL = `WITH created AS (
  INSERT INTO ntn_kv (key, value, expires_at)
  SELECT $1::text, $2::text, NULL
  WHERE (SELECT count(*) FROM ntn_set_members WHERE set_key = $3::text) < $5::bigint
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = NULL
    WHERE ntn_kv.expires_at IS NOT NULL AND ntn_kv.expires_at <= clock_timestamp()
  RETURNING key
), indexed AS (
  INSERT INTO ntn_set_members (set_key, member)
  SELECT $3::text, $4::text FROM created
  ON CONFLICT DO NOTHING
)
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM created) THEN 'created'
  WHEN (SELECT count(*) FROM ntn_set_members WHERE set_key = $3::text) >= $5::bigint
       AND NOT EXISTS (SELECT 1 FROM ntn_kv WHERE key = $1::text AND ${LIVE}) THEN 'full'
  ELSE 'exists'
END AS outcome`;

/**
 * Guarded (`$4` true): nothing happens unless the key still holds exactly `$5`. Unguarded: the
 * member is removed even when the record is already gone (clears a stale member).
 */
const DELETE_INDEXED_SQL = `WITH removed AS (
  DELETE FROM ntn_kv
  WHERE key = $1::text AND ($4::boolean IS NOT TRUE OR value = $5::text)
  RETURNING CASE WHEN ${LIVE} THEN 'live' ELSE 'expired' END AS state
), unindexed AS (
  DELETE FROM ntn_set_members
  WHERE set_key = $2::text AND member = $3::text
    AND ($4::boolean IS NOT TRUE OR EXISTS (SELECT 1 FROM removed WHERE state = 'live'))
)
SELECT CASE WHEN EXISTS (SELECT 1 FROM removed WHERE state = 'live') THEN 'removed' ELSE 'kept' END AS outcome`;

/** `to` is created (replacing an expired row) only while `from` still holds `expectedFrom`. */
const MOVE_INDEXED_SQL = `WITH src AS (
  SELECT key FROM ntn_kv WHERE key = $1::text AND value = $3::text AND ${LIVE} FOR UPDATE
), put AS (
  INSERT INTO ntn_kv (key, value, expires_at)
  SELECT $2::text, $4::text, NULL WHERE EXISTS (SELECT 1 FROM src)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = NULL
    WHERE ntn_kv.expires_at IS NOT NULL AND ntn_kv.expires_at <= clock_timestamp()
  RETURNING key
), gone AS (
  DELETE FROM ntn_kv WHERE key = $1::text AND EXISTS (SELECT 1 FROM put)
), unindexed AS (
  DELETE FROM ntn_set_members
  WHERE set_key = $5::text AND member = $6::text AND $6::text <> $7::text
    AND EXISTS (SELECT 1 FROM put)
), indexed AS (
  INSERT INTO ntn_set_members (set_key, member)
  SELECT $5::text, $7::text FROM put
  ON CONFLICT DO NOTHING
)
SELECT CASE
  WHEN NOT EXISTS (SELECT 1 FROM src) THEN 'missing'
  WHEN EXISTS (SELECT 1 FROM put) THEN 'moved'
  ELSE 'taken'
END AS outcome`;

const SET_MEMBERS_SQL = 'SELECT member FROM ntn_set_members WHERE set_key = $1::text';

/** Bounded; SKIP LOCKED leaves rows a concurrent writer is replacing right now. */
const PURGE_SQL = `DELETE FROM ntn_kv WHERE key IN (
  SELECT key FROM ntn_kv
  WHERE expires_at IS NOT NULL AND expires_at <= clock_timestamp()
  ORDER BY expires_at LIMIT $1::integer
  FOR UPDATE SKIP LOCKED
)`;

const statement = (text: string, ...params: SqlParam[]): SqlStatement => ({ text, params });

function isDeadline(candidate: unknown): boolean {
  return (
    candidate instanceof Error &&
    (candidate.name === 'TimeoutError' || candidate.name === 'AbortError')
  );
}

/**
 * A server-side rejection carries a Postgres SQLSTATE `code` (five characters of [0-9A-Z], no
 * data in them; Node's own errno codes such as ECONNRESET start with E, which no SQLSTATE
 * class does). The Neon driver wraps a fetch failure, abort included, in an error of its own
 * with the original under `sourceError`, and a non-JSON server answer without a code.
 */
function failureKind(error: unknown): FailureKind {
  if (isDeadline(error)) return 'timeout';
  if (error instanceof Error && 'sourceError' in error && isDeadline(error.sourceError)) {
    return 'timeout';
  }
  if (error instanceof MalformedReplyError) return 'bad-reply';
  if (error instanceof Error && 'code' in error && /^(?!E)[0-9A-Z]{5}$/.test(String(error.code))) {
    return 'backend-error';
  }
  return 'network';
}

/** Rejects when `signal` aborts, whatever the executor does with it. */
function abortion(signal: AbortSignal): { promise: Promise<never>; release: () => void } {
  const { promise, reject } = Promise.withResolvers<never>();
  const onAbort = (): void => reject(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return { promise, release: () => signal.removeEventListener('abort', onAbort) };
}

/** The one text cell a single-column reply must carry. */
function outcomeOf(rows: readonly SqlRow[]): string {
  const [row] = rows;
  const outcome = row?.outcome;
  if (rows.length !== 1 || typeof outcome !== 'string') throw unexpectedReply();
  return outcome;
}

export class PostgresStore implements Store {
  readonly #failures = new StorageFailureLog();
  readonly #executor: SqlExecutor;
  readonly #timeoutMs: number;
  readonly #purgeIntervalMs: number;
  #schema: Promise<void> | undefined;
  #lastPurge = Number.NEGATIVE_INFINITY;

  constructor(config: PostgresConfig) {
    this.#executor = config.executor;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#purgeIntervalMs = config.purgeIntervalMs ?? DEFAULT_PURGE_INTERVAL_MS;
  }

  /**
   * Runs one request under its own deadline. The signal goes to the driver (it cancels the
   * HTTP call), and the race guarantees the deadline even for an executor that ignores it.
   * No retries: a replayed increment or compare-and-set after a lost reply could apply twice.
   */
  async #withDeadline<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = AbortSignal.timeout(this.#timeoutMs);
    const deadline = abortion(signal);
    try {
      return await Promise.race([work(signal), deadline.promise]);
    } finally {
      deadline.release();
    }
  }

  /** Idempotent, shared by concurrent first callers, retried by the next call after a failure. */
  #ensureSchema(): Promise<void> {
    this.#schema ??= this.#withDeadline(async (signal) => {
      const present = await this.#executor.query(statement(SCHEMA_PRESENT_SQL), signal);
      if (present.length === 1 && present[0]?.outcome === 'present') return;
      await this.#executor.transaction(SCHEMA_BATCH, signal);
    }).catch((error: unknown) => {
      this.#schema = undefined;
      throw error;
    });
    return this.#schema;
  }

  async #run(
    command: string,
    statements: readonly SqlStatement[],
  ): Promise<ReadonlyArray<readonly SqlRow[]>> {
    try {
      await this.#ensureSchema();
      return await this.#withDeadline(async (signal) => {
        const [only, ...rest] = statements;
        if (only === undefined) return [];
        if (rest.length === 0) return [await this.#executor.query(only, signal)];
        return this.#executor.transaction(statements, signal);
      });
    } catch (error) {
      this.#failures.record(command, error, failureKind(error));
      throw storageFailed();
    }
  }

  async #query(command: string, query: SqlStatement): Promise<readonly SqlRow[]> {
    const [rows] = await this.#run(command, [query]);
    if (rows === undefined) throw unexpectedReply();
    return rows;
  }

  /** For statements that RETURN one 'ok' row when they wrote, and nothing when they did not. */
  async #acknowledged(command: string, query: SqlStatement): Promise<boolean> {
    const rows = await this.#query(command, query);
    if (rows.length === 0) return false;
    if (outcomeOf(rows) !== 'ok') throw unexpectedReply();
    return true;
  }

  /** Index operations lock their set first; the batch is one transaction. */
  async #queryUnderSetLock(
    command: string,
    setKey: string,
    query: SqlStatement,
  ): Promise<readonly SqlRow[]> {
    const results = await this.#run(command, [lockStatement(setKey), query]);
    const rows = results[1];
    if (results.length !== 2 || rows === undefined) throw unexpectedReply();
    return rows;
  }

  /** Called after a write that carries a TTL; never fails the write. */
  async #purgeIfDue(): Promise<void> {
    const now = Date.now();
    if (now - this.#lastPurge < this.#purgeIntervalMs) return;
    this.#lastPurge = now;
    try {
      await this.#withDeadline((signal) =>
        this.#executor.query(statement(PURGE_SQL, PURGE_BATCH), signal),
      );
    } catch (error) {
      this.#failures.record('PURGE', error, failureKind(error));
    }
  }

  async get(key: string): Promise<string | null> {
    const rows = await this.#query('GET', statement(GET_SQL, key));
    if (rows.length === 0) return null;
    const value = rows[0]?.value;
    if (rows.length !== 1 || typeof value !== 'string') throw unexpectedReply();
    return value;
  }

  async set(key: string, value: string, options: SetOptions = {}): Promise<boolean> {
    const ttl = options.ttlSeconds ?? null;
    const sql = options.ifAbsent ? SET_IF_ABSENT_SQL : SET_SQL;
    const written = await this.#acknowledged('SET', statement(sql, key, value, ttl));
    if (ttl !== null) await this.#purgeIfDue();
    return written;
  }

  async compareAndSet(key: string, expected: string, value: string): Promise<boolean> {
    return this.#acknowledged('CAS', statement(COMPARE_AND_SET_SQL, key, expected, value));
  }

  async delete(key: string): Promise<boolean> {
    const rows = await this.#query('DEL', statement(DELETE_SQL, key));
    if (rows.length > 1) throw unexpectedReply();
    return rows.length === 1 && outcomeOf(rows) === 'live';
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const value = Number(
      outcomeOf(await this.#query('INCR', statement(INCREMENT_SQL, key, ttlSeconds))),
    );
    if (!Number.isSafeInteger(value)) throw unexpectedReply();
    await this.#purgeIfDue();
    return value;
  }

  async createIndexed(
    key: string,
    value: string,
    setKey: string,
    member: string,
    maxMembers: number,
  ): Promise<'created' | 'exists' | 'full'> {
    const rows = await this.#queryUnderSetLock(
      'CREATE_INDEXED',
      setKey,
      statement(CREATE_INDEXED_SQL, key, value, setKey, member, maxMembers),
    );
    const outcome = outcomeOf(rows);
    if (outcome !== 'created' && outcome !== 'exists' && outcome !== 'full') {
      throw unexpectedReply();
    }
    return outcome;
  }

  async deleteIndexed(
    key: string,
    setKey: string,
    member: string,
    expected?: string,
  ): Promise<boolean> {
    const guard: SqlParam[] = expected === undefined ? [false, ''] : [true, expected];
    const rows = await this.#queryUnderSetLock(
      'DELETE_INDEXED',
      setKey,
      statement(DELETE_INDEXED_SQL, key, setKey, member, ...guard),
    );
    const outcome = outcomeOf(rows);
    if (outcome !== 'removed' && outcome !== 'kept') throw unexpectedReply();
    return outcome === 'removed';
  }

  async moveIndexed(move: IndexedMove): Promise<'moved' | 'missing' | 'taken'> {
    const rows = await this.#queryUnderSetLock(
      'MOVE_INDEXED',
      move.setKey,
      statement(
        MOVE_INDEXED_SQL,
        move.from,
        move.to,
        move.expectedFrom,
        move.value,
        move.setKey,
        move.fromMember,
        move.toMember,
      ),
    );
    const outcome = outcomeOf(rows);
    if (outcome !== 'moved' && outcome !== 'missing' && outcome !== 'taken') {
      throw unexpectedReply();
    }
    return outcome;
  }

  async setMembers(key: string): Promise<string[]> {
    const rows = await this.#query('SMEMBERS', statement(SET_MEMBERS_SQL, key));
    return rows.map((row) => {
      const member = row.member;
      if (typeof member !== 'string') throw unexpectedReply();
      return member;
    });
  }
}
