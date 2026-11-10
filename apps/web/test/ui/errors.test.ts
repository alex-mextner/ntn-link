/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { ERROR_CODES } from '../../../../packages/core/src/api-types';
import { ApiCallError, describeError, errorFromBody } from '../../lib/client/errors';

describe('error mapping', () => {
  test('every typed code of the contract has a Russian message', () => {
    for (const code of ERROR_CODES) {
      const message = describeError(new ApiCallError(code, 400));
      expect(message).toMatch(/[А-Яа-яЁё]/);
    }
  });

  test('uses our message, never the server English text', () => {
    const error = errorFromBody(422, {
      error: { code: 'not_public', message: 'Page is not public <script>' },
    });
    expect(error.code).toBe('not_public');
    expect(describeError(error)).not.toContain('script');
    expect(describeError(error)).not.toContain('Page is not public');
  });

  test('carries the challenge action of needs_verification', () => {
    const error = errorFromBody(403, {
      error: { code: 'needs_verification', message: 'x', action: 'rotate' },
    });
    expect(error.action).toBe('rotate');
    expect(
      errorFromBody(403, { error: { code: 'needs_verification', message: 'x', action: 'evil' } })
        .action,
    ).toBeUndefined();
  });

  test('rate limit mentions the wait time', () => {
    const error = errorFromBody(429, {
      error: { code: 'rate_limited', message: 'x', retryAfterSeconds: 12.2 },
    });
    expect(describeError(error)).toContain('13');
  });

  test.each([
    null,
    undefined,
    'oops',
    { error: { code: 'made_up', message: 'x' } },
    { error: { code: '__proto__' } },
  ])('unknown body %p becomes a generic error', (body) => {
    const error = errorFromBody(500, body);
    expect(error.code).toBe('unexpected');
    expect(describeError(error)).toMatch(/[А-Яа-я]/);
  });

  test('network failures and foreign exceptions are human too', () => {
    expect(describeError(new ApiCallError('network', 0))).toContain('связи');
    expect(describeError(new TypeError('boom'))).toMatch(/[А-Яа-я]/);
  });
});
