/** Store precedence: DATABASE_URL (Postgres) wins over the Upstash/KV names; nothing is null. */
import { describe, expect, test } from 'bun:test';
import { PostgresStore, UpstashStore } from '@ntn-link/core';
import { chooseStore } from '../lib/store';

const DB = 'postgres://u:p@ep-x-123456.eu-central-1.aws.neon.tech/neondb';
const UPSTASH = { UPSTASH_REDIS_REST_URL: 'https://r.test', UPSTASH_REDIS_REST_TOKEN: 't' };
const KV = { KV_REST_API_URL: 'https://r.test', KV_REST_API_TOKEN: 't' };

describe('chooseStore', () => {
  test('DATABASE_URL selects Postgres, even with Upstash or KV variables set', () => {
    for (const rest of [{}, UPSTASH, KV, { ...UPSTASH, ...KV }]) {
      const chosen = chooseStore({ DATABASE_URL: DB, ...rest });
      expect(chosen?.kind).toBe('postgres');
      expect(chosen?.store).toBeInstanceOf(PostgresStore);
    }
  });

  test('without DATABASE_URL the Upstash pair, or the KV pair, selects Upstash', () => {
    for (const env of [UPSTASH, KV, { DATABASE_URL: '  ', ...UPSTASH }]) {
      const chosen = chooseStore(env);
      expect(chosen?.kind).toBe('upstash');
      expect(chosen?.store).toBeInstanceOf(UpstashStore);
    }
  });

  test('nothing configured, or half a pair, selects nothing', () => {
    expect(chooseStore({})).toBeNull();
    expect(chooseStore({ UPSTASH_REDIS_REST_URL: 'https://r.test' })).toBeNull();
    expect(chooseStore({ DATABASE_URL: '' })).toBeNull();
  });
});
