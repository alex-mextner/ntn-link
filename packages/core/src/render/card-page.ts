/**
 * What the generated card (and its preview) shows of a page besides the title: the start of
 * its text and its icon, both read from the first chunk of Notion's page data.
 *
 * The icon is an emoji (kept as text; the card draws an emoji picture for it) or a picture
 * (fetched here, downscaled by Notion's image endpoint and returned as a data URI, so the card
 * never depends on a signed URL and the web preview can show it without another request).
 */
import type { CardIcon } from '../api-types';
import { emojiOfIcon } from './blocks';
import { pageImageSourceOf, resolveFreshImage } from './image';
import { cardExcerpt } from './excerpt';
import { dashedId, loadPageStart } from './page-chunk';
import type { NotionBlock } from './records';

export interface CardPage {
  excerpt: string[];
  icon: CardIcon | null;
}

/** Width asked from Notion for a picture icon: enough for the 96 px slot at 2x. */
const ICON_IMAGE_WIDTH = 256;
/** Largest icon picture embedded; bigger ones are not drawn (the data URI travels in the preview JSON). */
const ICON_IMAGE_MAX_BYTES = 192 * 1024;

export interface LoadCardPageArgs {
  workspace: string;
  pageId: string;
  fetchImpl?: typeof fetch;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

/**
 * PNG and JPEG only: the card renderer decodes both, and neither can carry script. The leading
 * bytes must agree with the content type, so a mislabelled body never reaches the decoder.
 */
function dataUriOf(bytes: Uint8Array, contentType: string): string | null {
  const magic =
    contentType === 'image/png' ? PNG_MAGIC : contentType === 'image/jpeg' ? JPEG_MAGIC : null;
  if (magic === null || !magic.every((byte, i) => bytes[i] === byte)) return null;
  if (bytes.byteLength > ICON_IMAGE_MAX_BYTES) return null;
  return `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`;
}

async function iconOf(
  root: NotionBlock,
  workspace: string,
  fetchImpl: typeof fetch | undefined,
): Promise<CardIcon | null> {
  const emoji = emojiOfIcon(root.format.page_icon);
  if (emoji !== null) return { kind: 'emoji', emoji };
  const source = pageImageSourceOf(root, 'icon', workspace);
  if (source === null) return null;
  try {
    const image = await resolveFreshImage({
      workspace,
      block: root,
      source,
      width: ICON_IMAGE_WIDTH,
      // One byte over the cap: a larger body arrives truncated and counts as too large.
      maxBytes: ICON_IMAGE_MAX_BYTES + 1,
      fetchImpl,
    });
    const dataUri = image === null ? null : dataUriOf(image.body, image.contentType);
    return dataUri === null ? null : { kind: 'image', dataUri };
  } catch {
    return null;
  }
}

/**
 * Text start and icon of a public page. Any failure yields what could be read (nothing at
 * worst): the card is decoration, and a Notion hiccup must not turn it into an error.
 */
export async function loadCardPage(args: LoadCardPageArgs): Promise<CardPage> {
  try {
    const map = await loadPageStart(args);
    const rootId = dashedId(args.pageId);
    const root = map.blocks.get(rootId);
    return {
      excerpt: cardExcerpt(map, rootId),
      icon: root === undefined ? null : await iconOf(root, args.workspace, args.fetchImpl),
    };
  } catch {
    return { excerpt: [], icon: null };
  }
}

/**
 * Only the page's emoji icon, for the redirect stub: one chunk fetch and no picture download
 * (a picture icon gives null). Failures give null as well.
 */
export async function loadPageEmoji(args: LoadCardPageArgs): Promise<string | null> {
  try {
    const map = await loadPageStart(args);
    return emojiOfIcon(map.blocks.get(dashedId(args.pageId))?.format.page_icon);
  } catch {
    return null;
  }
}
