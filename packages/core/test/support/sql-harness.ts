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

export interface SqlHarness extends StoreHarness {
  /** Raw statement outside the store, for assertions about what the store did to the tables. */
  sql: (text: string, ...params: SqlParam[]) => Promise<readonly SqlRow[]>;
}

/**
 * `timeoutMs` is the store's per-statement deadline. A remote database needs a longer one for
 * the contract's parallel-creation cases: hundreds of calls queue on one set's advisory lock,
 * so the last waits for all the others and the production 3 s deadline would fire on it.
 */
export function sqlHarness(executor: SqlExecutor, timeoutMs?: number): SqlHarness {
  const keyPrefix = `ntnlinktest:${randomBytes(6).toString('hex')}:`;
  const like = `%${keyPrefix}%`;
  const sql = (text: string, ...params: SqlParam[]): Promise<readonly SqlRow[]> =>
    executor.query({ text, params }, AbortSignal.timeout(STATEMENT_DEADLINE_MS));
  return {
    store: new PostgresStore({ executor, timeoutMs }),
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
      await sql('DELETE FROM ntn_kv WHERE key LIKE $1::text', like);
      await sql(
        'DELETE FROM ntn_set_members WHERE set_key LIKE $1::text OR member LIKE $1::text',
        like,
      );
    },
  };
}
