/**
 * The production executor: `neonHttpExecutor` and the real Neon serverless driver, against a
 * local stand-in for Neon's HTTP endpoint over PGlite (see support/neon-http-shim.ts). The
 * whole store contract runs through it, so what the driver does to parameters, batches and
 * errors is covered here; the real service is covered by `bun run test:neon`.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { PostgresStore } from '../src/postgres-store';
import { neonHttpExecutor } from '../src/sql-executor';
import { startNeonShim } from './support/neon-http-shim';
import { pgliteExecutor } from './support/pglite-executor';
import { sqlHarness } from './support/sql-harness';
import { defineStoreContract, eventually } from './store-contract';

const backend = pgliteExecutor(new PGlite());
const shim = startNeonShim(backend);
afterAll(() => shim.stop());

// Time travel and TTL probes talk to the database directly; the store under test goes over HTTP.
const direct = sqlHarness(backend);
defineStoreContract('PostgresStore through the Neon HTTP driver', () => ({
  ...direct,
  store: new PostgresStore({ executor: neonHttpExecutor(shim.connectionString) }),
}));

const newStore = (timeoutMs?: number): PostgresStore =>
  new PostgresStore({ executor: neonHttpExecutor(shim.connectionString), timeoutMs });

describe('neonHttpExecutor', () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
  });
  function silenced() {
    const log = spyOn(console, 'error').mockImplementation(() => {});
    restores.push(() => log.mockRestore());
    return log;
  }
  test('a single statement is one HTTP request, an index operation one batch with its lock', async () => {
    const store = newStore();
    await store.get('warm');
    shim.requests.length = 0;
    await store.get('k');
    await store.createIndexed(`neon-http:${crypto.randomUUID()}`, 'v', 'neon-http-set', 'm', 3);
    expect(shim.requests).toEqual([
      { batch: false, isolation: null, statements: 1 },
      { batch: true, isolation: 'ReadCommitted', statements: 2 },
    ]);
    await store.deleteIndexed('x', 'neon-http-set', 'm');
  });

  test('a hanging endpoint is an upstream_error within the deadline and the request is abandoned', async () => {
    const log = silenced();
    const store = newStore(150);
    await store.get('warm');
    const abortedBefore = shim.aborted();
    shim.hangNext();
    const started = Date.now();
    await expect(store.get('k')).rejects.toMatchObject({ code: 'upstream_error', status: 502 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ kind: 'timeout' });
    // The driver's fetch carries the deadline signal, so the connection really is dropped.
    await eventually(async () => expect(shim.aborted()).toBeGreaterThan(abortedBefore), 2000);
  });

  test('a database error answer is a typed backend-error that leaks neither text nor values', async () => {
    const log = silenced();
    const store = newStore();
    await store.get('warm');
    shim.failNext({
      message: 'relation "ntn_kv" does not exist, password=shim_password key=user-key-1',
      code: '42P01',
    });
    await expect(store.set('user-key-1', 'user-value-1')).rejects.toMatchObject({
      code: 'upstream_error',
    });
    const line = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      command: 'SET',
      errorClass: 'NeonDbError',
      kind: 'backend-error',
    });
    for (const forbidden of [
      'ntn_kv',
      'shim_password',
      'user-key-1',
      'user-value-1',
      'neon.tech',
    ]) {
      expect(line).not.toContain(forbidden);
    }
  });

  test('an unreachable endpoint is a network failure, not a hang', async () => {
    const log = silenced();
    const dead = Bun.serve({ port: 0, fetch: () => new Response('x') });
    const port = dead.port;
    await dead.stop(true);
    const { neonConfig } = await import('@neondatabase/serverless');
    const previous = neonConfig.fetchEndpoint;
    neonConfig.fetchEndpoint = () => `http://127.0.0.1:${port}/sql`;
    try {
      await expect(newStore().get('k')).rejects.toMatchObject({ code: 'upstream_error' });
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ kind: 'network' });
    } finally {
      neonConfig.fetchEndpoint = previous;
    }
  });
});
