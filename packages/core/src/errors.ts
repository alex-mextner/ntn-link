/**
 * Typed error thrown by every core operation; the web layer maps it to the
 * `{error:{code,message}}` envelope from api-types.ts without further interpretation.
 */
import { ERROR_STATUS, type ApiErrorBody, type ChallengeAction, type ErrorCode } from './api-types';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly action: ChallengeAction | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    extra: { action?: ChallengeAction; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.action = extra.action;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }

  toBody(): ApiErrorBody {
    const error: ApiErrorBody['error'] = { code: this.code, message: this.message };
    if (this.action) error.action = this.action;
    if (this.retryAfterSeconds !== undefined) error.retryAfterSeconds = this.retryAfterSeconds;
    return { error };
  }
}
