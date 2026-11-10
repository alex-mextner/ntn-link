/**
 * PostgresStore on the REAL Neon database behind DATABASE_URL, through the production
 * executor (opt-in: `DATABASE_URL=... bun run test:neon`, skipped otherwise). Every key of the
 * run carries a unique `ntnlinktest:<random>:` prefix and is removed again afterwards, so it is
 * safe against a database that serves real data. Time travel only touches this run's rows.
 */
import { describe, expect, test } from 'bun:test';
import { databaseUrlFromEnv } from '../src/postgres-store';
import { neonHttpExecutor } from '../src/sql-executor';
import { sqlHarness } from './support/sql-harness';
import { defineStoreContract } from './store-contract';

const url = databaseUrlFromEnv(process.env);
const executor = url ? neonHttpExecutor(url) : null;

defineStoreContract(
  'PostgresStore on Neon',
  () => {
    if (!executor) throw new Error('unreachable: the suite is skipped without DATABASE_URL');
    return sqlHarness(executor);
  },
  { skip: executor === null },
);

(executor ? describe : describe.skip)('Neon server', () => {
  test('reports the server it ran against', async () => {
    const [row] =
      (await executor?.query(
        { text: 'SELECT version() AS version', params: [] },
        AbortSignal.timeout(10_000),
      )) ?? [];
    console.log(`neon server: ${String(row?.version)}`);
    expect(typeof row?.version).toBe('string');
  });
});
