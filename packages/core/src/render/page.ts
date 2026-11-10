/**
 * The full fast-page document (spec section 5.3).
 *
 * The element structure is a contract with the Telegram Instant View template in
 * docs/fast-variant.md: `article > header > h1 + time`, then the body blocks, then
 * `footer > a.orig`. Change one only together with the other.
 */
import { escapeHtml, FAVICON_LINK } from '../og-html';
import { ogLocale } from '../metadata';
import { CRITICAL_CSS } from './css';
import { articleJsonLd } from './jsonld';
import type { RenderedBlocks } from './blocks';

export interface FastPageInput {
  workspace: string;
  slug: string;
  /** `PUBLIC_ORIGIN`, no trailing slash. */
  origin: string;
  title: string;
  description: string;
  /** BCP 47 tag; `en` when unknown. */
  lang: string;
  canonicalMode: 'self' | 'notion';
  notionUrl: string;
  /** Absolute card image URL (the same one the redirect link uses), or null. */
  ogImageUrl: string | null;
  /** ISO 8601. */
  editedAt?: string;
  createdAt?: string;
  body: RenderedBlocks;
}

export const fastPageUrl = (origin: string, workspace: string, slug: string): string =>
  `${origin}/${workspace}/${slug}/read`;

function metaTags(input: FastPageInput, selfUrl: string): string {
  const title = escapeHtml(input.title);
  const description = escapeHtml(input.description);
  const locale = ogLocale(input.lang);
  const image = input.ogImageUrl === null ? null : escapeHtml(input.ogImageUrl);
  const tags = [
    ...(description === '' ? [] : [`<meta name="description" content="${description}">`]),
    `<link rel="canonical" href="${escapeHtml(input.canonicalMode === 'notion' ? input.notionUrl : selfUrl)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:url" content="${escapeHtml(selfUrl)}">`,
    `<meta property="og:title" content="${title}">`,
    ...(description === '' ? [] : [`<meta property="og:description" content="${description}">`]),
    ...(locale === null ? [] : [`<meta property="og:locale" content="${locale}">`]),
    ...(image === null
      ? [`<meta name="twitter:card" content="summary">`]
      : [
          `<meta property="og:image" content="${image}">`,
          `<meta name="twitter:card" content="summary_large_image">`,
          `<meta name="twitter:image" content="${image}">`,
        ]),
    `<meta name="twitter:title" content="${title}">`,
    ...(description === '' ? [] : [`<meta name="twitter:description" content="${description}">`]),
    ...(input.editedAt === undefined
      ? []
      : [`<meta property="article:modified_time" content="${escapeHtml(input.editedAt)}">`]),
  ];
  return tags.join('\n');
}

function timeTag(editedAt: string | undefined): string {
  if (editedAt === undefined) return '';
  const day = editedAt.slice(0, 10);
  return `<time datetime="${escapeHtml(editedAt)}">${escapeHtml(day)}</time>`;
}

export function renderFastPage(input: FastPageInput): string {
  const selfUrl = fastPageUrl(input.origin, input.workspace, input.slug);
  const title = escapeHtml(input.title);
  return `<!doctype html>
<html lang="${escapeHtml(input.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${FAVICON_LINK}
${metaTags(input, selfUrl)}
<script type="application/ld+json">${articleJsonLd(input, selfUrl)}</script>
<style>${CRITICAL_CSS}</style>
</head>
<body>
<main>
<article>
<header>
<h1>${title}</h1>
${timeTag(input.editedAt)}
</header>
${input.body.html}<footer><a class="orig" href="${escapeHtml(input.notionUrl)}" rel="noopener nofollow">Open the original in Notion</a></footer>
</article>
</main>
</body>
</html>
`;
}
