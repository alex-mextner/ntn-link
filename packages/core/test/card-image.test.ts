/** The card image is requested as JPEG/PNG and only those two formats are passed on. */
import { describe, expect, test } from 'bun:test';
import { fetchCardImage } from '../src/card-image';

const IMAGE_URL = 'https://thsm.notion.site/image/attachment%3Aabc%3Ax.png?width=1200';
const BYTES = Uint8Array.of(1, 2, 3, 4);

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
