import { beforeEach, describe, expect, test } from 'bun:test';
import { API_LIMITS } from '../src/api-types';
import { ApiError } from '../src/errors';
import { enforceRateLimit, RATE_LIMITS } from '../src/rate-limit';
import { Repository } from '../src/records';
import { createService } from '../src/service';
import { claim, failureCode, harness, id, pageUrl, type Harness } from './helpers';

let h: Harness;
let key: string;
beforeEach(async () => {
  h = harness();
  h.notion.add(id(1), {
    workspace: 'thsm',
    title: 'Наши с Леночкой Путешествия',
    description: 'Лето 2026',
  });
  h.notion.add(id(2), { workspace: 'thsm', title: 'Наши с Леночкой Путешествия' });
  h.notion.add(id(3), { workspace: 'other', title: 'Foreign' });
  key = await claim(h, 'thsm', 1);
});

describe('creating links', () => {
  test('without a key an unclaimed namespace needs a claim, a claimed one needs a rotate', async () => {
    try {
      await h.service.createLink({ url: pageUrl('other', 3) }, null);
      throw new Error('expected failure');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect(e).toMatchObject({ code: 'needs_verification', action: 'claim', status: 403 });
    }
    try {
      await h.service.createLink({ url: pageUrl('thsm', 1) }, 'ntnk_wrong');
      throw new Error('expected failure');
    } catch (e) {
      expect(e).toMatchObject({ code: 'needs_verification', action: 'rotate' });
    }
  });

  test('a key of another namespace is not accepted', async () => {
    const otherKey = await claim(h, 'other', 3);
    expect(await failureCode(h.service.createLink({ url: pageUrl('thsm', 1) }, otherKey))).toBe(
      'needs_verification',
    );
  });

  test('derives a transliterated slug, returns both links and suffixes on collision', async () => {
    const first = await h.service.createLink({ url: pageUrl('thsm', 1) }, key);
    expect(first.link.slug).toBe('nashi-s-lenochkoy-puteshestviya');
    expect(first.link.redirectUrl).toBe('https://ntn.test/thsm/nashi-s-lenochkoy-puteshestviya');
    expect(first.link.fastUrl).toBe('https://ntn.test/thsm/nashi-s-lenochkoy-puteshestviya/read');
    const second = await h.service.createLink({ url: pageUrl('thsm', 2) }, key);
    expect(second.link.slug).toBe('nashi-s-lenochkoy-puteshestviya-2');
  });

  test('a retry without a slug returns the existing link instead of creating slug-2', async () => {
    const first = await h.service.createLink({ url: pageUrl('thsm', 1) }, key);
    expect(first.created).toBe(true);
    // The client timed out and retries the identical request.
    const retry = await h.service.createLink({ url: pageUrl('thsm', 1), fast: false }, key);
    expect(retry.created).toBe(false);
    expect(retry.link).toEqual(first.link);
    expect((await h.service.listLinks('thsm', key)).links).toHaveLength(1);
  });

  test('overlapping requests for one page create a single link', async () => {
    const results = await Promise.all([
      h.service.createLink({ url: pageUrl('thsm', 1) }, key),
      h.service.createLink({ url: pageUrl('thsm', 1) }, key),
      h.service.createLink({ url: pageUrl('thsm', 1) }, key),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.link.slug)).size).toBe(1);
    expect((await h.service.listLinks('thsm', key)).links).toHaveLength(1);
  });

  test('a stalled holder whose lease expired does not delete the successor lease', async () => {
    const repo = new Repository(h.store);
    const first = await repo.acquirePageCreation('thsm', id(1));
    expect(first).not.toBeNull();
    expect(await repo.acquirePageCreation('thsm', id(1))).toBeNull();
    // The lease expires and a second holder takes over; the first holder's release is a no-op.
    await h.store.delete('pagelock:thsm/' + id(1));
    const second = await repo.acquirePageCreation('thsm', id(1));
    expect(second).not.toBeNull();
    await repo.releasePageCreation('thsm', id(1), first ?? '');
    expect(await repo.acquirePageCreation('thsm', id(1))).toBeNull();
    await repo.releasePageCreation('thsm', id(1), second ?? '');
    expect(await repo.acquirePageCreation('thsm', id(1))).not.toBeNull();
  });

  test('a retry revives a link whose page was unpublished and published again', async () => {
    const first = await h.service.createLink({ url: pageUrl('thsm', 2) }, key);
    const page = h.notion.pages.get(id(2));
    if (!page) throw new Error('page missing');
    h.notion.pages.delete(id(2));
    await h.service.refreshLink('thsm', first.link.slug);
    expect((await h.service.redirectPage('thsm', first.link.slug)).kind).toBe('gone');

    h.notion.add(id(2), page);
    const retry = await h.service.createLink({ url: pageUrl('thsm', 2) }, key);
    expect(retry).toMatchObject({ created: false, link: { slug: first.link.slug } });
    expect((await h.service.redirectPage('thsm', first.link.slug)).kind).toBe('page');
  });

  test('an explicit different slug still creates a second link for the same page', async () => {
    const first = await h.service.createLink({ url: pageUrl('thsm', 1) }, key);
    const second = await h.service.createLink({ url: pageUrl('thsm', 1), slug: 'extra' }, key);
    expect(second.created).toBe(true);
    expect(second.link.slug).toBe('extra');
    // Without a slug the oldest link of the page answers.
    const retry = await h.service.createLink({ url: pageUrl('thsm', 1) }, key);
    expect(retry).toMatchObject({ created: false, link: { slug: first.link.slug } });
    // The idempotent path is still owner-only.
    expect(await failureCode(h.service.createLink({ url: pageUrl('thsm', 1) }, 'ntnk_x'))).toBe(
      'needs_verification',
    );
  });

  test('explicit slugs: taken, reserved and malformed are typed errors, nothing is rewritten', async () => {
    await h.service.createLink({ url: pageUrl('thsm', 1), slug: 'trips' }, key);
    expect(
      await failureCode(h.service.createLink({ url: pageUrl('thsm', 2), slug: 'trips' }, key)),
    ).toBe('slug_taken');
    expect(
      await failureCode(h.service.createLink({ url: pageUrl('thsm', 2), slug: 'api' }, key)),
    ).toBe('slug_reserved');
    expect(
      await failureCode(h.service.createLink({ url: pageUrl('thsm', 2), slug: 'Bad Slug' }, key)),
    ).toBe('slug_invalid');
  });

  test('concurrent creates of one slug: exactly one wins', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        h.service.createLink({ url: pageUrl('thsm', 1), slug: 'same' }, key),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  test('the same slug may exist in different namespaces', async () => {
    const otherKey = await claim(h, 'other', 3);
    await h.service.createLink({ url: pageUrl('thsm', 1), slug: 'home' }, key);
    expect(
      (await h.service.createLink({ url: pageUrl('other', 3), slug: 'home' }, otherKey)).link
        .workspace,
    ).toBe('other');
  });

  test('private pages are refused with not_public', async () => {
    expect(await failureCode(h.service.createLink({ url: pageUrl('thsm', 404) }, key))).toBe(
      'not_public',
    );
  });

  test('fast=false removes the fast link from the response', async () => {
    const { link } = await h.service.createLink({ url: pageUrl('thsm', 1), fast: false }, key);
    expect(link.fast).toBe(false);
    expect(link.fastUrl).toBeNull();
  });
});

describe('preview', () => {
  test('returns the exact card, a free slug and the verification need', async () => {
    const p = await h.service.preview({ url: `https://www.notion.so/thsm/${id(1)}` }, null);
    expect(p).toMatchObject({
      workspace: 'thsm',
      canonicalUrl: pageUrl('thsm', 1),
      card: { title: 'Наши с Леночкой Путешествия', language: 'ru' },
      proposedSlug: 'nashi-s-lenochkoy-puteshestviya',
      namespaceClaimed: true,
      needsVerification: true,
      suggestedAction: 'rotate',
    });
    const owned = await h.service.preview({ url: pageUrl('thsm', 1) }, key);
    expect(owned.needsVerification).toBe(false);
    expect(owned.suggestedAction).toBeNull();
  });

  test('proposes the next free slug and stores nothing', async () => {
    await h.service.createLink({ url: pageUrl('thsm', 1) }, key);
    const p = await h.service.preview({ url: pageUrl('thsm', 2) }, key);
    expect(p.proposedSlug).toBe('nashi-s-lenochkoy-puteshestviya-2');
    expect((await h.service.listLinks('thsm', key)).links).toHaveLength(1);
  });

  test('a page without a cover carries the start of its text for the generated card', async () => {
    h.excerpts.set(`thsm/${id(2)}`, ['Day one', '• Pack the bags']);
    h.icons.set(`thsm/${id(2)}`, { kind: 'emoji', emoji: '🤿' });
    const p = await h.service.preview({ url: pageUrl('thsm', 2) }, key);
    expect(p.card.imageUrl).toBeNull();
    expect(p.excerpt).toEqual(['Day one', '• Pack the bags']);
    expect(p.icon).toEqual({ kind: 'emoji', emoji: '🤿' });
  });

  test('a page without an icon previews with icon null', async () => {
    const p = await h.service.preview({ url: pageUrl('thsm', 2) }, key);
    expect(p.icon).toBeNull();
  });

  test('a page with its own cover carries no excerpt or icon, and the page is not even loaded', async () => {
    h.notion.add(id(6), {
      workspace: 'thsm',
      title: 'With cover',
      imageUrl: 'https://thsm.notion.site/image/x?table=block&width=2000',
    });
    h.excerpts.set(`thsm/${id(6)}`, ['must not appear']);
    h.icons.set(`thsm/${id(6)}`, { kind: 'emoji', emoji: '🤿' });
    const p = await h.service.preview({ url: pageUrl('thsm', 6) }, key);
    expect(p.card.imageUrl).toContain('/image/x');
    expect(p.excerpt).toEqual([]);
    expect(p.icon).toBeNull();
  });
});

describe('updating and deleting', () => {
  test('moving a slug frees the old one and purges both', async () => {
    await h.service.createLink({ url: pageUrl('thsm', 1), slug: 'old' }, key);
    h.purged.length = 0;
    const { link } = await h.service.updateLink('thsm', 'old', { slug: 'renamed' }, key);
    expect(link.slug).toBe('renamed');
    expect(await h.service.redirectPage('thsm', 'old')).toEqual({ kind: 'not_found' });
    expect((await h.service.redirectPage('thsm', 'renamed')).kind).toBe('page');
    expect(h.purged.toSorted()).toEqual(['thsm/old', 'thsm/renamed']);
    expect((await h.service.listLinks('thsm', key)).links.map((l) => l.slug)).toEqual(['renamed']);
  });

  test('moving onto an existing slug fails and changes nothing', async () => {
    await h.service.createLink({ url: pageUrl('thsm', 1), slug: 'a' }, key);
    await h.service.createLink({ url: pageUrl('thsm', 2), slug: 'b' }, key);
    expect(await failureCode(h.service.updateLink('thsm', 'a', { slug: 'b' }, key))).toBe(
      'slug_taken',
    );
    expect((await h.service.listLinks('thsm', key)).links).toHaveLength(2);
  });

  test('overrides win over fetched values and null removes them', async () => {
    await h.service.createLink({ url: pageUrl('thsm', 1), slug: 'a' }, key);
    const set = await h.service.updateLink(
      'thsm',
      'a',
      { overrides: { title: 'Custom' }, fast: false, canonicalMode: 'notion' },
      key,
    );
    expect(set.link).toMatchObject({
      card: { title: 'Custom', description: 'Лето 2026' },
      fast: false,
      canonicalMode: 'notion',
    });
    const cleared = await h.service.updateLink('thsm', 'a', { overrides: { title: null } }, key);
    expect(cleared.link.card.title).toBe('Наши с Леночкой Путешествия');
  });

  test('only the namespace owner may mutate or list', async () => {
    await h.service.createLink({ url: pageUrl('thsm', 1), slug: 'a' }, key);
    const otherKey = await claim(h, 'other', 3);
    expect(await failureCode(h.service.updateLink('thsm', 'a', { fast: false }, otherKey))).toBe(
      'unauthorized',
    );
    expect(
      await failureCode(h.service.deleteLink('thsm', 'a', { kind: 'owner', ownerKey: null })),
    ).toBe('unauthorized');
    expect(await failureCode(h.service.listLinks('thsm', otherKey))).toBe('unauthorized');
  });

  test('delete by owner and by operator; the link disappears and the cache is purged', async () => {
    await h.service.createLink({ url: pageUrl('thsm', 1), slug: 'a' }, key);
    await h.service.createLink({ url: pageUrl('thsm', 2), slug: 'b' }, key);
    h.purged.length = 0;
    await h.service.deleteLink('thsm', 'a', { kind: 'owner', ownerKey: key });
    await h.service.deleteLink('thsm', 'b', { kind: 'operator' });
    expect((await h.service.redirectPage('thsm', 'a')).kind).toBe('not_found');
    expect((await h.service.listLinks('thsm', key)).links).toEqual([]);
    expect(h.purged).toEqual(['thsm/a', 'thsm/b']);
    expect(await failureCode(h.service.deleteLink('thsm', 'a', { kind: 'operator' }))).toBe(
      'not_found',
    );
  });
});

describe('redirect page and lifecycle', () => {
  test('serves OG HTML whose redirect target is rebuilt from workspace and id', async () => {
    await h.service.createLink({ url: pageUrl('thsm', 1), slug: 'trips' }, key);
    const page = await h.service.redirectPage('thsm', 'trips');
    if (page.kind !== 'page') throw new Error(page.kind);
    expect(page.html).toContain('<meta property="og:title" content="Наши с Леночкой Путешествия">');
    expect(page.html).toContain('content="0;url=https://thsm.notion.site/' + id(1) + '"');
    expect(page.html).toContain('content="https://ntn.test/img/thsm/trips"');
    expect(page.needsRefresh).toBe(false);
  });

  test("the redirect page shows the page's emoji icon, and not a picture icon", async () => {
    await h.service.createLink({ url: pageUrl('thsm', 1), slug: 'trips' }, key);
    h.icons.set(`thsm/${id(1)}`, { kind: 'emoji', emoji: '🤿' });
    const withEmoji = await h.service.redirectPage('thsm', 'trips');
    if (withEmoji.kind !== 'page') throw new Error(withEmoji.kind);
    expect(withEmoji.html).toContain('<span class="m e" aria-hidden="true">🤿</span>');
    h.icons.set(`thsm/${id(1)}`, { kind: 'image', dataUri: 'data:image/png;base64,AAAA' });
    const withPicture = await h.service.redirectPage('thsm', 'trips');
    if (withPicture.kind !== 'page') throw new Error(withPicture.kind);
    expect(withPicture.html).not.toContain('class="m e"');
    expect(withPicture.html).not.toContain('data:image/png');
  });

  test.each([
    ['never answers', () => new Promise<string | null>(() => {})],
    ['rejects', () => Promise.reject(new Error('notion down'))],
  ])(
    'a lookup that %s still serves the stub, without the icon, within the deadline',
    async (_name, loadPageEmoji) => {
      const slow = harness({ loadPageEmoji });
      slow.notion.add(id(1), { workspace: 'thsm', title: 'T' });
      const slowKey = await claim(slow, 'thsm', 1);
      await slow.service.createLink({ url: pageUrl('thsm', 1), slug: 'trips' }, slowKey);
      const started = Date.now();
      const page = await slow.service.redirectPage('thsm', 'trips');
      if (page.kind !== 'page') throw new Error(page.kind);
      expect(Date.now() - started).toBeLessThan(2500);
      expect(page.html).not.toContain('class="m e"');
      expect(page.html).toContain('<meta property="og:title" content="T">');
    },
  );

  test('hostile Notion text is escaped in the served page', async () => {
    h.notion.add(id(5), {
      workspace: 'thsm',
      title: '<script>alert(1)</script>',
      description: '"><img src=x onerror=1>',
    });
    await h.service.createLink({ url: pageUrl('thsm', 5), slug: 'evil' }, key);
    const page = await h.service.redirectPage('thsm', 'evil');
    if (page.kind !== 'page') throw new Error(page.kind);
    expect(page.html).not.toContain('<script>alert');
    expect(page.html).not.toContain('<img src=x');
  });

  test('metadata is refreshed lazily after 24 h and follows renames; overrides still win', async () => {
    await h.service.createLink({ url: pageUrl('thsm', 1), slug: 'a' }, key);
    await h.service.createLink(
      { url: pageUrl('thsm', 2), slug: 'b', overrides: { title: 'Pinned' } },
      key,
    );
    h.clock.advanceHours(25);
    const stale = await h.service.redirectPage('thsm', 'a');
    expect(stale).toMatchObject({ kind: 'page', needsRefresh: true });

    const renamed = h.notion.pages.get(id(1));
    if (renamed) renamed.title = 'Renamed page';
    const pinned = h.notion.pages.get(id(2));
    if (pinned) pinned.title = 'Renamed too';
    await h.service.refreshLink('thsm', 'a');
    await h.service.refreshLink('thsm', 'b');
    const a = await h.service.redirectPage('thsm', 'a');
    const b = await h.service.redirectPage('thsm', 'b');
    if (a.kind !== 'page' || b.kind !== 'page') throw new Error('expected pages');
    expect(a.html).toContain('content="Renamed page"');
    expect(a.needsRefresh).toBe(false);
    expect(b.html).toContain('content="Pinned"');
  });

  test('a page that stops being public becomes a 410 without redirect, and recovers when public again', async () => {
    await h.service.createLink({ url: pageUrl('thsm', 1), slug: 'a' }, key);
    const saved = h.notion.pages.get(id(1));
    h.notion.pages.delete(id(1));
    await h.service.refreshLink('thsm', 'a');
    const gone = await h.service.redirectPage('thsm', 'a');
    expect(gone.kind).toBe('gone');
    if (gone.kind === 'gone') expect(gone.html).not.toContain('refresh');
    expect((await h.service.cardSource('thsm', 'a'))?.kind).toBe('generated');

    if (saved) h.notion.add(id(1), saved);
    // Just checked: no refresh yet. Once the card is stale the gone page asks for one.
    expect(await h.service.redirectPage('thsm', 'a')).toMatchObject({
      kind: 'gone',
      needsRefresh: false,
    });
    h.clock.advanceHours(25);
    const stale = await h.service.redirectPage('thsm', 'a');
    expect(stale).toMatchObject({ kind: 'gone', needsRefresh: true });
    await h.service.refreshLink('thsm', 'a');
    expect((await h.service.redirectPage('thsm', 'a')).kind).toBe('page');
  });

  test('a Notion outage during refresh keeps serving the stored card', async () => {
    await h.service.createLink({ url: pageUrl('thsm', 1), slug: 'a' }, key);
    h.notion.failing.add(id(1));
    await h.service.refreshLink('thsm', 'a');
    expect((await h.service.redirectPage('thsm', 'a')).kind).toBe('page');
  });

  test('unknown links are not_found', async () => {
    expect(await h.service.redirectPage('thsm', 'missing')).toEqual({ kind: 'not_found' });
    expect(await h.service.cardSource('thsm', 'missing')).toBeNull();
  });
});

const imageAt = (n: number): string =>
  `https://thsm.notion.site/image/v${n}?table=block&width=2000`;
const resolved = (n: number): string => imageAt(n).replace('width=2000', 'width=1200');
const served = async (): Promise<string | null> => {
  const card = await h.service.cardSource('thsm', 'cached');
  return card?.kind === 'notion-image' ? card.url : null;
};
describe('card source', () => {
  test('a stored Notion banner is never served, the generated card is drawn instead', async () => {
    h.notion.add(id(6), {
      workspace: 'thsm',
      title: 'Banner',
      imageUrl: 'https://thsm.notion.site/images/meta/notion-wordmark.png',
    });
    await h.service.createLink({ url: pageUrl('thsm', 6), slug: 'banner' }, key);
    // Even when Notion cannot be reached, the stored value (written before banners were
    // recognised) must not come back as an image.
    h.notion.failing.add(id(6));
    expect(await h.service.cardSource('thsm', 'banner')).toMatchObject({ kind: 'generated' });
  });

  test('a stored generated "Made with Notion" card is not served when Notion cannot be reached', async () => {
    h.notion.add(id(6), {
      workspace: 'thsm',
      title: 'Legacy',
      imageUrl:
        'https://thsm.notion.site/image/attachment%3Aabc%3ASocialMediaPreviewImage.png?table=block&width=2000',
    });
    await h.service.createLink({ url: pageUrl('thsm', 6), slug: 'legacy' }, key);
    h.notion.failing.add(id(6));
    expect(await h.service.cardSource('thsm', 'legacy')).toMatchObject({ kind: 'generated' });
  });

  test('the card page is read for the page id of the card source, never for whatever the slug is now', async () => {
    await h.service.createLink({ url: pageUrl('thsm', 2), slug: 'noimg' }, key);
    h.excerpts.set(`thsm/${id(2)}`, ['Text of page A']);
    h.excerpts.set(`thsm/${id(1)}`, ['Text of page B']);
    h.icons.set(`thsm/${id(2)}`, { kind: 'emoji', emoji: '🤿' });
    h.icons.set(`thsm/${id(1)}`, { kind: 'emoji', emoji: '🛕' });
    const source = await h.service.cardSource('thsm', 'noimg');
    // The slug is deleted and recreated for another page before the page content is read.
    await h.service.deleteLink('thsm', 'noimg', { kind: 'owner', ownerKey: key });
    await h.service.createLink({ url: pageUrl('thsm', 1), slug: 'noimg' }, key);
    expect(source).toMatchObject({ kind: 'generated', pageId: id(2) });
    expect(await h.service.pageCard('thsm', source?.pageId ?? '')).toEqual({
      excerpt: ['Text of page A'],
      icon: { kind: 'emoji', emoji: '🤿' },
    });
  });

  test('uses the freshly resolved Notion image at width 1200, or a generated card without one', async () => {
    h.notion.add(id(6), {
      workspace: 'thsm',
      title: 'With image',
      imageUrl: 'https://thsm.notion.site/image/x?table=block&width=2000',
    });
    await h.service.createLink({ url: pageUrl('thsm', 6), slug: 'withimage' }, key);
    await h.service.createLink({ url: pageUrl('thsm', 2), slug: 'noimg' }, key);
    expect(await h.service.cardSource('thsm', 'withimage')).toMatchObject({
      kind: 'notion-image',
      url: 'https://thsm.notion.site/image/x?table=block&width=1200',
    });
    expect(await h.service.cardSource('thsm', 'noimg')).toMatchObject({
      kind: 'generated',
      title: 'Наши с Леночкой Путешествия',
    });
  });

  test('an unpublished or relocated page never serves its stored image', async () => {
    const page = {
      workspace: 'thsm',
      title: 'With image',
      imageUrl: 'https://thsm.notion.site/image/x?table=block&width=2000',
    };
    h.notion.add(id(6), page);
    await h.service.createLink({ url: pageUrl('thsm', 6), slug: 'withimage' }, key);

    h.notion.pages.delete(id(6));
    expect((await h.service.cardSource('thsm', 'withimage'))?.kind).toBe('generated');

    h.notion.add(id(6), { ...page, workspace: 'other' });
    expect((await h.service.cardSource('thsm', 'withimage'))?.kind).toBe('generated');
  });

  test('a transient Notion failure keeps serving the stored image', async () => {
    h.notion.add(id(6), {
      workspace: 'thsm',
      title: 'With image',
      imageUrl: 'https://thsm.notion.site/image/x?table=block&width=2000',
    });
    await h.service.createLink({ url: pageUrl('thsm', 6), slug: 'withimage' }, key);
    h.notion.failing.add(id(6));
    expect((await h.service.cardSource('thsm', 'withimage'))?.kind).toBe('notion-image');
  });

  describe('caching the resolved image', () => {
    beforeEach(async () => {
      h.notion.add(id(7), { workspace: 'thsm', title: 'Cached', imageUrl: imageAt(1) });
      await h.service.createLink({ url: pageUrl('thsm', 7), slug: 'cached' }, key);
      h.notion.fetches = 0;
    });

    test('repeated image requests within the fresh window cost one Notion fetch', async () => {
      await served();
      await served();
      await served();
      expect(h.notion.fetches).toBe(1);
    });

    test('a burst of simultaneous requests shares one Notion fetch', async () => {
      await Promise.all(Array.from({ length: 10 }, served));
      expect(h.notion.fetches).toBe(1);
    });

    test('an entry is served until its TTL and never after it: the caller waits for Notion', async () => {
      await served();
      const page = h.notion.pages.get(id(7));
      if (page) page.imageUrl = imageAt(2);
      h.clock.advanceMinutes(0.99);
      expect(await served()).toBe(resolved(1));
      expect(h.notion.fetches).toBe(1);
      h.clock.advanceMinutes(0.01);
      expect(await served()).toBe(resolved(2));
      expect(h.notion.fetches).toBe(2);
    });

    test('a page unpublished or relocated while cached stops serving its image after the TTL', async () => {
      await served();
      h.notion.pages.delete(id(7));
      h.clock.advanceMinutes(5);
      expect(await served()).toBeNull();

      h.notion.add(id(7), { workspace: 'other', title: 'Cached', imageUrl: imageAt(1) });
      h.clock.advanceMinutes(5);
      expect(await served()).toBeNull();
    });

    test('a transient Notion failure is not remembered', async () => {
      h.notion.failing.add(id(7));
      expect(await served()).toBe(resolved(1));
      h.notion.failing.delete(id(7));
      const page = h.notion.pages.get(id(7));
      if (page) page.imageUrl = imageAt(2);
      expect(await served()).toBe(resolved(2));
    });

    test('refreshing the link drops the cached image at once', async () => {
      await served();
      h.notion.pages.delete(id(7));
      await h.service.refreshLink('thsm', 'cached');
      expect(await served()).toBeNull();
    });

    test('a deleted link that is recreated for another page does not inherit the image', async () => {
      await served();
      await h.service.deleteLink('thsm', 'cached', { kind: 'operator' });
      h.notion.add(id(8), { workspace: 'thsm', title: 'Other', imageUrl: imageAt(9) });
      await h.service.createLink({ url: pageUrl('thsm', 8), slug: 'cached' }, key);
      expect(await served()).toBe(resolved(9));
    });

    test('a slug recreated for another page by another instance does not join the old fetch', async () => {
      const other = createService({
        store: h.store,
        fetcher: h.notion,
        origin: 'https://ntn.test',
        now: h.clock.now,
      });
      const fetchPage = h.notion.fetchPage.bind(h.notion);
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let held = false;
      h.notion.fetchPage = async (request) => {
        if (request.pageId === id(7) && !held) {
          held = true;
          started.resolve();
          await release.promise;
        }
        return fetchPage(request);
      };
      const pending = served();
      await started.promise;

      await other.deleteLink('thsm', 'cached', { kind: 'operator' });
      h.notion.add(id(8), { workspace: 'thsm', title: 'Other', imageUrl: imageAt(9) });
      await other.createLink({ url: pageUrl('thsm', 8), slug: 'cached' }, key);
      expect(await served()).toBe(resolved(9));

      release.resolve();
      await pending;
      expect(await served()).toBe(resolved(9));
    });

    test('the resolved image is never written to storage', async () => {
      const before = await h.store.get('link:thsm/cached');
      const page = h.notion.pages.get(id(7));
      if (page) page.imageUrl = imageAt(2);
      await served();
      expect(await h.store.get('link:thsm/cached')).toBe(before);
    });
  });
});

describe('rate limiting', () => {
  test('blocks the request after the limit within a window and recovers in the next', async () => {
    const { limit, windowSeconds } = RATE_LIMITS.challenge;
    for (let i = 0; i < limit; i++)
      await enforceRateLimit(h.store, 'challenge', '203.0.113.7', h.clock.ms);
    try {
      await enforceRateLimit(h.store, 'challenge', '203.0.113.7', h.clock.ms);
      throw new Error('expected rate limit');
    } catch (e) {
      expect(e).toMatchObject({ code: 'rate_limited', status: 429 });
      expect((e as ApiError).retryAfterSeconds).toBeGreaterThan(0);
    }
    // Other IPs are unaffected.
    await enforceRateLimit(h.store, 'challenge', '203.0.113.8', h.clock.ms);
    h.clock.advanceMinutes(windowSeconds / 60 + 1);
    await enforceRateLimit(h.store, 'challenge', '203.0.113.7', h.clock.ms);
  });

  test('no raw IP address is stored in counter keys', async () => {
    await enforceRateLimit(h.store, 'preview', '203.0.113.7', h.clock.ms);
    expect(await h.store.get('rl:preview:203.0.113.7')).toBeNull();
  });
});

describe('concurrent changes', () => {
  test('a PATCH that races an operator delete does not bring the link back', async () => {
    await h.service.createLink({ url: pageUrl('thsm', 1), slug: 'a' }, key);
    const compareAndSet = h.store.compareAndSet.bind(h.store);
    let raced = false;
    h.store.compareAndSet = async (k, expected, value) => {
      if (!raced) {
        raced = true;
        await h.service.deleteLink('thsm', 'a', { kind: 'operator' });
      }
      return compareAndSet(k, expected, value);
    };

    expect(await failureCode(h.service.updateLink('thsm', 'a', { fast: false }, key))).toBe(
      'not_found',
    );
    expect(await h.service.getLink('thsm', 'a')).toBeNull();
    expect((await h.service.listLinks('thsm', key)).links).toEqual([]);
  });

  test('a refresh that outlives its link never writes into a replacement', async () => {
    await h.service.createLink({ url: pageUrl('thsm', 1), slug: 'a' }, key);
    const renamed = h.notion.pages.get(id(1));
    if (renamed) renamed.title = 'Renamed while refreshing';
    const fetchPage = h.notion.fetchPage.bind(h.notion);
    let swapped = false;
    h.notion.fetchPage = async (request) => {
      const result = await fetchPage(request);
      if (!swapped) {
        swapped = true;
        await h.service.deleteLink('thsm', 'a', { kind: 'operator' });
        await h.service.createLink({ url: pageUrl('thsm', 2), slug: 'a' }, key);
      }
      return result;
    };

    await h.service.refreshLink('thsm', 'a');

    expect(await h.service.getLink('thsm', 'a')).toMatchObject({
      pageId: id(2),
      title: 'Наши с Леночкой Путешествия',
    });
  });

  test('concurrent creates cannot exceed the namespace link limit', async () => {
    const limit = API_LIMITS.linksPerNamespace;
    for (let n = 0; n < limit - 1; n++) {
      await h.service.createLink({ url: pageUrl('thsm', 1), slug: `s-${n}` }, key);
    }
    // Hold both creates at the storage call so both are admitted by the cap at the same time.
    const createIndexed = h.store.createIndexed.bind(h.store);
    const bothArrived = Promise.withResolvers<void>();
    let arrived = 0;
    h.store.createIndexed = async (...args) => {
      if (++arrived <= 2) {
        if (arrived === 2) bothArrived.resolve();
        await bothArrived.promise;
      }
      return createIndexed(...args);
    };

    const results = await Promise.allSettled([
      h.service.createLink({ url: pageUrl('thsm', 1), slug: 'last-a' }, key),
      h.service.createLink({ url: pageUrl('thsm', 1), slug: 'last-b' }, key),
    ]);

    expect((await h.store.setMembers('nslinks:thsm')).length).toBe(limit);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected');
    expect(failed).toMatchObject({ reason: { code: 'link_limit' } });
  });

  test('a rename that races a delete-and-recreate removes nothing and resurrects nothing', async () => {
    await h.service.createLink({ url: pageUrl('thsm', 1), slug: 'a' }, key);
    const moveIndexed = h.store.moveIndexed.bind(h.store);
    let raced = false;
    h.store.moveIndexed = async (move) => {
      if (!raced) {
        raced = true;
        await h.service.deleteLink('thsm', 'a', { kind: 'operator' });
        await h.service.createLink({ url: pageUrl('thsm', 2), slug: 'a' }, key);
      }
      return moveIndexed(move);
    };

    expect(await failureCode(h.service.updateLink('thsm', 'a', { slug: 'b' }, key))).toBe(
      'not_found',
    );

    expect(await h.service.getLink('thsm', 'b')).toBeNull();
    expect(await h.service.getLink('thsm', 'a')).toMatchObject({ pageId: id(2) });
    const slugs = (await h.service.listLinks('thsm', key)).links.map((l) => l.slug);
    expect(slugs).toEqual(['a']);
  });

  test('a link deleted and recreated under the same slug stays in the namespace index', async () => {
    await h.service.createLink({ url: pageUrl('thsm', 1), slug: 'a' }, key);
    await h.service.deleteLink('thsm', 'a', { kind: 'operator' });
    await h.service.createLink({ url: pageUrl('thsm', 2), slug: 'a' }, key);
    expect((await h.service.listLinks('thsm', key)).links.map((l) => l.pageId)).toEqual([id(2)]);
  });
});
