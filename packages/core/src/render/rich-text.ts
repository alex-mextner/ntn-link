/**
 * Notion rich text to HTML. Every character of Notion text goes through `escapeHtml`, and
 * links are restricted to http(s)/mailto, so no Notion content can produce markup or script.
 */
import { escapeHtml } from '../og-html';
import type { Decoration, RichTextSegment } from './records';

export { escapeHtml };

export interface RichTextContext {
  workspace: string;
  /** Title of a mentioned page that is part of the loaded page; mentions otherwise read "Page". */
  pageTitle?: (pageId: string) => string | undefined;
}

const MENTION_PLACEHOLDER = '‣';
const PLAIN_ID = /^[0-9a-f]{32}$/;

/** Absolute http(s)/mailto URL, or a Notion-relative `/<id>` made absolute; everything else is null. */
export function safeHref(href: string, ctx: { workspace: string }): string | null {
  const relative = href.startsWith('/') && !href.startsWith('//');
  let url: URL;
  try {
    url = relative ? new URL(href, `https://${ctx.workspace}.notion.site`) : new URL(href);
  } catch {
    return null;
  }
  if (relative) return url.href;
  const allowed =
    url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:';
  return allowed ? url.href : null;
}

export function pageUrl(workspace: string, id: string): string | null {
  const plain = id.replaceAll('-', '').toLowerCase();
  return PLAIN_ID.test(plain) ? `https://${workspace}.notion.site/${plain}` : null;
}

function firstString(deco: Decoration): string | undefined {
  const value = deco[1];
  return typeof value === 'string' ? value : undefined;
}

function dateText(deco: Decoration): string | undefined {
  const value = deco[1];
  if (typeof value !== 'object' || value === null || !('start_date' in value)) return undefined;
  return typeof value.start_date === 'string' ? value.start_date : undefined;
}

function link(href: string, inner: string): string {
  return `<a href="${escapeHtml(href)}" rel="noopener nofollow">${inner}</a>`;
}

/** Replacement text for decorations that stand for something other than their own text. */
function substitution(deco: Decoration, text: string, ctx: RichTextContext): string | undefined {
  const arg = firstString(deco);
  const isMention = text === MENTION_PLACEHOLDER;
  switch (deco[0]) {
    case 'e':
      return `<span class="eq">${escapeHtml(arg ?? text)}</span>`;
    case 'd':
      return escapeHtml(dateText(deco) ?? text);
    case 'u':
      return isMention ? '@user' : undefined;
    case 'p': {
      if (!isMention) return undefined;
      return escapeHtml((arg === undefined ? undefined : ctx.pageTitle?.(arg)) ?? 'Page');
    }
    default:
      return undefined;
  }
}

/** The visible text of a segment after mention/date/equation substitution. */
function segmentInner(text: string, decorations: Decoration[], ctx: RichTextContext): string {
  for (const deco of decorations) {
    const replaced = substitution(deco, text, ctx);
    if (replaced !== undefined) return replaced;
  }
  // Notion keeps soft line breaks as \n inside one paragraph; HTML would collapse them.
  return escapeHtml(text).replaceAll('\n', '<br>');
}

/** Links come from `a` decorations and from page mentions. */
function hrefOf(decorations: Decoration[], ctx: RichTextContext): string | null {
  for (const deco of decorations) {
    const value = firstString(deco);
    if (value === undefined) continue;
    if (deco[0] === 'a') return safeHref(value, ctx);
    if (deco[0] === 'p') return pageUrl(ctx.workspace, value);
  }
  return null;
}

const WRAPPERS: ReadonlyArray<readonly [kind: string, tag: string]> = [
  ['b', 'strong'],
  ['i', 'em'],
  ['s', 's'],
  ['_', 'u'],
  ['c', 'code'],
];

const COLOURS: ReadonlySet<string> = new Set([
  'gray',
  'brown',
  'orange',
  'yellow',
  'teal',
  'blue',
  'purple',
  'pink',
  'red',
]);

/** A Notion colour value (`red`, `red_background`) as its name and whether it fills the background. */
export function parseColour(value: unknown): { name: string; background: boolean } | null {
  if (typeof value !== 'string') return null;
  const background = value.endsWith('_background');
  const name = background ? value.slice(0, -'_background'.length) : value;
  return COLOURS.has(name) ? { name, background } : null;
}

function renderSegment(segment: RichTextSegment, ctx: RichTextContext): string {
  const [text, decorations = []] = segment;
  let html = segmentInner(text, decorations, ctx);
  // Fixed nesting order (outermost last) so equal formatting gives equal markup.
  // Colours are a fixed set of class names (never Notion's text), styled in css.ts.
  const colour = parseColour(decorations.find((d) => d[0] === 'h')?.[1]);
  if (colour !== null) {
    html = colour.background
      ? `<mark class="${colour.name}">${html}</mark>`
      : `<span class="${colour.name} tx">${html}</span>`;
  }
  for (const [kind, tag] of WRAPPERS.toReversed()) {
    if (decorations.some((d) => d[0] === kind)) html = `<${tag}>${html}</${tag}>`;
  }
  const href = hrefOf(decorations, ctx);
  return href === null ? html : link(href, html);
}

export function renderRichText(
  segments: RichTextSegment[] | undefined,
  ctx: RichTextContext,
): string {
  return (segments ?? []).map((s) => renderSegment(s, ctx)).join('');
}
