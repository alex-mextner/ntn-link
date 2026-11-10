import { describe, expect, test } from 'bun:test';
import { brotliCompressSync } from 'node:zlib';
import {
  CRITICAL_CSS,
  renderBlocks,
  renderFastPage,
  unwrapRecordMap,
  type FastPageInput,
  type PageHero,
} from '../../src/render';
import { THSM_ID, readFixture, testCtx } from './helpers';

const NO_HERO: PageHero = {
  icon: null,
  cover: null,
  fullWidth: false,
  smallText: false,
  font: 'sans',
};
const ORIGIN = 'https://x.vercel.app';
const NOTION_URL = `https://thsm.notion.site/${THSM_ID.replaceAll('-', '')}`;

function thsmInput(overrides: Partial<FastPageInput> = {}): FastPageInput {
  const body = renderBlocks(
    unwrapRecordMap(readFixture('thsm-loadPageChunk.json')),
    testCtx({ rootId: THSM_ID }),
  );
  return {
    workspace: 'thsm',
    slug: 'our-trips',
    origin: ORIGIN,
    title: 'Наши с Леночкой Путешествия',
    description: 'Планы поездок',
    lang: 'ru',
    canonicalMode: 'self',
    notionUrl: NOTION_URL,
    ogImageUrl: `${ORIGIN}/img/thsm/our-trips`,
    editedAt: '2026-11-10T12:00:00.000Z',
    createdAt: '2026-11-09T12:00:00.000Z',
    body,
    hero: NO_HERO,
    ...overrides,
  };
}

const ldJson = (html: string): Record<string, unknown> => {
  const raw = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(html)?.[1] ?? '';
  return JSON.parse(raw);
};

describe('renderFastPage (thsm)', () => {
  const html = renderFastPage(thsmInput());

  test('canonical defaults to the fast page and can point at Notion', () => {
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/thsm/our-trips/read">`);
    const notion = renderFastPage(thsmInput({ canonicalMode: 'notion' }));
    expect(notion).toContain(`<link rel="canonical" href="${NOTION_URL}">`);
    expect(notion).toContain(`<meta property="og:url" content="${ORIGIN}/thsm/our-trips/read">`);
  });

  test('semantic structure: one h1 inside article > header, time, footer link', () => {
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain('<article>\n<header>\n<h1>Наши с Леночкой Путешествия</h1>');
    expect(html).toContain('<time datetime="2026-11-10T12:00:00.000Z">2026-11-10</time>');
    expect(html).toContain(`<a class="orig" href="${NOTION_URL}"`);
    expect(html).toContain('<html lang="ru">');
  });

  test('one main landmark around the article, and an inline icon instead of a /favicon.ico request', () => {
    expect(html).toContain('<main>\n<article>');
    expect(html.match(/<main>/g)).toHaveLength(1);
    expect(html).toMatch(/<link rel="icon" href="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+">/);
  });

  test('Open Graph and Twitter tags match the redirect card', () => {
    expect(html).toContain(`<meta property="og:image" content="${ORIGIN}/img/thsm/our-trips">`);
    expect(html).not.toContain('og:image:width');
    expect(html).not.toContain('og:image:height');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toContain('<meta property="og:locale" content="ru_RU">');
  });

  test('JSON-LD is a valid schema.org Article', () => {
    const ld = ldJson(html);
    expect(ld['@type']).toBe('Article');
    expect(ld.headline).toBe('Наши с Леночкой Путешествия');
    expect(ld.inLanguage).toBe('ru');
    expect(ld.dateModified).toBe('2026-11-10T12:00:00.000Z');
  });

  test('size budget: first response <= 14 KB brotli, CSS <= 10 KB', () => {
    const compressed = brotliCompressSync(Buffer.from(html)).length;
    expect(compressed).toBeLessThanOrEqual(14 * 1024);
    expect(Buffer.byteLength(CRITICAL_CSS)).toBeLessThanOrEqual(10 * 1024);
    expect(CRITICAL_CSS).not.toMatch(/url\(|@import|@font-face/);
  });

  test('no executable script and no URL outside our origin and Notion', () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toEqual(['<script type="application/ld+json">']);
    const hosts = new Set(
      [...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => new URL(m[0]).hostname),
    );
    for (const host of hosts) {
      expect(
        host === 'x.vercel.app' ||
          host === 'schema.org' ||
          host === 'maps.app.goo.gl' ||
          host.endsWith('.notion.site'),
      ).toBe(true);
    }
    expect(html).not.toMatch(/<(img|link|iframe|video|audio|source)\b[^>]*\bsrc?=?"https?:/);
  });
});

describe('renderFastPage (edge cases)', () => {
  test('a hostile title is escaped everywhere, including the JSON-LD data block', () => {
    const evil = '</title><script>x</script>"&';
    const html = renderFastPage(thsmInput({ title: evil, description: evil }));
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html).toContain(
      '<title>&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;&quot;&amp;</title>',
    );
    expect(html).toContain('<h1>&lt;/title&gt;');
    expect(html).toContain('\\u003c/title\\u003e');
    const ld = ldJson(html);
    expect(ld.headline).toBe(evil);
  });

  test('an empty page still has a title, a footer link and a valid document', () => {
    const html = renderFastPage(
      thsmInput({ body: { html: '', firstImageBlockId: null, text: '' }, editedAt: undefined }),
    );
    expect(html).toContain('<h1>Наши с Леночкой Путешествия</h1>');
    expect(html).toContain('class="orig"');
    expect(html).not.toContain('<time');
    expect(html.startsWith('<!doctype html>')).toBe(true);
  });

  test('without a card image the preview falls back to a summary card', () => {
    const html = renderFastPage(thsmInput({ ogImageUrl: null }));
    expect(html).not.toContain('og:image');
    expect(html).toContain('<meta name="twitter:card" content="summary">');
  });
});
