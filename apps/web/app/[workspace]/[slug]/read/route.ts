/**
 * Fast variant: `GET /<ws>/<slug>/read` serves the Notion page as static, zero-JavaScript
 * HTML (spec section 5.3).
 *
 * Caching mirrors the redirect link: the Vercel edge keeps the page for 60 s and serves it
 * stale for a day while one request refreshes it in the background, so visitors almost
 * never wait for Notion. The link's cache tag lets an update or delete purge it at once.
 * A transient Notion failure throws on purpose: the edge then keeps serving the last good
 * copy instead of caching an error page.
 */
import { after } from 'next/server';
import { buildFastPage } from '@ntn-link/core/render';
import { errorResponse } from '@/lib/http';
import { getService, linkCacheTag } from '@/lib/service';

/**
 * Room for the 10 s database warm-up (Neon scale-to-zero, see PostgresStore) plus paging
 * through Notion chunks (up to 40 sequential requests with their own deadlines).
 */
export const maxDuration = 60;

const PAGE_CACHE_CONTROL =
  'public, max-age=0, s-maxage=60, stale-while-revalidate=86400, stale-if-error=86400';
const NEGATIVE_CACHE_CONTROL = 'public, max-age=0, s-maxage=60';

function html(body: string, status: number, cacheControl: string, tag: string): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': cacheControl,
      'vercel-cache-tag': tag,
      'x-content-type-options': 'nosniff',
    },
  });
}

const notFoundHtml =
  '<!doctype html><meta charset="utf-8"><title>Not found</title><h1>No such page</h1>';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workspace: string; slug: string }> },
): Promise<Response> {
  const { workspace, slug } = await params;
  try {
    const service = getService();
    const tag = linkCacheTag(workspace, slug);
    const link = await service.getLink(workspace, slug);
    if (link === null) {
      // `getLink` hides links whose page stopped being public; those answer 410, not 404.
      const redirect = await service.redirectPage(workspace, slug);
      // A republished page can only recover if something re-checks it: honor the refresh signal.
      if (redirect.kind !== 'not_found' && redirect.needsRefresh) {
        after(() => service.refreshLink(workspace, slug));
      }
      return redirect.kind === 'gone'
        ? html(redirect.html, 410, NEGATIVE_CACHE_CONTROL, tag)
        : html(notFoundHtml, 404, NEGATIVE_CACHE_CONTROL, tag);
    }
    if (!link.fast) return html(notFoundHtml, 404, NEGATIVE_CACHE_CONTROL, tag);
    const page = await buildFastPage({ link, origin: service.origin });
    if (page.status === 410) {
      const gone = await service.redirectPage(workspace, slug);
      return html(
        gone.kind === 'gone'
          ? gone.html
          : '<!doctype html><title>Gone</title><h1>This page is no longer public</h1>',
        410,
        NEGATIVE_CACHE_CONTROL,
        tag,
      );
    }
    return html(page.html, 200, PAGE_CACHE_CONTROL, tag);
  } catch (error) {
    return errorResponse(error);
  }
}
