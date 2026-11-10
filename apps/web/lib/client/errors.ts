import type { ApiErrorBody, ErrorCode } from '../../../../packages/core/src/api-types';
import { ru } from './strings';

/** Human (Russian) messages for every typed API error. `Record<ErrorCode, ...>` keeps this exhaustive. */
const MESSAGES: Record<ErrorCode, string> = ru.errors;

export class ApiCallError extends Error {
  readonly code: ErrorCode | 'network' | 'unexpected';
  readonly status: number;
  readonly action: 'claim' | 'rotate' | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ApiCallError['code'],
    status: number,
    extra: { action?: 'claim' | 'rotate'; retryAfterSeconds?: number } = {},
  ) {
    super(code);
    this.name = 'ApiCallError';
    this.code = code;
    this.status = status;
    this.action = extra.action;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(MESSAGES, value);
}

/** Builds an ApiCallError from a failed response body; never trusts the server's English text. */
export function errorFromBody(status: number, body: unknown): ApiCallError {
  const raw = (body as Partial<ApiErrorBody> | null)?.error;
  if (raw && isErrorCode(raw.code)) {
    const action = raw.action === 'claim' || raw.action === 'rotate' ? raw.action : undefined;
    const retry =
      typeof raw.retryAfterSeconds === 'number' && Number.isFinite(raw.retryAfterSeconds)
        ? Math.max(1, Math.ceil(raw.retryAfterSeconds))
        : undefined;
    return new ApiCallError(raw.code, status, { action, retryAfterSeconds: retry });
  }
  return new ApiCallError('unexpected', status);
}

export function describeError(error: unknown): string {
  if (!(error instanceof ApiCallError)) return ru.errorsExtra.unexpected;
  if (error.code === 'network') return ru.errorsExtra.network;
  if (error.code === 'unexpected') return ru.errorsExtra.unexpected;
  if (error.code === 'rate_limited' && error.retryAfterSeconds !== undefined) {
    return ru.errorsExtra.rateLimitedAfter(error.retryAfterSeconds);
  }
  return MESSAGES[error.code];
}
