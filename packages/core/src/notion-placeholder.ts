/**
 * Recognises the images Notion puts in `og:image` when a page has no cover of its own: the
 * marketing banner (white, "Notion" logo, served from the static `/images/meta/` folder under
 * many names and hosts: `default.png`, `notion-wordmark.png`, ...) and the card Notion
 * generates per page (`SocialMediaPreviewImage.png`: icon, title cut to one line, "Made with
 * Notion"). Showing either under a link means every cover-less page looks like an
 * advertisement for Notion, so they count as "no image" and the link gets our own card.
 *
 * Two layers: the URL shape decides before anything is downloaded, and the sha-256 of the
 * downloaded bytes catches a known banner that is re-published under a name this file has not
 * seen. A real cover (an upload, or a picture from Notion's cover gallery) never matches.
 */

const NOTION_HOST = /(^|\.)notion\.(so|com|site)$/i;
const META_FOLDER = '/images/meta/';
const GENERATED_CARD_FILE = 'SocialMediaPreviewImage.png';
/** Notion's image resizer path: `/image/<url-encoded source>`. */
const IMAGE_PROXY_PREFIX = '/image/';

/** sha-256 (hex) of the banner files Notion served as of 2026-11. */
const PLACEHOLDER_SHA256: ReadonlySet<string> = new Set([
  // /images/meta/default.png (1200x625, "Where teams and agents think together")
  '3fad30c68e8991ce1eec0b36769e6ef0d618b11e2be7a4e8040364ae02c9408f',
  // /images/meta/notion-wordmark.png (1200x630, black logo on off-white)
  'fe1abee4df61a5202cb9944ce954af2c97c2f35afa24f7f9166e8e4dcdf3b221',
]);

function tryParse(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function tryDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** True when the URL is one of Notion's own static banners. */
function isMetaBanner(url: URL): boolean {
  return NOTION_HOST.test(url.hostname) && url.pathname.toLowerCase().startsWith(META_FOLDER);
}

export function isNotionPlaceholderImageUrl(value: string): boolean {
  const url = tryParse(value);
  if (url === null || !NOTION_HOST.test(url.hostname)) return false;
  if (isMetaBanner(url)) return true;
  const source = proxiedSource(url);
  const inner = source === null ? null : tryParse(source);
  return inner !== null && isMetaBanner(inner);
}

/** Source of a proxied image: a full URL (`https://...`) or `attachment:<id>:<file name>`. */
function proxiedSource(url: URL): string | null {
  return url.pathname.startsWith(IMAGE_PROXY_PREFIX)
    ? tryDecode(url.pathname.slice(IMAGE_PROXY_PREFIX.length))
    : null;
}

/**
 * True when the URL has the shape of the per-page "Made with Notion" card. The file name is
 * all there is to go on, and a user may upload a real cover under that very name, so this is
 * only a hint: the caller must confirm with the page data that the page has no cover of its own.
 */
export function isNotionGeneratedCardUrl(value: string): boolean {
  const url = tryParse(value);
  if (url === null || !NOTION_HOST.test(url.hostname)) return false;
  return proxiedSource(url)?.endsWith(`:${GENERATED_CARD_FILE}`) ?? false;
}

/** True when the bytes are exactly one of the known Notion banners. */
export async function isNotionPlaceholderImage(bytes: Uint8Array): Promise<boolean> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  return PLACEHOLDER_SHA256.has(hex);
}
