/**
 * HTML for the redirect link (spec section 5.2) and the "no longer public" page.
 *
 * Every dynamic value is escaped for the context it lands in; Notion titles and
 * descriptions are attacker-controlled. The redirect target is passed in by the caller
 * and is always the canonical URL the server rebuilt, never user input.
 */
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
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
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
${tags.join('\n')}
<meta http-equiv="refresh" content="0;url=${target}">
<script>location.replace(${scriptString(input.targetUrl)})</script>
</head>
<body>
<noscript><p><a href="${target}">${title}</a></p></noscript>
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
</head>
<body>
<h1>This page is no longer public</h1>
<p>The Notion page behind this link was unpublished or deleted.</p>
</body>
</html>
`;
}
