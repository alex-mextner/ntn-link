/**
 * `SqlExecutor` over an in-process PGlite (real Postgres compiled to WASM): the executor the
 * store tests run on. PGlite has one connection, so concurrent calls queue instead of racing;
 * the real-server suites (`test:postgres`, `test:neon`) are what exercise true concurrency.
 */
import { PGlite } from '@electric-sql/pglite';
import type { SqlExecutor, SqlRow, SqlStatement } from '../../src/sql-executor';

async function run(
  target: Pick<PGlite, 'query'>,
  { text, params }: SqlStatement,
): Promise<readonly SqlRow[]> {
  return (await target.query<SqlRow>(text, [...params])).rows;
}

export function pgliteExecutor(db: PGlite): SqlExecutor {
  return {
    query: (statement) => run(db, statement),
    transaction: (statements) =>
      db.transaction(async (tx) => {
        const results: Array<readonly SqlRow[]> = [];
        for (const statement of statements) results.push(await run(tx, statement));
        return results;
      }),
  };
}
