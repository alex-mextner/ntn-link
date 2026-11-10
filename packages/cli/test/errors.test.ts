import { expect, test } from 'bun:test';
import { EXIT, exitCodeFor } from '../src/errors';

test('known codes map to their exit codes', () => {
  expect(exitCodeFor('slug_taken')).toBe(EXIT.slug);
  expect(exitCodeFor('unauthorized')).toBe(EXIT.unauthorized);
  expect(exitCodeFor('rate_limited')).toBe(EXIT.rateLimited);
  expect(exitCodeFor('http_error')).toBe(EXIT.failure);
});

test('a code that names an Object.prototype member is just an unknown code (exit 1)', () => {
  for (const code of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    expect(exitCodeFor(code)).toBe(EXIT.failure);
  }
});

test('an unknown code is exit 1', () => {
  expect(exitCodeFor('something_new')).toBe(EXIT.failure);
  expect(exitCodeFor('')).toBe(EXIT.failure);
});
