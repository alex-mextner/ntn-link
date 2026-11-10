/**
 * Loads all blocks of a public Notion page through the unofficial `loadPageChunk` API.
 *
 * Two facts shape this (probed 2026-11-10): `loadPageChunk` pages through a long page with
 * a `cursor` that must be echoed back with an increasing `chunkNumber`, and blocks nested
 * inside toggles, callouts or columns are not always part of those chunks, so referenced
 * children that are still missing are fetched with `syncRecordValuesMain`. Both calls work
 * without cookies for public pages. All traffic goes through `safeFetch` (SSRF guard).
 */
import { z } from 'zod';
import { allowNotionPageUrl, safeFetch } from '../safe-fetch';
import { NotionDataError, unwrapRecordMap, type NotionBlock, type RecordMap } from './records';

/** Upper bounds so a hostile or huge page cannot make one render unbounded. */
export const PAGE_CHUNK_LIMITS = {
  maxChunks: 40,
  maxMissingRounds: 4,
  syncBatchSize: 100,
  maxSyncRequests: 30,
  totalMissingMs: 30_000,
  maxBytesPerResponse: 8 * 1024 * 1024,
  timeoutMs: 10_000,
} as const;

const cursorSchema = z.object({ stack: z.array(z.array(z.unknown())) });
const chunkEnvelopeSchema = z.object({ cursor: cursorSchema.optional() });

export interface LoadPageChunkArgs {
  workspace: string;
  /** Dashed or plain 32-hex page id. */
  pageId: string;
  fetchImpl?: typeof fetch;
}

export function dashedId(id: string): string {
  const hex = id.replaceAll('-', '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new NotionDataError('Invalid Notion page id.');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function postJson(
  url: URL,
  body: unknown,
  fetchImpl: typeof fetch | undefined,
): Promise<unknown> {
  const result = await safeFetch(url, {
    allow: allowNotionPageUrl,
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', accept: 'application/json' }),
    body: JSON.stringify(body),
    maxBytes: PAGE_CHUNK_LIMITS.maxBytesPerResponse,
    timeoutMs: PAGE_CHUNK_LIMITS.timeoutMs,
    fetchImpl,
  }).catch((cause: unknown) => {
    throw new NotionDataError(
      `Notion did not answer the page data request: ${cause instanceof Error ? cause.message : 'unknown error'}`,
    );
  });
  if (result.status === 404 || result.status === 403 || result.status === 401) {
    throw new NotionDataError('The Notion page is not public.', { notPublic: true });
  }
  if (result.status !== 200 || result.truncated) {
    throw new NotionDataError(`Notion page data request failed with HTTP ${result.status}.`);
  }
  try {
    return JSON.parse(new TextDecoder().decode(result.body));
  } catch {
    throw new NotionDataError('Notion page data is not JSON.');
  }
}

/** Child ids that the page shows but the map does not contain yet. */
export function missingChildIds(blocks: Map<string, NotionBlock>, rootId: string): string[] {
  const missing = new Set<string>();
  const seen = new Set<string>();
  const stack = [rootId];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const block = blocks.get(id);
    if (!block) continue;
    for (const child of block.content) {
      const known = blocks.get(child);
      if (known === undefined) missing.add(child);
      // Sub-pages are rendered as links, so their bodies are never needed.
      else if (known.type !== 'page') stack.push(child);
    }
  }
  return [...missing];
}

async function loadAllChunks(
  origin: string,
  pageId: string,
  fetchImpl: typeof fetch | undefined,
): Promise<{ blocks: Map<string, NotionBlock>; incomplete: boolean }> {
  const url = new URL('/api/v3/loadPageChunk', origin);
  const blocks = new Map<string, NotionBlock>();
  let cursor: z.infer<typeof cursorSchema> = { stack: [] };
  let incomplete = false;
  for (let chunkNumber = 0; chunkNumber < PAGE_CHUNK_LIMITS.maxChunks; chunkNumber++) {
    const raw = await postJson(
      url,
      { page: { id: pageId }, limit: 100, cursor, chunkNumber, verticalColumns: false },
      fetchImpl,
    );
    for (const [id, block] of unwrapRecordMap(raw).blocks) blocks.set(id, block);
    const envelope = chunkEnvelopeSchema.safeParse(raw);
    cursor = envelope.success ? (envelope.data.cursor ?? { stack: [] }) : { stack: [] };
    if (cursor.stack.length === 0) break;
    incomplete = chunkNumber === PAGE_CHUNK_LIMITS.maxChunks - 1;
  }
  return { blocks, incomplete };
}

/** Returns true when the request/time budget ran out while children were still missing. */
async function loadMissing(
  origin: string,
  rootId: string,
  blocks: Map<string, NotionBlock>,
  fetchImpl: typeof fetch | undefined,
): Promise<boolean> {
  const url = new URL('/api/v3/syncRecordValuesMain', origin);
  const deadline = Date.now() + PAGE_CHUNK_LIMITS.totalMissingMs;
  let requestsLeft: number = PAGE_CHUNK_LIMITS.maxSyncRequests;
  for (let round = 0; round < PAGE_CHUNK_LIMITS.maxMissingRounds; round++) {
    const missing = missingChildIds(blocks, rootId);
    if (missing.length === 0) return false;
    const before = blocks.size;
    for (let i = 0; i < missing.length; i += PAGE_CHUNK_LIMITS.syncBatchSize) {
      if (requestsLeft === 0 || Date.now() >= deadline) return true;
      requestsLeft--;
      const requests = missing
        .slice(i, i + PAGE_CHUNK_LIMITS.syncBatchSize)
        .map((id) => ({ pointer: { table: 'block', id }, version: -1 }));
      const raw = await postJson(url, { requests }, fetchImpl);
      for (const [id, block] of unwrapRecordMap(raw).blocks) blocks.set(id, block);
    }
    // Typeless (unreadable) records never appear in the map, so no progress means done.
    if (blocks.size === before) return false;
  }
  return missingChildIds(blocks, rootId).length > 0;
}

export async function loadPageChunk(args: LoadPageChunkArgs): Promise<RecordMap> {
  const pageId = dashedId(args.pageId);
  const origin = `https://${args.workspace}.notion.site`;
  const { blocks, incomplete } = await loadAllChunks(origin, pageId, args.fetchImpl);
  if (!blocks.has(pageId)) {
    throw new NotionDataError('The Notion page is not public.', { notPublic: true });
  }
  const missingLeft = await loadMissing(origin, pageId, blocks, args.fetchImpl);
  return { blocks, incomplete: incomplete || missingLeft };
}

/**
 * Only the first chunk of a page (about 100 blocks, in reading order): enough for a card
 * excerpt and one request instead of a full load. Nested children are not fetched.
 */
export async function loadPageStart(args: LoadPageChunkArgs): Promise<RecordMap> {
  const pageId = dashedId(args.pageId);
  const url = new URL('/api/v3/loadPageChunk', `https://${args.workspace}.notion.site`);
  const raw = await postJson(
    url,
    {
      page: { id: pageId },
      limit: 100,
      cursor: { stack: [] },
      chunkNumber: 0,
      verticalColumns: false,
    },
    args.fetchImpl,
  );
  const map = unwrapRecordMap(raw);
  if (!map.blocks.has(pageId)) {
    throw new NotionDataError('The Notion page is not public.', { notPublic: true });
  }
  return map;
}
