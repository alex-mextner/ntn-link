/**
 * Thin typed client for the ntn-link HTTP contract (packages/core/src/api-types.ts).
 * Only types are imported from core, so nothing from it ends up in the bundle.
 * Every request/response is written to the run log; secrets are kept out by
 * construction (the owner key only travels in the Authorization header, which is not logged).
 */
import type {
  ApiErrorBody,
  ChallengeAction,
  ChallengeResponse,
  CreateLinkRequest,
  CreateLinkResponse,
  DeleteLinkResponse,
  ErrorCode,
  LinkView,
  ListLinksResponse,
  PreviewResponse,
  SweepLinksResponse,
  UpdateLinkRequest,
  UpdateLinkResponse,
  VerifyResponse,
} from '../../core/src/api-types';
import { plainText } from './errors';
import type { RunLog } from './log';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class ApiFailure extends Error {
  constructor(
    readonly code: ErrorCode | 'http_error',
    message: string,
    readonly status: number,
    readonly action?: ChallengeAction,
    readonly retryAfterSeconds?: number,
  ) {
    super(plainText(message));
  }
}

export class NetworkFailure extends Error {}

export interface Timeouts {
  default: number;
  /** /api/verify on a rotation re-fetches every link of the namespace before it answers. */
  verify: number;
  /** /api/ns/<ws>/sweep re-checks every link of the namespace too. */
  sweep: number;
}

export const DEFAULT_TIMEOUTS: Timeouts = { default: 30_000, verify: 180_000, sweep: 180_000 };

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const error = (value as { error: unknown }).error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

export interface Api {
  preview(url: string): Promise<PreviewResponse>;
  challenge(url: string, action: ChallengeAction): Promise<ChallengeResponse>;
  verify(url: string, nonce: string, claimToken: string): Promise<VerifyResponse>;
  createLink(body: CreateLinkRequest, key: string | null): Promise<CreateLinkResponse>;
  updateLink(
    target: string,
    body: UpdateLinkRequest,
    key: string | null,
  ): Promise<UpdateLinkResponse>;
  deleteLink(target: string, key: string | null): Promise<DeleteLinkResponse>;
  listLinks(ws: string, key: string | null): Promise<ListLinksResponse>;
  sweepLinks(ws: string, key: string | null): Promise<SweepLinksResponse>;
}

const SECRET_FIELDS = new Set(['ownerKey', 'claimToken']);

/**
 * A response that does not parse is not logged when it was a success: a truncated body could
 * hold half a credential that pattern-based redaction cannot recognise. Parsed bodies are
 * redacted by field name.
 */
function logResponse(
  log: RunLog,
  status: number,
  ok: boolean,
  text: string,
  parsed: unknown,
): void {
  if (parsed !== undefined) {
    const safe = JSON.stringify(parsed, (key, value: unknown) =>
      SECRET_FIELDS.has(key) ? '[redacted]' : value,
    );
    log.write(`< ${status} ${safe}`);
  } else if (!ok) log.write(`< ${status} ${text}`);
  else
    log.write(
      `< ${status} (success response that is not valid JSON, ${text.length} bytes, body omitted)`,
    );
}

type Rec = Record<string, unknown>;

const isRec = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isStr = (value: unknown): value is string => typeof value === 'string';

/**
 * Responses are checked before anything is printed or persisted: a misbehaving origin must not be
 * able to put wrong types into the key file or onto stdout. Only the fields the CLI uses are checked.
 */
const isPreview = (v: unknown): v is PreviewResponse =>
  isRec(v) &&
  isStr(v['workspace']) &&
  isStr(v['pageId']) &&
  isRec(v['card']) &&
  isStr(v['card']['title']);

const isChallenge = (v: unknown): v is ChallengeResponse =>
  isRec(v) &&
  isStr(v['workspace']) &&
  isStr(v['nonce']) &&
  isStr(v['claimToken']) &&
  isStr(v['expiresAt']) &&
  (v['action'] === 'claim' || v['action'] === 'rotate');

const isVerify = (v: unknown): v is VerifyResponse =>
  isRec(v) &&
  isStr(v['workspace']) &&
  isStr(v['ownerKey']) &&
  isStr(v['ownerKey']) &&
  /^[!-~]+$/.test(v['ownerKey']) &&
  (v['action'] === 'claim' || v['action'] === 'rotate') &&
  typeof v['removedLinks'] === 'number' &&
  typeof v['cleanupComplete'] === 'boolean';

const isLink = (v: unknown): v is LinkView =>
  isRec(v) &&
  isStr(v['workspace']) &&
  isStr(v['slug']) &&
  isStr(v['redirectUrl']) &&
  (v['fastUrl'] === null || isStr(v['fastUrl'])) &&
  isRec(v['card']) &&
  isStr(v['card']['title']);

const isLinkEnvelope = (v: unknown): v is { link: LinkView } => isRec(v) && isLink(v['link']);
const isLinkList = (v: unknown): v is ListLinksResponse =>
  isRec(v) && Array.isArray(v['links']) && v['links'].every(isLink);
const isSweep = (v: unknown): v is SweepLinksResponse =>
  isRec(v) &&
  isStr(v['workspace']) &&
  typeof v['removedLinks'] === 'number' &&
  typeof v['cleanupComplete'] === 'boolean';
const isDeleted = (v: unknown): v is DeleteLinkResponse => isRec(v) && v['deleted'] === true;

const encodePath = (target: string): string => target.split('/').map(encodeURIComponent).join('/');

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Turns a finished HTTP exchange into a typed value, or throws the matching ApiFailure. */
function interpret<T>(
  log: RunLog,
  status: number,
  ok: boolean,
  text: string,
  guard: (value: unknown) => value is T,
): T {
  const parsed = parseJson(text);
  logResponse(log, status, ok, text, parsed);
  if (!ok) {
    if (!isErrorBody(parsed)) {
      throw new ApiFailure(
        'http_error',
        `The server answered HTTP ${status} without an error message.`,
        status,
      );
    }
    const { code, message, action, retryAfterSeconds } = parsed.error;
    const wait = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined;
    throw new ApiFailure(code, message, status, action, wait);
  }
  if (parsed === undefined) {
    throw new ApiFailure(
      'http_error',
      'The server answered with something that is not JSON.',
      status,
    );
  }
  if (!guard(parsed)) {
    throw new ApiFailure(
      'http_error',
      'The server answered with an unexpected response shape.',
      status,
    );
  }
  return parsed;
}

export function createApi(
  origin: string,
  fetchImpl: FetchFn,
  log: RunLog,
  version: string,
  timeouts: Timeouts = DEFAULT_TIMEOUTS,
): Api {
  async function call<T>(
    method: string,
    path: string,
    body: unknown,
    key: string | null | undefined,
    guard: (value: unknown) => value is T,
    timeoutMs: number = timeouts.default,
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': `ntn-link-cli/${version}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (key) headers['authorization'] = `Bearer ${key}`;
    log.write(
      `> ${method} ${path}${body === undefined ? '' : ` ${JSON.stringify(body)}`}${key ? ' (with owner key)' : ''}`,
    );
    let status: number;
    let ok: boolean;
    let text: string;
    try {
      const response = await fetchImpl(`${origin}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Reading the body can fail too (reset, timeout after the headers arrived): same class of error.
      text = await response.text();
      ({ status, ok } = response);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.write(`! network error: ${reason}`);
      throw new NetworkFailure(`cannot reach ${origin}: ${reason}`);
    }
    return interpret(log, status, ok, text, guard);
  }

  return {
    preview: (url) => call('POST', '/api/preview', { url }, undefined, isPreview),
    challenge: (url, action) =>
      call('POST', '/api/challenge', { url, action }, undefined, isChallenge),
    verify: (url, nonce, claimToken) =>
      call('POST', '/api/verify', { url, nonce, claimToken }, undefined, isVerify, timeouts.verify),
    createLink: (body, key) => call('POST', '/api/links', body, key, isLinkEnvelope),
    updateLink: (target, body, key) =>
      call('PATCH', `/api/links/${encodePath(target)}`, body, key, isLinkEnvelope),
    deleteLink: (target, key) =>
      call('DELETE', `/api/links/${encodePath(target)}`, undefined, key, isDeleted),
    listLinks: (ws, key) =>
      call('GET', `/api/ns/${encodeURIComponent(ws)}/links`, undefined, key, isLinkList),
    sweepLinks: (ws, key) =>
      call(
        'POST',
        `/api/ns/${encodeURIComponent(ws)}/sweep`,
        undefined,
        key,
        isSweep,
        timeouts.sweep,
      ),
  };
}
