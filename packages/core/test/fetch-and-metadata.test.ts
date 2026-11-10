import { describe, expect, test } from 'bun:test';
import { ApiError } from '../src/errors';
import { extractMetadata, stripNotionSuffix, withImageWidth, ogLocale } from '../src/metadata';
import { createPageFetcher } from '../src/notion-fetcher';
import { parseNotionUrl } from '../src/notion-url';
import { allowNotionImageUrl, allowNotionPageUrl, safeFetch } from '../src/safe-fetch';

const thsmHtml = await Bun.file(new URL('./fixtures/thsm-page.html', import.meta.url)).text();
const notFoundHtml = await Bun.file(
  new URL('./fixtures/not-public-404.html', import.meta.url),
).text();
const thsmChunk = await Bun.file(
  new URL('./fixtures/thsm-loadPageChunk.json', import.meta.url),
).json();
const ID = '413d447ac4b180169985c93eea7f02f9';

type Route = (url: URL) => Response | Promise<Response>;

/** Fake network keyed by exact URL; unknown URLs fail the test loudly. */
function fakeFetch(routes: ReadonlyMap<string, Route>, seen: string[] = []): typeof fetch {
  return (async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    seen.push(url.href);
    const route = routes.get(url.href);
    if (!route) throw new Error(`unexpected request ${url.href}`);
    if (init?.redirect !== 'manual') throw new Error('redirects must be followed manually');
    return route(url);
  }) as typeof fetch;
}

const html = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/html' } });
const redirect = (to: string, status = 302): Response =>
  new Response(null, { status, headers: { location: to } });

describe('extractMetadata on the recorded thsm page', () => {
  const meta = extractMetadata(thsmHtml);
  test('title has no " | Notion" suffix', () => {
    expect(meta.title).toBe('Наши с Леночкой Путешествия');
  });
  test('description and language', () => {
    expect(meta.description).toBe('Лето 2026 — Египет Беларусь Россия');
    expect(meta.language).toBe('ru');
  });
  test('Notion\u2019s generated card is kept by extraction: only the page data can tell it from a cover', () => {
    expect(meta.imageUrl).toContain('SocialMediaPreviewImage.png');
  });
});

describe('extractMetadata edge cases', () => {
  test('attribute order, single quotes and entities do not matter', () => {
    const meta = extractMetadata(
      `<meta content='Tom &amp; &quot;Jerry&quot; &#x41; | Notion' property='og:title'/>` +
        `<meta content="https://www.notion.so/images/meta/default.png" property="og:image">`,
    );
    expect(meta.title).toBe('Tom & "Jerry" A');
    expect(meta.imageUrl).toBeNull(); // generic Notion image means "no own image"
  });
  test('the white Notion logo banner (notion-wordmark.png) is no image either', () => {
    const meta = extractMetadata(
      `<meta property="og:title" content="Таиланд | Notion">` +
        `<meta property="og:image" content="https://thsm.notion.site/images/meta/notion-wordmark.png">`,
    );
    expect(meta.imageUrl).toBeNull();
  });
  test('a real cover passes through with its parameters decoded', () => {
    const cover =
      'https://thsm.notion.site/image/https%3A%2F%2Fthsm.notion.site%2Fimages%2Fpage-cover%2Fwebb2.jpg?table=block&id=319d447a-c4b1-8094-a402-cfbe020aeea7&width=2000';
    const meta = extractMetadata(
      `<meta property="og:title" content="План | Notion"><meta property="og:image" content="${cover.replaceAll('&', '&amp;')}">`,
    );
    expect(meta.imageUrl).toBe(cover);
  });
  test('a ">" inside a quoted attribute does not cut the tag short', () => {
    const meta = extractMetadata(
      `<meta property="og:title" content="a > b | Notion"><meta property="og:description" content="x -> y">`,
    );
    expect(meta.title).toBe('a > b');
    expect(meta.description).toBe('x -> y');
  });
  test('falls back to <title>, then to Untitled', () => {
    expect(extractMetadata('<title>Plain | Notion</title>').title).toBe('Plain');
    expect(extractMetadata('<html></html>').title).toBe('Untitled');
  });
  test('only a trailing suffix is removed', () => {
    expect(stripNotionSuffix('A | Notion | Notion')).toBe('A | Notion');
    expect(stripNotionSuffix('Notion | tips')).toBe('Notion | tips');
  });
  test('image width is rewritten only when the URL carries one', () => {
    expect(withImageWidth('https://a.notion.site/image/x?table=block&width=2000', 1200)).toContain(
      'width=1200',
    );
    expect(withImageWidth('https://a.notion.site/image/x?table=block', 1200)).not.toContain(
      'width',
    );
  });
  test('og:locale follows the detected language, never the Notion UI locale', () => {
    expect(ogLocale('ru')).toBe('ru_RU');
    expect(ogLocale(null)).toBeNull();
  });
});

const CHUNK_URL = 'https://thsm.notion.site/api/v3/loadPageChunk';
/** The recorded thsm page data, optionally with a `page_cover` on the page block. */
function chunk(cover?: string): Response {
  const data = structuredClone(thsmChunk);
  const record = data.recordMap.block['413d447a-c4b1-8016-9985-c93eea7f02f9'];
  if (cover !== undefined && record?.value?.value) record.value.value.format.page_cover = cover;
  return Response.json(data);
}

const THSM_URL = `https://thsm.notion.site/${ID}`;
/** Fetches the recorded thsm page; its page data carries `cover` as `page_cover` when given. */
const fetchThsm = (cover: string | undefined) =>
  createPageFetcher({
    fetchImpl: fakeFetch(
      new Map<string, Route>([
        [THSM_URL, () => html(thsmHtml)],
        [CHUNK_URL, () => chunk(cover)],
      ]),
    ),
  }).fetchPage(parseNotionUrl(THSM_URL));

describe('page fetcher: redirects and classification', () => {
  const canonical = `https://thsm.notion.site/${ID}`;

  test('follows www.notion.so -> workspace domain and reports the workspace from the final URL', async () => {
    const seen: string[] = [];
    const fetcher = createPageFetcher({
      fetchImpl: fakeFetch(
        new Map<string, Route>([
          [`https://www.notion.so/${ID}`, () => redirect(canonical, 301)],
          [canonical, () => html(thsmHtml)],
          [CHUNK_URL, () => chunk()],
        ]),
        seen,
      ),
    });
    const result = await fetcher.fetchPage(parseNotionUrl(`https://www.notion.so/${ID}`));
    expect(result).toMatchObject({
      kind: 'public',
      workspace: 'thsm',
      pageId: ID,
      canonicalUrl: canonical,
    });
    expect(seen).toEqual([`https://www.notion.so/${ID}`, canonical, CHUNK_URL]);
  });

  describe('the generated "Made with Notion" card', () => {
    test('is no image for a page without a cover', async () => {
      expect(await fetchThsm(undefined)).toMatchObject({ metadata: { imageUrl: null } });
    });

    test('is kept when the page has a cover of its own (an upload may share the file name)', async () => {
      const result = await fetchThsm('attachment:abc:SocialMediaPreviewImage.png');
      expect(result).toMatchObject({
        metadata: { imageUrl: expect.stringContaining('SocialMediaPreviewImage.png') },
      });
    });

    test('is no image when the page data cannot be read', async () => {
      const fetcher = createPageFetcher({
        fetchImpl: fakeFetch(
          new Map<string, Route>([
            [canonical, () => html(thsmHtml)],
            [CHUNK_URL, () => new Response('', { status: 500 })],
          ]),
        ),
      });
      expect(await fetcher.fetchPage(parseNotionUrl(canonical))).toMatchObject({
        metadata: { imageUrl: null },
      });
    });
  });

  test('a 404 is "not public", not an error', async () => {
    const fetcher = createPageFetcher({
      fetchImpl: fakeFetch(
        new Map<string, Route>([
          [canonical, () => html(notFoundHtml, 404)],
          [`https://www.notion.so/${ID}`, () => html(notFoundHtml, 404)],
        ]),
      ),
    });
    expect(await fetcher.fetchPage(parseNotionUrl(canonical))).toEqual({ kind: 'not_public' });
  });

  test('a redirect to the Notion homepage means unsupported workspace', async () => {
    const fetcher = createPageFetcher({
      fetchImpl: fakeFetch(
        new Map<string, Route>([
          [`https://www.notion.so/${ID}`, () => redirect('https://www.notion.com/')],
          ['https://www.notion.com/', () => html('<title>Notion</title>')],
        ]),
      ),
    });
    await expect(
      fetcher.fetchPage(parseNotionUrl(`https://notion.site/${ID}`)),
    ).rejects.toMatchObject({
      code: 'unsupported_workspace',
    });
  });

  test('upstream 5xx surfaces as upstream_error', async () => {
    const fetcher = createPageFetcher({
      fetchImpl: fakeFetch(new Map<string, Route>([[canonical, () => html('boom', 503)]])),
    });
    await expect(fetcher.fetchPage(parseNotionUrl(canonical))).rejects.toMatchObject({
      code: 'upstream_error',
    });
  });

  test('a notion.so/<name>/<id> hint that is not the published domain still resolves', async () => {
    const seen: string[] = [];
    const fetcher = createPageFetcher({
      fetchImpl: fakeFetch(
        new Map<string, Route>([
          [`https://internal-name.notion.site/${ID}`, () => html(notFoundHtml, 404)],
          [`https://www.notion.so/${ID}`, () => redirect(canonical, 301)],
          [canonical, () => html(thsmHtml)],
          [CHUNK_URL, () => chunk()],
        ]),
        seen,
      ),
    });
    const result = await fetcher.fetchPage(
      parseNotionUrl(`https://www.notion.so/internal-name/${ID}`),
    );
    expect(result).toMatchObject({ kind: 'public', workspace: 'thsm' });
    expect(seen).toEqual([
      `https://internal-name.notion.site/${ID}`,
      `https://www.notion.so/${ID}`,
      canonical,
      CHUNK_URL,
    ]);
  });

  test('a hinted domain and the bare id both 404: not public', async () => {
    const fetcher = createPageFetcher({
      fetchImpl: fakeFetch(
        new Map<string, Route>([
          [`https://internal-name.notion.site/${ID}`, () => html(notFoundHtml, 404)],
          [`https://www.notion.so/${ID}`, () => html(notFoundHtml, 404)],
        ]),
      ),
    });
    expect(
      await fetcher.fetchPage(parseNotionUrl(`https://www.notion.so/internal-name/${ID}`)),
    ).toEqual({ kind: 'not_public' });
  });
});

describe('safeFetch guards', () => {
  const start = new URL('https://thsm.notion.site/start');

  test('every hop is re-checked: a redirect to another host is refused before it is requested', async () => {
    const seen: string[] = [];
    const routes = new Map<string, Route>([
      [start.href, () => redirect('https://evil.example/steal')],
      ['https://evil.example/steal', () => html('secret')],
    ]);
    await expect(
      safeFetch(start, { allow: allowNotionPageUrl, fetchImpl: fakeFetch(routes, seen) }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(seen).toEqual([start.href]);
  });

  test('a downgrade to http is refused', async () => {
    const routes = new Map<string, Route>([
      [start.href, () => redirect('http://thsm.notion.site/start')],
    ]);
    await expect(
      safeFetch(start, { allow: allowNotionPageUrl, fetchImpl: fakeFetch(routes) }),
    ).rejects.toMatchObject({ code: 'upstream_error' });
  });

  test('allows at most 5 hops', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return redirect(`https://thsm.notion.site/hop${calls}`);
    }) as unknown as typeof fetch;
    await expect(safeFetch(start, { allow: allowNotionPageUrl, fetchImpl })).rejects.toMatchObject({
      code: 'upstream_error',
    });
    expect(calls).toBe(6); // the start request plus 5 followed redirects
  });

  test('exactly 5 redirects still succeed', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls <= 5 ? redirect(`https://thsm.notion.site/hop${calls}`) : html('ok');
    }) as unknown as typeof fetch;
    const result = await safeFetch(start, { allow: allowNotionPageUrl, fetchImpl });
    expect(result.status).toBe(200);
    expect(result.finalUrl.pathname).toBe('/hop5');
  });

  test('the body is capped and flagged as truncated', async () => {
    const big = 'x'.repeat(3000);
    const routes = new Map<string, Route>([[start.href, () => html(big)]]);
    const result = await safeFetch(start, {
      allow: allowNotionPageUrl,
      maxBytes: 1000,
      fetchImpl: fakeFetch(routes),
    });
    expect(result.body.byteLength).toBe(1000);
    expect(result.truncated).toBe(true);
  });

  test('a server that never answers is cut by the timeout', async () => {
    const fetchImpl = ((_url: URL, init?: RequestInit) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      return promise;
    }) as unknown as typeof fetch;
    await expect(
      safeFetch(start, { allow: allowNotionPageUrl, timeoutMs: 30, fetchImpl }),
    ).rejects.toMatchObject({ code: 'upstream_error' });
  });

  test('307 and 308 replay the method and body, 302 turns a POST into a GET', async () => {
    for (const [status, replays] of [
      [307, true],
      [308, true],
      [302, false],
    ] as const) {
      const calls: { method: string | undefined; body: unknown }[] = [];
      const fetchImpl = (async (_url: URL, init?: RequestInit) => {
        calls.push({ method: init?.method, body: init?.body });
        return calls.length === 1 ? redirect('https://thsm.notion.site/next', status) : html('ok');
      }) as unknown as typeof fetch;
      await safeFetch(start, { allow: allowNotionPageUrl, method: 'POST', body: '{}', fetchImpl });
      expect(calls[1]).toEqual(
        replays ? { method: 'POST', body: '{}' } : { method: 'GET', body: undefined },
      );
    }
  });
});

describe('image host allowlist (spec 5.3)', () => {
  test.each([
    'https://thsm.notion.site/image/x',
    'https://file.notion.so/f/f/abc',
    'https://img.notionusercontent.com/s3/abc',
    'https://www.notion.so/images/page-cover/webb2.jpg',
    'https://images.unsplash.com/photo-1',
  ])('allows %s', (u) => {
    expect(allowNotionImageUrl(new URL(u))).toBe(true);
  });
  test.each([
    'http://thsm.notion.site/image/x',
    'https://www.notion.so/api/v3/loadPageChunk',
    'https://evil.example/a.png',
    'https://notionusercontent.com.evil.example/a.png',
    'https://prod-files-secure.s3.us-west-2.amazonaws.com/a.png',
  ])('refuses %s', (u) => {
    expect(allowNotionImageUrl(new URL(u))).toBe(false);
  });
});
