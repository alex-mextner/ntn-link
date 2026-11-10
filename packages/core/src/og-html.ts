/**
 * HTML for the redirect link (spec section 5.2) and the "no longer public" page.
 *
 * Every dynamic value is escaped for the context it lands in; Notion titles and
 * descriptions are attacker-controlled. The redirect target is passed in by the caller
 * and is always the canonical URL the server rebuilt, never user input.
 */
import { FAVICON_SVG, LOGO_PATH, LOGO_STROKE, LOGO_VIEWBOX } from './brand';
import { ogLocale } from './metadata';

const HTML_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&#39;'],
]);

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES.get(ch) ?? ch);
}

/** JSON string literal that is safe inside an inline <script> (no `</script>`, no U+2028). */
function scriptString(text: string): string {
  return JSON.stringify(text)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

/**
 * Inline chrome for the two stub pages: one centred message in the ntn.link look (ink
 * background with a violet glow, the logo above it), light or dark by `prefers-color-scheme`.
 * No `url()`, no web fonts and no script, so the stub can never trigger a request of its own.
 */
const STUB_CSS = [
  ':root{color-scheme:dark light;--bg:#07070c;--fg:#f3f3f8;--mut:#a3a3b8;--ac:#a99bff}',
  '@media(prefers-color-scheme:light){:root{--bg:#f6f6fb;--fg:#14141f;--mut:#54546c;--ac:#4338ca}}',
  '*{box-sizing:border-box}',
  'body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;background:radial-gradient(40rem 26rem at 10% -10%,rgba(124,92,255,.28),transparent 62%),radial-gradient(34rem 24rem at 100% 0,rgba(56,189,248,.16),transparent 58%),var(--bg);color:var(--fg);font:1rem/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Helvetica Neue",Arial,sans-serif;text-align:center}',
  'main{max-width:28rem}',
  '.m{display:grid;place-items:center;width:3rem;height:3rem;margin:0 auto 1.25rem;color:var(--fg)}',
  '.m.e{width:auto;height:auto;font-size:3.5rem;line-height:1;font-family:"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif}',
  'h1{margin:0 0 .5rem;font-size:1.625rem;line-height:1.2;letter-spacing:-.025em}',
  'p{margin:.5rem 0;color:var(--mut)}',
  'a{color:var(--ac);font-weight:600;text-underline-offset:.2em}',
].join('');

/** The fastp.ge logo, drawn inline so the stub stays one self-contained document. */
const MARK = `<span class="m" aria-hidden="true"><svg width="48" height="48" viewBox="${LOGO_VIEWBOX}" fill="currentColor" stroke="currentColor" stroke-width="${LOGO_STROKE}" stroke-linejoin="round"><path fill-rule="evenodd" d="${LOGO_PATH}"/></svg></span>`;

/**
 * The logo as a tab icon in a data URI (base64, so the markup carries no foreign URL): stub and
 * fast pages show the brand in the tab without the browser requesting `/favicon.ico`.
 */
export const FAVICON_LINK = `<link rel="icon" href="data:image/svg+xml;base64,${Buffer.from(FAVICON_SVG).toString('base64')}">`;

/**
 * The page's own emoji as the tab icon (Notion's public pages do the same): an SVG data URI
 * holding the emoji as text, drawn by the visitor's emoji font, Apple Color Emoji first, so it
 * costs no request. `emoji` is escaped for XML.
 */
export function emojiFaviconLink(emoji: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90" font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,sans-serif">${escapeHtml(emoji)}</text></svg>`;
  return `<link rel="icon" href="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`;
}

export interface RedirectPageInput {
  title: string;
  description: string;
  /** Absolute URL of our `/img/<ws>/<slug>` card image. */
  imageUrl: string;
  /** Absolute URL of this very page (`og:url`). */
  pageUrl: string;
  /** Canonical Notion URL humans are sent to. */
  targetUrl: string;
  language: string | null;
  /** The page's emoji icon, shown in place of the logo mark and as the tab icon; null when it has none. */
  emoji: string | null;
}

export function renderRedirectHtml(input: RedirectPageInput): string {
  const title = escapeHtml(input.title);
  const description = escapeHtml(input.description);
  const target = escapeHtml(input.targetUrl);
  const locale = ogLocale(input.language);
  const tags: string[] = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${escapeHtml(input.pageUrl)}">`,
    `<meta property="og:title" content="${title}">`,
    ...(description === '' ? [] : [`<meta property="og:description" content="${description}">`]),
    `<meta property="og:image" content="${escapeHtml(input.imageUrl)}">`,
    ...(locale === null ? [] : [`<meta property="og:locale" content="${locale}">`]),
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${title}">`,
    ...(description === '' ? [] : [`<meta name="twitter:description" content="${description}">`]),
    `<meta name="twitter:image" content="${escapeHtml(input.imageUrl)}">`,
    ...(description === '' ? [] : [`<meta name="description" content="${description}">`]),
  ];
  return `<!doctype html>
<html lang="${escapeHtml(input.language ?? 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${input.emoji === null ? FAVICON_LINK : emojiFaviconLink(input.emoji)}\n${tags.join('\n')}
<meta http-equiv="refresh" content="0;url=${target}">
<style>${STUB_CSS}</style>
<script>location.replace(${scriptString(input.targetUrl)})</script>
</head>
<body>
<main>
${input.emoji === null ? MARK : `<span class="m e" aria-hidden="true">${escapeHtml(input.emoji)}</span>`}
<p lang="en">Opening the Notion page…</p>
<noscript><p><a href="${target}">${title}</a></p></noscript>
</main>
</body>
</html>
`;
}

/** Served with 410 when the Notion page stopped answering 200; deliberately no redirect. */
export function renderGoneHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>This page is no longer public</title>
${FAVICON_LINK}
<style>${STUB_CSS}</style>
</head>
<body>
<main>
${MARK}
<h1>This page is no longer public</h1>
<p>The Notion page behind this link was unpublished or deleted.</p>
</main>
</body>
</html>
`;
}
