/** The card image is requested as JPEG/PNG and only those two formats are passed on. */
import { describe, expect, test } from 'bun:test';
import { fetchCardImage } from '../src/card-image';

const IMAGE_URL = 'https://thsm.notion.site/image/attachment%3Aabc%3Ax.png?width=1200';
const BYTES = Uint8Array.of(1, 2, 3, 4);
const BANNER = new Uint8Array(
  await Bun.file(new URL('./fixtures/notion-wordmark.png', import.meta.url)).arrayBuffer(),
);

function serving(contentType: string, seen: Headers[] = []) {
  return Object.assign(
    async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response(BYTES, { headers: { 'content-type': contentType } });
    },
    { preconnect: () => {} },
  );
}

describe('fetchCardImage format decision', () => {
  test('asks the upstream for JPEG/PNG only, never WebP or AVIF', async () => {
    const seen: Headers[] = [];
    await fetchCardImage(IMAGE_URL, serving('image/png', seen));
    const accept = seen[0]?.get('accept') ?? '';
    expect(accept).toBe('image/jpeg,image/png;q=0.9,*/*;q=0.1');
    expect(accept).not.toContain('webp');
    expect(accept).not.toContain('avif');
  });

  test('passes PNG and JPEG through untouched', async () => {
    expect(await fetchCardImage(IMAGE_URL, serving('image/png'))).toEqual({
      bytes: BYTES,
      contentType: 'image/png',
    });
    expect(await fetchCardImage(IMAGE_URL, serving('image/jpeg; charset=binary'))).toEqual({
      bytes: BYTES,
      contentType: 'image/jpeg',
    });
  });

  test('refuses every other format so the title card is drawn instead', async () => {
    for (const type of ['image/webp', 'image/avif', 'image/gif', 'image/svg+xml', 'text/html']) {
      expect(await fetchCardImage(IMAGE_URL, serving(type))).toBeNull();
    }
  });
});

describe('fetchCardImage and Notion\u2019s own banners', () => {
  test('a banner URL is refused without any request', async () => {
    let requests = 0;
    const counting = Object.assign(
      async () => {
        requests++;
        return new Response(BYTES, { headers: { 'content-type': 'image/png' } });
      },
      { preconnect: () => {} },
    );
    expect(
      await fetchCardImage('https://thsm.notion.site/images/meta/notion-wordmark.png', counting),
    ).toBeNull();
    expect(requests).toBe(0);
  });

  test('a redirect from an innocent URL to a banner is refused, even with different bytes', async () => {
    const altered = BANNER.slice();
    altered[altered.length - 1] = (altered[altered.length - 1] ?? 0) ^ 1;
    const redirecting = Object.assign(
      async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : input);
        return url.pathname.startsWith('/images/meta/')
          ? new Response(altered, { headers: { 'content-type': 'image/png' } })
          : new Response(null, {
              status: 302,
              headers: { location: 'https://thsm.notion.site/images/meta/notion-wordmark.png' },
            });
      },
      { preconnect: () => {} },
    );
    expect(await fetchCardImage(IMAGE_URL, redirecting)).toBeNull();
  });

  test('the banner bytes are refused even under an innocent-looking URL', async () => {
    const banner = Object.assign(
      async () => new Response(BANNER, { headers: { 'content-type': 'image/png' } }),
      { preconnect: () => {} },
    );
    expect(await fetchCardImage(IMAGE_URL, banner)).toBeNull();
  });
});
