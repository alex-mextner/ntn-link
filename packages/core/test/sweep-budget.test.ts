/**
 * Rotation and sweep calls are bounded so they fit a serverless function limit: when the time
 * or fetch budget is spent they answer `cleanupComplete: false`, and repeated sweep calls
 * converge without ever re-fetching a link already confirmed public.
 */
import { describe, expect, test } from 'bun:test';
import { MemoryStore } from '../src/memory-store';
import type { PageFetcher, PageFetchResult } from '../src/notion-fetcher';
import type { ParsedNotionUrl } from '../src/notion-url';
import { createService, type ServiceDeps } from '../src/service';
import { FakeNotion, claim, id, pageUrl, type Harness } from './helpers';

class SlowNotion implements PageFetcher {
  delayMs = 0;
  /** Extra delay per page id, on top of `delayMs`. */
  readonly pageDelays = new Map<string, number>();
  readonly inner = new FakeNotion();
  async fetchPage(request: ParsedNotionUrl): Promise<PageFetchResult> {
    // Real delay on purpose: the sweep budget is enforced with a real timer.
    const delay = this.pageDelays.get(request.pageId) ?? this.delayMs;
    if (delay > 0 && request.pageId !== id(1))
      await new Promise((resolve) => setTimeout(resolve, delay));
    return this.inner.fetchPage(request);
  }
}

const LINKS = 6;

async function setup(budget: ServiceDeps['sweepBudget']) {
  const notion = new SlowNotion();
  const store = new MemoryStore();
  const slow = { purgeMs: 0 };
  const service = createService({
    store,
    fetcher: notion,
    origin: 'https://ntn.test',
    sweepBudget: budget,
    purge: async () => {
      // Real delay on purpose: the budget is enforced with a real timer.
      if (slow.purgeMs > 0) await new Promise((resolve) => setTimeout(resolve, slow.purgeMs));
    },
  });
  notion.inner.add(id(1), { workspace: 'thsm', title: 'Home' });
  const h = { notion: notion.inner, service, store } as unknown as Harness;
  const key = await claim(h, 'thsm', 1);
  for (let n = 10; n < 10 + LINKS; n++) {
    notion.inner.add(id(n), { workspace: 'thsm', title: `Page ${n}` });
    await service.createLink({ url: pageUrl('thsm', n), slug: `p${n}` }, key);
  }
  // Every second page gets unpublished.
  for (let n = 10; n < 10 + LINKS; n += 2) notion.inner.pages.delete(id(n));
  const rotate = async () => {
    const c = await service.issueChallenge({ url: pageUrl('thsm', 1), action: 'rotate' });
    const page = notion.inner.pages.get(id(1));
    if (!page) throw new Error('home page missing');
    page.title = `Home ${c.nonce}`;
    const result = await service.verify({
      url: pageUrl('thsm', 1),
      nonce: c.nonce,
      claimToken: c.claimToken,
    });
    page.title = 'Home';
    return result;
  };
  return { notion, service, key, rotate, slow, store };
}

describe('time-bounded sweeping', () => {
  test('verify returns within the time budget with cleanupComplete=false, sweeps finish it', async () => {
    const t = await setup({ timeMs: 80, concurrency: 2 });
    t.notion.delayMs = 400;
    const started = Date.now();
    const rotated = await t.rotate();
    expect(Date.now() - started).toBeLessThan(350);
    expect(rotated.cleanupComplete).toBe(false);
    expect(rotated.removedLinks).toBe(0);
    // The key was replaced first and stays replaced.
    expect((await t.service.listLinks('thsm', rotated.ownerKey)).links).toHaveLength(LINKS);

    t.notion.delayMs = 0;
    expect(await t.service.sweepLinks('thsm', rotated.ownerKey)).toEqual({
      workspace: 'thsm',
      removedLinks: LINKS / 2,
      cleanupComplete: true,
    });
    expect(await t.service.sweepLinks('thsm', rotated.ownerKey)).toEqual({
      workspace: 'thsm',
      removedLinks: 0,
      cleanupComplete: true,
    });
    const left = (await t.service.listLinks('thsm', rotated.ownerKey)).links.map((l) => l.slug);
    expect(left.toSorted()).toEqual(['p11', 'p13', 'p15']);
  });

  test('a fetch cap spreads the cleanup over calls that converge', async () => {
    const t = await setup({ maxFetches: 2, concurrency: 2 });
    const rotated = await t.rotate();
    expect(rotated.cleanupComplete).toBe(false);
    let removed = rotated.removedLinks;
    let calls = 0;
    for (; calls < 10; calls++) {
      const swept = await t.service.sweepLinks('thsm', rotated.ownerKey);
      removed += swept.removedLinks;
      if (swept.cleanupComplete) break;
    }
    // 6 links at 2 fetches per call: the third sweep examines the last two and completes.
    expect(calls).toBeLessThanOrEqual(3);
    expect(removed).toBe(LINKS / 2);
    const left = (await t.service.listLinks('thsm', rotated.ownerKey)).links.map((l) => l.slug);
    expect(left.toSorted()).toEqual(['p11', 'p13', 'p15']);
  });

  test('a slow cache purge cannot hold the call past the budget', async () => {
    const t = await setup({ timeMs: 60 });
    t.slow.purgeMs = 500;
    const started = Date.now();
    const rotated = await t.rotate();
    expect(Date.now() - started).toBeLessThan(400);
    expect(rotated.cleanupComplete).toBe(false);

    t.slow.purgeMs = 0;
    const swept = await t.service.sweepLinks('thsm', rotated.ownerKey);
    expect(swept.cleanupComplete).toBe(true);
    const left = (await t.service.listLinks('thsm', rotated.ownerKey)).links.map((l) => l.slug);
    expect(left.toSorted()).toEqual(['p11', 'p13', 'p15']);
  });

  test('links whose fetch keeps failing do not starve the links behind them', async () => {
    const t = await setup({ maxFetches: 2, concurrency: 2 });
    t.notion.inner.failing.add(id(10));
    t.notion.inner.failing.add(id(11));
    const rotated = await t.rotate();
    let calls = 0;
    for (; calls < 3; calls++) {
      await t.service.sweepLinks('thsm', rotated.ownerKey);
    }
    const left = (await t.service.listLinks('thsm', rotated.ownerKey)).links.map((l) => l.slug);
    // p12 and p14 are gone and were reached; p10 (gone but unreadable) is kept on purpose.
    expect(left.toSorted()).toEqual(['p10', 'p11', 'p13', 'p15']);
  });

  test('a link that recovers after failing is still reached when failures fill the budget', async () => {
    const t = await setup({ maxFetches: 2, concurrency: 2 });
    // p10 and p12 are gone; p10 is unreadable first, p11 (kept) too, so the budget is spent on them.
    t.notion.inner.failing.add(id(10));
    t.notion.inner.failing.add(id(11));
    t.notion.inner.failing.add(id(12));
    const rotated = await t.rotate();
    for (let i = 0; i < 2; i++) await t.service.sweepLinks('thsm', rotated.ownerKey);
    // Notion recovers for p12 only; p10/p11 keep failing and must not hog every later call.
    t.notion.inner.failing.delete(id(12));
    for (let i = 0; i < 4; i++) await t.service.sweepLinks('thsm', rotated.ownerKey);
    const left = (await t.service.listLinks('thsm', rotated.ownerKey)).links.map((l) => l.slug);
    expect(left).not.toContain('p12');
    expect(left).not.toContain('p14');
  });

  test('results that settled before the deadline are kept when a sibling is still slow', async () => {
    const t = await setup({ timeMs: 100, concurrency: 8 });
    // p10 (gone) is far slower than the budget; p12 and p14 (gone) answer at once.
    t.notion.pageDelays.set(id(10), 600);
    const rotated = await t.rotate();
    expect(rotated.cleanupComplete).toBe(false);
    expect(rotated.removedLinks).toBe(2);
    const left = (await t.service.listLinks('thsm', rotated.ownerKey)).links.map((l) => l.slug);
    expect(left.toSorted()).toEqual(['p10', 'p11', 'p13', 'p15']);
  });

  test('a gone link whose record changed under the sweep is reported incomplete and removed next call', async () => {
    const t = await setup({});
    const original = t.notion.inner.fetchPage.bind(t.notion.inner);
    let touched = false;
    t.notion.inner.fetchPage = async (request) => {
      if (request.pageId === id(10) && !touched) {
        touched = true;
        // A concurrent sweep recorded a failed attempt, so this sweep's snapshot is stale.
        const raw = JSON.parse((await t.store.get('link:thsm/p10')) ?? '{}');
        await t.store.set(
          'link:thsm/p10',
          JSON.stringify({ ...raw, sweepTried: { version: 'other', count: 1 } }),
        );
      }
      return original(request);
    };
    const rotated = await t.rotate();
    expect(rotated.cleanupComplete).toBe(false);
    const next = await t.service.sweepLinks('thsm', rotated.ownerKey);
    expect(next).toMatchObject({ removedLinks: 1, cleanupComplete: true });
    const left = (await t.service.listLinks('thsm', rotated.ownerKey)).links.map((l) => l.slug);
    expect(left).not.toContain('p10');
  });
});
