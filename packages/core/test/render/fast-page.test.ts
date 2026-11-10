import { describe, expect, test } from 'bun:test';
import { buildFastPage, findImageBlock } from '../../src/render';
import type { LinkRecord } from '../../src';
import { cardImageUrl } from '../../src/card-version';
import {
  OMAN_ID,
  THSM_ID,
  bid,
  fakeNotion,
  mapOf,
  pageWith,
  readChunks,
  readFixture,
  ROOT,
} from './helpers';

const link = (overrides: Partial<LinkRecord> = {}): LinkRecord => ({
  workspace: 'thsm',
  slug: 'oman',
  pageId: OMAN_ID.replaceAll('-', ''),
  canonicalUrl: `https://thsm.notion.site/${OMAN_ID.replaceAll('-', '')}`,
  title: 'Оман: 18–26 января 2027',
  description: '',
  imageUrl: null,
  language: 'ru',
  fetchedAt: '2026-11-10T00:00:00.000Z',
  createdAt: '2026-11-10T00:00:00.000Z',
  overrides: {},
  fast: true,
  canonicalMode: 'self',
  goneAt: null,
  ...overrides,
});

function pngBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

describe('buildFastPage (recorded Oman page with image blocks)', () => {
  const fake = fakeNotion(readChunks('render/oman-chunks.json'), {
    image: { bytes: pngBytes(800, 600), contentType: 'image/png' },
  });
  const result = buildFastPage({
    link: link(),
    origin: 'https://x.vercel.app',
    fetchImpl: fake.impl,
  });

  test('og:image is the same versioned card URL the redirect page announces', async () => {
    const out = await result;
    const html = out.status === 200 ? out.html : '';
    const url = await cardImageUrl('https://x.vercel.app', link());
    expect(url).toMatch(/^https:\/\/x\.vercel\.app\/img\/thsm\/oman\?v=[0-9a-f]{10}$/);
    expect(html).toContain(`<meta property="og:image" content="${url}">`);
  });

  test('renders every image through our proxy with sniffed dimensions', async () => {
    const out = await result;
    expect(out.status).toBe(200);
    const html = out.status === 200 ? out.html : '';
    const imgs = html.match(/<img [^>]*>/g) ?? [];
    expect(imgs).toHaveLength(10);
    for (const img of imgs) {
      expect(img).toContain('width="800" height="600"');
      expect(img).toMatch(/src="\/img\/content\/thsm\/oman\/[0-9a-f-]{36}\?v=\d+&amp;w=640"/);
    }
    expect(imgs.filter((i) => i.includes('fetchpriority="high"'))).toHaveLength(1);
    expect(imgs.filter((i) => i.includes('loading="lazy"'))).toHaveLength(9);
  });

  test('signed or Notion-hosted image URLs never reach the page', async () => {
    const out = await result;
    const html = out.status === 200 ? out.html : '';
    expect(html).not.toMatch(
      /notionusercontent|file\.notion\.so|secure\.notion-static|amazonaws|attachment:/,
    );
  });

  test('renders the rest of the page: headings, callouts, lists', async () => {
    const out = await result;
    const html = out.status === 200 ? out.html : '';
    expect(html).toContain('<aside class="callout">');
    expect(html).toContain('<ul>');
    expect(html).toContain('<h3 ');
    expect(html).toContain('<h4 ');
  });
});

describe('buildFastPage verdicts', () => {
  test('a page Notion no longer serves is 410', async () => {
    const impl = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    expect(
      await buildFastPage({ link: link(), origin: 'https://x.vercel.app', fetchImpl: impl }),
    ).toEqual({ status: 410 });
  });

  test('a transient Notion failure throws, so the cached page keeps being served', async () => {
    const impl = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    await expect(
      buildFastPage({ link: link(), origin: 'https://x.vercel.app', fetchImpl: impl }),
    ).rejects.toThrow();
  });

  test('overrides win over fetched title and description', async () => {
    const fake = fakeNotion([readFixture('thsm-loadPageChunk.json')]);
    const out = await buildFastPage({
      link: link({ pageId: THSM_ID, overrides: { title: 'Mine', description: 'My text' } }),
      origin: 'https://x.vercel.app',
      fetchImpl: fake.impl,
    });
    expect(out.status === 200 && out.html.includes('<h1>Mine</h1>')).toBe(true);
    expect(out.status === 200 && out.html.includes('content="My text"')).toBe(true);
  });

  test('a renamed Notion page shows its current title, not the stored one', async () => {
    const fake = fakeNotion([readFixture('thsm-loadPageChunk.json')]);
    const out = await buildFastPage({
      link: link({ pageId: THSM_ID, title: 'Stale old title' }),
      origin: 'https://x.vercel.app',
      fetchImpl: fake.impl,
    });
    expect(out.status === 200 && out.html.includes('Stale old title')).toBe(false);
  });
});

describe('findImageBlock', () => {
  const map = mapOf(
    pageWith(
      {
        [bid(1)]: { type: 'image', properties: { source: [['attachment:a:b.png']] } },
        [bid(2)]: { type: 'text' },
        [bid(3)]: { type: 'page', content: [bid(4)] },
        [bid(4)]: { type: 'image', properties: { source: [['attachment:c:d.png']] } },
        [bid(5)]: { type: 'toggle', content: [bid(6)] },
        [bid(6)]: { type: 'image', properties: { source: [['attachment:e:f.png']] } },
      },
      [bid(1), bid(2), bid(3), bid(5)],
    ),
  );

  test('only image blocks shown on the page are served', () => {
    expect(findImageBlock(map, ROOT, bid(1))?.id).toBe(bid(1));
    expect(findImageBlock(map, ROOT, bid(6))?.id).toBe(bid(6)); // inside a toggle
    expect(findImageBlock(map, ROOT, bid(2))).toBeNull(); // not an image
    expect(findImageBlock(map, ROOT, bid(4))).toBeNull(); // inside a sub-page: not on this page
    expect(findImageBlock(map, ROOT, bid(99))).toBeNull(); // unknown
  });
});
