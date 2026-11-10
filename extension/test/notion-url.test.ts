import { describe, expect, test } from 'bun:test';
import { classifyPageUrl } from '../src/notion-url';

describe('classifyPageUrl', () => {
  test('app.notion.com/p/<ws>/<id> with copy_link query', () => {
    expect(
      classifyPageUrl(
        'https://app.notion.com/p/thsm/413d447ac4b180169985c93eea7f02f9?source=copy_link',
      ),
    ).toEqual({
      workspace: 'thsm',
      pageId: '413d447ac4b180169985c93eea7f02f9',
      canonical: 'https://thsm.notion.site/413d447ac4b180169985c93eea7f02f9',
    });
  });

  test('slugged notion.site URL', () => {
    expect(
      classifyPageUrl('https://thsm.notion.site/Our-Trips-413d447ac4b180169985c93eea7f02f9')
        ?.workspace,
    ).toBe('thsm');
  });

  test('workspace-less notion.so URL has a null workspace', () => {
    expect(classifyPageUrl('https://www.notion.so/413d447ac4b180169985c93eea7f02f9')).toEqual({
      workspace: null,
      pageId: '413d447ac4b180169985c93eea7f02f9',
      canonical: 'https://www.notion.so/413d447ac4b180169985c93eea7f02f9',
    });
  });

  test.each([
    'https://example.com/x',
    'hello world',
    '',
    'notion.so/413d447ac4b180169985c93eea7f02f9',
    `https://thsm.notion.site/413d447ac4b180169985c93eea7f02f9\nhttps://thsm.notion.site/${'a'.repeat(32)}`,
    'see https://thsm.notion.site/413d447ac4b180169985c93eea7f02f9',
  ])('%p is not a Notion page URL', (text) => {
    expect(classifyPageUrl(text)).toBeNull();
  });
});
