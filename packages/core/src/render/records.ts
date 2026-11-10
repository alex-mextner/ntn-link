/**
 * Notion block records as served by the unofficial `loadPageChunk` endpoint.
 *
 * The endpoint is undocumented and its record envelope has changed shape before
 * (`value` vs `value.value`), so everything is validated at this boundary with
 * lenient schemas: a field of the wrong type degrades to "absent" instead of failing the
 * page, while a payload with no usable block map at all raises `NotionDataError`.
 */
import { z } from 'zod';

export class NotionDataError extends Error {
  /** True when Notion answered that the page does not exist or is not public. */
  readonly notPublic: boolean;
  constructor(message: string, options: { notPublic?: boolean } = {}) {
    super(message);
    this.name = 'NotionDataError';
    this.notPublic = options.notPublic ?? false;
  }
}

/** A decoration is `[kind, ...args]`; args are strings, or objects for date mentions. */
export type Decoration = [kind: string, ...args: unknown[]];

/** `[text, decorations?]`; mention segments carry their payload inside a decoration. */
export type RichTextSegment = [text: string, decorations?: Decoration[]];

const segmentSchema = z.union([
  z.tuple([z.string()]),
  z.tuple([z.string(), z.array(z.tuple([z.string()]).rest(z.unknown()))]),
]);

/** Format values the renderer reads; anything of an unexpected type becomes undefined. */
const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);
const formatSchema = z.object({
  page_icon: lenient(z.string()),
  block_width: lenient(z.number()),
  block_height: lenient(z.number()),
  block_aspect_ratio: lenient(z.number()),
  column_ratio: lenient(z.number()),
  list_start_index: lenient(z.number()),
  toggleable: lenient(z.boolean()),
  table_block_column_order: lenient(z.array(z.string())),
  table_block_column_header: lenient(z.boolean()),
  table_block_row_header: lenient(z.boolean()),
  display_source: lenient(z.string()),
  page_cover: lenient(z.string()),
});
export type BlockFormat = z.infer<typeof formatSchema>;

const blockSchema = z.object({
  id: z.string(),
  type: z.string().min(1),
  version: lenient(z.number()),
  last_edited_time: lenient(z.number()),
  created_time: lenient(z.number()),
  parent_id: lenient(z.string()),
  content: lenient(z.array(z.string())),
  properties: lenient(z.record(z.string(), z.unknown())),
  format: lenient(formatSchema),
});

export interface NotionBlock {
  id: string;
  type: string;
  version: number | undefined;
  lastEditedTime: number | undefined;
  createdTime: number | undefined;
  parentId: string | undefined;
  /** Ids of child blocks in display order. */
  content: string[];
  format: BlockFormat;
  /** Raw properties; read through `textOf` / `propertyText`, which validate lazily. */
  properties: Readonly<Record<string, unknown>>;
}

export interface RecordMap {
  blocks: Map<string, NotionBlock>;
  /** True when loading stopped at a safety limit, so the page is longer than the blocks held. */
  incomplete?: boolean;
}

const EMPTY_FORMAT: BlockFormat = formatSchema.parse({});

/** Rich text stored under `key`; malformed segments are skipped, never the whole property. */
export function textOf(block: NotionBlock, key = 'title'): RichTextSegment[] {
  const raw = block.properties[key];
  if (!Array.isArray(raw)) return [];
  const segments: RichTextSegment[] = [];
  for (const candidate of raw) {
    const parsed = segmentSchema.safeParse(candidate);
    if (parsed.success) segments.push(parsed.data);
  }
  return segments;
}

/** Plain text of one property (no decorations). */
export function plainTextOf(block: NotionBlock, key = 'title'): string {
  return textOf(block, key)
    .map((s) => s[0])
    .join('');
}

const recordWrapperSchema = z.object({ value: z.unknown() });

/** Both known shapes: `{value: {value: block}}` (current) and `{value: block}` (older). */
function blockValueOf(record: unknown): unknown {
  const outer = recordWrapperSchema.safeParse(record);
  if (!outer.success) return undefined;
  const inner = recordWrapperSchema.safeParse(outer.data.value);
  const looksNested =
    inner.success && typeof inner.data.value === 'object' && inner.data.value !== null;
  return looksNested ? inner.data.value : outer.data.value;
}

/** Adds every typed block of a `recordMap.block` object into `into`; typeless records are skipped. */
function addBlocks(blockRecords: Record<string, unknown>, into: Map<string, NotionBlock>): void {
  for (const [key, record] of Object.entries(blockRecords)) {
    const parsed = blockSchema.safeParse(blockValueOf(record));
    if (!parsed.success) continue; // Typeless: Notion lists blocks it will not let us read.
    const b = parsed.data;
    into.set(key, {
      id: b.id,
      type: b.type,
      version: b.version,
      lastEditedTime: b.last_edited_time,
      createdTime: b.created_time,
      parentId: b.parent_id,
      content: b.content ?? [],
      format: b.format ?? EMPTY_FORMAT,
      properties: b.properties ?? {},
    });
  }
}

const envelopeSchema = z.object({
  recordMap: z.object({ block: z.record(z.string(), z.unknown()) }),
});

/**
 * Block map of one loadPageChunk response. Throws `NotionDataError` when the response has no
 * `recordMap.block`, which is how a changed API shape surfaces loudly.
 */
export function unwrapRecordMap(raw: unknown): RecordMap {
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new NotionDataError('Notion page data has an unexpected shape (no recordMap.block).');
  }
  const blocks = new Map<string, NotionBlock>();
  addBlocks(parsed.data.recordMap.block, blocks);
  return { blocks };
}
