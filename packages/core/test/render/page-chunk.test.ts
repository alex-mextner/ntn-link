import { describe, expect, test } from 'bun:test';
import {
  NotionDataError,
  PAGE_CHUNK_LIMITS,
  loadPageChunk,
  missingChildIds,
  unwrapRecordMap,
} from '../../src/render';
import {
  OMAN_ID,
  ROOT,
  THSM_ID,
  bid,
  fakeNotion,
  mapOf,
  pageWith,
  rawPayload,
  readChunks,
  readFixture,
  recordsOf,
} from './helpers';

describe('unwrapRecordMap', () => {
  test('reads the recorded thsm payload and drops typeless records', () => {
    const { blocks } = unwrapRecordMap(readFixture('thsm-loadPageChunk.json'));
    expect(blocks.get(THSM_ID)?.type).toBe('page');
    expect(blocks.get(THSM_ID)?.properties.title).toEqual([['Наши с Леночкой Путешествия']]);
    expect([...blocks.values()].every((b) => b.type.length > 0)).toBe(true);
    // 21 records minus the 2 typeless ones.
    expect(blocks.size).toBe(19);
  });

  test('accepts the older flat record shape', () => {
    const flat = { recordMap: { block: { a: { value: { id: 'a', type: 'text' } } } } };
    expect([...unwrapRecordMap(flat).blocks.keys()]).toEqual(['a']);
  });

  test('a payload without recordMap.block fails loudly', () => {
    expect(() => unwrapRecordMap({})).toThrow(NotionDataError);
  });

  test('a malformed format field degrades to absent instead of failing the page', () => {
    const raw = {
      recordMap: {
        block: { a: { value: { id: 'a', type: 'image', format: { block_width: 'wide' } } } },
      },
    };
    expect(unwrapRecordMap(raw).blocks.get('a')?.format.block_width).toBeUndefined();
  });
});

describe('loadPageChunk', () => {
  test('posts the pinned request to the workspace host', async () => {
    const fake = fakeNotion([readFixture('thsm-loadPageChunk.json')]);
    await loadPageChunk({
      workspace: 'thsm',
      pageId: THSM_ID.replaceAll('-', ''),
      fetchImpl: fake.impl,
    });
    expect(fake.requests[0]?.url).toBe('https://thsm.notion.site/api/v3/loadPageChunk');
    expect(fake.requests[0]?.body).toEqual({
      page: { id: THSM_ID },
      limit: 100,
      cursor: { stack: [] },
      chunkNumber: 0,
      verticalColumns: false,
    });
  });

  test('follows the cursor through every chunk of a long page', async () => {
    const fake = fakeNotion(readChunks('render/oman-chunks.json'));
    const { blocks } = await loadPageChunk({
      workspace: 'thsm',
      pageId: OMAN_ID,
      fetchImpl: fake.impl,
    });
    const loads = fake.requests.filter((r) => r.url.endsWith('loadPageChunk'));
    expect(loads.map((r) => (r.body as { chunkNumber: number }).chunkNumber)).toEqual([0, 1, 2]);
    expect([...blocks.values()].filter((b) => b.type === 'image')).toHaveLength(10);
    expect(missingChildIds(blocks, OMAN_ID)).toEqual([]);
  });

  test('fetches children that the chunks referenced but did not contain', async () => {
    const inner = bid(2);
    const all = pageWith({
      [bid(1)]: { type: 'toggle', content: [inner] },
      [inner]: { type: 'text', properties: { title: [['hidden inside']] } },
    });
    const { [inner]: innerBlock, ...visible } = all;
    const fake = fakeNotion([rawPayload(visible)], {
      syncOnly: innerBlock ? recordsOf({ [inner]: innerBlock }) : {},
    });
    expect(missingChildIds(mapOf(visible).blocks, ROOT)).toEqual([inner]);
    const { blocks } = await loadPageChunk({
      workspace: 'thsm',
      pageId: ROOT,
      fetchImpl: fake.impl,
    });
    expect(blocks.has(inner)).toBe(true);
    expect(fake.requests.at(-1)?.url).toBe('https://thsm.notion.site/api/v3/syncRecordValuesMain');
  });

  test('an unreadable child that never arrives does not loop', async () => {
    const all = pageWith({ [bid(1)]: { type: 'toggle', content: [bid(9)] } });
    const fake = fakeNotion([rawPayload(all)]);
    await loadPageChunk({ workspace: 'thsm', pageId: ROOT, fetchImpl: fake.impl });
    expect(fake.requests.filter((r) => r.url.endsWith('syncRecordValuesMain'))).toHaveLength(1);
  });

  test('a page with thousands of missing children stops at the request budget', async () => {
    const ids = Array.from({ length: 10_001 }, (_, i) => bid(i + 10));
    const all = pageWith({ [bid(1)]: { type: 'toggle', content: ids } });
    const fake = fakeNotion([rawPayload(all)]);
    const map = await loadPageChunk({ workspace: 'thsm', pageId: ROOT, fetchImpl: fake.impl });
    const syncs = fake.requests.filter((r) => r.url.endsWith('syncRecordValuesMain'));
    expect(syncs).toHaveLength(PAGE_CHUNK_LIMITS.maxSyncRequests);
    expect(map.incomplete).toBe(true);
  });

  test('a page that never stops paging is cut at the limit and flagged incomplete', async () => {
    const endless = { ...rawPayload(pageWith({})), cursor: { stack: [[{ id: 'x' }]] } };
    const fake = fakeNotion(Array.from({ length: 60 }, () => endless));
    const map = await loadPageChunk({ workspace: 'thsm', pageId: ROOT, fetchImpl: fake.impl });
    expect(map.incomplete).toBe(true);
    expect(fake.requests.filter((r) => r.url.endsWith('loadPageChunk'))).toHaveLength(40);
  });

  test('a 404 means the page is not public', async () => {
    const impl = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    const error = await loadPageChunk({
      workspace: 'thsm',
      pageId: THSM_ID,
      fetchImpl: impl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotionDataError);
    expect((error as NotionDataError).notPublic).toBe(true);
  });

  test('a 500 is a transient failure, not a verdict', async () => {
    const impl = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    const error = await loadPageChunk({
      workspace: 'thsm',
      pageId: THSM_ID,
      fetchImpl: impl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotionDataError);
    expect((error as NotionDataError).notPublic).toBe(false);
  });

  test('a workspace that would leave the Notion hosts is refused before any request', async () => {
    const fake = fakeNotion([]);
    await expect(
      loadPageChunk({ workspace: 'x@evil.example#', pageId: THSM_ID, fetchImpl: fake.impl }),
    ).rejects.toThrow(NotionDataError);
    expect(fake.requests).toHaveLength(0);
  });
});
