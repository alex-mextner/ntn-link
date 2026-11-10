/**
 * Live shape check against Notion (opt-in: `bun run smoke:notion`, never part of `bun test`).
 *
 * Notion changes its markup without notice. ntn-link depends on two things that this script
 * fetches for real from the public test page and checks structurally (not by content, so an
 * owner editing the page does not break it):
 *   1. the SSR <head> served to the unfurler UA carries og:title, og:description and a
 *      non-generic og:image, from which verification and link cards are built;
 *   2. POST /api/v3/loadPageChunk still returns `recordMap.block[id].value.value` blocks,
 *      with the requested page block carrying a type, a title and a content list, which the
 *      fast variant renders from.
 * Any deviation prints every failed expectation and exits 1.
 */
import { BOT_USER_AGENT, extractMetadata, safeFetch, allowNotionPageUrl } from '../src/index';

const WORKSPACE = 'thsm';
const PAGE_ID = '413d447a-c4b1-8016-9985-c93eea7f02f9';
const TIMEOUT_MS = 15_000;

const failures: string[] = [];
const expect = (condition: boolean, message: string): void => {
  if (!condition) failures.push(message);
};

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function checkHtml(): Promise<void> {
  const url = new URL(`https://${WORKSPACE}.notion.site/${PAGE_ID.replaceAll('-', '')}`);
  const result = await safeFetch(url, {
    allow: allowNotionPageUrl,
    timeoutMs: TIMEOUT_MS,
    headers: new Headers({ 'user-agent': BOT_USER_AGENT, accept: 'text/html' }),
  });
  expect(result.status === 200, `page HTML answered HTTP ${result.status}, expected 200`);
  if (result.status !== 200) return;
  const html = new TextDecoder().decode(result.body);
  for (const tag of ['og:title', 'og:description', 'og:image']) {
    expect(
      new RegExp(`<meta[^>]+(?:property|name)=["']${tag}["']`, 'i').test(html),
      `<meta ${tag}> is missing from the SSR HTML`,
    );
  }
  const meta = extractMetadata(html);
  expect(meta.title !== 'Untitled' && meta.title !== '', 'og:title did not yield a title');
  expect(!/\|\s*Notion\s*$/.test(meta.title), 'title still ends with "| Notion"');
  expect(meta.description !== '', 'og:description is empty');
  expect(meta.imageUrl !== null, "og:image is absent or Notion's generic default image");
  console.log(`og title: ${JSON.stringify(meta.title)}`);
}

async function checkPageChunk(): Promise<void> {
  const url = new URL(`https://${WORKSPACE}.notion.site/api/v3/loadPageChunk`);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': BOT_USER_AGENT },
    body: JSON.stringify({
      page: { id: PAGE_ID },
      limit: 100,
      cursor: { stack: [] },
      chunkNumber: 0,
      verticalColumns: false,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  expect(response.status === 200, `loadPageChunk answered HTTP ${response.status}, expected 200`);
  if (response.status !== 200) return;
  const body: unknown = await response.json().catch(() => null);
  const blocks = isRecord(body) && isRecord(body.recordMap) ? body.recordMap.block : undefined;
  expect(isRecord(blocks), 'loadPageChunk: recordMap.block is missing');
  if (!isRecord(blocks)) return;
  const wrapper = blocks[PAGE_ID];
  const block = isRecord(wrapper) && isRecord(wrapper.value) ? wrapper.value.value : undefined;
  expect(
    isRecord(block),
    'loadPageChunk: block record shape changed, expected recordMap.block[id].value.value',
  );
  if (!isRecord(block)) return;
  expect(block.type === 'page', `loadPageChunk: page block type is ${String(block.type)}`);
  expect(
    isRecord(block.properties) && Array.isArray(block.properties.title),
    'loadPageChunk: page block has no properties.title',
  );
  expect(
    Array.isArray(block.content) && block.content.length > 0,
    'loadPageChunk: page block has no content list',
  );
  console.log(`loadPageChunk: ${Object.keys(blocks).length} blocks`);
}

for (const [name, check] of [
  ['SSR HTML', checkHtml],
  ['loadPageChunk', checkPageChunk],
] as const) {
  try {
    await check();
  } catch (error) {
    failures.push(
      `${name}: request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (failures.length > 0) {
  console.error('Notion smoke test FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('Notion smoke test passed.');
