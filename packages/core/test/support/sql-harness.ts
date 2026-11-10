/**
 * Contract harness for a `PostgresStore` over any executor. Time travel and TTL probes go
 * through plain SQL, restricted to the rows of this run (their keys contain the run prefix),
 * so the same harness is safe against a shared database such as a real Neon branch.
 */
import { randomBytes } from 'node:crypto';
import { PostgresStore } from '../../src/postgres-store';
import type { SqlExecutor, SqlParam, SqlRow } from '../../src/sql-executor';
import type { StoreHarness } from '../store-contract';

const STATEMENT_DEADLINE_MS = 15_000;
/** One cleanup attempt; shorter than a test statement so the retries fit the afterAll budget. */
const CLEANUP_DEADLINE_MS = 10_000;
/** Pauses between the attempts of a cleanup statement (so there are `length + 1` attempts). */
const CLEANUP_BACKOFF_MS: readonly number[] = [250, 1_000];

export interface SqlHarness extends StoreHarness {
  /** Raw statement outside the store, for assertions about what the store did to the tables. */
  sql: (text: string, ...params: SqlParam[]) => Promise<readonly SqlRow[]>;
}

export function sqlHarness(
  executor: SqlExecutor,
  maxParallelism?: number,
  backoffMs: readonly number[] = CLEANUP_BACKOFF_MS,
): SqlHarness {
  const keyPrefix = `ntnlinktest:${randomBytes(6).toString('hex')}:`;
  const like = `%${keyPrefix}%`;
  const sql = (text: string, ...params: SqlParam[]): Promise<readonly SqlRow[]> =>
    executor.query({ text, params }, AbortSignal.timeout(STATEMENT_DEADLINE_MS));
  return {
    store: new PostgresStore({ executor }),
    ...(maxParallelism === undefined ? {} : { maxParallelism }),
    keyPrefix,
    sql,
    advanceSeconds: async (seconds) => {
      await sql(
        `UPDATE ntn_kv SET expires_at = expires_at - make_interval(secs => $1::double precision)
         WHERE expires_at IS NOT NULL AND key LIKE $2::text`,
        seconds,
        like,
      );
    },
    ttlSecondsOf: async (key) => {
      const [row] = await sql(
        `SELECT ceil(extract(epoch FROM expires_at - clock_timestamp()))::int AS remaining
         FROM ntn_kv WHERE key = $1::text`,
        key,
      );
      return typeof row?.remaining === 'number' ? row.remaining : null;
    },
    dispose: async () => {
      // Runs in afterAll, i.e. also after failed tests. Both deletes run at once and each is
      // retried with a growing pause, so a blip of the connection cannot leave rows and the
      // worst case (every attempt waits out its hard limit of 11 s) is about 34 s, inside the 60 s
      // that `afterAll(h.dispose, ...)` allows in store-contract.ts.
      const cleanups: ReadonlyArray<readonly [string, ...SqlParam[]]> = [
        ['DELETE FROM ntn_kv WHERE key LIKE $1::text', like],
        ['DELETE FROM ntn_set_members WHERE set_key LIKE $1::text OR member LIKE $1::text', like],
      ];
      const outcomes = await Promise.all(
        cleanups.map(([text, ...params]) =>
          retried(
            () =>
              withinDeadline(
                executor.query({ text, params }, AbortSignal.timeout(CLEANUP_DEADLINE_MS)),
              ),
            backoffMs,
          ),
        ),
      );
      const failed = outcomes.flatMap((outcome, index) =>
        outcome === null ? [] : [`${cleanups[index]?.[0]} (${outcome})`],
      );
      if (failed.length > 0) {
        throw new Error(
          `Cleanup of ${keyPrefix} failed, remove its rows by hand: ${failed.join('; ')}`,
        );
      }
    },
  };
}

/** Rejects after the cleanup deadline even when the executor ignores its abort signal (a stalled `pg` socket). */
function withinDeadline<T>(attempt: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('cleanup deadline')),
      CLEANUP_DEADLINE_MS + 1_000,
    );
    attempt.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** What a failed attempt may say: the error class and code, never its message (it may quote a URL). */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? `${error.name} ${code}` : error.name;
}

/** null when an attempt succeeded, otherwise the description of the last failure. */
async function retried(
  attempt: () => Promise<unknown>,
  backoffMs: readonly number[],
): Promise<string | null> {
  let failure = '';
  for (let tries = 0; tries <= backoffMs.length; tries++) {
    try {
      await attempt();
      return null;
    } catch (error) {
      failure = describeFailure(error);
      const pause = backoffMs[tries];
      if (pause !== undefined) await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
  return failure;
}
