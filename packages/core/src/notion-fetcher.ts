/**
 * Fetches a public Notion page as a bot and normalizes it (spec sections 2, 4, 7).
 *
 * `PageFetcher` is the seam the ownership state machine and the service depend on, so
 * tests (and the dev-only `NTN_TEST_FETCHER`) can substitute it. The real
 * implementation below only ever goes through `safeFetch`.
 */
import { ApiError } from './errors';
import { extractMetadata, type PageMetadata } from './metadata';
import { isNotionGeneratedCardUrl } from './notion-placeholder';
import { dashedId, loadPageStart } from './render/page-chunk';
import { allowNotionPageUrl, safeFetch, BOT_USER_AGENT, type SafeFetchOptions } from './safe-fetch';
import {
  canonicalNotionUrl,
  parseNotionUrl,
  workspaceFromHost,
  type ParsedNotionUrl,
} from './notion-url';

export type PageFetchResult =
  | {
      kind: 'public';
      workspace: string;
      pageId: string;
      canonicalUrl: string;
      metadata: PageMetadata;
    }
  | { kind: 'not_public' };

export interface PageFetcher {
  /**
   * Resolves the page through Notion's redirects. Throws `unsupported_workspace` when the
   * page does not live under a `<ws>.notion.site` domain and `upstream_error` when Notion
   * misbehaves; a page that is private or missing is the `not_public` result, not an error.
   */
  fetchPage(page: ParsedNotionUrl): Promise<PageFetchResult>;
}

export interface RealPageFetcherOptions {
  fetchImpl?: typeof fetch;
}

function bareIdUrl(page: ParsedNotionUrl): URL {
  return new URL(`https://www.notion.so/${page.pageId}`);
}

function startUrl(page: ParsedNotionUrl): URL {
  return page.workspaceHint === null
    ? bareIdUrl(page)
    : new URL(canonicalNotionUrl(page.workspaceHint, page.pageId));
}

/**
 * Notion's generated "Made with Notion" card is not a cover. Its URL shape is only a hint (a
 * real cover can be uploaded under the same file name), so the page data decides: a page with
 * a `page_cover` keeps the image; without one, or when the page data cannot be read, the
 * image is dropped and our own card is drawn.
 */
async function withoutGeneratedCard(
  metadata: PageMetadata,
  workspace: string,
  pageId: string,
  fetchImpl: typeof fetch | undefined,
): Promise<PageMetadata> {
  if (metadata.imageUrl === null || !isNotionGeneratedCardUrl(metadata.imageUrl)) return metadata;
  const hasCover = await loadPageStart({ workspace, pageId, fetchImpl })
    .then((map) => (map.blocks.get(dashedId(pageId))?.format.page_cover ?? '') !== '')
    .catch(() => false);
  return hasCover ? metadata : { ...metadata, imageUrl: null };
}

export function createPageFetcher(options: RealPageFetcherOptions = {}): PageFetcher {
  return {
    async fetchPage(page) {
      const fetchOptions: SafeFetchOptions = {
        allow: allowNotionPageUrl,
        headers: new Headers({ 'user-agent': BOT_USER_AGENT, accept: 'text/html' }),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      };
      let result = await safeFetch(startUrl(page), fetchOptions);
      // A hint taken from `notion.so/<name>/<id>` is Notion's internal workspace name, which
      // need not be the published domain; resolve the id through Notion before giving up.
      if (result.status === 404 && page.workspaceHint !== null) {
        result = await safeFetch(bareIdUrl(page), fetchOptions);
      }
      if (result.status === 404) return { kind: 'not_public' };
      if (result.status !== 200) {
        throw new ApiError('upstream_error', `Notion answered with HTTP ${result.status}.`);
      }
      const workspace = workspaceFromHost(result.finalUrl.hostname);
      if (workspace === null) {
        throw new ApiError(
          'unsupported_workspace',
          'This page is not under a <workspace>.notion.site domain. Workspaces without a public domain are not supported yet.',
        );
      }
      let pageId = page.pageId;
      try {
        pageId = parseNotionUrl(result.finalUrl.href).pageId;
      } catch {
        // Final URL without a recognisable id: keep the requested one.
      }
      const html = new TextDecoder().decode(result.body);
      return {
        kind: 'public',
        workspace,
        pageId,
        canonicalUrl: canonicalNotionUrl(workspace, pageId),
        metadata: await withoutGeneratedCard(
          extractMetadata(html),
          workspace,
          pageId,
          options.fetchImpl,
        ),
      };
    },
  };
}
