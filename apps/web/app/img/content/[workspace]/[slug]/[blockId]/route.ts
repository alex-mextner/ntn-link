/**
 * In-content image proxy for the fast variant: `GET /img/content/<ws>/<slug>/<blockId>`.
 *
 * Notion image URLs are signed and expire within hours, so pages embed this URL instead and
 * a fresh signed URL is resolved here per request. Only image blocks that are shown on the
 * link's own page are served (otherwise any block id of the workspace could be proxied
 * through our domain), at a fixed set of widths. `v` is the block's edit time, only a cache
 * key: a new edit gives a new URL, so the response can be cached for a long time.
 */
import {
  IMAGE_WIDTHS,
  NotionDataError,
  dashedId,
  findImageBlock,
  loadPageChunk,
  resolveFreshImage,
} from '@ntn-link/core/render';
import { getService, linkCacheTag } from '@/lib/service';

/**
 * Room for the 10 s database warm-up (Neon scale-to-zero, see PostgresStore) plus paging
 * through Notion chunks (up to 40 sequential requests with their own deadlines).
 */
export const maxDuration = 60;

const IMAGE_CACHE_CONTROL = 'public, max-age=86400, s-maxage=2592000, immutable';
const ERROR_CACHE_CONTROL = 'public, max-age=0, s-maxage=30';
const BLOCK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function plain(status: number, text: string, tag?: string): Response {
  return new Response(text, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': ERROR_CACHE_CONTROL,
      ...(tag === undefined ? {} : { 'vercel-cache-tag': tag }),
    },
  });
}

function requestedWidth(url: URL): (typeof IMAGE_WIDTHS)[number] | null {
  const width = Number(url.searchParams.get('w') ?? IMAGE_WIDTHS[0]);
  return IMAGE_WIDTHS.find((w) => w === width) ?? null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspace: string; slug: string; blockId: string }> },
): Promise<Response> {
  const { workspace, slug, blockId } = await params;
  const width = requestedWidth(new URL(request.url));
  if (width === null || !BLOCK_ID.test(blockId)) return plain(400, 'Bad image request.');
  const tag = linkCacheTag(workspace, slug);
  const link = await getService().getLink(workspace, slug);
  if (link === null || !link.fast) return plain(404, 'Not found.', tag);
  try {
    const map = await loadPageChunk({ workspace, pageId: link.pageId });
    const block = findImageBlock(map, dashedId(link.pageId), blockId);
    if (block === null) return plain(404, 'Not found.', tag);
    const image = await resolveFreshImage({
      workspace,
      block,
      width,
      accept: request.headers.get('accept') ?? undefined,
    });
    if (image === null) return plain(404, 'Not found.', tag);
    return new Response(image.body, {
      headers: {
        'content-type': image.contentType,
        'cache-control': IMAGE_CACHE_CONTROL,
        'vercel-cache-tag': tag,
        vary: 'Accept',
        'x-content-type-options': 'nosniff',
        // A raster image only: this stops anything else from running if it is ever opened directly.
        'content-security-policy': "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    if (error instanceof NotionDataError && error.notPublic) return plain(404, 'Not found.', tag);
    return plain(502, 'Image temporarily unavailable.');
  }
}
