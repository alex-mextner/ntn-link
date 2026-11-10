/**
 * Card image of a link. Notion image URLs are signed and expire within hours, so the
 * source is resolved fresh on every request that misses the CDN and only the image bytes
 * are cached, never the signed URL. Without a usable Notion image the title card is drawn.
 */
import { fetchCardImage } from '@ntn-link/core';
import { errorResponse } from '@/lib/http';
import { isPlausibleLinkPath } from '@/lib/link-path';
import { getService, linkCacheTag } from '@/lib/service';
import { renderTitleCard } from '@/lib/title-card';

/** Room for the 10 s database warm-up (Neon scale-to-zero, see PostgresStore) plus the request's own work (Notion calls have 10 s deadlines). */
export const maxDuration = 60;

const CACHE_CONTROL = 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workspace: string; slug: string }> },
): Promise<Response> {
  const { workspace, slug } = await params;
  if (!isPlausibleLinkPath(workspace, slug)) {
    return new Response('No such link', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  try {
    const source = await getService().cardSource(workspace, slug);
    if (source === null) {
      return new Response('No such link', {
        status: 404,
        headers: { 'cache-control': 'no-store' },
      });
    }
    const headers = {
      'cache-control': CACHE_CONTROL,
      'vercel-cache-tag': linkCacheTag(workspace, slug),
    };
    if (source.kind === 'notion-image') {
      const image = await fetchCardImage(source.url);
      if (image !== null) {
        return new Response(Buffer.from(image.bytes), {
          headers: {
            ...headers,
            'content-type': image.contentType,
            'x-content-type-options': 'nosniff',
          },
        });
      }
    }
    return await renderTitleCard(source.title, source.description, workspace, headers);
  } catch (error) {
    return errorResponse(error);
  }
}
