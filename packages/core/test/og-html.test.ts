import { describe, expect, test } from 'bun:test';
import { escapeHtml, FAVICON_LINK, renderGoneHtml, renderRedirectHtml } from '../src/og-html';

const hostile = `</title><script>alert("x")</script> & 'q' "d" \u2028`;
const base = {
  title: 'Наши Путешествия',
  description: 'Лето 2026',
  imageUrl: 'https://ntn.link/img/thsm/our-trips',
  pageUrl: 'https://ntn.link/thsm/our-trips',
  targetUrl: 'https://thsm.notion.site/413d447ac4b180169985c93eea7f02f9',
  language: 'ru',
  emoji: null,
};

describe('renderRedirectHtml', () => {
  test('emits the full card, a refresh, a location.replace and a noscript link', () => {
    const out = renderRedirectHtml(base);
    expect(out).toContain('<meta property="og:title" content="Наши Путешествия">');
    expect(out).toContain('<meta property="og:description" content="Лето 2026">');
    expect(out).toContain(
      '<meta property="og:image" content="https://ntn.link/img/thsm/our-trips">',
    );
    expect(out).toContain('<meta property="og:url" content="https://ntn.link/thsm/our-trips">');
    expect(out).toContain('<meta property="og:locale" content="ru_RU">');
    expect(out).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(out).not.toContain('og:image:width');
    expect(out).not.toContain('og:image:height');
    expect(out).toContain(
      '<meta http-equiv="refresh" content="0;url=https://thsm.notion.site/413d447ac4b180169985c93eea7f02f9">',
    );
    expect(out).toContain(
      'location.replace("https://thsm.notion.site/413d447ac4b180169985c93eea7f02f9")',
    );
    expect(out).toContain('<noscript><p><a href="https://thsm.notion.site/');
    expect(out).not.toContain('og:site_name');
  });

  test('omits description tags when there is no description and og:locale when language is unknown', () => {
    const out = renderRedirectHtml({ ...base, description: '', language: null });
    expect(out).not.toContain('og:description');
    expect(out).not.toContain('twitter:description');
    expect(out).not.toContain('og:locale');
  });

  test('escapes hostile title, description and URLs in every context', () => {
    const out = renderRedirectHtml({
      ...base,
      title: hostile,
      description: hostile,
      imageUrl: `https://x.example/"><script>1</script>`,
      pageUrl: `https://x.example/"><b>`,
      targetUrl: `https://thsm.notion.site/a"></script><script>alert(1)</script>\u2028`,
    });
    expect(out).not.toContain('<script>alert');
    expect(out).not.toContain('"><script>');
    expect(out).not.toContain('"><b>');
    // Exactly the one legitimate inline script remains, with its terminator intact.
    expect(out.match(/<script>/g)).toHaveLength(1);
    expect(out.match(/<\/script>/g)).toHaveLength(1);
    const scriptLine = out.split('\n').find((l) => l.startsWith('<script>')) ?? '';
    expect(scriptLine).not.toContain('\u2028');
  });
});

describe('redirect page icon', () => {
  const iconed = renderRedirectHtml({ ...base, emoji: '🤿' });

  test('an emoji icon replaces the logo mark and becomes the tab icon', () => {
    expect(iconed).toContain('<span class="m e" aria-hidden="true">🤿</span>');
    expect(iconed).not.toContain('<svg width="48"');
    const favicon = /<link rel="icon" href="data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)">/.exec(
      iconed,
    )?.[1];
    expect(Buffer.from(favicon ?? '', 'base64').toString('utf8')).toContain('>🤿</text>');
  });

  test('no icon keeps the logo mark and the logo as the tab icon', () => {
    const plain = renderRedirectHtml(base);
    expect(plain).toContain('<svg width="48"');
    expect(plain).toContain(FAVICON_LINK);
  });

  test('the emoji is escaped', () => {
    const out = renderRedirectHtml({ ...base, emoji: '<img src=x onerror=alert(1)>' });
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;img src=x');
  });
});

test('escapeHtml covers the five significant characters', () => {
  expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
});

test('the gone page has no redirect and no script', () => {
  const out = renderGoneHtml();
  expect(out).not.toContain('refresh');
  expect(out).not.toContain('<script');
  expect(out).toContain('no longer public');
});

describe('stub page chrome', () => {
  const pages = {
    redirect: renderRedirectHtml(base),
    gone: renderGoneHtml(),
  };

  test.each(Object.entries(pages))(
    '%s page styles itself inline without any request',
    (_name, out) => {
      expect(out).toMatch(/<style>[^<]+<\/style>/);
      expect(out).not.toMatch(/url\(|@import|@font-face|<img\b/);
      // The only <link> is the icon, inlined as a data URI: no request, no foreign host.
      const links = out.match(/<link\b[^>]*>/g) ?? [];
      for (const link of links)
        expect(link).toMatch(
          /^<link rel="icon" href="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+">$/,
        );
    },
  );

  test('the gone page names no host at all', () => {
    expect(pages.gone).not.toMatch(/https?:\/\//);
  });

  test('the visible redirect message is English whatever the page language', () => {
    expect(pages.redirect).toContain('<p lang="en">Opening the Notion page…</p>');
    expect(pages.redirect).toContain('<html lang="ru">');
  });

  test('the gone page is English and says what happened', () => {
    expect(pages.gone).toContain('<html lang="en">');
    expect(pages.gone).toContain('unpublished or deleted');
  });
});
