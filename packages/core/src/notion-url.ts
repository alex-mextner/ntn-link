/**
 * Notion URL parser (spec sections 2, 3, 7).
 *
 * Accepts every share-link form seen in the wild and reduces it to a page id plus an
 * optional workspace hint. The hint is only a hint: the authoritative workspace is the
 * host of the URL Notion redirects to (see fetcher.ts), because `/<ws>/<id>` paths on
 * notion.so name a workspace that may not have a public domain.
 *
 * Hosts are checked against an allowlist; nothing else is ever fetched (SSRF guard).
 */
import { ApiError } from './errors';
import { RESERVED_WORDS } from './slug';

/** Exact hosts that may be fetched for page metadata and data. */
const ALLOWED_EXACT_HOSTS: ReadonlySet<string> = new Set([
  'notion.so',
  'www.notion.so',
  'notion.site',
  'notion.com',
  'www.notion.com',
  'app.notion.com',
]);

const WORKSPACE_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PAGE_ID_AT_END = /([0-9a-f]{32})$/i;
const DASHED_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Subdomains of notion.site that are Notion infrastructure, not workspaces. */
const NON_WORKSPACE_SUBDOMAINS: ReadonlySet<string> = new Set(['www', 'app', 'api', 'help']);

export interface ParsedNotionUrl {
  /** 32 lowercase hex characters, no dashes. */
  pageId: string;
  /** Workspace name taken from the URL, when it names one. Unverified until fetched. */
  workspaceHint: string | null;
}

/** True when `host` may be fetched for page data (https only is enforced by callers). */
export function isAllowedNotionHost(host: string): boolean {
  const h = host.toLowerCase();
  if (ALLOWED_EXACT_HOSTS.has(h)) return true;
  return h.endsWith('.notion.site') && h.length > '.notion.site'.length;
}

/** `thsm` for `thsm.notion.site`, otherwise null (including `notion.site` itself). */
export function workspaceFromHost(host: string): string | null {
  const h = host.toLowerCase();
  if (!h.endsWith('.notion.site')) return null;
  const label = h.slice(0, -'.notion.site'.length);
  return isUsableWorkspace(label) ? label : null;
}

/** A workspace name that can be a namespace on our domain: a DNS label that is not reserved. */
export function isUsableWorkspace(ws: string): boolean {
  return WORKSPACE_LABEL.test(ws) && !RESERVED_WORDS.has(ws) && !NON_WORKSPACE_SUBDOMAINS.has(ws);
}

export function canonicalNotionUrl(workspace: string, pageId: string): string {
  return `https://${workspace}.notion.site/${pageId}`;
}

/** `413d447a-c4b1-8016-9985-c93eea7f02f9` form used by Notion's internal API. */
export function toDashedUuid(pageId: string): string {
  return [
    pageId.slice(0, 8),
    pageId.slice(8, 12),
    pageId.slice(12, 16),
    pageId.slice(16, 20),
    pageId.slice(20),
  ].join('-');
}

function pageIdFromSegment(segment: string): string | null {
  if (DASHED_UUID.test(segment)) return segment.replaceAll('-', '').toLowerCase();
  // `Our-Trips-<id>` and bare `<id>`; the id is always the trailing 32 hex characters.
  const match = PAGE_ID_AT_END.exec(segment);
  if (!match?.[1]) return null;
  const before = segment.slice(0, match.index);
  // `Trips-<id>` is fine; `abc<id>` would mean the 32 hex run is part of a longer word.
  if (before !== '' && !before.endsWith('-')) return null;
  return match[1].toLowerCase();
}

/** Parses the input as a plain https(s) URL on an allowed Notion host. */
function parseNotionHostUrl(input: string): URL {
  const raw = input.trim();
  if (raw === '' || raw.length > 2048) {
    throw new ApiError('not_notion_url', 'Paste a link to a public Notion page.');
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ApiError('not_notion_url', 'That does not look like a URL.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ApiError('not_notion_url', 'Only https links to Notion pages are supported.');
  }
  if (url.username !== '' || url.password !== '' || url.port !== '') {
    throw new ApiError('not_notion_url', 'That is not a plain Notion page link.');
  }
  if (!isAllowedNotionHost(url.hostname)) {
    throw new ApiError('not_notion_url', 'That is not a Notion link (notion.so, notion.site).');
  }
  return url;
}

function decodedPathSegments(url: URL): string[] {
  return url.pathname
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

function workspaceHintFor(host: string, segments: readonly string[]): string | null {
  const hostWorkspace = workspaceFromHost(host);
  if (host.endsWith('.notion.site') && hostWorkspace === null) {
    throw new ApiError(
      'unsupported_workspace',
      `"${host.slice(0, -'.notion.site'.length)}" cannot be used as a workspace name.`,
    );
  }
  if (hostWorkspace !== null) return hostWorkspace;
  // notion.so/<ws>/<id>, notion.so/p/<ws>/<id>, app.notion.com/p/<ws>/<id>
  const path = segments.slice(0, -1);
  if (path[0] === 'p') path.shift();
  const candidate = path.at(-1)?.toLowerCase();
  return candidate !== undefined && path.length === 1 && isUsableWorkspace(candidate)
    ? candidate
    : null;
}

export function parseNotionUrl(input: string): ParsedNotionUrl {
  const url = parseNotionHostUrl(input);
  const segments = decodedPathSegments(url);
  const last = segments.at(-1);
  const pageId = last === undefined ? null : pageIdFromSegment(last);
  if (pageId === null) {
    throw new ApiError('not_notion_url', 'No Notion page id found in that link.');
  }
  return { pageId, workspaceHint: workspaceHintFor(url.hostname.toLowerCase(), segments) };
}
