/** Markup that carries the Notion look: colours, hero (cover and icon), blank lines, callouts. */
import { describe, expect, test } from 'bun:test';
import {
  CRITICAL_CSS,
  renderBlocks,
  renderFastPage,
  pageImageSourceOf,
  unwrapRecordMap,
  type FastPageInput,
  type PageHero,
} from '../../src/render';
import { ROOT, bid, mapOf, pageWith, testCtx } from './helpers';

const t = (value: string) => ({ title: [[value]] });
const html = (blocks: Parameters<typeof pageWith>[0]) =>
  renderBlocks(mapOf(pageWith(blocks)), testCtx()).html;

describe('block colours and blank lines', () => {
  test('text and background colours become fixed class names', () => {
    const out = html({
      [bid(1)]: { type: 'text', properties: t('a'), format: { block_color: 'red' } },
      [bid(2)]: { type: 'text', properties: t('b'), format: { block_color: 'teal_background' } },
      [bid(3)]: { type: 'text', properties: t('c'), format: { block_color: 'x" onload="1' } },
    });
    expect(out).toContain('<p class="red tx">a</p>');
    expect(out).toContain('<p class="teal bg">b</p>');
    expect(out).toContain('<p>c</p>');
  });

  test('an empty text block is a blank line, an empty callout title is no paragraph', () => {
    const out = html({
      [bid(1)]: { type: 'text' },
      [bid(2)]: { type: 'callout', content: [bid(3)], format: { page_icon: '💡' } },
      [bid(3)]: { type: 'text', properties: t('inside') },
    });
    expect(out).toContain('<p class="e"></p>');
    expect(out).toContain('<div><p>inside</p>');
  });

  test('a checked to-do is marked done', () => {
    const out = html({
      [bid(1)]: { type: 'to_do', properties: { ...t('x'), checked: [['Yes']] } },
    });
    expect(out).toContain('<li class="done"><input type="checkbox" disabled checked>');
  });
});

const page = (format: Record<string, unknown>) =>
  mapOf(pageWith({}, [])).blocks.get(ROOT) && {
    ...mapOf({ [ROOT]: { type: 'page', format } }).blocks.get(ROOT)!,
  };

describe('table of contents', () => {
  test('links the page headings in order, indented by level, escaped', () => {
    const out = html({
      [bid(1)]: { type: 'table_of_contents' },
      [bid(2)]: { type: 'header', properties: t('One <b>') },
      [bid(3)]: { type: 'sub_header', properties: t('Two') },
      [bid(4)]: { type: 'header', properties: t('') },
    });
    expect(out).toContain('<nav class="toc">');
    expect(out).toContain(`<a class="l1" href="#${bid(2).replaceAll('-', '')}">One &lt;b&gt;</a>`);
    expect(out.indexOf('class="l1"')).toBeLessThan(out.indexOf('class="l2"'));
    expect(out.match(/class="l\d"/g)).toHaveLength(2);
  });
});

describe('table of contents bounds', () => {
  test('only headings that were rendered get a link (none under an unsupported block)', () => {
    const blocks = {
      [bid(1)]: { type: 'table_of_contents' },
      [bid(2)]: { type: 'transclusion_container', content: [bid(3)] },
      [bid(3)]: { type: 'header', properties: t('Hidden in a synced block') },
      [bid(4)]: { type: 'header', properties: t('Shown') },
    };
    // bid(3) is only a child of the synced block, which is not rendered.
    const out = renderBlocks(mapOf(pageWith(blocks, [bid(1), bid(2), bid(4)])), testCtx()).html;
    expect(out).toContain('>Shown</a>');
    expect(out).not.toContain('Hidden in a synced block');
  });

  test('many tables of contents over many headings stay small', () => {
    const blocks: Parameters<typeof pageWith>[0] = {};
    for (let i = 0; i < 20; i++) blocks[bid(i + 1)] = { type: 'table_of_contents' };
    for (let i = 0; i < 1000; i++) {
      blocks[bid(i + 100)] = { type: 'header', properties: t(`H${i}`) };
    }
    const out = html(blocks);
    expect(out.match(/<nav class="toc">/g)).toHaveLength(3);
    expect(out.match(/class="l1"/g)).toHaveLength(3 * 200);
    expect(out).not.toContain('<!--toc-->');
  });
});

describe('page cover and icon sources', () => {
  test('gallery covers resolve on the workspace host, uploads as attachments', () => {
    const gallery = page({ page_cover: '/images/page-cover/webb2.jpg' });
    expect(pageImageSourceOf(gallery!, 'cover', 'thsm')).toEqual({
      kind: 'notion-file',
      value: 'https://thsm.notion.site/images/page-cover/webb2.jpg',
    });
    const upload = page({ page_icon: 'attachment:abc:icon.png' });
    expect(pageImageSourceOf(upload!, 'icon', 'thsm')).toEqual({
      kind: 'attachment',
      value: 'attachment:abc:icon.png',
    });
  });

  test('an emoji icon, a missing cover and a foreign host are not pictures', () => {
    expect(pageImageSourceOf(page({ page_icon: '🌴' })!, 'icon', 'thsm')).toBeNull();
    expect(pageImageSourceOf(page({})!, 'cover', 'thsm')).toBeNull();
    expect(
      pageImageSourceOf(page({ page_cover: 'https://evil.example/x.jpg' })!, 'cover', 'thsm'),
    ).toBeNull();
  });
});

const heroOf = (icon: PageHero['icon']): PageHero => ({
  icon,
  cover: null,
  fullWidth: false,
  smallText: false,
  font: 'sans',
});

const faviconSvg = (out: string): string => {
  const encoded = /<link rel="icon" href="data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)">/.exec(
    out,
  )?.[1];
  return Buffer.from(encoded ?? '', 'base64').toString('utf8');
};

describe('renderFastPage hero', () => {
  const body = renderBlocks(unwrapRecordMap({ recordMap: { block: {} } }), testCtx());
  const input = (hero: PageHero): FastPageInput => ({
    workspace: 'thsm',
    slug: 's',
    origin: 'https://x.test',
    title: 'T',
    description: '',
    lang: 'en',
    canonicalMode: 'self',
    notionUrl: 'https://thsm.notion.site/x',
    ogImageUrl: null,
    body,
    hero,
  });
  const image = {
    src: '/img/a?w=640',
    srcset: '/img/a?w=640 640w, /img/a?w=1280 1280w',
    position: 0.3,
  };

  test('cover on top, the icon overlapping it, options as body classes', () => {
    const out = renderFastPage(
      input({
        icon: { kind: 'emoji', text: '🌴' },
        cover: image,
        fullWidth: true,
        smallText: true,
        font: 'serif',
      }),
    );
    expect(out).toContain('<body class="fw sm serif">');
    expect(out).toMatch(/<div class="cv"><img src="\/img\/a\?w=640"[^>]*object-position:50% 70%/);
    expect(out).toContain('<div class="pi up" aria-hidden="true">🌴</div>');
    expect(out.indexOf('class="cv"')).toBeLessThan(out.indexOf('<article>'));
  });

  test('no decoration means plain markup', () => {
    const out = renderFastPage(
      input({ icon: null, cover: null, fullWidth: false, smallText: false, font: 'sans' }),
    );
    expect(out).toContain('<body>');
    expect(out).not.toContain('class="cv"');
    expect(out).not.toContain('class="pi');
  });

  test('an emoji icon is also the tab icon, drawn by the emoji font with Apple first', () => {
    const svg = faviconSvg(renderFastPage(input(heroOf({ kind: 'emoji', text: '🤿' }))));
    expect(svg).toContain('>🤿</text>');
    expect(svg).toMatch(/font-family="Apple Color Emoji,/);
    // The hero itself prefers Apple Color Emoji too.
    expect(CRITICAL_CSS).toMatch(/\.pi\{[^}]*font-family:"Apple Color Emoji"/);
  });

  test('an emoji cannot break out of the favicon SVG', () => {
    const svg = faviconSvg(renderFastPage(input(heroOf({ kind: 'emoji', text: '<&">' }))));
    expect(svg).toContain('&lt;&amp;&quot;&gt;</text>');
    expect(svg).not.toContain('<&');
  });

  test('a picture icon or none keeps the ntn.link favicon, with no request of its own', () => {
    const brand = faviconSvg(renderFastPage(input(heroOf(null))));
    expect(brand).toContain('<rect');
    expect(brand).not.toContain('<text');
    const picture = faviconSvg(renderFastPage(input(heroOf({ kind: 'image', image }))));
    expect(picture).toBe(brand);
  });
});
