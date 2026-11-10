import { describe, expect, test } from 'bun:test';
import { ApiError } from '../src/errors';
import { canonicalNotionUrl, parseNotionUrl, toDashedUuid } from '../src/notion-url';

const ID = '413d447ac4b180169985c93eea7f02f9';

function errorCode(input: string): string | undefined {
  try {
    parseNotionUrl(input);
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
  return undefined;
}

describe('parseNotionUrl: every share-link form resolves to id + workspace hint', () => {
  const cases: ReadonlyArray<readonly [string, string | null]> = [
    [`https://app.notion.com/p/thsm/${ID}?source=copy_link`, 'thsm'],
    [`https://www.notion.so/thsm/${ID}`, 'thsm'],
    [`https://www.notion.so/${ID}`, null],
    [`https://www.notion.so/thsm/Our-Trips-${ID}`, 'thsm'],
    [`https://www.notion.so/Our-Trips-${ID}?pvs=4`, null],
    [`https://thsm.notion.site/${ID}`, 'thsm'],
    [`https://thsm.notion.site/Our-Trips-${ID}?v=abc&pvs=4#anchor`, 'thsm'],
    [`https://www.notion.so/p/${ID}`, null],
    [`https://notion.so/thsm/413d447a-c4b1-8016-9985-c93eea7f02f9`, 'thsm'],
    [`https://www.notion.com/thsm/${ID.toUpperCase()}`, 'thsm'],
    [`thsm.notion.site/${ID}`, 'thsm'],
    [`  http://THSM.notion.site/${ID}  `, 'thsm'],
    [`https://thsm.notion.site/%D0%9D%D0%B0%D1%88%D0%B8-${ID}`, 'thsm'],
  ];
  for (const [input, hint] of cases) {
    test(input.trim(), () => {
      expect(parseNotionUrl(input)).toEqual({ pageId: ID, workspaceHint: hint });
    });
  }
});

describe('parseNotionUrl: rejects what must never be fetched', () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ['', 'not_notion_url'],
    ['not a url at all', 'not_notion_url'],
    [`https://evil.example/${ID}`, 'not_notion_url'],
    [`https://notion.so.evil.example/${ID}`, 'not_notion_url'],
    [`https://evilnotion.so/${ID}`, 'not_notion_url'],
    [`https://thsm.notion.site.evil.example/${ID}`, 'not_notion_url'],
    [`https://user:pw@thsm.notion.site/${ID}`, 'not_notion_url'],
    [`https://thsm.notion.site:8443/${ID}`, 'not_notion_url'],
    [`ftp://thsm.notion.site/${ID}`, 'not_notion_url'],
    ['https://thsm.notion.site/', 'not_notion_url'],
    ['https://thsm.notion.site/not-an-id', 'not_notion_url'],
    [`https://thsm.notion.site/x${ID}`, 'not_notion_url'],
    [`https://www.notion.site/${ID}`, 'unsupported_workspace'],
    [`https://api.notion.site/${ID}`, 'unsupported_workspace'],
  ];
  for (const [input, code] of rejected) {
    test(`${input || '(empty)'} -> ${code}`, () => {
      expect(errorCode(input)).toBe(code);
    });
  }
});

test('notion.site without a subdomain parses (the fetch later rejects the redirect to the homepage)', () => {
  expect(parseNotionUrl(`https://notion.site/${ID}`)).toEqual({ pageId: ID, workspaceHint: null });
});

test('a notion.so path workspace that is reserved or not a DNS label is not used as a hint', () => {
  expect(parseNotionUrl(`https://www.notion.so/api/${ID}`).workspaceHint).toBeNull();
  expect(parseNotionUrl(`https://www.notion.so/a.b/${ID}`).workspaceHint).toBeNull();
});

test('canonical URL and dashed uuid are rebuilt from the id only', () => {
  expect(canonicalNotionUrl('thsm', ID)).toBe(`https://thsm.notion.site/${ID}`);
  expect(toDashedUuid(ID)).toBe('413d447a-c4b1-8016-9985-c93eea7f02f9');
});
