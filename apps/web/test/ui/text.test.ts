/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { plainText, safeImageUrl, workspaceHint } from '../../lib/client/text';

describe('plainText (Notion titles are attacker-controlled)', () => {
  test('keeps markup as inert text, it is React that renders it escaped', () => {
    expect(plainText('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });

  test('strips bidi overrides, zero-width and control characters', () => {
    expect(plainText('a\u202Eb\u200Bc\u0000d\u2066e\uFEFF')).toBe('abcde');
  });

  test('collapses newlines and tabs to single spaces', () => {
    expect(plainText('a\n\n b\tc')).toBe('a b c');
  });

  test('keeps ZWJ emoji sequences intact', () => {
    expect(plainText('👩\u200D💻')).toBe('👩\u200D💻');
  });

  test('keeps Cyrillic, emoji and inner spaces', () => {
    expect(plainText('  Наши 🌍 пути ')).toBe('Наши 🌍 пути');
  });
});

describe('safeImageUrl', () => {
  test('accepts https only', () => {
    expect(safeImageUrl('https://img.notion.so/a.png?width=1200')).toBe(
      'https://img.notion.so/a.png?width=1200',
    );
  });

  test.each([
    'http://example.com/a.png',
    'javascript:alert(1)',
    'data:image/svg+xml;base64,AAAA',
    'https://user:pw@example.com/a.png',
    '//example.com/a.png',
    'not a url',
    '',
  ])('rejects %p', (value) => expect(safeImageUrl(value)).toBeNull());

  test('null stays null', () => expect(safeImageUrl(null)).toBeNull());
});

describe('workspaceHint', () => {
  test('extracts the workspace of a notion.site URL', () => {
    expect(workspaceHint(' https://THSM.notion.site/413d447ac4b180169985c93eea7f02f9 ')).toBe(
      'thsm',
    );
  });

  test.each([
    'https://www.notion.so/page',
    'https://notion.site/x',
    'ftp://a.notion.site/x',
    'thsm',
    '',
  ])('no hint for %p', (value) => expect(workspaceHint(value)).toBeNull());
});
