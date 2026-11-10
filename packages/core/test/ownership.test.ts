import { beforeEach, describe, expect, test } from 'bun:test';
import { ApiError } from '../src/errors';
import { createService } from '../src/service';
import { claim, failureCode, harness, id, pageUrl, type Harness } from './helpers';

let h: Harness;
beforeEach(() => {
  h = harness();
  h.notion.add(id(1), { workspace: 'thsm', title: 'Our Trips' });
  h.notion.add(id(2), { workspace: 'thsm', title: 'Second page' });
  h.notion.add(id(3), { workspace: 'other', title: 'Foreign page' });
});

async function challengeFor(ws = 'thsm', n = 1, action: 'claim' | 'rotate' = 'claim') {
  return h.service.issueChallenge({ url: pageUrl(ws, n), action });
}

function publishNonce(n: number, nonce: string): void {
  const page = h.notion.pages.get(id(n));
  if (page) page.title = `${page.title} ${nonce}`;
}

describe('claim', () => {
  test('issues a public nonce and a private token; only the nonce goes on the page', async () => {
    const c = await challengeFor();
    expect(c.nonce).toMatch(/^ntn-verify-[a-z0-9]{10}$/);
    expect(c.claimToken.length).toBeGreaterThanOrEqual(43);
    expect(c.nonce).not.toContain(c.claimToken);
    expect(c.expiresAt).toBe('2026-11-10T12:15:00.000Z');
  });

  test('verifying with the nonce on the page and the claim token returns an owner key once', async () => {
    const c = await challengeFor();
    publishNonce(1, c.nonce);
    const result = await h.service.verify({
      url: pageUrl('thsm', 1),
      nonce: c.nonce,
      claimToken: c.claimToken,
    });
    expect(result).toMatchObject({ workspace: 'thsm', action: 'claim', removedLinks: 0 });
    expect(result.ownerKey).toStartWith('ntnk_');
    // The raw key is never persisted.
    const stored = await h.store.get('ns:thsm');
    expect(stored).not.toContain(result.ownerKey);
  });

  test('any public page of the workspace works, and a hint-less URL resolves the namespace', async () => {
    const c = await challengeFor('thsm', 1);
    publishNonce(2, c.nonce);
    const hintless = `https://www.notion.so/${id(2)}`;
    const result = await h.service.verify({
      url: hintless,
      nonce: c.nonce,
      claimToken: c.claimToken,
    });
    expect(result.workspace).toBe('thsm');
  });

  test('a claim challenge for an already claimed namespace is refused', async () => {
    await claim(h, 'thsm', 1);
    expect(await failureCode(challengeFor('thsm', 1, 'claim'))).toBe('namespace_claimed');
  });

  test('a rotate challenge for an unclaimed namespace is refused', async () => {
    expect(await failureCode(challengeFor('thsm', 1, 'rotate'))).toBe('namespace_not_claimed');
  });

  test('a private page cannot start a challenge', async () => {
    expect(
      await failureCode(h.service.issueChallenge({ url: pageUrl('thsm', 99), action: 'claim' })),
    ).toBe('not_public');
  });
});

describe('verification failures', () => {
  test('nonce missing from the title: nothing is consumed and a retry after publishing works', async () => {
    const c = await challengeFor();
    const req = { url: pageUrl('thsm', 1), nonce: c.nonce, claimToken: c.claimToken };
    expect(await failureCode(h.service.verify(req))).toBe('nonce_not_found');
    publishNonce(1, c.nonce);
    expect((await h.service.verify(req)).action).toBe('claim');
  });

  test('a reader of the public nonce without the claim token cannot claim, and does not burn the challenge', async () => {
    const c = await challengeFor();
    publishNonce(1, c.nonce);
    const attacker = { url: pageUrl('thsm', 1), nonce: c.nonce, claimToken: 'guess-guess-guess' };
    expect(await failureCode(h.service.verify(attacker))).toBe('challenge_invalid');
    const owner = { url: pageUrl('thsm', 1), nonce: c.nonce, claimToken: c.claimToken };
    expect((await h.service.verify(owner)).action).toBe('claim');
  });

  test('five wrong tokens delete the challenge, even for the right token afterwards', async () => {
    const c = await challengeFor();
    publishNonce(1, c.nonce);
    const wrong = { url: pageUrl('thsm', 1), nonce: c.nonce, claimToken: 'nope' };
    for (let i = 0; i < 4; i++)
      expect(await failureCode(h.service.verify(wrong))).toBe('challenge_invalid');
    expect(await failureCode(h.service.verify(wrong))).toBe('challenge_expired');
    const right = { url: pageUrl('thsm', 1), nonce: c.nonce, claimToken: c.claimToken };
    expect(await failureCode(h.service.verify(right))).toBe('challenge_expired');
  });

  test('an expired challenge is rejected even with everything right', async () => {
    const c = await challengeFor();
    publishNonce(1, c.nonce);
    h.clock.advanceMinutes(16);
    const req = { url: pageUrl('thsm', 1), nonce: c.nonce, claimToken: c.claimToken };
    expect(await failureCode(h.service.verify(req))).toBe('challenge_expired');
  });

  test('a challenge cannot be reused after success', async () => {
    const c = await challengeFor();
    publishNonce(1, c.nonce);
    const req = { url: pageUrl('thsm', 1), nonce: c.nonce, claimToken: c.claimToken };
    await h.service.verify(req);
    expect(await failureCode(h.service.verify(req))).toBe('challenge_expired');
  });

  test('a challenge for one namespace is useless in another', async () => {
    const c = await challengeFor('thsm', 1);
    publishNonce(3, c.nonce);
    const viaOther = { url: pageUrl('other', 3), nonce: c.nonce, claimToken: c.claimToken };
    expect(await failureCode(h.service.verify(viaOther))).toBe('challenge_expired');
    // Even when the namespace is only discovered by resolving a hint-less URL.
    const hintless = {
      url: `https://www.notion.so/${id(3)}`,
      nonce: c.nonce,
      claimToken: c.claimToken,
    };
    expect(await failureCode(h.service.verify(hintless))).toBe('challenge_expired');
    expect(await h.store.get('ns:other')).toBeNull();
  });

  test('a page of another workspace cannot satisfy the proof even if a hint names the right one', async () => {
    const c = await challengeFor('thsm', 1);
    publishNonce(3, c.nonce);
    // The hint says thsm, but Notion resolves the id to the page's real workspace: `other`.
    const req = {
      url: `https://www.notion.so/thsm/${id(3)}`,
      nonce: c.nonce,
      claimToken: c.claimToken,
    };
    expect(await failureCode(h.service.verify(req))).toBe('challenge_invalid');
    expect(await h.store.get('ns:thsm')).toBeNull();
  });

  test('malformed nonces are rejected before touching storage or Notion', async () => {
    const before = h.notion.fetches;
    const req = { url: pageUrl('thsm', 1), nonce: 'ntn-verify-../../ns', claimToken: 'x' };
    expect(await failureCode(h.service.verify(req))).toBe('challenge_invalid');
    expect(h.notion.fetches).toBe(before);
  });

  test('a claim challenge cannot rotate: if the namespace got claimed meanwhile it fails and the key stays', async () => {
    const mine = await challengeFor();
    const winnerKey = await claim(h, 'thsm', 2);
    publishNonce(1, mine.nonce);
    const req = { url: pageUrl('thsm', 1), nonce: mine.nonce, claimToken: mine.claimToken };
    expect(await failureCode(h.service.verify(req))).toBe('namespace_claimed');
    const created = h.service.createLink({ url: pageUrl('thsm', 1) }, winnerKey);
    expect((await created).link.workspace).toBe('thsm');
  });
});

describe('races', () => {
  test('two concurrent verifications of one challenge: exactly one succeeds', async () => {
    const c = await challengeFor();
    publishNonce(1, c.nonce);
    const req = { url: pageUrl('thsm', 1), nonce: c.nonce, claimToken: c.claimToken };
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => h.service.verify(req)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  test('two different valid challenges for one namespace: exactly one claim wins', async () => {
    const a = await challengeFor();
    const b = await challengeFor();
    publishNonce(1, a.nonce);
    publishNonce(1, b.nonce);
    const results = await Promise.allSettled([
      h.service.verify({ url: pageUrl('thsm', 1), nonce: a.nonce, claimToken: a.claimToken }),
      h.service.verify({ url: pageUrl('thsm', 1), nonce: b.nonce, claimToken: b.claimToken }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('rotation', () => {
  test('replaces the key: the old key stops working, the new one works', async () => {
    const oldKey = await claim(h, 'thsm', 1);
    const c = await challengeFor('thsm', 1, 'rotate');
    publishNonce(1, c.nonce);
    const rotated = await h.service.verify({
      url: pageUrl('thsm', 1),
      nonce: c.nonce,
      claimToken: c.claimToken,
    });
    expect(rotated.action).toBe('rotate');
    expect(rotated.ownerKey).not.toBe(oldKey);
    expect(await failureCode(h.service.listLinks('thsm', oldKey))).toBe('unauthorized');
    expect((await h.service.listLinks('thsm', rotated.ownerKey)).links).toEqual([]);
  });

  test('a claim challenge cannot be used to rotate a claimed namespace', async () => {
    const claimChallenge = await challengeFor('thsm', 1, 'claim');
    const key = await claim(h, 'thsm', 2);
    publishNonce(1, claimChallenge.nonce);
    const req = {
      url: pageUrl('thsm', 1),
      nonce: claimChallenge.nonce,
      claimToken: claimChallenge.claimToken,
    };
    expect(await failureCode(h.service.verify(req))).toBe('namespace_claimed');
    expect((await h.service.listLinks('thsm', key)).workspace).toBe('thsm');
  });

  test('links whose target is gone are removed; reachable and transiently failing ones stay', async () => {
    const key = await claim(h, 'thsm', 1);
    h.notion.add(id(10), { workspace: 'thsm', title: 'Keep' });
    h.notion.add(id(11), { workspace: 'thsm', title: 'Unpublished later' });
    h.notion.add(id(12), { workspace: 'thsm', title: 'Flaky' });
    for (const n of [10, 11, 12]) await h.service.createLink({ url: pageUrl('thsm', n) }, key);
    h.notion.pages.delete(id(11));
    h.notion.failing.add(id(12));
    h.purged.length = 0;

    const c = await challengeFor('thsm', 1, 'rotate');
    publishNonce(1, c.nonce);
    const rotated = await h.service.verify({
      url: pageUrl('thsm', 1),
      nonce: c.nonce,
      claimToken: c.claimToken,
    });

    expect(rotated.removedLinks).toBe(1);
    const slugs = (await h.service.listLinks('thsm', rotated.ownerKey)).links
      .map((l) => l.slug)
      .toSorted();
    expect(slugs).toEqual(['flaky', 'keep']);
    expect(h.purged).toEqual(['thsm/unpublished-later']);
  });
});

describe('notion.so/<name>/<id> links whose name is not the published domain', () => {
  test('the same URL that issued a challenge can verify it', async () => {
    const internalUrl = `https://www.notion.so/internal-name/${id(1)}`;
    const c = await h.service.issueChallenge({ url: internalUrl, action: 'claim' });
    expect(c.workspace).toBe('thsm');
    publishNonce(1, c.nonce);
    const result = await h.service.verify({
      url: internalUrl,
      nonce: c.nonce,
      claimToken: c.claimToken,
    });
    expect(result).toMatchObject({ workspace: 'thsm', action: 'claim' });
  });
});

describe('rotation cleanup failures', () => {
  test('a failing cache purge still returns the new key', async () => {
    const key = await claim(h, 'thsm', 1);
    h.notion.add(id(11), { workspace: 'thsm', title: 'Unpublished later' });
    await h.service.createLink({ url: pageUrl('thsm', 11) }, key);
    h.notion.pages.delete(id(11));
    const service = createService({
      store: h.store,
      fetcher: h.notion,
      origin: 'https://ntn.test',
      now: h.clock.now,
      purge: async () => {
        throw new Error('cache purge unavailable');
      },
    });

    const c = await service.issueChallenge({ url: pageUrl('thsm', 1), action: 'rotate' });
    publishNonce(1, c.nonce);
    const rotated = await service.verify({
      url: pageUrl('thsm', 1),
      nonce: c.nonce,
      claimToken: c.claimToken,
    });

    expect(rotated.removedLinks).toBe(1);
    expect(await failureCode(service.listLinks('thsm', key))).toBe('unauthorized');
    expect((await service.listLinks('thsm', rotated.ownerKey)).links).toEqual([]);
  });

  test('a deletion failing mid-sweep keeps the new key; the sweep can be re-run to finish', async () => {
    const key = await claim(h, 'thsm', 1);
    for (const n of [21, 22, 23]) {
      h.notion.add(id(n), { workspace: 'thsm', title: `Gone ${n}` });
      await h.service.createLink({ url: pageUrl('thsm', n), slug: `g${n}` }, key);
      h.notion.pages.delete(id(n));
    }
    const c = await challengeFor('thsm', 1, 'rotate');
    publishNonce(1, c.nonce);
    const deleteIndexed = h.store.deleteIndexed.bind(h.store);
    let deletions = 0;
    h.store.deleteIndexed = async (...args) => {
      // First gone link is deleted for real, the second deletion hits a storage error.
      if (++deletions === 2) {
        h.store.deleteIndexed = deleteIndexed;
        throw new ApiError('upstream_error', 'storage unavailable');
      }
      return deleteIndexed(...args);
    };

    const rotated = await h.service.verify({
      url: pageUrl('thsm', 1),
      nonce: c.nonce,
      claimToken: c.claimToken,
    });

    expect(rotated).toMatchObject({ action: 'rotate', removedLinks: 1, cleanupComplete: false });
    expect(await failureCode(h.service.listLinks('thsm', key))).toBe('unauthorized');
    expect(await failureCode(h.service.sweepLinks('thsm', key))).toBe('unauthorized');
    const remaining = (await h.service.listLinks('thsm', rotated.ownerKey)).links;
    expect(remaining.map((l) => l.slug).toSorted()).toEqual(['g22', 'g23']);

    expect(await h.service.sweepLinks('thsm', rotated.ownerKey)).toEqual({
      removedLinks: 2,
      complete: true,
    });
    expect((await h.service.listLinks('thsm', rotated.ownerKey)).links).toEqual([]);
  });

  test('a failing key replacement leaves the old key and every link in place', async () => {
    const key = await claim(h, 'thsm', 1);
    h.notion.add(id(11), { workspace: 'thsm', title: 'Unpublished later' });
    await h.service.createLink({ url: pageUrl('thsm', 11), slug: 'gone-soon' }, key);
    h.notion.pages.delete(id(11));
    const c = await challengeFor('thsm', 1, 'rotate');
    publishNonce(1, c.nonce);
    const compareAndSet = h.store.compareAndSet.bind(h.store);
    h.store.compareAndSet = async (k, expected, value) => {
      if (k === 'ns:thsm') {
        h.store.compareAndSet = compareAndSet;
        throw new ApiError('upstream_error', 'storage unavailable');
      }
      return compareAndSet(k, expected, value);
    };
    const req = { url: pageUrl('thsm', 1), nonce: c.nonce, claimToken: c.claimToken };

    expect(await failureCode(h.service.verify(req))).toBe('upstream_error');
    const links = (await h.service.listLinks('thsm', key)).links;
    expect(links.map((l) => l.slug)).toEqual(['gone-soon']);

    const rotated = await h.service.verify(req);
    expect(rotated.removedLinks).toBe(1);
  });

  test('a link recreated under the same slug during the sweep is not removed', async () => {
    const key = await claim(h, 'thsm', 1);
    h.notion.add(id(11), { workspace: 'thsm', title: 'Old target' });
    await h.service.createLink({ url: pageUrl('thsm', 11), slug: 'x' }, key);
    h.notion.pages.delete(id(11));
    const original: object = JSON.parse((await h.store.get('link:thsm/x')) ?? '{}');
    const replacement = JSON.stringify({ ...original, pageId: id(12) });
    const fetchPage = h.notion.fetchPage.bind(h.notion);
    h.notion.fetchPage = async (request) => {
      const result = await fetchPage(request);
      if (request.pageId === id(11)) {
        // The old key is already replaced mid-sweep, so recreate through storage directly.
        await h.service.deleteLink('thsm', 'x', { kind: 'operator' });
        await h.store.createIndexed('link:thsm/x', replacement, 'nslinks:thsm', 'x', 200);
      }
      return result;
    };

    const c = await challengeFor('thsm', 1, 'rotate');
    publishNonce(1, c.nonce);
    const rotated = await h.service.verify({
      url: pageUrl('thsm', 1),
      nonce: c.nonce,
      claimToken: c.claimToken,
    });

    expect(rotated.removedLinks).toBe(0);
    const links = (await h.service.listLinks('thsm', rotated.ownerKey)).links;
    expect(links.map((l) => [l.slug, l.pageId])).toEqual([['x', id(12)]]);
  });
});

describe('competing rotations', () => {
  test('two valid rotate challenges: one key is issued and it works', async () => {
    await claim(h, 'thsm', 1);
    const a = await challengeFor('thsm', 1, 'rotate');
    const b = await challengeFor('thsm', 1, 'rotate');
    publishNonce(1, a.nonce);
    publishNonce(1, b.nonce);
    // Both rotations must have read the namespace before either writes it.
    const compareAndSet = h.store.compareAndSet.bind(h.store);
    const bothReady = Promise.withResolvers<void>();
    let ready = 0;
    h.store.compareAndSet = async (k, expected, value) => {
      if (k === 'ns:thsm') {
        if (++ready === 2) bothReady.resolve();
        await bothReady.promise;
      }
      return compareAndSet(k, expected, value);
    };

    const results = await Promise.allSettled(
      [a, b].map((c) =>
        h.service.verify({ url: pageUrl('thsm', 1), nonce: c.nonce, claimToken: c.claimToken }),
      ),
    );

    const winners = results.filter((r) => r.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'challenge_expired' },
    });
    const [winner] = winners;
    expect((await h.service.listLinks('thsm', winner?.value.ownerKey ?? null)).workspace).toBe(
      'thsm',
    );
  });
});
