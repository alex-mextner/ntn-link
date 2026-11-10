/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { plainText, safeIcon, safeImageUrl, workspaceHint } from '../../lib/client/text';

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

describe('safeIcon', () => {
  test('an emoji stays text, so the viewer’s own emoji font draws it', () => {
    expect(safeIcon({ kind: 'emoji', emoji: '🤿' })).toEqual({ kind: 'emoji', text: '🤿' });
    expect(safeIcon({ kind: 'emoji', emoji: '👩\u200D💻' })).toEqual({
      kind: 'emoji',
      text: '👩\u200D💻',
    });
  });

  test('an empty or oversized emoji string is not drawn', () => {
    expect(safeIcon({ kind: 'emoji', emoji: '' })).toBeNull();
    expect(safeIcon({ kind: 'emoji', emoji: '🤿'.repeat(30) })).toBeNull();
  });

  test('a PNG or JPEG data URI passes, anything else a manipulated response could carry does not', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(safeIcon({ kind: 'image', dataUri: png })).toEqual({ kind: 'image', src: png });
    expect(
      safeIcon({ kind: 'image', dataUri: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' }),
    ).not.toBeNull();
    for (const dataUri of [
      'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+',
      'data:text/html;base64,PHNjcmlwdD4=',
      'https://evil.example/x.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA" onerror="alert(1)',
      `data:image/png;base64,${'A'.repeat(300_000)}`,
    ]) {
      expect(safeIcon({ kind: 'image', dataUri })).toBeNull();
    }
  });

  test('no icon, no picture', () => expect(safeIcon(null)).toBeNull());
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
