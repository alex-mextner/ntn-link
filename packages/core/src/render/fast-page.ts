/**
 * Everything between a stored link and the fast page HTML: load the Notion blocks, learn
 * image sizes the blocks do not record, render. Kept in core (not in the route file) so the
 * whole path is testable without Next.js and with an injected `fetch`.
 */
import type { LinkRecord } from '../records';
import { renderBlocks } from './blocks';
import { imageSourceOf, resolveFreshImage, sniffImageSize, type ImageSize } from './image';
import { dashedId, loadPageChunk } from './page-chunk';
import { NotionDataError, plainTextOf, type NotionBlock, type RecordMap } from './records';
import { renderFastPage } from './page';

const MAX_SIZE_PROBES = 12;

export interface BuildFastPageArgs {
  link: LinkRecord;
  origin: string;
  fetchImpl?: typeof fetch;
}

export type FastPageResult = { status: 200; html: string } | { status: 410 };

/** Blocks shown on the page: the page's content tree, not descending into sub-pages. */
function* visibleBlocks(map: RecordMap, rootId: string): Generator<NotionBlock> {
  const seen = new Set<string>([rootId]);
  const stack = (map.blocks.get(rootId)?.content ?? []).toReversed();
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    const block = map.blocks.get(id);
    if (block === undefined || seen.has(id)) continue;
    seen.add(id);
    yield block;
    if (block.type !== 'page') stack.push(...block.content.toReversed());
  }
}

/** The image block `blockId` when it is an image shown on the page; the proxy serves nothing else. */
export function findImageBlock(
  map: RecordMap,
  rootId: string,
  blockId: string,
): NotionBlock | null {
  for (const block of visibleBlocks(map, rootId)) {
    if (block.id === blockId) return block.type === 'image' ? block : null;
  }
  return null;
}

/** Sizes for images without recorded dimensions, read from the header of a small rendition. */
async function sniffMissingSizes(
  map: RecordMap,
  link: LinkRecord,
  rootId: string,
  fetchImpl: typeof fetch | undefined,
): Promise<Map<string, ImageSize>> {
  const pending = [...visibleBlocks(map, rootId)]
    .filter((b) => b.type === 'image' && imageSourceOf(b) !== null)
    .filter((b) => b.format.block_width === undefined || b.format.block_height === undefined)
    .slice(0, MAX_SIZE_PROBES);
  const sizes = new Map<string, ImageSize>();
  await Promise.all(
    pending.map(async (block) => {
      const image = await resolveFreshImage({
        workspace: link.workspace,
        block,
        width: 640,
        fetchImpl,
      }).catch(() => null);
      const size = image === null ? null : sniffImageSize(image.body);
      if (size !== null) sizes.set(block.id, size);
    }),
  );
  return sizes;
}

const isoOrUndefined = (ms: number | undefined): string | undefined =>
  ms === undefined ? undefined : new Date(ms).toISOString();

export async function buildFastPage(args: BuildFastPageArgs): Promise<FastPageResult> {
  const { link, origin } = args;
  let map: RecordMap;
  try {
    map = await loadPageChunk({
      workspace: link.workspace,
      pageId: link.pageId,
      fetchImpl: args.fetchImpl,
    });
  } catch (cause) {
    // Only "not public" is a verdict; any other failure must propagate so ISR keeps the last good page.
    if (cause instanceof NotionDataError && cause.notPublic) return { status: 410 };
    throw cause;
  }
  const rootId = dashedId(link.pageId);
  const root = map.blocks.get(rootId);
  const imageSizes = await sniffMissingSizes(map, link, rootId, args.fetchImpl);
  const body = renderBlocks(map, {
    workspace: link.workspace,
    rootId,
    imageSizes,
    imageUrl: (block, width) =>
      imageSourceOf(block) === null
        ? null
        : `/img/content/${link.workspace}/${link.slug}/${block.id}?v=${block.lastEditedTime ?? block.version ?? 0}&w=${width}`,
  });
  const html = renderFastPage({
    workspace: link.workspace,
    slug: link.slug,
    origin,
    title: (link.overrides.title ?? (root === undefined ? '' : plainTextOf(root))) || link.title,
    description: link.overrides.description ?? (link.description || body.text.slice(0, 200)),
    lang: link.language ?? 'en',
    canonicalMode: link.canonicalMode,
    notionUrl: link.canonicalUrl,
    ogImageUrl: `${origin}/img/${link.workspace}/${link.slug}`,
    editedAt: isoOrUndefined(root?.lastEditedTime),
    createdAt: isoOrUndefined(root?.createdTime),
    body,
  });
  return { status: 200, html };
}
