/**
 * Public redirect link: always 200 HTML (never 302) so unfurlers and browsers see the same
 * OG tags; humans are sent on by meta refresh and a script. Edge-cached with a tag so a
 * link change can purge every form at once; stale metadata is refreshed in the background.
 */
import { after } from 'next/server';
import { getService, linkCacheTag } from '@/lib/service';
import { errorResponse } from '@/lib/http';
import { isPlausibleLinkPath } from '@/lib/link-path';

const CACHE_CONTROL = 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400';
const NOT_FOUND_CACHE_CONTROL = 'public, max-age=0, s-maxage=60';

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

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workspace: string; slug: string }> },
): Promise<Response> {
  const { workspace, slug } = await params;
  if (!isPlausibleLinkPath(workspace, slug)) {
    return new Response('No such link', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  try {
    const service = getService();
    const result = await service.redirectPage(workspace, slug);
    const tag = linkCacheTag(workspace, slug);
    if (result.kind === 'not_found') {
      return html(
        '<!doctype html><meta charset="utf-8"><title>Not found</title><h1>No such link</h1>',
        404,
        NOT_FOUND_CACHE_CONTROL,
        tag,
      );
    }
    if (result.needsRefresh) after(() => service.refreshLink(workspace, slug));
    return html(result.html, result.kind === 'gone' ? 410 : 200, CACHE_CONTROL, tag);
  } catch (error) {
    return errorResponse(error);
  }
}
