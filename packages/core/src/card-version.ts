/**
 * Version of a link's card image, carried in its URL (`/img/<ws>/<slug>?v=<version>`).
 *
 * Why: unfurlers (Telegram, Slack, Facebook, ...) cache the image of an already shared link
 * by its URL. With a stable `/img/<ws>/<slug>` a changed card (new look, edited title, a new
 * cover) keeps being shown from their cache even after they re-read the page. A URL that
 * changes with the card makes every re-read of the page pick the new image, and gives the
 * CDN a separate cache entry per card version. An unfurler that never re-reads the page keeps
 * its old preview regardless; that cache cannot be cleared from our side.
 */
import { sha256Hex } from './crypto';
import { isNotionPlaceholderImageUrl } from './notion-placeholder';
import type { LinkRecord } from './records';

/**
 * Bump this whenever the look of the card changes without any stored field changing: the
 * generated card (`apps/web/lib/title-card.tsx`, `card-layout.ts`, bundled fonts), what is
 * drawn on it, or which images count as a usable cover. Bumping changes the image URL of
 * every link, so shared links pick up the new look the next time a crawler reads their page.
 */
export const CARD_RENDER_VERSION = 1;

/** What the card is built from, as far as the stored record knows it. */
function cardImageKey(imageUrl: string | null): string {
  if (imageUrl === null) return 'generated';
  // Only the fixed Notion banners count as "no cover" here. The per-page "Made with Notion" file
  // name proves nothing on its own (an upload can carry it, and the fetcher keeps such a cover
  // when the page data confirms it), so a stored image of that name is a cover like any other.
  if (isNotionPlaceholderImageUrl(imageUrl)) return 'generated';
  try {
    // Origin and path name the image; the query carries a signature and a size that change
    // without the picture changing.
    const url = new URL(imageUrl);
    return url.origin + url.pathname;
  } catch {
    return imageUrl;
  }
}

/**
 * Short, URL-safe digest of everything the stored record contributes to the card image:
 * the effective title and description, the cover (or its absence), the opening text drawn on a
 * coverless card, and the render version.
 */
export async function cardImageVersion(record: LinkRecord): Promise<string> {
  const digest = await sha256Hex(
    JSON.stringify([
      CARD_RENDER_VERSION,
      record.overrides.title ?? record.title,
      record.overrides.description ?? record.description,
      cardImageKey(record.imageUrl),
      record.excerptDigest ?? null,
    ]),
  );
  return digest.slice(0, 10);
}

/** Absolute `og:image` URL of a link's card: the stable image path plus its version. */
export async function cardImageUrl(origin: string, record: LinkRecord): Promise<string> {
  return `${origin}/img/${record.workspace}/${record.slug}?v=${await cardImageVersion(record)}`;
}
