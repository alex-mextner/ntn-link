/**
 * Minimal client for the ntn-link JSON API (contract: packages/core/src/api-types.ts).
 * Only the fields the extension reads are validated; everything else is ignored.
 */
export type ApiResult =
  | { ok: true; body: unknown }
  | { ok: false; status: number; code: string | null; message: string }
  | { ok: false; status: 0; code: null; message: string };

export interface ApiCall {
  origin: string;
  fetch: typeof fetch;
  path: string;
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  /** Sent as `Authorization: Bearer`, never in a body or URL. */
  ownerKey?: string;
  signal?: AbortSignal;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export async function callApi(call: ApiCall): Promise<ApiResult> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (call.body !== undefined) headers['content-type'] = 'application/json';
  if (call.ownerKey !== undefined) headers.authorization = `Bearer ${call.ownerKey}`;
  let res: Response;
  try {
    res = await call.fetch(`${call.origin}${call.path}`, {
      method: call.method ?? 'GET',
      headers,
      // The API is key-authenticated; ambient cookies must never ride along.
      credentials: 'omit',
      ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
      ...(call.signal ? { signal: call.signal } : {}),
    });
  } catch {
    return { ok: false, status: 0, code: null, message: 'Could not reach ntn-link.' };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // Non-JSON body: handled by the status below.
  }
  if (res.ok) return { ok: true, body: json };
  const error = isRecord(json) ? json.error : undefined;
  const message =
    isRecord(error) && typeof error.message === 'string'
      ? error.message
      : `ntn-link answered HTTP ${res.status}.`;
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : null;
  return { ok: false, status: res.status, code, message };
}

/** The subset of the API's LinkView the extension relies on. */
export interface LinkSummary {
  workspace: string;
  slug: string;
  pageId: string;
  redirectUrl: string;
  fastUrl: string | null;
}

export function parseLinkView(v: unknown): LinkSummary | null {
  if (!isRecord(v)) return null;
  const { pageId, slug, workspace, redirectUrl, fastUrl } = v;
  if (
    typeof pageId !== 'string' ||
    typeof slug !== 'string' ||
    typeof workspace !== 'string' ||
    typeof redirectUrl !== 'string' ||
    !(typeof fastUrl === 'string' || fastUrl === null)
  ) {
    return null;
  }
  return { pageId, slug, workspace, redirectUrl, fastUrl };
}
