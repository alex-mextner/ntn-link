/**
 * The beginning of a page as plain text lines, for the generated card of a page that has no
 * cover (the card shows the title and these lines large instead of a generic Notion banner).
 *
 * Only text-bearing blocks count, in reading order: paragraphs, headings, list items, to-dos,
 * quotes, callouts, toggle titles and the titles of sub-pages (the whole content of a hub page);
 * columns are read left to right. Pictures, dividers and inline databases carry no text and are
 * skipped. The result is bounded, so it is safe to put into an API response.
 */
import { plainTextOf, type NotionBlock, type RecordMap } from './records';

export const EXCERPT_LIMITS = { maxLines: 8, maxLineChars: 140, maxTotalChars: 700 } as const;

const MENTION_PLACEHOLDER = '‣';
const TEXT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'header',
  'sub_header',
  'sub_sub_header',
  'bulleted_list',
  'numbered_list',
  'to_do',
  'quote',
  'callout',
  'toggle',
  'page',
  'collection_view_page',
]);
const FLATTENED_TYPES: ReadonlySet<string> = new Set(['column_list', 'column']);

const MARKERS: Readonly<Record<string, string>> = { bulleted_list: '• ', to_do: '• ' };

function lineOf(block: NotionBlock, number: number): string {
  const text = plainTextOf(block).replaceAll(MENTION_PLACEHOLDER, '').replace(/\s+/gu, ' ').trim();
  if (text === '') return '';
  const clipped = [...text].slice(0, EXCERPT_LIMITS.maxLineChars).join('');
  const marker = block.type === 'numbered_list' ? `${number}. ` : (MARKERS[block.type] ?? '');
  return `${marker}${clipped}`;
}

interface Collected {
  lines: string[];
  total: number;
  /** Position of the current item within a run of numbered list items. */
  number: number;
}

const isFull = (out: Collected): boolean =>
  out.lines.length >= EXCERPT_LIMITS.maxLines || out.total >= EXCERPT_LIMITS.maxTotalChars;

function take(block: NotionBlock, out: Collected): void {
  if (!TEXT_TYPES.has(block.type)) return;
  const line = lineOf(block, out.number);
  if (line === '') return;
  out.lines.push(line);
  out.total += line.length;
}

function collect(map: RecordMap, ids: readonly string[], depth: number, out: Collected): void {
  for (const id of ids) {
    if (isFull(out)) return;
    const block = map.blocks.get(id);
    if (block === undefined) continue;
    out.number = block.type === 'numbered_list' ? out.number + 1 : 0;
    if (FLATTENED_TYPES.has(block.type) && depth < 3) collect(map, block.content, depth + 1, out);
    take(block, out);
  }
}

export function cardExcerpt(map: RecordMap, rootId: string): string[] {
  const out: Collected = { lines: [], total: 0, number: 0 };
  collect(map, map.blocks.get(rootId)?.content ?? [], 0, out);
  return out.lines;
}
