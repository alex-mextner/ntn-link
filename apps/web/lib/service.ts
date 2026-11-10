/**
 * Process-wide service singleton shared by every route (and by the fast-variant routes).
 *
 * Configuration problems throw a `server_misconfigured` ApiError so a deployment without a
 * store fails loudly with a clear 500 instead of silently keeping data in memory, where it
 * would vanish on every cold start.
 */
import { revalidatePath } from 'next/cache';
import {
  ApiError,
  MemoryStore,
  UpstashStore,
  createPageFetcher,
  createService,
  upstashConfigFromEnv,
  type PageFetcher,
  type Service,
  type Store,
} from '@ntn-link/core';
import { createTestFetcher, type TestFetcher } from './test-fetcher';

interface Runtime {
  service: Service;
  testFetcher: TestFetcher | null;
}

const RUNTIME_KEY = Symbol.for('ntn-link.runtime');
type WithRuntime = typeof globalThis & { [RUNTIME_KEY]?: Runtime };

function misconfigured(message: string): ApiError {
  console.error(`ntn-link misconfigured: ${message}`);
  return new ApiError('server_misconfigured', message);
}

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

function resolveOrigin(): string {
  const configured =
    process.env.PUBLIC_ORIGIN ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined);
  if (configured) return configured.replace(/\/+$/, '');
  if (isProduction()) {
    throw misconfigured('PUBLIC_ORIGIN is not set; it is required in production.');
  }
  return `http://localhost:${process.env.PORT ?? '3000'}`;
}

function resolveStore(): Store {
  const config = upstashConfigFromEnv(process.env);
  if (config) return new UpstashStore(config);
  if (isProduction()) {
    throw misconfigured(
      'No storage configured: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL and KV_REST_API_TOKEN).',
    );
  }
  console.warn('ntn-link: no Upstash config, using the in-memory store (development only).');
  return new MemoryStore();
}

async function purgeEdgeCaches(workspace: string, slug: string): Promise<void> {
  try {
    revalidatePath(`/${workspace}/${slug}/read`);
  } catch (error) {
    console.error('revalidatePath failed', error);
  }
  if (!process.env.VERCEL) return;
  try {
    const { dangerouslyDeleteByTag } = await import('@vercel/functions');
    await dangerouslyDeleteByTag(linkCacheTag(workspace, slug));
  } catch (error) {
    // A failed purge only delays freshness until s-maxage runs out.
    console.error('CDN purge failed', error);
  }
}

/** Attached to every public response of one link so a single purge clears all its forms. */
export function linkCacheTag(workspace: string, slug: string): string {
  return `ntn-${workspace}-${slug}`;
}

function build(): Runtime {
  let fetcher: PageFetcher = createPageFetcher();
  let testFetcher: TestFetcher | null = null;
  if (process.env.NTN_TEST_FETCHER === '1') {
    if (isProduction()) throw misconfigured('NTN_TEST_FETCHER must not be set in production.');
    testFetcher = createTestFetcher(fetcher, {
      dropImage: process.env.NTN_TEST_FETCHER_NO_IMAGE === '1',
    });
    fetcher = testFetcher;
  }
  const service = createService({
    store: resolveStore(),
    fetcher,
    origin: resolveOrigin(),
    purge: purgeEdgeCaches,
  });
  return { service, testFetcher };
}

function runtime(): Runtime {
  const holder = globalThis as WithRuntime;
  holder[RUNTIME_KEY] ??= build();
  return holder[RUNTIME_KEY];
}

export function getService(): Service {
  return runtime().service;
}

/** Non-null only when the dev/test fetcher is active. */
export function getTestFetcher(): TestFetcher | null {
  return runtime().testFetcher;
}
