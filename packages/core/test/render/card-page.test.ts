import { describe, expect, test } from 'bun:test';
import { dashedId, loadCardPage } from '../../src/render';
import { loadPageEmoji } from '../../src/render/card-page';
import {
  ROOT,
  THSM_ID,
  WS,
  fakeNotion,
  pageWith,
  rawPayload,
  readFixture,
  type RawBlock,
} from './helpers';

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngBytes(length = 33): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  bytes.set(PNG_HEADER);
  return bytes;
}

/** A page whose icon is `icon` (an emoji or a Notion picture reference) and whose text is one line. */
function pageWithIcon(icon: string) {
  const blocks: Record<string, RawBlock> = pageWith({
    '00000000-0000-4000-8000-000000000101': { type: 'text', properties: { title: [['Hello']] } },
  });
  const root = blocks[ROOT];
  if (root === undefined) throw new Error('root missing');
  blocks[ROOT] = { ...root, format: { page_icon: icon } };
  return rawPayload(blocks);
}

describe('loadCardPage', () => {
  test('asks Notion for the first chunk only and returns the page text and its emoji icon', async () => {
    const { impl, requests } = fakeNotion([readFixture('thsm-loadPageChunk.json')]);
    const page = await loadCardPage({ workspace: WS, pageId: THSM_ID, fetchImpl: impl });
    expect(page.excerpt[0]).toBe('Лето 2026 — Египет Беларусь Россия');
    expect(page.icon).toEqual({ kind: 'emoji', emoji: '🤿' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({ chunkNumber: 0, page: { id: dashedId(THSM_ID) } });
  });

  test('a page without an icon has none', async () => {
    const chunk = rawPayload(pageWith({}));
    const { impl } = fakeNotion([chunk]);
    expect((await loadCardPage({ workspace: WS, pageId: ROOT, fetchImpl: impl })).icon).toBeNull();
  });

  test('a picture icon is fetched at 256 px from the workspace image endpoint as a PNG data URI', async () => {
    const bytes = pngBytes();
    const fake = fakeNotion([pageWithIcon('attachment:abc:icon.png')], {
      image: { bytes, contentType: 'image/png' },
    });
    const page = await loadCardPage({ workspace: WS, pageId: ROOT, fetchImpl: fake.impl });
    expect(page.icon).toEqual({
      kind: 'image',
      dataUri: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
    });
    const imageRequest = fake.requests.find((r) => new URL(r.url).pathname.startsWith('/image/'));
    expect(imageRequest).toBeDefined();
    const url = new URL(imageRequest?.url ?? '');
    expect(url.searchParams.get('width')).toBe('256');
    expect(url.searchParams.get('id')).toBe(ROOT);
    // The card renderer decodes PNG and JPEG: Notion is asked for exactly those, never WebP.
    expect(imageRequest?.accept).toBe('image/png,image/jpeg');
    expect(page.excerpt).toEqual(['Hello']);
  });

  test('an icon picture that is not PNG or JPEG, or is too large, is not drawn; the text still is', async () => {
    for (const image of [
      { bytes: pngBytes(), contentType: 'image/gif' },
      { bytes: pngBytes(200 * 1024), contentType: 'image/png' },
    ]) {
      const fake = fakeNotion([pageWithIcon('attachment:abc:icon.png')], { image });
      const page = await loadCardPage({ workspace: WS, pageId: ROOT, fetchImpl: fake.impl });
      expect(page.icon).toBeNull();
      expect(page.excerpt).toEqual(['Hello']);
    }
  });

  test('an icon picture that cannot be fetched is not drawn; the text still is', async () => {
    const fake = fakeNotion([pageWithIcon('attachment:abc:icon.png')]);
    const page = await loadCardPage({ workspace: WS, pageId: ROOT, fetchImpl: fake.impl });
    expect(page).toEqual({ excerpt: ['Hello'], icon: null });
  });

  test('an icon reference outside the image allowlist is never requested', async () => {
    const fake = fakeNotion([pageWithIcon('https://evil.example/x.png')], {
      image: { bytes: pngBytes(), contentType: 'image/png' },
    });
    const page = await loadCardPage({ workspace: WS, pageId: ROOT, fetchImpl: fake.impl });
    expect(page.icon).toBeNull();
    expect(fake.requests.map((r) => new URL(r.url).hostname)).not.toContain('evil.example');
  });

  test('any failure yields an empty page instead of an error', async () => {
    const { impl } = fakeNotion([]);
    const empty = { excerpt: [], icon: null };
    expect(await loadCardPage({ workspace: WS, pageId: THSM_ID, fetchImpl: impl })).toEqual(empty);
    expect(await loadCardPage({ workspace: WS, pageId: 'not-an-id', fetchImpl: impl })).toEqual(
      empty,
    );
  });

  test('a body whose bytes do not match its image type is not drawn', async () => {
    const fake = fakeNotion([pageWithIcon('attachment:abc:icon.png')], {
      image: { bytes: new Uint8Array(64), contentType: 'image/png' },
    });
    const page = await loadCardPage({ workspace: WS, pageId: ROOT, fetchImpl: fake.impl });
    expect(page).toEqual({ excerpt: ['Hello'], icon: null });
    const jpegAsPng = fakeNotion([pageWithIcon('attachment:abc:icon.png')], {
      image: { bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 0), contentType: 'image/png' },
    });
    const mislabelled = await loadCardPage({
      workspace: WS,
      pageId: ROOT,
      fetchImpl: jpegAsPng.impl,
    });
    expect(mislabelled.icon).toBeNull();
  });
});

describe('loadPageEmoji', () => {
  test('gives the emoji of the page after one chunk fetch', async () => {
    const { impl, requests } = fakeNotion([pageWithIcon('🤿')]);
    expect(await loadPageEmoji({ workspace: WS, pageId: ROOT, fetchImpl: impl })).toBe('🤿');
    expect(requests).toHaveLength(1);
  });

  test('a picture icon is null and its image is never downloaded', async () => {
    const fake = fakeNotion([pageWithIcon('attachment:abc:icon.png')], {
      image: { bytes: pngBytes(), contentType: 'image/png' },
    });
    expect(await loadPageEmoji({ workspace: WS, pageId: ROOT, fetchImpl: fake.impl })).toBeNull();
    expect(fake.requests.some((r) => new URL(r.url).pathname.startsWith('/image/'))).toBe(false);
  });

  test('any failure is null', async () => {
    const { impl } = fakeNotion([]);
    expect(await loadPageEmoji({ workspace: WS, pageId: ROOT, fetchImpl: impl })).toBeNull();
  });
});
