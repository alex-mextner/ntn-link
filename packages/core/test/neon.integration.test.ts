/**
 * PostgresStore on a REAL Neon database through the production executor. Opt-in and guarded
 * (see `support/live-db-guard.ts`): it never reads `DATABASE_URL`, and runs only with
 *
 *   NTN_TEST_DATABASE_URL=<a separate Neon branch> NTN_ALLOW_LIVE_DB_TESTS=1 bun run test:neon
 *
 * and is skipped otherwise. Every key of the run carries a unique `ntnlinktest:<random>:`
 * prefix and is removed again in `afterAll`, which also runs after failures. Time travel only
 * touches this run's rows.
 */
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { neonHttpExecutor } from '../src/sql-executor';
import { liveDbTarget } from './support/live-db-guard';
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

const target = liveDbTarget(process.env);
const executor = target.kind === 'run' ? neonHttpExecutor(target.url) : null;

defineStoreContract(
  'PostgresStore on Neon',
  () => {
    if (!executor) throw new Error('unreachable: the suite is skipped without a live target');
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
