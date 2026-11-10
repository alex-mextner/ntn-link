/**
 * schema.org Article JSON-LD for the fast page. The output sits inside a
 * `<script type="application/ld+json">` data block, so every character that could end the
 * block or be read as markup is written as a \uXXXX escape.
 */
import type { FastPageInput } from './page';

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

export function articleJsonLd(input: FastPageInput, pageUrl: string): string {
  return safeJson({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: input.title,
    description: input.description,
    inLanguage: input.lang,
    url: pageUrl,
    mainEntityOfPage: pageUrl,
    ...(input.ogImageUrl === null ? {} : { image: input.ogImageUrl }),
    ...(input.createdAt === undefined ? {} : { datePublished: input.createdAt }),
    ...(input.editedAt === undefined ? {} : { dateModified: input.editedAt }),
  });
}
