/**
 * Privacy gate for the AUTOMATIC "replace Notion's Copy link" path.
 *
 * Hard rule: our server learns a page id only after the extension itself proved the page
 * public with a direct, credential-less request to Notion's own public API, inside a workspace the user
 * switched on, with an owner key present. Every earlier step that fails ends the chain
 * with `null` ("leave the clipboard text alone") and no request to our origin.
 */
import { toDashedUuid } from '../../packages/core/src/notion-url';
import { isRecord } from './api';
import { PROOF_TTL_MS } from './config';
import type { KeyStore } from './keys';
import { resolveLink } from './link-service';
import { classifyPageUrl } from './notion-url';
import { TIMED_OUT, withTimeout } from './timeout';

export { PROOF_TTL_MS };

export interface PolicyDeps {
  keys: KeyStore;
  fetch: typeof fetch;
  now: () => number;
  timeoutMs: number;
  origin: string;
}

/** The answer is a few KB; anything larger is not what we asked for. */
const MAX_PROOF_BYTES = 256 * 1024;

/**
 * Notion's unauthenticated record endpoint. It was chosen over scraping the page HTML
 * because Notion answers browser-like clients (the only identity an extension can present;
 * Chrome ignores a User-Agent override on fetch) with its app shell, HTTP 200 for ANY id,
 * so status and og:title prove nothing. This endpoint returns the block record only for
 * pages readable without credentials and `{role: "none"}` otherwise (observed live).
 */
function proofRequest(ws: string, pageId: string): { url: string; init: RequestInit } {
  return {
    url: `https://${ws}.notion.site/api/v3/syncRecordValuesMain`,
    init: {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: [{ pointer: { table: 'block', id: toDashedUuid(pageId) }, version: -1 }],
      }),
    },
  };
}

function hasBlockRecord(body: unknown, pageId: string): boolean {
  const dashed = toDashedUuid(pageId);
  if (!isRecord(body) || !isRecord(body.recordMap) || !isRecord(body.recordMap.block)) return false;
  const entry = body.recordMap.block[dashed];
  const wrapper = isRecord(entry) ? entry.value : undefined;
  // Notion nests the record as `value.value`; `{role}` alone means "no access".
  const record = isRecord(wrapper) && isRecord(wrapper.value) ? wrapper.value : undefined;
  return record?.id === dashed;
}

async function fetchProof(
  ws: string,
  pageId: string,
  d: Pick<PolicyDeps, 'fetch'>,
  signal: AbortSignal,
): Promise<boolean> {
  const { url, init } = proofRequest(ws, pageId);
  const res = await d.fetch(url, { ...init, signal });
  if (res.status !== 200) return false;
  // A redirect to another host is not a proof for this workspace.
  if (new URL(res.url).hostname !== `${ws}.notion.site`) return false;
  const text = await res.text();
  if (text.length > MAX_PROOF_BYTES) return false;
  return hasBlockRecord(JSON.parse(text), pageId);
}

/** True only when the page is demonstrably public on its own `<ws>.notion.site` domain. */
export async function provePublic(
  ws: string,
  pageId: string,
  d: Pick<PolicyDeps, 'keys' | 'fetch' | 'now' | 'timeoutMs' | 'origin'>,
): Promise<boolean> {
  const cacheKey = `${ws}/${pageId}`;
  const cached = await d.keys.getPublicProof(cacheKey, d.now());
  if (cached !== null) return cached;
  let ok = false;
  let definite = true;
  try {
    const out = await withTimeout(d.timeoutMs, (signal) => fetchProof(ws, pageId, d, signal));
    if (out === TIMED_OUT) definite = false;
    else ok = out;
  } catch {
    // DNS failure and the like: not public as far as we can tell, but not a Notion answer
    // either, so it is not cached (a flaky network must not pin a page as private).
    definite = false;
  }
  if (definite) await d.keys.setPublicProof(cacheKey, ok, d.now());
  return ok;
}

/** The pretty link to write instead of `url`, or null to leave the clipboard untouched. */
export async function interceptionLink(url: string, d: PolicyDeps): Promise<string | null> {
  const deadline = d.now() + d.timeoutMs;
  try {
    const page = classifyPageUrl(url);
    if (page === null || page.workspace === null) return null;
    const ws = page.workspace;
    if (!(await d.keys.isAutoEnabled(ws))) return null;
    if ((await d.keys.getKey(ws)) === null) return null;
    // One deadline for the whole chain (started before any storage await): if the page-side
    // wrapper already gave up, our API must not still create a link nobody asked for.
    if (!(await provePublic(ws, page.pageId, d))) return null;
    const remaining = deadline - d.now();
    if (remaining <= 0) return null;
    const out = await resolveLink({
      url: page.canonical,
      kind: 'pretty',
      keys: d.keys,
      fetch: d.fetch,
      timeoutMs: remaining,
      origin: d.origin,
      now: d.now,
    });
    return out.ok ? out.link : null;
  } catch {
    return null;
  }
}
