/**
 * Image blocks: which sources we may proxy, how to resolve them fresh, and how to learn
 * their size.
 *
 * Notion image URLs are signed and expire within hours (spec section 2), so a page never
 * embeds one: it embeds our proxy URL, and the proxy resolves a fresh signed URL per
 * request. Hosts outside the spec 5.3 allowlist are not proxied at all.
 */
import { allowNotionImageUrl, safeFetch } from '../safe-fetch';
import { NotionDataError, plainTextOf, type NotionBlock } from './records';

export type ImageSource =
  /** Uploaded file stored as `attachment:<id>:<name>`; resolved by the workspace `/image/` endpoint. */
  | { kind: 'attachment'; value: string }
  /** Notion's own file storage (S3 style URL); also resolved by `/image/`, which signs it. */
  | { kind: 'notion-file'; value: string }
  /** An allowlisted host that can be fetched directly. */
  | { kind: 'external'; value: string };

const NOTION_FILE_HOSTS: ReadonlySet<string> = new Set([
  'prod-files-secure.s3.us-west-2.amazonaws.com',
  'secure.notion-static.com',
  's3-us-west-2.amazonaws.com',
]);

/** Widths the proxy serves; anything else is rejected so the cache key space stays small. */
export const IMAGE_WIDTHS = [640, 1280] as const;
export type ImageWidth = (typeof IMAGE_WIDTHS)[number];

export const IMAGE_LIMITS = { maxBytes: 10 * 1024 * 1024, timeoutMs: 5000 } as const;

/** Raster formats only: an SVG served from our origin could run script if opened directly. */
const SERVABLE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

/** The source behind a raw Notion image reference; null when it may not be proxied. */
export function imageSourceFromRaw(raw: string): ImageSource | null {
  if (raw.startsWith('attachment:')) return { kind: 'attachment', value: raw };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === 'https:' && NOTION_FILE_HOSTS.has(url.hostname)) {
    return { kind: 'notion-file', value: url.href };
  }
  return allowNotionImageUrl(url) ? { kind: 'external', value: url.href } : null;
}

export function imageSourceOf(block: NotionBlock): ImageSource | null {
  return imageSourceFromRaw(plainTextOf(block, 'source') || block.format.display_source || '');
}

/** The two decorations of a page that are pictures: the cover and an uploaded or linked icon. */
export type PageImageSlot = 'cover' | 'icon';

/**
 * Cover or icon picture of a page block. Notion's gallery covers are relative paths
 * (`/images/page-cover/x.jpg`); like uploads they are resized by the workspace `/image/`
 * endpoint. Emoji icons are not pictures and give null.
 */
export function pageImageSourceOf(
  page: NotionBlock,
  slot: PageImageSlot,
  workspace: string,
): ImageSource | null {
  const raw = (slot === 'cover' ? page.format.page_cover : page.format.page_icon) ?? '';
  if (raw.startsWith('/images/')) {
    return { kind: 'notion-file', value: `https://${workspace}.notion.site${raw}` };
  }
  return imageSourceFromRaw(raw);
}

export function imageRequestUrl(
  workspace: string,
  block: NotionBlock,
  source: ImageSource,
  width: number,
): URL {
  if (source.kind === 'external') return new URL(source.value);
  const url = new URL(
    `/image/${encodeURIComponent(source.value)}`,
    `https://${workspace}.notion.site`,
  );
  url.search = new URLSearchParams({
    table: 'block',
    id: block.id,
    width: String(width),
  }).toString();
  return url;
}

export interface ResolvedImage {
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
}

/** A fixed set of values instead of the raw header, so the cache key space stays tiny. */
export function preferredAccept(clientAccept: string | undefined): string {
  if (clientAccept?.includes('image/avif')) return 'image/avif,image/webp,image/png,image/jpeg';
  if (clientAccept?.includes('image/webp')) return 'image/webp,image/png,image/jpeg';
  return 'image/png,image/jpeg';
}

/** Fetches the image now, with a fresh signed URL; null when it cannot be served. */
export async function resolveFreshImage(args: {
  workspace: string;
  block: NotionBlock;
  /** What to fetch; defaults to the image block's own source. */
  source?: ImageSource | null;
  width: number;
  /** The client's `Accept`; Notion's image endpoint then answers WebP/AVIF where supported. */
  accept?: string;
  fetchImpl?: typeof fetch;
}): Promise<ResolvedImage | null> {
  const source = args.source === undefined ? imageSourceOf(args.block) : args.source;
  if (source === null) return null;
  const result = await safeFetch(imageRequestUrl(args.workspace, args.block, source, args.width), {
    allow: allowNotionImageUrl,
    headers: new Headers({ accept: preferredAccept(args.accept) }),
    maxBytes: IMAGE_LIMITS.maxBytes,
    timeoutMs: IMAGE_LIMITS.timeoutMs,
    fetchImpl: args.fetchImpl,
  }).catch((cause: unknown) => {
    throw new NotionDataError(cause instanceof Error ? cause.message : 'Image fetch failed.');
  });
  const contentType = (result.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  const servable = result.status === 200 && !result.truncated && SERVABLE_TYPES.has(contentType);
  return servable ? { body: new Uint8Array(result.body), contentType } : null;
}

export interface ImageSize {
  width: number;
  height: number;
}

function pngSize(b: Uint8Array): ImageSize | null {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

function gifSize(b: Uint8Array): ImageSize | null {
  if (b.length < 10 || b[0] !== 0x47 || b[1] !== 0x49) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
}

function jpegSize(b: Uint8Array): ImageSize | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let offset = 2;
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) return null;
    const marker = b[offset + 1] ?? 0;
    // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc) carry the frame size.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) return { height: v.getUint16(offset + 5), width: v.getUint16(offset + 7) };
    offset += 2 + v.getUint16(offset + 2);
  }
  return null;
}

function webpSize(b: Uint8Array): ImageSize | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length < 30 || ascii(0, 4) !== 'RIFF' || ascii(8, 12) !== 'WEBP') return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const kind = ascii(12, 16);
  if (kind === 'VP8X') {
    return {
      width: 1 + (v.getUint16(24, true) | ((b[26] ?? 0) << 16)),
      height: 1 + (v.getUint16(27, true) | ((b[29] ?? 0) << 16)),
    };
  }
  if (kind === 'VP8 ')
    return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
  if (kind === 'VP8L') {
    const bits = v.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

/** Pixel size from the file header, for images whose block carries no dimensions. */
export function sniffImageSize(bytes: Uint8Array): ImageSize | null {
  const size = pngSize(bytes) ?? jpegSize(bytes) ?? gifSize(bytes) ?? webpSize(bytes);
  return size !== null && size.width > 0 && size.height > 0 ? size : null;
}
