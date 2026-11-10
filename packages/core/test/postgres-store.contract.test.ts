/**
 * The store contract on `PostgresStore` over PGlite. Time travel moves every stored expiry
 * of the run into the past (the store reads only the database clock, so this is what a later
 * "now" looks like to it). PGlite has a single connection, so real-server concurrency lives in
 * `postgres.integration.test.ts` (`bun run test:postgres`) and `neon.integration.test.ts`.
 */
import { PGlite } from '@electric-sql/pglite';
import { pgliteExecutor } from './support/pglite-executor';
import { sqlHarness } from './support/sql-harness';
import { defineStoreContract } from './store-contract';

defineStoreContract('PostgresStore on PGlite', () => sqlHarness(pgliteExecutor(new PGlite())));
