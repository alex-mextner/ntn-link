/**
 * UpstashStore against a REAL Redis (opt-in: `bun run test:redis`, skipped otherwise).
 * The in-memory store is trivially atomic, so only a real server can show that the Lua
 * scripts hold their guarantees under parallel callers. The behaviours themselves are the
 * shared store contract; a real Redis cannot be time-travelled, so the expiry tests that need
 * it are skipped here and TTLs are read back with the TTL command instead.
 */
import { describe, expect, test } from 'bun:test';
import { UpstashStore } from '../src/upstash-store';
import { defineStoreContract, eventually } from './store-contract';

const url = process.env.REDIS_REST_TEST_URL;
const token = process.env.REDIS_REST_TEST_TOKEN;
const live = url !== undefined && token !== undefined;

/**
 * Raw command outside the store, to observe what the store did to Redis itself. It is not the
 * store's client, so on a replicated endpoint it carries no read-your-writes token and may
 * briefly see older data: assertions on it go through `eventually`.
 */
async function raw(...command: Array<string | number>): Promise<unknown> {
  const response = await fetch(url ?? '', {
    method: 'POST',
    headers: { authorization: `Bearer ${token ?? ''}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
  const json: { result?: unknown; error?: string } = await response.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}

defineStoreContract(
  'UpstashStore on real Redis',
  () => ({
    store: new UpstashStore({ url: url ?? '', token: token ?? '' }),
    ttlSecondsOf: async (key) => {
      const ttl = Number(await raw('TTL', key));
      return ttl > 0 ? ttl : null;
    },
  }),
  { skip: !live },
);

(live ? describe : describe.skip)('Redis server', () => {
  test('reports the server it ran against', async () => {
    await eventually(async () => {
      const info = String(await raw('INFO', 'server'));
      const version = /(?:redis|valkey)_version:(\S+)/.exec(info)?.[1];
      console.log(`redis server version: ${version}`);
      expect(version).toBeDefined();
    });
  });
});
