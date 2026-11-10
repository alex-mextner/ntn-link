/**
 * The only way the server talks to Notion (SSRF guard, spec section 7).
 *
 * Redirects are followed manually so every hop is re-checked against an allowlist; a
 * total deadline and a body cap bound both time and memory. Callers pick the allowlist:
 * page metadata and data use the Notion page hosts, the image proxy a narrower image
 * host list.
 */
import { ApiError } from './errors';
import { isAllowedNotionHost } from './notion-url';

/** Bot UA: Notion only serves complete OpenGraph tags to unfurler-like agents (spec section 2). */
export const BOT_USER_AGENT = 'Mozilla/5.0 (compatible; TelegramBot like TwitterBot)';

export const SAFE_FETCH_DEFAULTS = {
  maxHops: 5,
  timeoutMs: 5000,
  maxBytes: 1024 * 1024,
} as const;

export type UrlAllowlist = (url: URL) => boolean;

/** Page metadata/data hosts: https only, Notion hosts only. */
export const allowNotionPageUrl: UrlAllowlist = (url) =>
  url.protocol === 'https:' && url.port === '' && isAllowedNotionHost(url.hostname);

const IMAGE_EXACT_HOSTS: ReadonlySet<string> = new Set([
  'notion.site',
  'file.notion.so',
  'img.notionusercontent.com',
  'images.unsplash.com',
]);

/** Image hosts from spec section 5.3; `www.notion.so` only under `/images/`. */
export const allowNotionImageUrl: UrlAllowlist = (url) => {
  if (url.protocol !== 'https:' || url.port !== '') return false;
  const host = url.hostname.toLowerCase();
  if (IMAGE_EXACT_HOSTS.has(host)) return true;
  if (host.endsWith('.notion.site') && host.length > '.notion.site'.length) return true;
  return host === 'www.notion.so' && url.pathname.startsWith('/images/');
};

export interface SafeFetchOptions {
  allow: UrlAllowlist;
  method?: 'GET' | 'POST';
  headers?: Headers;
  body?: string;
  maxHops?: number;
  timeoutMs?: number;
  maxBytes?: number;
  /** Injection point for tests and for the test-only fetcher. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface SafeFetchResult {
  status: number;
  finalUrl: URL;
  headers: Headers;
  body: Uint8Array;
  /** True when the body was cut at `maxBytes`. Metadata lives in <head>, so cutting is fine. */
  truncated: boolean;
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ body: Uint8Array; truncated: boolean }> {
  if (!response.body) return { body: new Uint8Array(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, truncated };
}

/** Resolves the `Location` of a redirect response against the URL that produced it. */
async function redirectTarget(response: Response, from: URL): Promise<URL> {
  const location = response.headers.get('location');
  await response.body?.cancel();
  if (location === null) {
    throw new ApiError('upstream_error', 'Notion sent a redirect without a target.');
  }
  try {
    return new URL(location, from);
  } catch {
    throw new ApiError('upstream_error', 'Notion sent an invalid redirect target.');
  }
}

async function requestOnce(
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch {
    throw new ApiError('upstream_error', 'Notion did not answer in time. Try again in a moment.');
  }
}

async function readBodyOnce(response: Response, maxBytes: number) {
  try {
    return await readCapped(response, maxBytes);
  } catch {
    throw new ApiError('upstream_error', 'Notion did not finish answering in time.');
  }
}

export async function safeFetch(
  startUrl: URL,
  options: SafeFetchOptions,
): Promise<SafeFetchResult> {
  const maxHops = options.maxHops ?? SAFE_FETCH_DEFAULTS.maxHops;
  const maxBytes = options.maxBytes ?? SAFE_FETCH_DEFAULTS.maxBytes;
  const timeoutMs = options.timeoutMs ?? SAFE_FETCH_DEFAULTS.timeoutMs;
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(timeoutMs);

  let url = startUrl;
  let method = options.method ?? 'GET';
  let body = options.body;
  for (let hop = 0; hop <= maxHops; hop++) {
    if (!options.allow(url)) {
      throw new ApiError('upstream_error', 'The link leads outside Notion; refusing to follow it.');
    }
    const response = await requestOnce(fetchImpl, url, {
      method,
      headers: options.headers,
      body,
      redirect: 'manual',
      signal,
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      const read = await readBodyOnce(response, maxBytes);
      return {
        status: response.status,
        finalUrl: url,
        headers: response.headers,
        body: read.body,
        truncated: read.truncated,
      };
    }
    // 307/308 replay the original request; 301/302/303 turn it into a bodiless GET.
    const keepsRequest = response.status === 307 || response.status === 308;
    url = await redirectTarget(response, url);
    if (!keepsRequest) {
      method = 'GET';
      body = undefined;
    }
  }
  throw new ApiError('upstream_error', `Too many redirects (more than ${maxHops}).`);
}
