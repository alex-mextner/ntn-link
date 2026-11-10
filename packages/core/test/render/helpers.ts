/**
 * Builders for hand-made Notion payloads (the `-synthetic` fixtures: crafted, not recorded)
 * and a fake Notion `fetch` that serves recorded loadPageChunk chunks.
 */
import { readFileSync } from 'node:fs';
import { unwrapRecordMap, type BlockRenderCtx, type RecordMap } from '../../src/render';

export const WS = 'thsm';
export const ROOT = '00000000-0000-4000-8000-000000000001';
export const THSM_ID = '413d447a-c4b1-8016-9985-c93eea7f02f9';
export const OMAN_ID = '413d447a-c4b1-81ee-9199-f6a347244a4c';

export interface RawBlock {
  type: string;
  content?: string[];
  properties?: Record<string, unknown>;
  format?: Record<string, unknown>;
  last_edited_time?: number;
  created_time?: number;
}

/** Block id number `n` as a valid dashed uuid, so tests can name blocks by number. */
export const bid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n + 100).padStart(12, '0')}`;

function recordsOf(blocks: Record<string, RawBlock>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [id, block] of Object.entries(blocks)) {
    record[id] = { value: { value: { id, version: 1, ...block } } };
  }
  return record;
}

export function rawPayload(blocks: Record<string, RawBlock>): ChunkResponse {
  return { cursor: { stack: [] }, recordMap: { block: recordsOf(blocks) } };
}

export function mapOf(blocks: Record<string, RawBlock>): RecordMap {
  return unwrapRecordMap(rawPayload(blocks));
}

/** A page whose children are `children`, in insertion order unless `order` says otherwise. */
export function pageWith(
  children: Record<string, RawBlock>,
  order: string[] = Object.keys(children),
): Record<string, RawBlock> {
  return {
    [ROOT]: { type: 'page', content: order, properties: { title: [['Root']] } },
    ...children,
  };
}

export const testCtx = (overrides: Partial<BlockRenderCtx> = {}): BlockRenderCtx => ({
  workspace: WS,
  rootId: ROOT,
  imageUrl: (block, width) => `/img/content/${WS}/s/${block.id}?w=${width}`,
  ...overrides,
});

export const readFixture = (name: string): ChunkResponse =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

export const readChunks = (name: string): ChunkResponse[] =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

export interface ChunkResponse {
  cursor: { stack: unknown[] };
  recordMap: { block: Record<string, unknown> };
}

export interface FakeNotionOptions {
  /** Served for every `/image/` request with this content type. */
  image?: { bytes: Uint8Array<ArrayBuffer>; contentType: string };
  /** Records served only by `syncRecordValuesMain`, never by `loadPageChunk`. */
  syncOnly?: Record<string, unknown>;
}

/** Fake Notion: chunks by `chunkNumber`, `syncRecordValuesMain` from all chunks plus `syncOnly`. */
export function fakeNotion(chunks: ChunkResponse[], options: FakeNotionOptions = {}) {
  const requests: { url: string; body: unknown; accept: string | null }[] = [];
  const known = (id: string): unknown =>
    options.syncOnly?.[id] ?? chunks.map((c) => c.recordMap.block[id]).find((r) => r !== undefined);
  const impl = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: url.href, body, accept: new Headers(init?.headers).get('accept') });
    if (url.pathname === '/api/v3/loadPageChunk') {
      const chunk = chunks[(body as { chunkNumber: number }).chunkNumber];
      return chunk ? Response.json(chunk) : new Response('', { status: 404 });
    }
    if (url.pathname === '/api/v3/syncRecordValuesMain') {
      const asked = (body as { requests: { pointer: { id: string } }[] }).requests;
      const block: Record<string, unknown> = {};
      for (const { pointer } of asked) {
        const record = known(pointer.id);
        if (record !== undefined) block[pointer.id] = record;
      }
      return Response.json({ recordMap: { block } });
    }
    if (url.pathname.startsWith('/image/') && options.image) {
      return new Response(options.image.bytes, {
        headers: { 'content-type': options.image.contentType },
      });
    }
    return new Response('', { status: 404 });
  };
  return { impl: impl as typeof fetch, requests };
}

export { recordsOf };
