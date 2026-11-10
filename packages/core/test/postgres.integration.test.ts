/**
 * PostgresStore on a REAL Postgres server over a pooled node-postgres connection (opt-in:
 * `bun run test:postgres`, which starts a throwaway container; skipped otherwise). Unlike
 * PGlite this has many connections, so the parallel-caller tests of the contract really race:
 * they show that the statements and advisory locks hold their guarantees under true concurrency.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { pgExecutor } from './support/pg-executor';
import { sqlHarness } from './support/sql-harness';
import { defineStoreContract } from './store-contract';

const url = process.env.POSTGRES_TEST_URL;
const executor = url ? pgExecutor(url) : null;
afterAll(() => executor?.close());

defineStoreContract(
  'PostgresStore on a real Postgres',
  () => {
    if (!executor) throw new Error('unreachable: the suite is skipped without POSTGRES_TEST_URL');
    return sqlHarness(executor);
  },
  { skip: executor === null },
);

(executor ? describe : describe.skip)('Postgres server', () => {
  test('reports the server it ran against', async () => {
    const [row] =
      (await executor?.query(
        { text: 'SELECT version() AS version', params: [] },
        AbortSignal.timeout(10_000),
      )) ?? [];
    console.log(`postgres server: ${String(row?.version)}`);
    expect(typeof row?.version).toBe('string');
  });
});
