/**
 * Store selection from the environment. Precedence: Postgres (`DATABASE_URL`, the pooled Neon
 * URL) before Upstash Redis (`UPSTASH_REDIS_REST_*`, or the `KV_REST_API_*` names the Vercel
 * Marketplace injects). Nothing configured is the caller's decision: development falls back to
 * memory, production fails loud.
 */
import {
  PostgresStore,
  UpstashStore,
  databaseUrlFromEnv,
  neonHttpExecutor,
  upstashConfigFromEnv,
  type Store,
} from '@ntn-link/core';

export type StoreKind = 'postgres' | 'upstash';

export interface ChosenStore {
  kind: StoreKind;
  store: Store;
}

export function chooseStore(env: {
  readonly [name: string]: string | undefined;
}): ChosenStore | null {
  const databaseUrl = databaseUrlFromEnv(env);
  if (databaseUrl) {
    return {
      kind: 'postgres',
      store: new PostgresStore({ executor: neonHttpExecutor(databaseUrl) }),
    };
  }
  const upstash = upstashConfigFromEnv(env);
  if (upstash) return { kind: 'upstash', store: new UpstashStore(upstash) };
  return null;
}
