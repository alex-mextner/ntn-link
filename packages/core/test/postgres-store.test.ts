/**
 * PostgresStore behaviour that is not part of the shared contract: lazy schema creation, the
 * database clock, the opportunistic purge, request deadlines, typed errors and what reaches the
 * log. The statements run on PGlite behind a recording executor.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { ApiError } from '../src/errors';
import { databaseUrlFromEnv, PostgresStore } from '../src/postgres-store';
import {
  MalformedReplyError,
  type SqlExecutor,
  type SqlRow,
  type SqlStatement,
} from '../src/sql-executor';
import { pgliteExecutor } from './support/pglite-executor';

interface Recording extends SqlExecutor {
  readonly statements: SqlStatement[];
  readonly signals: AbortSignal[];
}

function recording(inner: SqlExecutor): Recording {
  const statements: SqlStatement[] = [];
  const signals: AbortSignal[] = [];
  return {
    statements,
    signals,
    query(statement, signal) {
      statements.push(statement);
      signals.push(signal);
      return inner.query(statement, signal);
    },
    transaction(batch, signal) {
      statements.push(...batch);
      signals.push(signal);
      return inner.transaction(batch, signal);
    },
  };
}

const isWarmup = (statement: SqlStatement): boolean => statement.text === 'SELECT 1 AS outcome';

/** The warm-up has its own tests; everywhere else the database is awake and only statements fail. */
const failing = (error: Error): SqlExecutor => ({
  query: (statement) =>
    isWarmup(statement) ? Promise.resolve([{ outcome: 1 }]) : Promise.reject(error),
  transaction: () => Promise.reject(error),
});

const hanging: SqlExecutor = {
  query: (statement) =>
    isWarmup(statement)
      ? Promise.resolve([{ outcome: 1 }])
      : new Promise<readonly SqlRow[]>(() => {}),
  transaction: () => new Promise<ReadonlyArray<readonly SqlRow[]>>(() => {}),
};

class NeonDbError extends Error {
  override name = 'NeonDbError';
  code = '42P01';
}

const quietLog = () => spyOn(console, 'error').mockImplementation(() => {});

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});
function silenced() {
  const log = quietLog();
  restores.push(() => log.mockRestore());
  return log;
}

describe('databaseUrlFromEnv', () => {
  test('reads DATABASE_URL, trimmed; empty or missing is null', () => {
    expect(databaseUrlFromEnv({ DATABASE_URL: ' postgres://u@h/db ' })).toBe('postgres://u@h/db');
    expect(databaseUrlFromEnv({ DATABASE_URL: '  ' })).toBeNull();
    expect(databaseUrlFromEnv({})).toBeNull();
  });
});

describe('PostgresStore schema', () => {
  test('is created lazily, once per instance, shared by concurrent first calls', async () => {
    const exec = recording(pgliteExecutor(new PGlite()));
    const store = new PostgresStore({ executor: exec });
    expect(exec.statements).toHaveLength(0);
    await Promise.all([store.get('a'), store.get('b'), store.set('c', 'v')]);
    await store.get('a');
    const creates = exec.statements.filter((s) => /CREATE TABLE/.test(s.text));
    expect(creates).toHaveLength(2);
    expect(exec.statements.filter((s) => /pg_advisory_xact_lock/.test(s.text))).toHaveLength(1);
  });

  test('a second instance over the same database finds the schema and its data', async () => {
    const executor = pgliteExecutor(new PGlite());
    await new PostgresStore({ executor }).set('shared', 'v');
    expect(await new PostgresStore({ executor }).get('shared')).toBe('v');
  });

  test('a provisioned database is used without any DDL, so a role that cannot create objects works', async () => {
    const exec = recording(pgliteExecutor(new PGlite()));
    await new PostgresStore({ executor: exec }).set('shared', 'v');
    exec.statements.length = 0;
    expect(await new PostgresStore({ executor: exec }).get('shared')).toBe('v');
    expect(exec.statements.some((s) => /\b(CREATE|ALTER|DROP)\b/i.test(s.text))).toBe(false);
  });

  test('a database with a missing table is completed', async () => {
    const db = new PGlite();
    const executor = pgliteExecutor(db);
    await new PostgresStore({ executor }).set('shared', 'v');
    await db.exec('DROP TABLE ntn_set_members');
    const store = new PostgresStore({ executor });
    expect(await store.createIndexed('k', 'v', 's', 'm', 2)).toBe('created');
  });

  test('a failed schema step fails the call and is retried by the next one', async () => {
    silenced();
    const inner = pgliteExecutor(new PGlite());
    let broken = true;
    const flaky: SqlExecutor = {
      query: (statement, signal) => inner.query(statement, signal),
      transaction: (batch, signal) =>
        broken ? Promise.reject(new NeonDbError('down')) : inner.transaction(batch, signal),
    };
    const store = new PostgresStore({ executor: flaky });
    await expect(store.get('k')).rejects.toMatchObject({ code: 'upstream_error' });
    broken = false;
    expect(await store.get('k')).toBeNull();
  });
});

describe('PostgresStore expiry', () => {
  // A clock that jumps one second on every reading, installed ahead of pg_catalog in the search
  // path. A statement that reads the clock more than once while deciding about one counter would
  // see it expire halfway: the count carried on, but the window restarted.
  test('a counter at its expiry boundary either restarts completely or continues completely', async () => {
    const db = new PGlite();
    const store = new PostgresStore({ executor: pgliteExecutor(db) });
    await store.get('warm'); // creates the schema
    await db.exec(`
      CREATE SEQUENCE ntn_test_ticks;
      CREATE FUNCTION public.clock_timestamp() RETURNS timestamptz LANGUAGE sql
        AS 'SELECT pg_catalog.clock_timestamp() + make_interval(secs => nextval(''ntn_test_ticks''))';
      SET search_path = public, pg_catalog;
    `);
    await db.query(
      `INSERT INTO ntn_kv (key, value, expires_at)
       VALUES ('c', '100', pg_catalog.clock_timestamp() + interval '2.5 seconds')`,
    );
    const counted = await store.increment('c', 3600);
    const { rows } = await db.query<{ remaining: number }>(
      `SELECT extract(epoch FROM expires_at - pg_catalog.clock_timestamp())::float8 AS remaining
       FROM ntn_kv WHERE key = 'c'`,
    );
    const remaining = rows[0]?.remaining ?? 0;
    // Continued: 101 with the old, nearly spent window. Restarted: 1 with a fresh hour.
    expect(counted === 101 ? remaining < 60 : counted === 1 && remaining > 3000).toBe(true);
  });

  // Deliberately real time: this is the one test that shows expiry with no row manipulation.
  test('a short real ttl runs out', async () => {
    const store = new PostgresStore({ executor: pgliteExecutor(new PGlite()) });
    await store.set('k', 'v', { ttlSeconds: 0.15 });
    expect(await store.get('k')).toBe('v');
    await Bun.sleep(250);
    expect(await store.get('k')).toBeNull();
  });
});

async function count(db: PGlite): Promise<number> {
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM ntn_kv');
  return rows[0]?.n ?? -1;
}

const expireAll = (db: PGlite) =>
  db.query(
    `UPDATE ntn_kv SET expires_at = now() - interval '1 minute' WHERE expires_at IS NOT NULL`,
  );

describe('PostgresStore purge', () => {
  test('a ttl write removes expired rows, bounded per run and at most once per interval', async () => {
    const db = new PGlite();
    const store = new PostgresStore({ executor: pgliteExecutor(db), purgeIntervalMs: 60_000 });
    await store.set('keep', 'v'); // creates the schema
    await db.query(
      `INSERT INTO ntn_kv (key, value, expires_at)
       SELECT 'old' || n, 'v', now() - interval '1 minute' FROM generate_series(1, 230) AS n`,
    );
    expect(await count(db)).toBe(231);
    await store.set('timed', 'v', { ttlSeconds: 100 });
    // 200 per purge run, then the interval gate holds the next one back.
    expect(await count(db)).toBe(231 + 1 - 200);
    await store.set('timed2', 'v', { ttlSeconds: 100 });
    expect(await count(db)).toBe(231 + 2 - 200);
  });

  test('never removes live rows, expiry-less rows or set members', async () => {
    const db = new PGlite();
    const store = new PostgresStore({ executor: pgliteExecutor(db), purgeIntervalMs: 0 });
    await store.createIndexed('rec', 'v', 'set', 'm', 5);
    await store.set('live', 'v', { ttlSeconds: 1000 });
    await store.set('dies', 'v', { ttlSeconds: 1000 });
    await expireAll(db);
    await db.query(`UPDATE ntn_kv SET expires_at = now() + interval '1 hour' WHERE key = 'live'`);
    await store.increment('counter', 60);
    expect(await store.get('rec')).toBe('v');
    expect(await store.get('live')).toBe('v');
    expect(await store.setMembers('set')).toEqual(['m']);
    const { rows } = await db.query<{ key: string }>('SELECT key FROM ntn_kv ORDER BY key');
    expect(rows.map((row) => row.key)).toEqual(['counter', 'live', 'rec']);
  });

  test('a failing purge does not fail the write and is logged redacted', async () => {
    const log = silenced();
    const inner = pgliteExecutor(new PGlite());
    const flaky: SqlExecutor = {
      transaction: (batch, signal) => inner.transaction(batch, signal),
      query: (statement, signal) =>
        /DELETE FROM ntn_kv WHERE key IN/.test(statement.text)
          ? Promise.reject(new NeonDbError('purge down'))
          : inner.query(statement, signal),
    };
    const store = new PostgresStore({ executor: flaky, purgeIntervalMs: 0 });
    expect(await store.set('k', 'v', { ttlSeconds: 10 })).toBe(true);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      event: 'storage_failure',
      command: 'PURGE',
      kind: 'backend-error',
    });
  });

  test('writes without a ttl never purge', async () => {
    const exec = recording(pgliteExecutor(new PGlite()));
    const store = new PostgresStore({ executor: exec, purgeIntervalMs: 0 });
    await store.set('k', 'v');
    await store.compareAndSet('k', 'v', 'w');
    expect(exec.statements.some((s) => /SKIP LOCKED/.test(s.text))).toBe(false);
  });
});

describe('PostgresStore statements', () => {
  test('keys and values only ever travel as parameters, never inside the SQL text', async () => {
    const exec = recording(pgliteExecutor(new PGlite()));
    const store = new PostgresStore({ executor: exec });
    const key = "k'; DROP TABLE ntn_kv; --";
    const value = "v' OR '1'='1";
    await store.set(key, value, { ttlSeconds: 5 });
    await store.compareAndSet(key, value, 'w');
    await store.increment(`${key}:n`, 5);
    await store.createIndexed(`${key}:r`, value, `${key}:s`, "m'", 3);
    await store.moveIndexed({
      from: `${key}:r`,
      to: `${key}:t`,
      setKey: `${key}:s`,
      fromMember: "m'",
      toMember: "n'",
      expectedFrom: value,
      value,
    });
    await store.deleteIndexed(`${key}:t`, `${key}:s`, "n'", value);
    for (const { text } of exec.statements) {
      expect(text).not.toContain('DROP TABLE ntn_kv; --');
      expect(text).not.toContain("'1'='1");
    }
    expect(await store.get(key)).toBe('w');
  });

  test('index operations lock their set key inside the same transaction as their statement', async () => {
    const exec = recording(pgliteExecutor(new PGlite()));
    const batches: number[] = [];
    const wrapped: SqlExecutor = {
      query: (statement, signal) => exec.query(statement, signal),
      transaction: (batch, signal) => {
        batches.push(batch.length);
        return exec.transaction(batch, signal);
      },
    };
    const store = new PostgresStore({ executor: wrapped });
    await store.get('warm');
    batches.length = 0;
    await store.createIndexed('a', 'v', 'set', 'm', 3);
    await store.deleteIndexed('a', 'set', 'm');
    await store.moveIndexed({
      from: 'x',
      to: 'y',
      setKey: 'set',
      fromMember: 'a',
      toMember: 'b',
      expectedFrom: 'v',
      value: 'v',
    });
    expect(batches).toEqual([2, 2, 2]);
    const locks = exec.statements.filter((s) => /pg_advisory_xact_lock/.test(s.text));
    expect(locks.slice(-3).map((s) => s.params)).toEqual([['set'], ['set'], ['set']]);
  });
});

const wrongShape = (rows: readonly SqlRow[]): SqlExecutor => ({
  query: async () => rows,
  transaction: async () => [rows, rows],
});

describe('PostgresStore deadlines and errors', () => {
  test('an executor that never answers is an upstream_error within the timeout, for every command', async () => {
    silenced();
    const store = new PostgresStore({ executor: hanging, timeoutMs: 40 });
    const started = Date.now();
    for (const call of [
      () => store.get('k'),
      () => store.set('k', 'v'),
      () => store.increment('k', 60),
      () => store.compareAndSet('k', 'a', 'b'),
      () => store.createIndexed('k', 'v', 's', 'm', 3),
    ]) {
      const failure = await call().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure).toMatchObject({ code: 'upstream_error', status: 502 });
    }
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test('every request gets its own live deadline signal, passed to the executor', async () => {
    const exec = recording(pgliteExecutor(new PGlite()));
    const store = new PostgresStore({ executor: exec, timeoutMs: 5000 });
    await store.get('warm'); // the schema step has its own signal too
    exec.signals.length = 0;
    await store.get('a');
    await store.get('b');
    expect(exec.signals).toHaveLength(2);
    expect(new Set(exec.signals).size).toBe(exec.signals.length);
    expect(exec.signals.every((signal) => !signal.aborted)).toBe(true);
  });

  test('a deadline aborts the signal the executor was given', async () => {
    silenced();
    const seen: AbortSignal[] = [];
    const executor: SqlExecutor = {
      query: (statement, signal) => {
        if (isWarmup(statement)) return Promise.resolve([{ outcome: 1 }]);
        seen.push(signal);
        return new Promise<readonly SqlRow[]>(() => {});
      },
      transaction: () => Promise.resolve([]),
    };
    const store = new PostgresStore({ executor, timeoutMs: 30 });
    await store.get('k').catch(() => undefined);
    expect(seen[0]?.aborted).toBe(true);
  });

  test('logs one structured line with command and class, never keys, values, SQL or the URL', async () => {
    const log = silenced();
    const url = 'postgres://app_user:synthetic-password-xyz@ep-test.neon.tech/neondb';
    const store = new PostgresStore({
      executor: failing(
        new NeonDbError(`password authentication failed for ${url} at SELECT value FROM ntn_kv`),
      ),
    });
    await store.set('user-key-123', 'user-value-456').catch(() => undefined);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      event: 'storage_failure',
      command: 'SET',
      errorClass: 'NeonDbError',
      kind: 'backend-error',
    });
    for (const forbidden of [
      'synthetic-password-xyz',
      'neon.tech',
      'user-key-123',
      'user-value-456',
      'ntn_kv',
      'SELECT',
    ]) {
      expect(line).not.toContain(forbidden);
    }
  });

  test('transport faults, timeouts and malformed replies are told apart', async () => {
    const log = silenced();
    const kinds: string[] = [];
    for (const error of [
      new TypeError('fetch failed'),
      Object.assign(new Error('x'), { name: 'TimeoutError' }),
      new MalformedReplyError('rows'),
    ]) {
      await new PostgresStore({ executor: failing(error) }).get('k').catch(() => undefined);
      kinds.push(JSON.parse(String(log.mock.calls.at(-1)?.[0])).kind);
    }
    expect(kinds).toEqual(['network', 'timeout', 'bad-reply']);
  });

  test('identical failures are logged once per window, different ones separately', async () => {
    const log = silenced();
    const store = new PostgresStore({ executor: failing(new TypeError('down')) });
    for (let n = 0; n < 5; n++) await store.get('k').catch(() => undefined);
    expect(log).toHaveBeenCalledTimes(1);
    await store.delete('k').catch(() => undefined);
    expect(log).toHaveBeenCalledTimes(2);
  });

  test('a reply of the wrong shape is an upstream_error, not a value', async () => {
    // The schema step is a transaction too, so these executors answer it with something harmless.
    for (const [call, rows] of [
      [(s: PostgresStore) => s.get('k'), [{ value: 42 }]],
      [(s: PostgresStore) => s.increment('k', 5), [{ outcome: 'NaN' }]],
      [(s: PostgresStore) => s.createIndexed('k', 'v', 's', 'm', 1), [{ outcome: 'wat' }]],
      [(s: PostgresStore) => s.setMembers('s'), [{ member: 7 }]],
      [(s: PostgresStore) => s.delete('k'), [{ outcome: 'live' }, { outcome: 'live' }]],
      [(s: PostgresStore) => s.set('k', 'v', { ifAbsent: true }), [{}]],
      [(s: PostgresStore) => s.set('k', 'v'), [{ outcome: 'nope' }]],
      [(s: PostgresStore) => s.compareAndSet('k', 'a', 'b'), [{}]],
      [
        (s: PostgresStore) => s.compareAndSet('k', 'a', 'b'),
        [{ outcome: 'ok' }, { outcome: 'ok' }],
      ],
    ] as const) {
      const failure = await call(new PostgresStore({ executor: wrongShape(rows) })).catch(
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ code: 'upstream_error' });
    }
  });
});

/** An executor whose first answer takes `coldMs` (a suspended database), later ones are instant. */
function sleepy(coldMs: number) {
  const inner = recording(pgliteExecutor(new PGlite()));
  const state = { cold: true };
  const waking = <T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    if (!state.cold) return run();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.cold = false;
        run().then(resolve, reject);
      }, coldMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason);
      });
    });
  };
  const executor: SqlExecutor = {
    query: (statement, signal) => waking(() => inner.query(statement, signal), signal),
    transaction: (batch, signal) => waking(() => inner.transaction(batch, signal), signal),
  };
  return { executor, inner, state };
}

describe('PostgresStore warm-up (Neon scale-to-zero)', () => {
  test('a cold first call outlasts the statement deadline, waits for the warm-up and succeeds', async () => {
    const { executor, inner } = sleepy(120);
    const store = new PostgresStore({ executor, timeoutMs: 50, warmupTimeoutMs: 1000 });
    expect(await store.set('k', 'v')).toBe(true);
    expect(await store.get('k')).toBe('v');
    expect(inner.statements[0]?.text).toBe('SELECT 1 AS outcome');
  });

  test('concurrent first calls share one warm-up', async () => {
    const { executor, inner } = sleepy(60);
    const store = new PostgresStore({ executor, timeoutMs: 50, warmupTimeoutMs: 1000 });
    await Promise.all([store.get('a'), store.get('b'), store.set('c', 'v')]);
    expect(inner.statements.filter((s) => isWarmup(s))).toHaveLength(1);
  });

  test('a warm instance does not warm up again; an idle gap does', async () => {
    let now = 1_000_000;
    const exec = recording(pgliteExecutor(new PGlite()));
    const store = new PostgresStore({ executor: exec, idleMs: 240_000, now: () => now });
    const warmups = () => exec.statements.filter((s) => isWarmup(s)).length;
    await store.get('k');
    expect(warmups()).toBe(1);
    now += 239_000;
    await store.get('k');
    expect(warmups()).toBe(1);
    now += 239_000; // each answer restarts the idle clock
    await store.get('k');
    expect(warmups()).toBe(1);
    now += 241_000;
    await store.get('k');
    expect(warmups()).toBe(2);
    await store.get('k');
    expect(warmups()).toBe(2);
  });

  test('a warm-up slower than its deadline is an upstream_error, logged once as warmup-timeout', async () => {
    const log = silenced();
    const exec = recording(hanging);
    const slow: SqlExecutor = {
      query: (statement, signal) => {
        exec.statements.push(statement);
        return new Promise<readonly SqlRow[]>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        );
      },
      transaction: exec.transaction.bind(exec),
    };
    const store = new PostgresStore({ executor: slow, timeoutMs: 20, warmupTimeoutMs: 60 });
    const started = Date.now();
    const results = await Promise.all(
      [store.get('a'), store.get('b')].map((call) => call.catch((error: unknown) => error)),
    );
    for (const failure of results) {
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure).toMatchObject({ code: 'upstream_error', status: 502 });
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(exec.statements.filter((s) => isWarmup(s))).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      event: 'storage_failure',
      command: 'WARMUP',
      kind: 'warmup-timeout',
    });
  });

  test('a failed warm-up does not poison later calls', async () => {
    silenced();
    const inner = pgliteExecutor(new PGlite());
    let down = true;
    const executor: SqlExecutor = {
      query: (statement, signal) =>
        down && isWarmup(statement)
          ? Promise.reject(new TypeError('fetch failed'))
          : inner.query(statement, signal),
      transaction: (batch, signal) => inner.transaction(batch, signal),
    };
    const store = new PostgresStore({ executor });
    await expect(store.get('k')).rejects.toMatchObject({ code: 'upstream_error' });
    down = false;
    expect(await store.set('k', 'v')).toBe(true);
    expect(await store.get('k')).toBe('v');
  });

  test('real statements keep the normal deadline after the warm-up, and are never retried', async () => {
    silenced();
    const seen: Array<{ text: string; signal: AbortSignal }> = [];
    const executor: SqlExecutor = {
      query: (statement, signal) => {
        seen.push({ text: statement.text, signal });
        if (isWarmup(statement) || /to_regclass/.test(statement.text)) {
          return Promise.resolve([{ outcome: 'present' }]);
        }
        return new Promise<readonly SqlRow[]>(() => {}); // never answers
      },
      transaction: () => Promise.reject(new Error('unused')),
    };
    const store = new PostgresStore({ executor, timeoutMs: 40, warmupTimeoutMs: 5000 });
    const started = Date.now();
    await expect(store.increment('k', 60)).rejects.toMatchObject({ code: 'upstream_error' });
    expect(Date.now() - started).toBeLessThan(1000);
    const increments = seen.filter((entry) => /INSERT INTO ntn_kv/.test(entry.text));
    expect(increments).toHaveLength(1);
    expect(seen.filter((entry) => isWarmup({ text: entry.text, params: [] }))).toHaveLength(1);
    expect(increments[0]?.signal.aborted).toBe(true);
  });
});
