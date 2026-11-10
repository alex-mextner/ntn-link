import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { MAX_BLOCKS, MAX_DEPTH, renderBlocks, unwrapRecordMap } from '../../src/render';
import {
  ROOT,
  THSM_ID,
  bid,
  mapOf,
  pageWith,
  readFixture,
  testCtx,
  type RawBlock,
} from './helpers';

const GOLDEN_DIR = new URL('../fixtures/render/', import.meta.url);

/** Compares with a checked-in golden file; UPDATE_GOLDEN=1 rewrites it for review in the diff. */
function expectGolden(name: string, actual: string): void {
  const file = new URL(name, GOLDEN_DIR);
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(file)) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, actual);
  }
  expect(actual).toBe(readFileSync(file, 'utf8'));
}

const title = (text: string, ...more: unknown[]) => ({ title: [[text], ...more] });

const render = (blocks: Record<string, RawBlock>, ctx = testCtx()) =>
  renderBlocks(mapOf(blocks), ctx);

describe('thsm page (recorded)', () => {
  test('matches the golden HTML and keeps every block visible', () => {
    const map = unwrapRecordMap(readFixture('thsm-loadPageChunk.json'));
    const { html } = renderBlocks(map, testCtx({ rootId: THSM_ID }));
    expectGolden('thsm-blocks.golden.html', html);
    expect(html.match(/<h[2-4]\b/g)).toHaveLength(4);
    expect(html.match(/<hr>/g)).toHaveLength(1);
    expect(html.match(/<p>/g)).toHaveLength(2); // two of the three text blocks have text
    expect(html.match(/<p class="e">/g)).toHaveLength(1); // the third is a blank line
    // 8 sub-page links, plus the collection_view_page and the collection_view.
    expect(html.match(/class="pg"/g)).toHaveLength(8);
    expect(html.match(/class="unsupported"/g)).toHaveLength(2);
  });
});

describe('every supported type (synthetic)', () => {
  const blocks = pageWith(
    {
      [bid(1)]: { type: 'text', properties: title('plain'), content: [bid(30)] },
      [bid(30)]: { type: 'text', properties: title('indented under text') },
      [bid(2)]: { type: 'header', properties: title('H2') },
      [bid(3)]: { type: 'sub_header', properties: title('H3') },
      [bid(4)]: { type: 'sub_sub_header', properties: title('H4') },
      [bid(5)]: { type: 'bulleted_list', properties: title('b1'), content: [bid(6)] },
      [bid(6)]: { type: 'bulleted_list', properties: title('nested') },
      [bid(7)]: { type: 'bulleted_list', properties: title('b2') },
      [bid(8)]: { type: 'numbered_list', properties: title('n3'), format: { list_start_index: 3 } },
      [bid(9)]: { type: 'numbered_list', properties: title('n4') },
      [bid(10)]: { type: 'to_do', properties: { ...title('done'), checked: [['Yes']] } },
      [bid(11)]: { type: 'to_do', properties: title('open') },
      [bid(12)]: { type: 'quote', properties: title('quoted') },
      [bid(13)]: { type: 'callout', properties: title('callout'), format: { page_icon: '🚕' } },
      [bid(14)]: {
        type: 'code',
        properties: { ...title('if (a < b) { x() }'), language: [['JavaScript']] },
      },
      [bid(15)]: { type: 'divider' },
      [bid(16)]: {
        type: 'image',
        properties: { source: [['attachment:i1:a.png']], caption: [['first']] },
        format: { block_width: 600, block_height: 300 },
      },
      [bid(17)]: {
        type: 'image',
        properties: { source: [['attachment:i2:b.png']] },
        format: { block_width: 100, block_height: 200 },
      },
      [bid(18)]: { type: 'toggle', properties: title('toggle me'), content: [bid(19)] },
      [bid(19)]: { type: 'text', properties: title('inside toggle') },
      [bid(20)]: {
        type: 'bookmark',
        properties: {
          link: [['https://example.com/a?b=1&c=2']],
          title: [['Example']],
          description: [['desc']],
        },
      },
      [bid(21)]: {
        type: 'table',
        content: [bid(22), bid(23)],
        format: { table_block_column_order: ['c1', 'c2'], table_block_column_header: true },
      },
      [bid(22)]: { type: 'table_row', properties: { c1: [['H1']], c2: [['H2']] } },
      [bid(23)]: { type: 'table_row', properties: { c1: [['a']], c2: [['b']] } },
      [bid(24)]: { type: 'column_list', content: [bid(25), bid(26)] },
      [bid(25)]: { type: 'column', content: [bid(27)], format: { column_ratio: 0.25 } },
      [bid(26)]: { type: 'column', content: [bid(28)], format: { column_ratio: 0.75 } },
      [bid(27)]: { type: 'text', properties: title('left') },
      [bid(28)]: { type: 'text', properties: title('right') },
      [bid(29)]: { type: 'page', properties: title('Sub page') },
    },
    [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 24, 29].map(bid),
  );
  const { html, firstImageBlockId } = render(blocks);

  test('matches the golden HTML', () =>
    expectGolden('blocks-all-types-synthetic.golden.html', html));

  test('headings, lists and nesting', () => {
    expect(html).toContain(
      '<h2 id="000000000000400080000000000002">H2</h2>'.replace(
        '000000000000400080000000000002',
        bid(2).replaceAll('-', ''),
      ),
    );
    expect(html).toContain('<h3 ');
    expect(html).toContain('<h4 ');
    expect(html).toContain('<li>b1<div class="in">\n<ul>\n<li>nested</li>');
    expect(html).toContain('<ol start="3">');
    expect(html.match(/<ul>/g)).toHaveLength(2); // the outer bullet list and the nested one
  });

  test('to-dos, toggles, tables, columns, code, bookmarks', () => {
    expect(html).toContain('<input type="checkbox" disabled checked> done');
    expect(html).toContain('<input type="checkbox" disabled> open');
    expect(html).toContain('<details>\n<summary>toggle me</summary>');
    expect(html).toContain('<thead><tr><th>H1</th><th>H2</th></tr>');
    expect(html).toContain('<tbody>\n<tr><td>a</td><td>b</td></tr>');
    expect(html).toContain('style="flex:0.25"');
    expect(html).toContain('style="flex:0.75"');
    expect(html).toMatch(
      /<pre data-l="[^"]*"><code class="language-javascript">if \(a &lt; b\) \{ x\(\) \}<\/code><\/pre>/,
    );
    expect(html).toContain('href="https://example.com/a?b=1&amp;c=2"');
    expect(html).toContain('<aside class="callout"><span class="ico" aria-hidden="true">🚕</span>');
    expect(html).toContain('<a href="https://thsm.notion.site/' + bid(29).replaceAll('-', ''));
  });

  test('images: first is prioritised, later ones lazy, all carry dimensions', () => {
    expect(firstImageBlockId).toBe(bid(16));
    const imgs = html.match(/<img [^>]*>/g) ?? [];
    expect(imgs).toHaveLength(2);
    expect(imgs[0]).toContain('fetchpriority="high"');
    expect(imgs[0]).not.toContain('loading="lazy"');
    expect(imgs[1]).toContain('loading="lazy"');
    for (const img of imgs) expect(img).toMatch(/width="\d+" height="\d+"/);
    expect(imgs[0]).toContain('width="600" height="300"');
    expect(html).toContain('<figcaption>first</figcaption>');
  });
});

describe('boundaries', () => {
  test('an unsupported block becomes a visible Notion link, never a silent drop', () => {
    const { html } = render(pageWith({ [bid(1)]: { type: 'video', properties: title('A film') } }));
    expect(html).toContain('class="unsupported"');
    expect(html).toContain('Open in Notion: A film');
    expect(html).toContain(
      `href="https://thsm.notion.site/${ROOT.replaceAll('-', '')}#${bid(1).replaceAll('-', '')}"`,
    );
  });

  test('a child id that is missing from the map is linked too', () => {
    const { html } = render(pageWith({}, [bid(77)]));
    expect(html).toContain('class="unsupported"');
  });

  test('a block that contains itself, or two that contain each other, terminate', () => {
    for (const blocks of [
      pageWith({ [bid(1)]: { type: 'text', properties: title('self'), content: [bid(1)] } }),
      pageWith(
        {
          [bid(1)]: { type: 'toggle', properties: title('a'), content: [bid(2)] },
          [bid(2)]: { type: 'toggle', properties: title('b'), content: [bid(1)] },
        },
        [bid(1)],
      ),
    ]) {
      const { html } = render(blocks);
      expect(html.match(/class="unsupported"/g)).toHaveLength(1);
    }
  });

  test('nesting deeper than MAX_DEPTH stops with a link', () => {
    const chain: Record<string, RawBlock> = {};
    const depth = MAX_DEPTH + 3;
    for (let i = 1; i <= depth; i++) {
      chain[bid(i)] = {
        type: 'toggle',
        properties: title(`level ${i}`),
        content: i < depth ? [bid(i + 1)] : [],
      };
    }
    const { html } = render(pageWith(chain, [bid(1)]));
    expect(html).toContain('class="unsupported"');
    expect(html).not.toContain(`level ${depth}`.concat('</summary>'));
  });

  test('an image that cannot be proxied is a link, not an <img>', () => {
    const blocks = pageWith({
      [bid(1)]: { type: 'image', properties: { source: [['https://evil.example/a.png']] } },
    });
    const { html } = render(blocks, testCtx({ imageUrl: () => null }));
    expect(html).not.toContain('<img');
    expect(html).toContain('<a href="https://evil.example/a.png"');
  });

  test('an image without any dimension still declares width and height', () => {
    const { html } = render(
      pageWith({ [bid(1)]: { type: 'image', properties: { source: [['attachment:x:y.png']] } } }),
    );
    expect(html).toMatch(/<img [^>]*width="1280" height="720"/);
  });

  test('sniffed sizes are used when the block has none', () => {
    const sizes = new Map([[bid(1), { width: 328, height: 353 }]]);
    const { html } = render(
      pageWith({ [bid(1)]: { type: 'image', properties: { source: [['attachment:x:y.png']] } } }),
      testCtx({ imageSizes: sizes }),
    );
    expect(html).toContain('width="328" height="353"');
  });
});

describe('size limits', () => {
  test('a page past MAX_BLOCKS ends with a visible link to the rest', () => {
    const many: Record<string, RawBlock> = {};
    for (let i = 1; i <= MAX_BLOCKS + 5; i++)
      many[bid(i)] = { type: 'text', properties: title(`p${i}`) };
    const { html } = render(pageWith(many));
    expect(html).not.toContain(`p${MAX_BLOCKS + 5}<`);
    expect(html.endsWith('this page continues</a></p>\n')).toBe(true);
  });

  test('an incomplete load is flagged the same way', () => {
    const map = {
      ...mapOf(pageWith({ [bid(1)]: { type: 'text', properties: title('x') } })),
      incomplete: true,
    };
    expect(renderBlocks(map, testCtx()).html).toContain('this page continues');
  });
});

describe('partial data', () => {
  test('a missing table row and a missing column become visible links', () => {
    const { html } = render(
      pageWith(
        {
          [bid(1)]: {
            type: 'table',
            content: [bid(2), bid(3)],
            format: { table_block_column_order: ['c'] },
          },
          [bid(2)]: { type: 'table_row', properties: { c: [['known']] } },
          [bid(4)]: { type: 'column_list', content: [bid(5), bid(6)] },
          [bid(5)]: { type: 'column', content: [], format: { column_ratio: 0.5 } },
        },
        [bid(1), bid(4)],
      ),
    );
    expect(html).toContain('<td>known</td>');
    expect(html.match(/class="unsupported"/g)).toHaveLength(2);
  });

  test('table rows and missing children count against MAX_BLOCKS', () => {
    const rows: Record<string, RawBlock> = {
      [bid(1)]: {
        type: 'table',
        content: Array.from({ length: MAX_BLOCKS + 10 }, (_, i) => bid(i + 10)),
        format: { table_block_column_order: ['c'] },
      },
    };
    for (let i = 0; i < MAX_BLOCKS + 10; i++)
      rows[bid(i + 10)] = { type: 'table_row', properties: { c: [[`r${i}`]] } };
    const table = render(pageWith(rows, [bid(1)])).html;
    expect(table.match(/<tr>/g)?.length).toBeLessThan(MAX_BLOCKS);
    expect(table).toContain('this page continues');
    const missing = render(
      pageWith(
        {},
        Array.from({ length: MAX_BLOCKS + 10 }, (_, i) => bid(i + 10)),
      ),
    ).html;
    expect(missing.match(/class="unsupported"/g)?.length).toBeLessThanOrEqual(MAX_BLOCKS + 1);
    expect(missing).toContain('this page continues');
  });

  test('an exhausted budget stops list wrappers too', () => {
    const many: Record<string, RawBlock> = {};
    for (let i = 1; i <= MAX_BLOCKS * 3; i++)
      many[bid(i)] = {
        type: i % 2 === 0 ? 'numbered_list' : 'bulleted_list',
        properties: title('x'),
      };
    const { html } = render(pageWith(many));
    expect((html.match(/<li>/g) ?? []).length).toBeLessThanOrEqual(MAX_BLOCKS);
    expect((html.match(/<[uo]l[ >]/g) ?? []).length).toBeLessThanOrEqual(MAX_BLOCKS);
    expect(html).not.toContain('<ul>\n</ul>');
    expect(html).not.toContain('<ol>\n</ol>');
  });

  test('the header-column setting of the table styles first-column cells', () => {
    const { html } = render(
      pageWith(
        {
          [bid(1)]: {
            type: 'table',
            content: [bid(2)],
            format: { table_block_column_order: ['a', 'b'], table_block_row_header: true },
          },
          [bid(2)]: { type: 'table_row', properties: { a: [['label']], b: [['value']] } },
        },
        [bid(1)],
      ),
    );
    expect(html).toContain('<th>label</th><td>value</td>');
  });
});

describe('hostile content', () => {
  const evil = '<script>alert(1)</script>';
  const blocks = pageWith({
    [bid(1)]: { type: 'text', properties: title(evil, ['a', 'javascript:alert(1)']) },
    [bid(2)]: { type: 'header', properties: title(`"><img src=x onerror=alert(1)>`) },
    [bid(3)]: {
      type: 'code',
      properties: { ...title(evil), language: [['"><script>x</script>']] },
    },
    [bid(4)]: { type: 'callout', properties: title(evil), format: { page_icon: '<script>' } },
    [bid(5)]: {
      type: 'bookmark',
      properties: { link: [['javascript:alert(1)']], title: [[evil]] },
    },
    [bid(6)]: { type: 'embed', properties: title(`<b onmouseover="x">${evil}`) },
    [bid(7)]: { type: 'table', content: [bid(8)], format: { table_block_column_order: ['c'] } },
    [bid(8)]: { type: 'table_row', properties: { c: [[evil]] } },
    [bid(9)]: { type: 'column_list', content: [bid(10)] },
    [bid(10)]: { type: 'column', content: [], format: { column_ratio: 1 } },
  });
  const { html } = render(blocks);

  test('no executable markup comes out and attacker strings appear only escaped', () => {
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror=alert(1)>');
    expect(html).not.toContain('<b ');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  test('a script-scheme bookmark degrades to a visible Notion link', () => {
    expect(html).toContain('Open in Notion: &lt;script&gt;');
  });
});
