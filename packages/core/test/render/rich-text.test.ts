import { describe, expect, test } from 'bun:test';
import { renderRichText, safeHref, type RichTextSegment } from '../../src/render';

const ctx = { workspace: 'thsm' };
const render = (segments: RichTextSegment[]) => renderRichText(segments, ctx);

describe('renderRichText', () => {
  test('escapes markup, quotes and ampersands', () => {
    expect(render([['<script>alert(1)</script> & "q" \'s\'']])).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot; &#39;s&#39;',
    );
  });

  test('nesting order is fixed regardless of decoration order', () => {
    const a = render([['hi', [['i'], ['b']]]]);
    const b = render([['hi', [['b'], ['i']]]]);
    expect(a).toBe('<strong><em>hi</em></strong>');
    expect(b).toBe(a);
    expect(render([['x', [['c'], ['s'], ['_']]]])).toBe('<s><u><code>x</code></u></s>');
  });

  test('links: http(s) kept and escaped, script schemes dropped', () => {
    expect(render([['x', [['a', 'https://e.com/?a=1&b=2']]]])).toBe(
      '<a href="https://e.com/?a=1&amp;b=2" rel="noopener nofollow">x</a>',
    );
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      'JaVaScRiPt:alert(1)',
      'vbscript:x',
    ]) {
      expect(render([['x', [['a', bad]]]])).toBe('x');
    }
    expect(render([['m', [['a', 'mailto:a@b.co']]]])).toContain('href="mailto:a@b.co"');
  });

  test('a page mention links to the Notion page and shows the page title', () => {
    const html = renderRichText([['‣', [['p', '413d447a-c4b1-8016-9985-c93eea7f02f9']]]], {
      workspace: 'thsm',
      pageTitle: () => 'Our trips',
    });
    expect(html).toBe(
      '<a href="https://thsm.notion.site/413d447ac4b180169985c93eea7f02f9" rel="noopener nofollow">Our trips</a>',
    );
  });

  test('equations, dates and background highlights', () => {
    expect(render([['⁍', [['e', 'x^2 < y']]]])).toBe('<span class="eq">x^2 &lt; y</span>');
    expect(render([['‣', [['d', { start_date: '2027-01-18' }]]]])).toBe('2027-01-18');
    expect(render([['hot', [['h', 'yellow_background']]]])).toBe('<mark>hot</mark>');
    expect(render([['red', [['h', 'red']]]])).toBe('red');
  });

  test('soft line breaks survive, escaped, also inside formatted text', () => {
    expect(render([['first\nsecond <b>']])).toBe('first<br>second &lt;b&gt;');
    expect(render([['a\nb', [['b']]]])).toBe('<strong>a<br>b</strong>');
  });

  test('empty input, emoji and RTL text pass through', () => {
    expect(renderRichText(undefined, ctx)).toBe('');
    expect(render([])).toBe('');
    expect(render([['🤿 שלום Ωmega']])).toBe('🤿 שלום Ωmega');
  });
});

describe('safeHref', () => {
  test('Notion-relative links become absolute workspace links; protocol-relative ones are refused', () => {
    expect(safeHref('/abc', ctx)).toBe('https://thsm.notion.site/abc');
    expect(safeHref('//evil.example/x', ctx)).toBeNull();
    expect(safeHref('not a url', ctx)).toBeNull();
    expect(safeHref('/\\[', ctx)).toBeNull();
    expect(renderRichText([['x', [['a', '/\\[']]]], ctx)).toBe('x');
  });
});
