import { describe, expect, test } from 'bun:test';
import { installInterceptor, type InterceptDeps } from '../src/intercept-main';
import { classifyPageUrl } from '../src/notion-url';
import {
  PROOF_TTL_MS,
  interceptionLink,
  provePublic,
  type PolicyDeps,
} from '../src/intercept-policy';
import {
  Clock,
  NOTION_PAGE,
  notionRecordAnswer,
  ORIGIN,
  PAGE_ID,
  memoryKeys,
  response,
  scriptedFetch,
  type Call,
} from './helpers';

const OWNER = 'fixture-owner-0000-0000';
const PRETTY = `${ORIGIN}/thsm/our-trips`;

/** Notion's public record endpoint: the page record only for public ids. */
function notion(c: Call, publicIds: readonly string[] = [PAGE_ID]): Response {
  const body: { requests: Array<{ pointer: { id: string } }> } = JSON.parse(String(c.init?.body));
  const id = (body.requests[0]?.pointer.id ?? '').replaceAll('-', '');
  return response(200, notionRecordAnswer(id, publicIds.includes(id)), c.url);
}

const apiHandler = (c: Call): Response => {
  if (c.init?.method === 'POST') {
    return response(201, { link: linkView() }, c.url);
  }
  return response(200, { workspace: 'thsm', links: [] }, c.url);
};
const linkView = () => ({
  workspace: 'thsm',
  slug: 'our-trips',
  pageId: PAGE_ID,
  redirectUrl: PRETTY,
  fastUrl: `${PRETTY}/read`,
});

function policySetup(handler: (c: Call) => Promise<Response> | Response) {
  const keys = memoryKeys();
  const net = scriptedFetch(handler);
  const clock = new Clock();
  const deps: PolicyDeps = {
    keys,
    fetch: net.fetch,
    now: clock.now,
    timeoutMs: 50,
    origin: ORIGIN,
  };
  return { keys, net, clock, deps };
}

const routed = (c: Call, notionHandler: (c: Call) => Promise<Response> | Response) =>
  new URL(c.url).host === new URL(ORIGIN).host ? apiHandler(c) : notionHandler(c);

describe('interceptionLink: privacy gates', () => {
  test('workspace-less URL: zero fetches at all', async () => {
    const t = policySetup((c) => routed(c, (n) => notion(n)));
    await t.keys.setAutoEnabled('thsm', true);
    await t.keys.setKey('thsm', OWNER);
    expect(await interceptionLink(`https://www.notion.so/${PAGE_ID}`, t.deps)).toBeNull();
    expect(t.net.calls).toHaveLength(0);
  });

  test('workspace not enabled (the default): zero fetches at all', async () => {
    const t = policySetup((c) => routed(c, (n) => notion(n)));
    await t.keys.setKey('thsm', OWNER);
    expect(await t.keys.isAutoEnabled('thsm')).toBe(false);
    expect(await interceptionLink(NOTION_PAGE, t.deps)).toBeNull();
    expect(t.net.calls).toHaveLength(0);
  });

  test('another workspace enabled does not enable this one', async () => {
    const t = policySetup((c) => routed(c, (n) => notion(n)));
    await t.keys.setKey('thsm', OWNER);
    await t.keys.setAutoEnabled('other', true);
    expect(await interceptionLink(NOTION_PAGE, t.deps)).toBeNull();
    expect(t.net.calls).toHaveLength(0);
  });

  test('enabled but no owner key: nothing leaves the browser', async () => {
    const t = policySetup((c) => routed(c, (n) => notion(n)));
    await t.keys.setAutoEnabled('thsm', true);
    expect(await interceptionLink(NOTION_PAGE, t.deps)).toBeNull();
    expect(t.net.toOrigin()).toHaveLength(0);
  });

  test.each([
    ['private page (role none)', (c: Call) => notion(c, [])],
    [
      'unknown workspace (fetch rejects)',
      () => {
        throw new TypeError('getaddrinfo ENOTFOUND');
      },
    ],
    [
      'non-JSON 200 (app shell or challenge page)',
      (c: Call) => response(200, '<html>Notion</html>', c.url),
    ],
    [
      'JSON 200 without a record for the page',
      (c: Call) => response(200, { recordMap: { block: {} } }, c.url),
    ],
    ['HTTP 404', (c: Call) => response(404, 'Not Found', c.url)],
    [
      'redirect to another host',
      () => response(200, notionRecordAnswer(PAGE_ID, true), `https://evil.example/${PAGE_ID}`),
    ],
    ['hanging fetch', () => new Promise<Response>(() => undefined)],
  ])('%s: null and zero requests to our origin', async (_name, notionHandler) => {
    const t = policySetup((c) => routed(c, notionHandler));
    await t.keys.setAutoEnabled('thsm', true);
    await t.keys.setKey('thsm', OWNER);
    expect(await interceptionLink(NOTION_PAGE, t.deps)).toBeNull();
    expect(t.net.toOrigin()).toHaveLength(0);
  });

  test('enabled + public + key: direct credential-less proof via the record API, then the pretty link', async () => {
    const t = policySetup((c) => routed(c, (n) => notion(n)));
    await t.keys.setAutoEnabled('thsm', true);
    await t.keys.setKey('thsm', OWNER);
    expect(await interceptionLink(NOTION_PAGE, t.deps)).toBe(PRETTY);
    const proof = t.net.calls[0];
    expect(proof?.url).toBe('https://thsm.notion.site/api/v3/syncRecordValuesMain');
    expect(proof?.init?.method).toBe('POST');
    expect(proof?.init?.credentials).toBe('omit');
    expect(String(proof?.init?.body)).toContain('413d447a-c4b1-8016-9985-c93eea7f02f9');
    // The proof is strictly first: nothing reached our origin before it.
    expect(new URL(proof?.url ?? '').host).toBe('thsm.notion.site');
    expect(t.net.toOrigin().length).toBeGreaterThan(0);
    // Only the query-free canonical URL is ever sent on.
    const post = t.net.calls.find((c) => c.init?.method === 'POST');
    expect(String(post?.init?.body)).not.toContain('copy_link');
  });

  test('API failure after a good proof still yields null (original text kept)', async () => {
    const t = policySetup((c) =>
      new URL(c.url).host === new URL(ORIGIN).host
        ? response(500, { error: { code: 'upstream_error', message: 'boom' } }, c.url)
        : notion(c),
    );
    await t.keys.setAutoEnabled('thsm', true);
    await t.keys.setKey('thsm', OWNER);
    expect(await interceptionLink(NOTION_PAGE, t.deps)).toBeNull();
  });
});

describe('provePublic: cache', () => {
  test('second proof makes zero direct fetches; both TTLs expire on the injected clock', async () => {
    const t = policySetup((c) => notion(c));
    expect(await provePublic('thsm', PAGE_ID, t.deps)).toBe(true);
    expect(await provePublic('thsm', PAGE_ID, t.deps)).toBe(true);
    expect(t.net.calls).toHaveLength(1);
    t.clock.advance(PROOF_TTL_MS.positive - 1);
    await provePublic('thsm', PAGE_ID, t.deps);
    expect(t.net.calls).toHaveLength(1);
    t.clock.advance(2);
    await provePublic('thsm', PAGE_ID, t.deps);
    expect(t.net.calls).toHaveLength(2);

    const priv = '0'.repeat(32);
    expect(await provePublic('thsm', priv, t.deps)).toBe(false);
    expect(await provePublic('thsm', priv, t.deps)).toBe(false);
    expect(t.net.calls).toHaveLength(3);
    t.clock.advance(PROOF_TTL_MS.negative - 1);
    await provePublic('thsm', priv, t.deps);
    expect(t.net.calls).toHaveLength(3);
    t.clock.advance(2);
    await provePublic('thsm', priv, t.deps);
    expect(t.net.calls).toHaveLength(4);
  });

  test('a timeout or network failure is not cached as "private"', async () => {
    let up = false;
    const t = policySetup((c) => (up ? notion(c) : Promise.reject(new TypeError('offline'))));
    expect(await provePublic('thsm', PAGE_ID, t.deps)).toBe(false);
    up = true;
    expect(await provePublic('thsm', PAGE_ID, t.deps)).toBe(true);
  });
});

/** Fake Clipboard recording what actually gets written. */
class FakeClipboard {
  written: string[] = [];
  writeCalls = 0;
  rejectWith: Error | null = null;
  async writeText(text: string): Promise<void> {
    this.writeCalls++;
    if (this.rejectWith) throw this.rejectWith;
    this.written.push(String(text));
  }
  async write(items: unknown): Promise<void> {
    this.writeCalls++;
    if (this.rejectWith) throw this.rejectWith;
    const list = items as ReadonlyArray<{ getType(t: string): Promise<Blob> }>;
    for (const item of list) this.written.push(await (await item.getType('text/plain')).text());
  }
}

interface FakeItem {
  types: string[];
  getType(t: string): Promise<Blob>;
}
const item = (text: string, types: string[] = ['text/plain']): FakeItem => ({
  types,
  getType: async () => new Blob([text], { type: 'text/plain' }),
});

function wrapperSetup(ask: InterceptDeps['ask'], opts: { timeoutMs?: number } = {}) {
  const clip = new FakeClipboard();
  const asked: string[] = [];
  installInterceptor(
    {
      target: clip as unknown as Clipboard,
      ask: (url, ms) => {
        asked.push(url);
        return ask(url, ms);
      },
      isNotionPageUrl: (text) => classifyPageUrl(text)?.workspace != null,
      textItem: (text) => item(text) as unknown as ClipboardItem,
    },
    opts,
  );
  const board = clip as unknown as Clipboard;
  return { clip, board, asked };
}

describe('installInterceptor', () => {
  test('writeText: Notion URL replaced by the pretty link', async () => {
    const w = wrapperSetup(async () => PRETTY);
    await w.board.writeText(NOTION_PAGE);
    expect(w.clip.written).toEqual([PRETTY]);
  });

  test('write: single text/plain Notion URL item replaced', async () => {
    const w = wrapperSetup(async () => PRETTY);
    await w.board.write([item(NOTION_PAGE) as unknown as ClipboardItem]);
    expect(w.clip.written).toEqual([PRETTY]);
  });

  test('non-Notion text: original called, ask never called', async () => {
    const w = wrapperSetup(async () => PRETTY);
    await w.board.writeText('hello');
    await w.board.write([item('https://example.com') as unknown as ClipboardItem]);
    expect(w.clip.written).toEqual(['hello', 'https://example.com']);
    expect(w.asked).toEqual([]);
  });

  test.each([
    ['null (policy declined)', async () => null],
    ['ask rejects', async () => Promise.reject(new Error('relay down'))],
    [
      'ask throws synchronously',
      () => {
        throw new Error('boom');
      },
    ],
    ['non-URL garbage answer', async () => 'javascript:alert(1)'],
    ['non-string answer', async () => 42 as unknown as string],
  ])('%s: original text written, wrapper resolves', async (_n, ask) => {
    const w = wrapperSetup(ask as InterceptDeps['ask']);
    await expect(w.board.writeText(NOTION_PAGE)).resolves.toBeUndefined();
    await expect(
      w.board.write([item(NOTION_PAGE) as unknown as ClipboardItem]),
    ).resolves.toBeUndefined();
    expect(w.clip.written).toEqual([NOTION_PAGE, NOTION_PAGE]);
  });

  test('hanging ask falls back after timeoutMs', async () => {
    const w = wrapperSetup(() => new Promise<string | null>(() => undefined), { timeoutMs: 20 });
    const started = Date.now();
    await w.board.writeText(NOTION_PAGE);
    expect(w.clip.written).toEqual([NOTION_PAGE]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('write with two items, or html only: passed through untouched, ask not called', async () => {
    const w = wrapperSetup(async () => PRETTY);
    const two = [item(NOTION_PAGE), item('x')] as unknown as ClipboardItem[];
    const html = [item(NOTION_PAGE, ['text/html'])] as unknown as ClipboardItem[];
    const both = [item(NOTION_PAGE, ['text/plain', 'text/html'])] as unknown as ClipboardItem[];
    await w.board.write(two);
    await w.board.write(html);
    await w.board.write(both);
    expect(w.asked).toEqual([]);
    expect(w.clip.written).toEqual([NOTION_PAGE, 'x', NOTION_PAGE, NOTION_PAGE]);
  });

  test('write whose getType throws: original items are written', async () => {
    const w = wrapperSetup(async () => PRETTY);
    let decoded = 0;
    const bad = {
      types: ['text/plain'],
      getType: () => {
        decoded++;
        return Promise.reject(new Error('nope'));
      },
    };
    let passed: unknown;
    // The recording replaces the ORIGINAL method before the wrapper is installed.
    const recording = new FakeClipboard();
    recording.write = async (items: unknown) => {
      passed = items;
    };
    const items = [bad] as unknown as ClipboardItem[];
    installInterceptor({
      target: recording as unknown as Clipboard,
      ask: async () => PRETTY,
      isNotionPageUrl: () => true,
      textItem: (text) => item(text) as unknown as ClipboardItem,
    });
    await (recording as unknown as Clipboard).write(items);
    expect(decoded).toBe(1);
    expect(passed).toBe(items);
    expect(w.asked).toEqual([]);
  });

  test('the original method own rejection is not swallowed', async () => {
    const w = wrapperSetup(async () => PRETTY);
    w.clip.rejectWith = new Error('NotAllowedError');
    await expect(w.board.writeText('hello')).rejects.toThrow('NotAllowedError');
    await expect(w.board.writeText(NOTION_PAGE)).rejects.toThrow('NotAllowedError');
  });

  test('never throws synchronously, whatever it is called with', async () => {
    const w = wrapperSetup(async () => PRETTY);
    const weird: unknown[] = [undefined, 42, Object.freeze({ a: 1 }), null, Symbol.iterator];
    const pending: Promise<void>[] = [];
    for (const arg of weird) {
      // A synchronous throw would escape this loop; a rejection is the original method's own.
      pending.push(w.board.writeText(arg as string), w.board.write(arg as ClipboardItems));
    }
    const settled = await Promise.allSettled(pending);
    expect(settled).toHaveLength(weird.length * 2);
  });

  test('a delayed replacement never overwrites a newer copy, in either method', async () => {
    const gate: { release: (v: string | null) => void } = { release: () => undefined };
    const w = wrapperSetup(
      (url) =>
        url === NOTION_PAGE ? new Promise((r) => (gate.release = r)) : Promise.resolve(null),
      { timeoutMs: 2000 },
    );
    const slow = w.board.writeText(NOTION_PAGE);
    await w.board.write([item('newer text') as unknown as ClipboardItem]);
    gate.release(PRETTY);
    await slow;
    expect(w.clip.written).toEqual(['newer text']);
  });

  test('a slow promise-backed item falls back to the original items within the deadline', async () => {
    let passed: unknown;
    let decoded = 0;
    const recording = new FakeClipboard();
    // The recording is the ORIGINAL method, installed before the wrapper replaces it.
    recording.write = async (items: unknown) => {
      passed = items;
    };
    installInterceptor(
      {
        target: recording as unknown as Clipboard,
        ask: async () => PRETTY,
        isNotionPageUrl: () => true,
        textItem: (text) => item(text) as unknown as ClipboardItem,
      },
      { timeoutMs: 30 },
    );
    const slow = {
      types: ['text/plain'],
      getType: () => {
        decoded++;
        return new Promise<Blob>(() => undefined);
      },
    };
    const items = [slow] as unknown as ClipboardItem[];
    const t0 = Date.now();
    await (recording as unknown as Clipboard).write(items);
    expect(decoded).toBe(1);
    expect(passed).toBe(items);
    expect(Date.now() - t0).toBeLessThan(400);
  });

  test('a native copy during a pending replacement is not overwritten', async () => {
    const gate: { release: (v: string | null) => void } = { release: () => undefined };
    const clip = new FakeClipboard();
    const native: { fire: () => void } = { fire: () => undefined };
    installInterceptor(
      {
        target: clip as unknown as Clipboard,
        ask: () => new Promise((r) => (gate.release = r)),
        isNotionPageUrl: () => true,
        textItem: (text) => item(text) as unknown as ClipboardItem,
        watchNativeCopy: (cb) => {
          native.fire = cb;
        },
      },
      { timeoutMs: 2000 },
    );
    const pending = (clip as unknown as Clipboard).writeText(NOTION_PAGE);
    native.fire();
    gate.release(PRETTY);
    await pending;
    expect(clip.written).toEqual([]);
  });
});
