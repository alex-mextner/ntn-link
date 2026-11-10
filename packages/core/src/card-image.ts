/**
 * Fetches the page's social image for the `/img/<ws>/<slug>` proxy. The URL handed in is
 * resolved at request time (Notion signs image URLs for 6-24 h), only allowlisted image
 * hosts are followed, and only PNG and JPEG are passed on, byte for byte (nothing is decoded
 * in our process): serving an SVG from our origin would be an XSS vector.
 */
import { allowNotionImageUrl, safeFetch } from './safe-fetch';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 8000;
/**
 * Link-preview crawlers (Telegram, WhatsApp, Slack) handle JPEG/PNG reliably and WebP not.
 * Notion honours this header (a plain `image/webp,...` accept gets WebP), so we ask for what
 * we serve and refuse anything else.
 */
const CARD_IMAGE_ACCEPT = 'image/jpeg,image/png;q=0.9,*/*;q=0.1';

export interface FetchedImage {
  bytes: Uint8Array;
  contentType: 'image/png' | 'image/jpeg';
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
      headers: new Headers({ accept: CARD_IMAGE_ACCEPT }),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    const contentType =
      result.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (result.status !== 200 || result.truncated) return null;
    if (contentType !== 'image/png' && contentType !== 'image/jpeg') return null;
    return { bytes: result.body, contentType };
  } catch {
    return null;
  }
}
