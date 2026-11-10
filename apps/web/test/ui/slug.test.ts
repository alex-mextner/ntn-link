/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { API_LIMITS as CORE_LIMITS } from '../../../../packages/core/src/api-types';
import {
  RESERVED_WORDS,
  checkSlug as coreCheckSlug,
  slugify,
} from '../../../../packages/core/src/slug';
import { API_LIMITS } from '../../lib/client/limits';
import { RESERVED_SLUGS, checkSlug } from '../../lib/client/slug';

describe('slug validation', () => {
  test('accepts plain slugs and rejects the empty string distinctly', () => {
    expect(checkSlug('my-page-2')).toBe('ok');
    expect(checkSlug('')).toBe('empty');
  });

  test.each(['Upper', 'a_b', 'a--b', '-a', 'a-', 'пример', 'a b', 'a/b', 'a.b', 'a'.repeat(65)])(
    'rejects %p as invalid',
    (slug) => expect(checkSlug(slug)).toBe('invalid'),
  );

  test('accepts the maximum length', () => {
    expect(checkSlug('a'.repeat(64))).toBe('ok');
  });

  test.each(['api', 'read', 'admin', 'img'])('reserved word %p', (slug) => {
    expect(checkSlug(slug)).toBe('reserved');
  });

  test('agrees with the server checkSlug on a broad corpus (drift guard)', () => {
    const corpus = [
      ...RESERVED_WORDS,
      ...RESERVED_SLUGS,
      'ok',
      'a-b-c',
      'A',
      'a_b',
      '',
      '-',
      '--',
      'a'.repeat(64),
      'a'.repeat(65),
      '0',
      '0-0',
      slugify('Наши с Леночкой Путешествия'),
    ];
    for (const slug of corpus) {
      const server = coreCheckSlug(slug);
      const client = checkSlug(slug);
      expect({ slug, client }).toEqual({ slug, client: slug === '' ? 'empty' : server });
    }
  });

  test('reserved list and limits match core exactly', () => {
    expect([...RESERVED_SLUGS].toSorted()).toEqual([...RESERVED_WORDS].toSorted());
    expect(API_LIMITS).toEqual(CORE_LIMITS);
  });
});
