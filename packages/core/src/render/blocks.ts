/**
 * Notion blocks to static, semantic, zero-JavaScript HTML (spec section 5.3).
 *
 * Rules that hold for every block: all text is escaped (rich-text.ts), no block is ever
 * silently dropped (an unsupported, missing, cyclic or too deeply nested block becomes a
 * visible "open in Notion" link), and rendering never throws on hostile input.
 */
import { imageSourceOf, IMAGE_WIDTHS, type ImageSize } from './image';
import { escapeHtml, pageUrl, parseColour, renderRichText, safeHref } from './rich-text';
import { plainTextOf, textOf, type NotionBlock, type RecordMap } from './records';

export const MAX_DEPTH = 8;
/** Bounds output size for pathological pages (each block costs at least a few bytes). */
export const MAX_BLOCKS = 5000;
const DESCRIPTION_TEXT_CHARS = 600;

export interface BlockRenderCtx {
  workspace: string;
  /** Id of the page block whose content is rendered. */
  rootId: string;
  /** Our proxy URL for an image block at `width`, or null when the source is not proxiable. */
  imageUrl(block: NotionBlock, width: number): string | null;
  /** Dimensions learned outside the block record (header sniffing), by block id. */
  imageSizes?: ReadonlyMap<string, ImageSize>;
}

export interface RenderedBlocks {
  html: string;
  firstImageBlockId: string | null;
  /** Plain text of the start of the page, a fallback for descriptions. */
  text: string;
}

interface TocHeading {
  level: number;
  id: string;
  text: string;
}

interface Walk {
  map: RecordMap;
  ctx: BlockRenderCtx;
  path: Set<string>;
  depth: number;
  shared: {
    blocks: number;
    images: number;
    firstImage: string | null;
    text: string;
    /** Headings in the order they were rendered, for tables of contents. */
    headings: TocHeading[];
  };
}

type Handler = (block: NotionBlock, walk: Walk) => string;

const LIST_TAGS: Readonly<Record<string, 'ul' | 'ol'>> = {
  bulleted_list: 'ul',
  numbered_list: 'ol',
  to_do: 'ul',
};

const HEADING_TAGS: Readonly<Record<string, string>> = {
  header: 'h2',
  sub_header: 'h3',
  sub_sub_header: 'h4',
};

const noDashes = (id: string): string => id.replaceAll('-', '');

function titleOf(block: NotionBlock, walk: Walk): string {
  return renderRichText(textOf(block), richCtx(walk));
}

function richCtx(walk: Walk) {
  return {
    workspace: walk.ctx.workspace,
    pageTitle: (id: string) => {
      const target = walk.map.blocks.get(id) ?? walk.map.blocks.get(noDashes(id));
      return target === undefined ? undefined : plainTextOf(target) || undefined;
    },
  };
}

function note(walk: Walk, text: string): void {
  if (walk.shared.text.length < DESCRIPTION_TEXT_CHARS) walk.shared.text += `${text} `;
}

/** A link to the block on Notion; for blocks that are pages themselves it is the page URL. */
function notionLink(block: NotionBlock | undefined, id: string, walk: Walk): string {
  const own = block?.type === 'page' || block?.type === 'collection_view_page';
  const base = pageUrl(walk.ctx.workspace, own ? id : walk.ctx.rootId);
  return own || base === null ? (base ?? '#') : `${base}#${noDashes(id)}`;
}

/** Readable names for untitled blocks that are common in real pages; others show their type. */
const TYPE_LABELS: Readonly<Record<string, string>> = {
  collection_view: 'database',
  collection_view_page: 'database',
  video: 'video',
  embed: 'embed',
  file: 'file',
  pdf: 'PDF',
  equation: 'equation',
  synced_block: 'synced block',
  transclusion_container: 'synced block',
};

function unsupported(block: NotionBlock | undefined, id: string, walk: Walk): string {
  const title = block === undefined ? '' : plainTextOf(block);
  const label = title === '' ? (TYPE_LABELS[block?.type ?? ''] ?? block?.type ?? 'block') : title;
  const href = escapeHtml(notionLink(block, id, walk));
  return `<p class="unsupported"><a href="${href}" rel="noopener nofollow">Open in Notion: ${escapeHtml(label)}</a></p>\n`;
}

function unsupportedPage(ctx: BlockRenderCtx): string {
  const href = escapeHtml(pageUrl(ctx.workspace, ctx.rootId) ?? '#');
  return `<p class="unsupported"><a href="${href}" rel="noopener nofollow">Open in Notion: this page continues</a></p>\n`;
}

function children(block: NotionBlock, walk: Walk): string {
  return renderIds(block.content, {
    ...walk,
    path: new Set([...walk.path, block.id]),
    depth: walk.depth + 1,
  });
}

function nested(block: NotionBlock, walk: Walk): string {
  const inner = children(block, walk);
  return inner === '' ? '' : `<div class="in">\n${inner}</div>\n`;
}

/** `class="red tx"` / `class="red bg"` for a block Notion coloured; empty otherwise. */
function colourClasses(block: NotionBlock): string {
  const colour = parseColour(block.format.block_color);
  return colour === null ? '' : `${colour.name} ${colour.background ? 'bg' : 'tx'}`;
}

/** ` class="..."` joining the given names and the block's colour, or nothing. */
function classAttr(block: NotionBlock, ...names: string[]): string {
  const all = [...names, colourClasses(block)].filter((name) => name !== '');
  return all.length === 0 ? '' : ` class="${all.join(' ')}"`;
}

/** The block's own text as a paragraph; Notion callouts and quotes often keep their text in children only. */
function titleParagraph(block: NotionBlock, walk: Walk): string {
  const html = titleOf(block, walk);
  return html === '' ? '' : `<p>${html}</p>\n`;
}

const paragraph: Handler = (block, walk) => {
  const html = titleOf(block, walk);
  note(walk, plainTextOf(block));
  // An empty paragraph is a blank line in Notion and keeps its height here.
  const own = html === '' ? `<p class="e"></p>\n` : `<p${classAttr(block)}>${html}</p>\n`;
  return `${own}${nested(block, walk)}`;
};

const heading: Handler = (block, walk) => {
  const tag = HEADING_TAGS[block.type] ?? 'h2';
  note(walk, plainTextOf(block));
  const level = TOC_LEVELS[block.type];
  const plain = plainTextOf(block);
  if (level !== undefined && plain !== '') {
    walk.shared.headings.push({ level, id: noDashes(block.id), text: plain });
  }
  const head = `<${tag} id="${noDashes(block.id)}"${classAttr(block)}>${titleOf(block, walk)}</${tag}>\n`;
  if (block.content.length === 0) return head;
  // A heading that has children is a toggle heading in Notion.
  return `<details class="th">\n<summary>${head}</summary>\n${children(block, walk)}</details>\n`;
};

const listItem: Handler = (block, walk) => {
  const checked = block.type === 'to_do' && plainTextOf(block, 'checked') === 'Yes';
  const box =
    block.type === 'to_do' ? `<input type="checkbox" disabled${checked ? ' checked' : ''}> ` : '';
  note(walk, plainTextOf(block));
  return `<li${classAttr(block, checked ? 'done' : '')}>${box}${titleOf(block, walk)}${nested(block, walk)}</li>\n`;
};

const quote: Handler = (block, walk) => {
  note(walk, plainTextOf(block));
  return `<blockquote${classAttr(block)}>${titleParagraph(block, walk)}${children(block, walk)}</blockquote>\n`;
};

/** The icon when it is an emoji (not an uploaded or linked picture); null otherwise. */
export function emojiOfIcon(icon: string | undefined): string | null {
  const isEmoji =
    icon !== undefined &&
    icon !== '' &&
    icon.length <= 16 &&
    !/^(https?:|\/|attachment:)/.test(icon);
  return isEmoji ? icon : null;
}

function emojiIcon(block: NotionBlock): string {
  const emoji = emojiOfIcon(block.format.page_icon);
  return emoji === null ? '' : `<span class="ico" aria-hidden="true">${escapeHtml(emoji)}</span>`;
}

const callout: Handler = (block, walk) => {
  note(walk, plainTextOf(block));
  return `<aside${classAttr(block, 'callout')}>${emojiIcon(block)}<div>${titleParagraph(block, walk)}${children(block, walk)}</div></aside>\n`;
};

const code: Handler = (block, walk) => {
  const language = (plainTextOf(block, 'language') || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#-]/g, '');
  const cls = language === '' ? '' : ` class="language-${language}"`;
  const label = plainTextOf(block, 'language');
  const dataL = label === '' ? '' : ` data-l="${escapeHtml(label)}"`;
  const pre = `<pre${dataL}><code${cls}>${escapeHtml(plainTextOf(block))}</code></pre>`;
  const caption = renderRichText(textOf(block, 'caption'), richCtx(walk));
  return caption === ''
    ? `${pre}\n`
    : `<figure class="cb">${pre}<figcaption>${caption}</figcaption></figure>\n`;
};

const divider: Handler = () => '<hr>\n';

const toggle: Handler = (block, walk) => {
  note(walk, plainTextOf(block));
  return `<details${classAttr(block)}>\n<summary>${titleOf(block, walk)}</summary>\n${children(block, walk)}</details>\n`;
};

const bookmark: Handler = (block, walk) => {
  const href = safeHref(plainTextOf(block, 'link'), walk.ctx);
  if (href === null) return unsupported(block, block.id, walk);
  const title = plainTextOf(block) || href;
  const description = plainTextOf(block, 'description');
  const small =
    description === '' ? '' : `<span class="d">${escapeHtml(clipText(description, 300))}</span>`;
  return `<p class="bm"><a href="${escapeHtml(href)}" rel="noopener nofollow"><span class="t">${escapeHtml(clipText(title, 300))}</span>${small}<span class="u">${escapeHtml(clipText(href, 200))}</span></a></p>\n`;
};

const subPage: Handler = (block, walk) => {
  const href = escapeHtml(notionLink(block, block.id, walk));
  const icon = emojiIcon(block) || '<span class="ico" aria-hidden="true">📄</span>';
  return `<p class="pg"><a href="${href}" rel="noopener nofollow">${icon}<span class="t">${titleOf(block, walk) || 'Untitled'}</span></a></p>\n`;
};

function clipText(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

function imageSize(block: NotionBlock, walk: Walk): ImageSize {
  const { block_width: w, block_height: h, block_aspect_ratio: ratio } = block.format;
  if (w !== undefined && h !== undefined && w > 0 && h > 0) return { width: w, height: h };
  const sniffed = walk.ctx.imageSizes?.get(block.id);
  if (sniffed !== undefined) return sniffed;
  const width = 1280;
  // Unknown size: assume 16:9 unless Notion recorded a ratio (height / width).
  return { width, height: Math.round(width * (ratio !== undefined && ratio > 0 ? ratio : 9 / 16)) };
}

const image: Handler = (block, walk) => {
  const caption = renderRichText(textOf(block, 'caption'), richCtx(walk));
  const small = walk.ctx.imageUrl(block, IMAGE_WIDTHS[0]);
  if (small === null || imageSourceOf(block) === null) {
    const source = plainTextOf(block, 'source') || block.format.display_source || '';
    const href = safeHref(source, walk.ctx);
    if (href === null) return unsupported(block, block.id, walk);
    return `<p class="pg"><a href="${escapeHtml(href)}" rel="noopener nofollow">${caption || 'Image'}</a></p>\n`;
  }
  const large = walk.ctx.imageUrl(block, IMAGE_WIDTHS[1]) ?? small;
  const first = walk.shared.images++ === 0;
  if (first) walk.shared.firstImage = block.id;
  const { width, height } = imageSize(block, walk);
  const loading = first ? 'fetchpriority="high"' : 'loading="lazy" decoding="async"';
  const alt = escapeHtml(plainTextOf(block, 'caption'));
  const fig = caption === '' ? '' : `<figcaption>${caption}</figcaption>`;
  const align = block.format.block_alignment;
  const figClass = align === 'left' ? ' class="l"' : align === 'right' ? ' class="r"' : '';
  return `<figure${figClass}><img src="${escapeHtml(small)}" srcset="${escapeHtml(small)} ${IMAGE_WIDTHS[0]}w, ${escapeHtml(large)} ${IMAGE_WIDTHS[1]}w" sizes="(max-width:720px) 100vw,704px" width="${Math.round(width)}" height="${Math.round(height)}" alt="${alt}" ${loading}>${fig}</figure>\n`;
};

function tableCells(
  row: NotionBlock,
  columns: string[],
  walk: Walk,
  tag: 'th' | 'td',
  headerColumn: boolean,
): string {
  return columns
    .map((col, i) => {
      const cellTag = i === 0 && headerColumn ? 'th' : tag;
      return `<${cellTag}>${renderRichText(textOf(row, col), richCtx(walk))}</${cellTag}>`;
    })
    .join('');
}

/** Child blocks of `block` in order; an id the map lacks stays `undefined` so callers can link it. */
function childEntries(block: NotionBlock, walk: Walk): [string, NotionBlock | undefined][] {
  return block.content.map((id) => [id, walk.map.blocks.get(id)]);
}

/** Remaining block budget; consumed by `take`, so tables and columns cannot bypass the cap. */
function take(walk: Walk, wanted: number): number {
  const granted = Math.max(0, Math.min(wanted, MAX_BLOCKS - walk.shared.blocks));
  walk.shared.blocks += wanted;
  return granted;
}

const table: Handler = (block, walk) => {
  const columns = block.format.table_block_column_order ?? [];
  const entries = childEntries(block, walk);
  if (columns.length === 0 || entries.length === 0) return unsupported(block, block.id, walk);
  const shown = entries.slice(0, take(walk, entries.length));
  const hasHeader = block.format.table_block_column_header === true;
  const headerColumn = block.format.table_block_row_header === true;
  const line = ([id, row]: [string, NotionBlock | undefined], tag: 'th' | 'td'): string =>
    row?.type === 'table_row'
      ? `<tr>${tableCells(row, columns, walk, tag, headerColumn)}</tr>\n`
      : `<tr><td colspan="${columns.length}">${unsupported(row, id, walk).trim()}</td></tr>\n`;
  const [first, ...rest] = shown;
  const head = hasHeader && first !== undefined ? `<thead>${line(first, 'th')}</thead>\n` : '';
  const bodyRows = hasHeader ? rest : shown;
  return `<div class="tw"><table>\n${head}<tbody>\n${bodyRows.map((r) => line(r, 'td')).join('')}</tbody>\n</table></div>\n`;
};

const columnList: Handler = (block, walk) => {
  const entries = childEntries(block, walk);
  if (entries.length === 0) return unsupported(block, block.id, walk);
  const shown = entries.slice(0, take(walk, entries.length));
  const inner = shown
    .map(([id, col]) => {
      if (col?.type !== 'column') return `<div>\n${unsupported(col, id, walk)}</div>\n`;
      const ratio = col.format.column_ratio;
      const flex = ratio !== undefined && ratio > 0 ? ratio : 1 / entries.length;
      return `<div style="flex:${Number(flex.toFixed(4))}">\n${children(col, walk)}</div>\n`;
    })
    .join('');
  return `<div class="cols">\n${inner}</div>\n`;
};

const TOC_LEVELS: Readonly<Record<string, number>> = {
  header: 1,
  sub_header: 2,
  sub_sub_header: 3,
};

/** At most this many links per table of contents, and this many tables of contents per page. */
const TOC_MAX_LINKS = 200;
const TOC_MAX_TABLES = 3;
/** Stands where a table of contents goes until the whole page is rendered (escaped text cannot contain it). */
const TOC_MARK = '<!--toc-->';

/**
 * Table of contents: a marker now, links later. The links are built from the headings the body
 * actually rendered (so every link has a target and the render cutoffs apply), which are only
 * known once the walk is over; see `fillTocs`.
 */
const tableOfContents: Handler = () => `${TOC_MARK}\n`;

function tocNav(headings: readonly TocHeading[]): string {
  const links = headings
    .slice(0, TOC_MAX_LINKS)
    .map((h) => `<a class="l${h.level}" href="#${h.id}">${escapeHtml(h.text)}</a>`);
  return links.length === 0 ? '' : `<nav class="toc">${links.join('')}</nav>\n`;
}

/** Replaces the markers: the first few tables of contents get the links, further ones nothing. */
function fillTocs(html: string, headings: readonly TocHeading[]): string {
  if (!html.includes(TOC_MARK)) return html;
  const nav = tocNav(headings);
  let tables = 0;
  return html.replaceAll(`${TOC_MARK}\n`, () => (++tables <= TOC_MAX_TABLES ? nav : ''));
}

const HANDLERS: ReadonlyMap<string, Handler> = new Map<string, Handler>([
  ['text', paragraph],
  ['header', heading],
  ['sub_header', heading],
  ['sub_sub_header', heading],
  ['bulleted_list', listItem],
  ['numbered_list', listItem],
  ['to_do', listItem],
  ['quote', quote],
  ['callout', callout],
  ['code', code],
  ['divider', divider],
  ['toggle', toggle],
  ['bookmark', bookmark],
  ['image', image],
  ['table', table],
  ['column_list', columnList],
  ['page', subPage],
  ['table_of_contents', tableOfContents],
]);

function renderOne(id: string, walk: Walk): string {
  // Every block and every fallback link spends budget; past the cap the page ends with a note.
  if (++walk.shared.blocks > MAX_BLOCKS) return '';
  const block = walk.map.blocks.get(id);
  if (block === undefined || walk.path.has(id) || walk.depth > MAX_DEPTH) {
    return unsupported(block, id, walk);
  }
  const handler = HANDLERS.get(block.type);
  return handler === undefined ? unsupported(block, id, walk) : handler(block, walk);
}

function listOpen(tag: 'ul' | 'ol', first: NotionBlock, type: string): string {
  const start = first.format.list_start_index;
  if (type === 'to_do') return '<ul class="todo">';
  const startAttr = tag === 'ol' && start !== undefined && start > 1 ? ` start="${start}"` : '';
  return `<${tag}${startAttr}>`;
}

/** One list of consecutive same-type items starting at `start`; returns the html and the next index. */
function renderListRun(
  ids: string[],
  start: number,
  first: NotionBlock,
  tag: 'ul' | 'ol',
  walk: Walk,
): { html: string; next: number } {
  let items = '';
  let next = start;
  for (; next < ids.length; next++) {
    const sibling = walk.map.blocks.get(ids[next] ?? '');
    if (sibling?.type !== first.type || walk.shared.blocks > MAX_BLOCKS) break;
    items += renderOne(sibling.id, walk);
  }
  const html = items === '' ? '' : `${listOpen(tag, first, first.type)}\n${items}</${tag}>\n`;
  return { html, next };
}

/** Renders sibling blocks, grouping consecutive list items of one type into one list. */
function renderIds(ids: string[], walk: Walk): string {
  let html = '';
  let i = 0;
  // Past the budget no further siblings or list wrappers are emitted.
  while (i < ids.length && walk.shared.blocks <= MAX_BLOCKS) {
    const id = ids[i] ?? '';
    const block = walk.map.blocks.get(id);
    const tag = block === undefined ? undefined : LIST_TAGS[block.type];
    if (block === undefined || tag === undefined) {
      html += renderOne(id, walk);
      i++;
      continue;
    }
    const run = renderListRun(ids, i, block, tag, walk);
    html += run.html;
    i = run.next;
  }
  return html;
}

export function renderBlocks(map: RecordMap, ctx: BlockRenderCtx): RenderedBlocks {
  const root = map.blocks.get(ctx.rootId);
  const shared = {
    blocks: 0,
    images: 0,
    firstImage: null as string | null,
    text: '',
    headings: [] as TocHeading[],
  };
  const walk: Walk = { map, ctx, path: new Set([ctx.rootId]), depth: 0, shared };
  const body = root === undefined ? '' : renderIds(root.content, walk);
  const cut = shared.blocks > MAX_BLOCKS || map.incomplete === true;
  // A page too long to show in full says so, with a way to the rest.
  const html = fillTocs(cut ? `${body}${unsupportedPage(ctx)}` : body, shared.headings);
  return { html, firstImageBlockId: shared.firstImage, text: shared.text.trim() };
}
