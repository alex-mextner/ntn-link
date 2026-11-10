/**
 * Everything between a stored link and the fast page HTML: load the Notion blocks, learn
 * image sizes the blocks do not record, render. Kept in core (not in the route file) so the
 * whole path is testable without Next.js and with an injected `fetch`.
 */
import { cardImageUrl } from '../card-version';
import type { LinkRecord } from '../records';
import { emojiOfIcon, renderBlocks } from './blocks';
import {
  IMAGE_WIDTHS,
  imageSourceOf,
  pageImageSourceOf,
  resolveFreshImage,
  sniffImageSize,
  type ImageSize,
  type PageImageSlot,
} from './image';
import { dashedId, loadPageChunk } from './page-chunk';
import { NotionDataError, plainTextOf, type NotionBlock, type RecordMap } from './records';
import { renderFastPage, type PageHero, type PageImage } from './page';

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

/** Proxy URL of the page's own cover or icon picture, `w` being the rendition width. */
function pageImageUrl(link: LinkRecord, root: NotionBlock, slot: PageImageSlot, w: number): string {
  return `/img/content/${link.workspace}/${link.slug}/${root.id}?k=${slot}&v=${root.lastEditedTime ?? root.version ?? 0}&w=${w}`;
}

function pageImageOf(
  link: LinkRecord,
  root: NotionBlock,
  slot: PageImageSlot,
  position: number,
): PageImage | null {
  if (pageImageSourceOf(root, slot, link.workspace) === null) return null;
  const [small, large] = IMAGE_WIDTHS;
  const src = pageImageUrl(link, root, slot, small);
  return {
    src,
    srcset: `${src} ${small}w, ${pageImageUrl(link, root, slot, large)} ${large}w`,
    position,
  };
}

/** Cover, icon and the per-page display options of the root page. */
function heroOf(root: NotionBlock | undefined, link: LinkRecord): PageHero {
  if (root === undefined) {
    return { icon: null, cover: null, fullWidth: false, smallText: false, font: 'sans' };
  }
  const { format } = root;
  const emoji = emojiOfIcon(format.page_icon);
  const iconImage = emoji === null ? pageImageOf(link, root, 'icon', 0.5) : null;
  const font = format.page_font;
  return {
    icon:
      emoji !== null
        ? { kind: 'emoji', text: emoji }
        : iconImage === null
          ? null
          : { kind: 'image', image: iconImage },
    cover: pageImageOf(link, root, 'cover', format.page_cover_position ?? 0.5),
    fullWidth: format.page_full_width === true,
    smallText: format.page_small_text === true,
    font: font === 'serif' || font === 'mono' ? font : 'sans',
  };
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
    ogImageUrl: await cardImageUrl(origin, link),
    editedAt: isoOrUndefined(root?.lastEditedTime),
    createdAt: isoOrUndefined(root?.createdTime),
    body,
    hero: heroOf(root, link),
  });
  return { status: 200, html };
}
