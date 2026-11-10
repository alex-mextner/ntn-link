import { describe, expect, test } from 'bun:test';
import { imageSourceOf, resolveFreshImage, sniffImageSize } from '../../src/render';
import { bid, fakeNotion, mapOf, pageWith } from './helpers';

const block = (source: string) =>
  [
    ...mapOf(
      pageWith({ [bid(1)]: { type: 'image', properties: { source: [[source]] } } }),
    ).blocks.values(),
  ].find((b) => b.type === 'image');

function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

function jpeg(width: number, height: number): Uint8Array<ArrayBuffer> {
  // SOI, an APP0 segment to skip, then SOF0.
  const b = new Uint8Array(40);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0, 6, 0, 0, 0, 0]);
  b.set([0xff, 0xc0, 0, 17, 8], 10);
  const v = new DataView(b.buffer);
  v.setUint16(15, height);
  v.setUint16(17, width);
  return b;
}

function webpLossless(width: number, height: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(40);
  b.set([...'RIFF'].map((c) => c.charCodeAt(0)));
  b.set(
    [...'WEBPVP8L'].map((c) => c.charCodeAt(0)),
    8,
  );
  b[20] = 0x2f;
  new DataView(b.buffer).setUint32(21, (width - 1) | ((height - 1) << 14), true);
  return b;
}

describe('imageSourceOf', () => {
  test('uploads, Notion-hosted files and allowlisted hosts are proxiable', () => {
    expect(imageSourceOf(block('attachment:abc:a.png')!)?.kind).toBe('attachment');
    expect(
      imageSourceOf(block('https://prod-files-secure.s3.us-west-2.amazonaws.com/x/y.png')!)?.kind,
    ).toBe('notion-file');
    expect(imageSourceOf(block('https://images.unsplash.com/photo-1?w=800')!)?.kind).toBe(
      'external',
    );
  });

  test('other hosts, other schemes and lookalike hosts are not proxied', () => {
    for (const src of [
      'https://i.imgur.com/a.png',
      'http://images.unsplash.com/a.png',
      'https://notion.site.evil.example/a.png',
      'https://evilnotion.site/a.png',
      'javascript:alert(1)',
      '',
    ]) {
      expect(imageSourceOf(block(src)!)).toBeNull();
    }
  });
});

describe('resolveFreshImage', () => {
  const upload = block('attachment:abc:a.png')!;

  test('asks the workspace image endpoint for this block at the requested width', async () => {
    const fake = fakeNotion([], { image: { bytes: png(2, 3), contentType: 'image/png' } });
    const image = await resolveFreshImage({
      workspace: 'thsm',
      block: upload,
      width: 640,
      fetchImpl: fake.impl,
    });
    expect(image?.contentType).toBe('image/png');
    const url = new URL(fake.requests[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe(
      'https://thsm.notion.site/image/attachment%3Aabc%3Aa.png',
    );
    expect(url.searchParams.get('id')).toBe(upload.id);
    expect(url.searchParams.get('width')).toBe('640');
  });

  test('forwards a fixed Accept so Notion can answer WebP or AVIF', async () => {
    const fake = fakeNotion([], { image: { bytes: png(2, 3), contentType: 'image/webp' } });
    const args = { workspace: 'thsm', block: upload, width: 640, fetchImpl: fake.impl };
    await resolveFreshImage({ ...args, accept: 'image/avif,image/webp,*/*;q=0.8' });
    await resolveFreshImage({ ...args, accept: 'text/html,image/webp' });
    await resolveFreshImage({ ...args, accept: '*/*' });
    expect(fake.requests.map((r) => r.accept)).toEqual([
      'image/avif,image/webp,image/png,image/jpeg',
      'image/webp,image/png,image/jpeg',
      'image/png,image/jpeg',
    ]);
  });

  test('SVG and HTML answers are refused, never passed through', async () => {
    for (const contentType of ['image/svg+xml', 'text/html']) {
      const fake = fakeNotion([], {
        image: { bytes: new TextEncoder().encode('<svg onload=alert(1)>'), contentType },
      });
      expect(
        await resolveFreshImage({
          workspace: 'thsm',
          block: upload,
          width: 640,
          fetchImpl: fake.impl,
        }),
      ).toBeNull();
    }
  });

  test('a redirect to a host outside the allowlist is never followed', async () => {
    const calls: string[] = [];
    const impl = (async (input: URL | RequestInfo) => {
      calls.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example/x.png' },
      });
    }) as unknown as typeof fetch;
    await expect(
      resolveFreshImage({ workspace: 'thsm', block: upload, width: 640, fetchImpl: impl }),
    ).rejects.toThrow();
    expect(calls.some((c) => c.includes('evil.example'))).toBe(false);
  });
});

describe('sniffImageSize', () => {
  test('reads PNG, JPEG and WebP headers', () => {
    expect(sniffImageSize(png(328, 353))).toEqual({ width: 328, height: 353 });
    expect(sniffImageSize(jpeg(1600, 900))).toEqual({ width: 1600, height: 900 });
    expect(sniffImageSize(webpLossless(640, 480))).toEqual({ width: 640, height: 480 });
  });

  test('garbage and truncated input give null', () => {
    expect(sniffImageSize(new Uint8Array(0))).toBeNull();
    expect(sniffImageSize(new TextEncoder().encode('<html>not an image</html>'))).toBeNull();
    expect(sniffImageSize(png(0, 0))).toBeNull();
  });
});
