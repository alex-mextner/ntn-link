/**
 * Fetches the page's social image for the `/img/<ws>/<slug>` proxy. The URL handed in is
 * resolved at request time (Notion signs image URLs for 6-24 h), only allowlisted image
 * hosts are followed, and only raster formats are passed on: serving an SVG from our
 * origin would be an XSS vector.
 */
import { allowNotionImageUrl, safeFetch } from './safe-fetch';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 8000;
const RASTER_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
]);

export interface FetchedImage {
  bytes: Uint8Array;
  contentType: string;
}

/** Null on any failure so the caller can fall back to the generated card. */
export async function fetchCardImage(
  url: string,
  fetchImpl?: typeof fetch,
): Promise<FetchedImage | null> {
  try {
    const result = await safeFetch(new URL(url), {
      allow: allowNotionImageUrl,
      maxBytes: MAX_IMAGE_BYTES,
      timeoutMs: IMAGE_TIMEOUT_MS,
      headers: new Headers({ accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5' }),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    const contentType =
      result.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (result.status !== 200 || result.truncated || !RASTER_TYPES.has(contentType)) return null;
    return { bytes: result.body, contentType };
  } catch {
    return null;
  }
}
