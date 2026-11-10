import { describe, expect, test } from 'bun:test';
import { resolveLink, type ResolveArgs } from '../src/link-service';
import {
  Clock,
  NOTION_PAGE,
  ORIGIN,
  PAGE_ID,
  memoryKeys,
  response,
  scriptedFetch,
  type Call,
} from './helpers';

const view = (over: Record<string, unknown> = {}) => ({
  workspace: 'thsm',
  slug: 'our-trips',
  pageId: PAGE_ID,
  redirectUrl: `${ORIGIN}/thsm/our-trips`,
  fastUrl: `${ORIGIN}/thsm/our-trips/read`,
  ...over,
});

function setup(handler: (c: Call) => Promise<Response> | Response) {
  const keys = memoryKeys();
  const net = scriptedFetch(handler);
  const clock = new Clock();
  const args = (over: Partial<ResolveArgs> = {}): ResolveArgs => ({
    url: NOTION_PAGE,
    kind: 'pretty',
    keys,
    fetch: net.fetch,
    timeoutMs: 100,
    origin: ORIGIN,
    now: clock.now,
    ...over,
  });
  return { keys, net, args, clock };
}

const preview = (id = PAGE_ID) => ({
  workspace: 'thsm',
  pageId: id,
  canonicalUrl: `https://thsm.notion.site/${id}`,
});
const json = (body: object, status = 200) => response(status, body, ORIGIN);
const OWNER = 'fixture-owner-0000-0000';

describe('resolveLink', () => {
  test('no key: no_key and zero requests', async () => {
    const t = setup(() => json({}));
    const out = await resolveLink(t.args());
    expect(out).toMatchObject({ ok: false, reason: 'no_key', workspace: 'thsm' });
    expect(t.net.calls).toHaveLength(0);
  });

  test('not a Notion URL', async () => {
    const t = setup(() => json({}));
    expect(await resolveLink(t.args({ url: 'https://example.com' }))).toMatchObject({
      ok: false,
      reason: 'not_notion',
    });
    expect(t.net.calls).toHaveLength(0);
  });

  test('existing link is returned without POST; key goes in the Authorization header', async () => {
    const t = setup(() => json({ workspace: 'thsm', links: [view()] }));
    await t.keys.setKey('thsm', OWNER);
    expect(await resolveLink(t.args())).toEqual({ ok: true, link: `${ORIGIN}/thsm/our-trips` });
    expect(t.net.calls.map((c) => c.init?.method ?? 'GET')).toEqual(['GET']);
    const headers = t.net.calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${OWNER}`);
    expect(t.net.calls[0]?.url).toBe(`${ORIGIN}/api/ns/thsm/links`);
  });

  test('empty list: exactly one POST /api/links with the canonical url and fast, key only in header', async () => {
    const t = setup((c) =>
      c.init?.method === 'POST'
        ? json({ link: view() }, 201)
        : json({ workspace: 'thsm', links: [] }),
    );
    await t.keys.setKey('thsm', OWNER);
    expect(await resolveLink(t.args())).toEqual({ ok: true, link: `${ORIGIN}/thsm/our-trips` });
    const posts = t.net.calls.filter((c) => c.init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe(`${ORIGIN}/api/links`);
    const body = String(posts[0]?.init?.body);
    expect(JSON.parse(body)).toEqual({ url: `https://thsm.notion.site/${PAGE_ID}`, fast: true });
    expect(body).not.toContain(OWNER);
  });

  test('second call is served from the cache with zero requests', async () => {
    const t = setup(() => json({ workspace: 'thsm', links: [view()] }));
    await t.keys.setKey('thsm', OWNER);
    await resolveLink(t.args());
    const before = t.net.calls.length;
    expect(await resolveLink(t.args())).toEqual({ ok: true, link: `${ORIGIN}/thsm/our-trips` });
    expect(t.net.calls).toHaveLength(before);
  });

  test('cache expires so a deleted link is not served forever', async () => {
    const t = setup(() => json({ workspace: 'thsm', links: [view()] }));
    await t.keys.setKey('thsm', OWNER);
    await resolveLink(t.args());
    t.clock.advance(3_600_001);
    await resolveLink(t.args());
    expect(t.net.calls).toHaveLength(2);
  });

  test('fast kind returns the /read link', async () => {
    const t = setup(() => json({ workspace: 'thsm', links: [view()] }));
    await t.keys.setKey('thsm', OWNER);
    expect(await resolveLink(t.args({ kind: 'fast' }))).toEqual({
      ok: true,
      link: `${ORIGIN}/thsm/our-trips/read`,
    });
  });

  test('fast kind on a link with fast off patches it on', async () => {
    const t = setup((c) =>
      c.init?.method === 'PATCH'
        ? json({ link: view() })
        : json({ workspace: 'thsm', links: [view({ fastUrl: null })] }),
    );
    await t.keys.setKey('thsm', OWNER);
    expect(await resolveLink(t.args({ kind: 'fast' }))).toEqual({
      ok: true,
      link: `${ORIGIN}/thsm/our-trips/read`,
    });
    expect(t.net.calls.find((c) => c.init?.method === 'PATCH')?.url).toBe(
      `${ORIGIN}/api/links/thsm/our-trips`,
    );
  });

  test('workspace-less URL resolves the workspace through /api/preview', async () => {
    const t = setup((c) =>
      c.url.endsWith('/api/preview')
        ? json(preview())
        : json({ workspace: 'thsm', links: [view()] }),
    );
    await t.keys.setKey('thsm', OWNER);
    const out = await resolveLink(t.args({ url: `https://www.notion.so/${PAGE_ID}` }));
    expect(out).toEqual({ ok: true, link: `${ORIGIN}/thsm/our-trips` });
    expect(t.net.calls[0]?.url).toBe(`${ORIGIN}/api/preview`);
  });

  test('typed API error message is surfaced as is', async () => {
    const t = setup(() =>
      json({ error: { code: 'not_public', message: 'That page is not public.' } }, 422),
    );
    await t.keys.setKey('thsm', OWNER);
    expect(await resolveLink(t.args())).toMatchObject({
      ok: false,
      reason: 'api_error',
      message: 'That page is not public.',
    });
  });

  test('network failure becomes api_error, never a throw', async () => {
    const t = setup(() => {
      throw new TypeError('fail');
    });
    await t.keys.setKey('thsm', OWNER);
    expect(await resolveLink(t.args())).toMatchObject({ ok: false, reason: 'api_error' });
  });

  test('a fetch that never resolves times out', async () => {
    const t = setup(() => new Promise<Response>(() => undefined));
    await t.keys.setKey('thsm', OWNER);
    expect(await resolveLink(t.args({ timeoutMs: 20 }))).toMatchObject({
      ok: false,
      reason: 'timeout',
    });
  });

  test('path hint differing from the published workspace uses the key of the real one', async () => {
    const t = setup((c) =>
      c.url.endsWith('/api/preview')
        ? json(preview())
        : json({ workspace: 'thsm', links: [view()] }),
    );
    await t.keys.setKey('thsm', OWNER);
    const out = await resolveLink(
      t.args({ url: `https://www.notion.so/internal-name/${PAGE_ID}` }),
    );
    expect(out).toEqual({ ok: true, link: `${ORIGIN}/thsm/our-trips` });
  });

  test('two overlapping resolutions create exactly one link', async () => {
    let created = false;
    const t = setup(async (c) => {
      await Bun.sleep(10);
      if (c.init?.method === 'POST') {
        created = true;
        return json({ link: view() }, 201);
      }
      return json({ workspace: 'thsm', links: created ? [view()] : [] });
    });
    await t.keys.setKey('thsm', OWNER);
    const [a, b] = await Promise.all([
      resolveLink(t.args({ timeoutMs: 2000 })),
      resolveLink(t.args({ kind: 'fast', timeoutMs: 2000 })),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(t.net.calls.filter((c) => c.init?.method === 'POST')).toHaveLength(1);
  });

  test('a hint key does not win over the published workspace key', async () => {
    const t = setup((c) =>
      c.url.endsWith('/api/preview')
        ? json(preview())
        : json({ workspace: 'thsm', links: [view()] }),
    );
    await t.keys.setKey('thsm', OWNER);
    await t.keys.setKey('internal-name', 'other-owner-key-0000-1111');
    await resolveLink(t.args({ url: `https://www.notion.so/internal-name/${PAGE_ID}` }));
    const listing = t.net.calls.find((c) => c.url.includes('/api/ns/'));
    expect(listing?.url).toBe(`${ORIGIN}/api/ns/thsm/links`);
  });

  test('a cached link of another workspace is not reused for the same page id', async () => {
    const t = setup(() => json({ workspace: 'thsm', links: [view()] }));
    await t.keys.setKey('thsm', OWNER);
    await t.keys.setKey('moved', OWNER);
    await resolveLink(t.args());
    const before = t.net.calls.length;
    await resolveLink(t.args({ url: `https://moved.notion.site/${PAGE_ID}` }));
    expect(t.net.calls.length).toBeGreaterThan(before);
  });

  test('a queued request that times out does not release the run in progress', async () => {
    let active = 0;
    let maxActive = 0;
    const t = setup(async (c) => {
      if (c.init?.method === 'POST') {
        active++;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(80);
        active--;
        return json({ link: view() }, 201);
      }
      return json({ workspace: 'thsm', links: [] });
    });
    await t.keys.setKey('thsm', OWNER);
    const a = resolveLink(t.args({ timeoutMs: 2000 }));
    await Bun.sleep(10);
    const b = resolveLink(t.args({ kind: 'fast', timeoutMs: 20 }));
    await Bun.sleep(40);
    const c = resolveLink(t.args({ timeoutMs: 2000 }));
    await Promise.all([a, b, c]);
    expect(maxActive).toBe(1);
  });

  test('a redirecting URL is looked up and created under the page preview resolved', async () => {
    const dest = 'b'.repeat(32);
    const t = setup((c) => {
      if (c.url.endsWith('/api/preview')) return json(preview(dest));
      if (c.init?.method === 'POST') return json({ link: view({ pageId: dest }) }, 201);
      return json({ workspace: 'thsm', links: [] });
    });
    await t.keys.setKey('thsm', OWNER);
    await resolveLink(t.args({ url: `https://www.notion.so/${PAGE_ID}` }));
    const post = t.net.calls.find((c) => c.url.endsWith('/api/links'));
    expect(JSON.parse(String(post?.init?.body)).url).toBe(`https://thsm.notion.site/${dest}`);
  });

  test('an alias URL and the canonical URL share one creation queue', async () => {
    let created = false;
    let posts = 0;
    const t = setup(async (c) => {
      await Bun.sleep(10);
      if (c.url.endsWith('/api/preview')) return json(preview());
      if (c.init?.method === 'POST') {
        posts++;
        created = true;
        return json({ link: view() }, 201);
      }
      return json({ workspace: 'thsm', links: created ? [view()] : [] });
    });
    await t.keys.setKey('thsm', OWNER);
    await Promise.all([
      resolveLink(t.args({ url: `https://www.notion.so/alias-name/${PAGE_ID}`, timeoutMs: 2000 })),
      resolveLink(t.args({ timeoutMs: 2000 })),
    ]);
    expect(posts).toBe(1);
  });

  test('a malformed link list fails instead of creating', async () => {
    const t = setup(() => json({ workspace: 'thsm', links: 'malformed' }));
    await t.keys.setKey('thsm', OWNER);
    expect(await resolveLink(t.args())).toMatchObject({ ok: false, reason: 'api_error' });
    expect(t.net.calls.filter((c) => c.init?.method === 'POST')).toHaveLength(0);
  });
});
