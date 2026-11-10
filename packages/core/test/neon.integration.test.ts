/**
 * PostgresStore on the REAL Neon database behind DATABASE_URL, through the production
 * executor (opt-in: `DATABASE_URL=... bun run test:neon`, skipped otherwise). Every key of the
 * run carries a unique `ntnlinktest:<random>:` prefix and is removed again afterwards, so it is
 * safe against a database that serves real data. Time travel only touches this run's rows.
 */
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { databaseUrlFromEnv } from '../src/postgres-store';
import { neonHttpExecutor } from '../src/sql-executor';
import { sqlHarness } from './support/sql-harness';
import { defineStoreContract } from './store-contract';

/**
 * The store runs with its production deadline. 220 calls at once do not fit it on the free
 * plan (even 220 plain reads at once time out: every call is its own HTTPS connection to a
 * 0.25 vCPU compute), so the burst is bounded; the cap invariants are asserted unchanged.
 */
const BURST_WIDTH = 20;

/** The bounded burst of 220 calls takes longer than bun's 5 s default per test. */
setDefaultTimeout(60_000);

const url = databaseUrlFromEnv(process.env);
const executor = url ? neonHttpExecutor(url) : null;

defineStoreContract(
  'PostgresStore on Neon',
  () => {
    if (!executor) throw new Error('unreachable: the suite is skipped without DATABASE_URL');
    return sqlHarness(executor, BURST_WIDTH);
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
