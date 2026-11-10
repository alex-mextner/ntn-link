import { describe, expect, test } from 'bun:test';
import { checkSlug, slugCandidate, slugify } from '../src/slug';

describe('slugify', () => {
  test('transliterates the owner test page title', () => {
    expect(slugify('Наши с Леночкой Путешествия')).toBe('nashi-s-lenochkoy-puteshestviya');
  });

  test('handles soft/hard signs, yo, and multi-letter mappings', () => {
    expect(slugify('Подъезд 5, Ёлка & Щука')).toBe('podezd-5-elka-schuka');
  });

  test('strips accents, punctuation and emoji; collapses separators', () => {
    expect(slugify('  Café — Résumé!!  🚀 v2 ')).toBe('cafe-resume-v2');
  });

  test('falls back when nothing usable remains', () => {
    expect(slugify('🚀🚀')).toBe('page');
    expect(slugify('')).toBe('page');
  });

  test('never yields a reserved word', () => {
    expect(slugify('About')).toBe('about-page');
    expect(slugify('Read')).toBe('read-page');
  });

  test('is cut at 64 chars without a trailing hyphen', () => {
    const slug = slugify('слово '.repeat(30));
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith('-')).toBe(false);
    expect(checkSlug(slug)).toBe('ok');
  });
});

describe('checkSlug', () => {
  test.each(['a', 'our-trips', 'a1-b2', 'x'.repeat(64)])('accepts %s', (s) => {
    expect(checkSlug(s)).toBe('ok');
  });
  test.each(['', 'Upper', 'a_b', '-a', 'a-', 'a--b', 'пример', 'a/b', 'a b', 'x'.repeat(65)])(
    'rejects %j as invalid',
    (s) => {
      expect(checkSlug(s)).toBe('invalid');
    },
  );
  test.each(['api', 'og', 'img', 'new', 'about', 'read'])('reserves %s', (s) => {
    expect(checkSlug(s)).toBe('reserved');
  });
  test('rejects _next (underscore is not a slug character)', () => {
    expect(checkSlug('_next')).toBe('invalid');
  });
});

describe('slugCandidate', () => {
  test('appends a counter and respects the length limit', () => {
    expect(slugCandidate('trips', 1)).toBe('trips');
    expect(slugCandidate('trips', 3)).toBe('trips-3');
    const long = 'a'.repeat(64);
    expect(slugCandidate(long, 12)).toHaveLength(64);
    expect(slugCandidate(long, 12).endsWith('-12')).toBe(true);
  });
});
