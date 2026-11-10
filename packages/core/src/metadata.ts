/**
 * Metadata extraction from Notion's server-rendered HTML (spec sections 2 and 5.2).
 *
 * Verification depends on `og:title` being present in SSR output, so this is the
 * piece the live smoke test guards. Parsing is tag-by-tag regex on <meta>, enough for
 * Notion's machine-generated head and avoiding a DOM dependency at the edge.
 */

export interface PageMetadata {
  /** Title with the trailing " | Notion" removed. */
  title: string;
  description: string;
  /** Social image as served by Notion, or null for Notion's generic default image. */
  imageUrl: string | null;
  language: string | null;
}

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', '\u00a0'],
]);

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES.get(body.toLowerCase()) ?? whole;
  });
}

// Quoted values may legally contain ">", so quoted runs are consumed as a unit.
const META_TAG = /<meta\s+((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/gi;
const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** First value per `property`/`name` key, entity-decoded. */
function readMetaTags(html: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const tag of html.matchAll(META_TAG)) {
    const attrs = new Map<string, string>();
    for (const attr of (tag[1] ?? '').matchAll(ATTRIBUTE)) {
      attrs.set((attr[1] ?? '').toLowerCase(), attr[2] ?? attr[3] ?? '');
    }
    const key = attrs.get('property') ?? attrs.get('name');
    const content = attrs.get('content');
    if (key !== undefined && content !== undefined && !found.has(key.toLowerCase())) {
      found.set(key.toLowerCase(), decodeHtmlEntities(content));
    }
  }
  return found;
}

const NOTION_SUFFIX = /\s*\|\s*Notion\s*$/;

export function stripNotionSuffix(title: string): string {
  return title.replace(NOTION_SUFFIX, '').trim();
}

/** Notion serves this to plain clients that are not recognised as unfurlers. */
const GENERIC_NOTION_IMAGE = /\/images\/meta\/default\.png$/;

export function extractMetadata(html: string): PageMetadata {
  const meta = readMetaTags(html);
  const titleTag = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];
  const rawTitle =
    meta.get('og:title') ?? (titleTag === undefined ? '' : decodeHtmlEntities(titleTag));
  const title = stripNotionSuffix(rawTitle) || 'Untitled';
  const description = (meta.get('og:description') ?? meta.get('description') ?? '').trim();

  const image = meta.get('og:image');
  let imageUrl: string | null = null;
  if (image !== undefined && image !== '') {
    try {
      const parsed = new URL(image);
      imageUrl = GENERIC_NOTION_IMAGE.test(parsed.pathname) ? null : parsed.href;
    } catch {
      imageUrl = null;
    }
  }
  return { title, description, imageUrl, language: detectLanguage(`${title} ${description}`) };
}

/**
 * Notion's own `<html lang>` and `og:locale` are the UI language (always en), so the
 * page language is guessed from the script of the text, which is what matters for
 * `og:locale`. Returns null when there is nothing to go on.
 */
export function detectLanguage(text: string): string | null {
  const cyrillic = (text.match(/[\u0400-\u04ff]/g) ?? []).length;
  const latin = (text.match(/[a-z]/gi) ?? []).length;
  if (cyrillic === 0 && latin === 0) return null;
  if (cyrillic > latin) {
    if (/[їєґ]/i.test(text)) return 'uk';
    if (/ў/i.test(text)) return 'be';
    return 'ru';
  }
  return 'en';
}

const LOCALES: ReadonlyMap<string, string> = new Map([
  ['ru', 'ru_RU'],
  ['uk', 'uk_UA'],
  ['be', 'be_BY'],
  ['en', 'en_US'],
]);

export function ogLocale(language: string | null): string | null {
  return language === null ? null : (LOCALES.get(language) ?? null);
}

/** Notion image URL requested at the card width (spec 5.2). Other hosts pass through unchanged. */
export function withImageWidth(imageUrl: string, width: number): string {
  const url = new URL(imageUrl);
  if (url.searchParams.has('width')) url.searchParams.set('width', String(width));
  return url.href;
}
