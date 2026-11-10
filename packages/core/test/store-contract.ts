/**
 * The behaviours every `Store` implementation must show, written once and run against each of
 * them (MemoryStore, PostgresStore on PGlite, PostgresStore on a real server, UpstashStore on a
 * real Redis). The design's ownership state machine, rate limiter, sweep and creation lease
 * rely on exactly these guarantees. Every test uses keys under the harness's random prefix, so
 * runs never see each other's data.
 *
 * Capabilities a backend cannot offer are optional on the harness and their tests are skipped:
 * `advanceSeconds` moves the backend's clock forward (a real Redis cannot be time-travelled),
 * `ttlSecondsOf` reads a key's remaining lifetime.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { API_LIMITS } from '../src/api-types';
import { enforceRateLimit, RATE_LIMITS } from '../src/rate-limit';
import { Repository, type LinkRecord } from '../src/records';
import type { Store } from '../src/store';

export interface StoreHarness {
  store: Store;
  advanceSeconds?: (seconds: number) => Promise<void>;
  /** Marks every key of this run (default `t:`), so a shared database can be cleaned afterwards. */
  keyPrefix?: string;
  /** Removes what the run left behind in a shared backend. */
  dispose?: () => Promise<void>;
  /** Remaining lifetime in whole seconds; null for a missing key or one without expiry. */
  ttlSecondsOf?: (key: string) => Promise<number | null>;
  /**
   * At most this many calls in flight in the case that fires hundreds of them at one namespace
   * (default: all at once). A remote database behind a per-request HTTP connection (Neon free
   * plan) cannot even answer 220 plain reads at once inside the production 3 s deadline, so
   * its run keeps the production deadline and bounds the burst instead.
   */
  maxParallelism?: number;
}

const moveOf = (s: { setKey: string; from: string; to: string }, value = 'new') => ({
  from: s.from,
  to: s.to,
  setKey: s.setKey,
  fromMember: 'a',
  toMember: 'b',
  expectedFrom: 'old',
  value,
});

/** Polls until the check passes, for at most `timeoutMs`; the last failure is thrown. */
export async function eventually(check: () => Promise<void>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(100);
    }
  }
}

/** Runs `count` calls with at most `width` in flight; results in call order. */
export async function allWithin<T>(
  count: number,
  width: number,
  make: (i: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = Array.from({ length: count });
  let next = 0;
  let failure: { error: unknown } | undefined;
  // A failed call stops the scheduling, and every worker is awaited before the error is
  // rethrown, so nothing is still writing when the harness cleans up.
  const workers = Array.from({ length: Math.min(width, count) }, async () => {
    while (next < count && failure === undefined) {
      const i = next++;
      try {
        results[i] = await make(i);
      } catch (error) {
        failure ??= { error };
      }
    }
  });
  await Promise.all(workers);
  if (failure !== undefined) throw failure.error;
  return results;
}

const all = <T>(count: number, make: (i: number) => Promise<T>): Promise<T[]> =>
  Promise.all(Array.from({ length: count }, (_, i) => make(i)));
const count = <T>(items: readonly T[], wanted: T): number =>
  items.filter((item) => item === wanted).length;

export function linkRecord(
  workspace: string,
  slug: string,
  over: Partial<LinkRecord> = {},
): LinkRecord {
  return {
    workspace,
    slug,
    pageId: '0'.repeat(32),
    canonicalUrl: `https://${workspace}.notion.site/${'0'.repeat(32)}`,
    title: 'T',
    description: '',
    imageUrl: null,
    language: null,
    fetchedAt: '2026-11-10T12:00:00.000Z',
    createdAt: '2026-11-10T12:00:00.000Z',
    overrides: {},
    fast: false,
    canonicalMode: 'self',
    goneAt: null,
    ...over,
  };
}

/**
 * `makeHarness` is called once, while the suite is registered; a backend that needs async
 * set-up connects lazily behind the store. `skip` registers the suite as skipped, without
 * calling it.
 */
export function defineStoreContract(
  label: string,
  makeHarness: () => StoreHarness,
  { skip = false }: { skip?: boolean } = {},
): void {
  if (skip) {
    describe.skip(`${label}: store contract`, () => test('needs its backend', () => {}));
    return;
  }
  describe(`${label}: store contract`, () => {
    const h = makeHarness();
    const { store } = h;
    const fresh = (): string => `${h.keyPrefix ?? 't:'}${randomBytes(6).toString('hex')}`;
    if (h.dispose) afterAll(h.dispose);
    const { advanceSeconds, ttlSecondsOf } = h;
    const timeTravel = advanceSeconds === undefined;
    const noTtlProbe = ttlSecondsOf === undefined;
    const advance = async (seconds: number): Promise<void> => {
      if (advanceSeconds === undefined) throw new Error('no clock control on this backend');
      await advanceSeconds(seconds);
    };
    const ttlOf = async (key: string): Promise<number | null> => {
      if (ttlSecondsOf === undefined) throw new Error('no ttl probe on this backend');
      return ttlSecondsOf(key);
    };

    async function seededMove(): Promise<{ setKey: string; from: string; to: string }> {
      const setKey = fresh();
      const from = fresh();
      await store.createIndexed(from, 'old', setKey, 'a', 5);
      return { setKey, from, to: fresh() };
    }
    test('values come back as the exact string stored, never parsed', async () => {
      const key = fresh();
      for (const text of [
        '{"a":1}',
        '12345',
        'true',
        'null',
        '"quoted"',
        '',
        'ünï\ncode',
        "it's",
      ]) {
        await store.set(key, text);
        expect(await store.get(key)).toBe(text);
      }
    });

    test('set honours ifAbsent and ttl, get and delete report what happened', async () => {
      const key = fresh();
      expect(await store.get(key)).toBeNull();
      expect(await store.set(key, 'a', { ifAbsent: true, ttlSeconds: 100 })).toBe(true);
      expect(await store.set(key, 'b', { ifAbsent: true })).toBe(false);
      expect(await store.get(key)).toBe('a');
      expect(await store.delete(key)).toBe(true);
      expect(await store.delete(key)).toBe(false);
    });

    test('a plain set replaces the value and drops a ttl; ifAbsent with ttl sets one', async () => {
      const key = fresh();
      expect(await store.set(key, 'a', { ttlSeconds: 100 })).toBe(true);
      expect(await store.set(key, 'b')).toBe(true);
      expect(await store.get(key)).toBe('b');
      if (ttlSecondsOf) expect(await ttlOf(key)).toBeNull();
    });

    test.skipIf(noTtlProbe)('ifAbsent with a ttl is visible as a remaining lifetime', async () => {
      const key = fresh();
      await store.set(key, 'a', { ifAbsent: true, ttlSeconds: 100 });
      await eventually(async () => {
        const ttl = await ttlOf(key);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(100);
      });
    });

    test('parallel set ifAbsent: exactly one caller wins and its value stays', async () => {
      const key = fresh();
      const results = await all(30, (i) => store.set(key, `v${i}`, { ifAbsent: true }));
      expect(count(results, true)).toBe(1);
      expect(await store.get(key)).toBe(`v${results.indexOf(true)}`);
    });

    test.skipIf(timeTravel)('a key expires after its ttl, for get and delete', async () => {
      const key = fresh();
      await store.set(key, 'a', { ttlSeconds: 60 });
      await advance(59);
      expect(await store.get(key)).toBe('a');
      await advance(2);
      expect(await store.get(key)).toBeNull();
      expect(await store.delete(key)).toBe(false);
    });

    test.skipIf(timeTravel)('ifAbsent treats an expired key as absent', async () => {
      const key = fresh();
      await store.set(key, 'old', { ttlSeconds: 10 });
      await advance(11);
      expect(await store.set(key, 'new', { ifAbsent: true, ttlSeconds: 100 })).toBe(true);
      expect(await store.get(key)).toBe('new');
      expect(await store.set(key, 'again', { ifAbsent: true })).toBe(false);
    });

    test.skipIf(timeTravel)(
      'an expired key is never confirmed or overwritten by compareAndSet',
      async () => {
        const key = fresh();
        await store.set(key, 'v0', { ttlSeconds: 10 });
        await advance(11);
        expect(await store.compareAndSet(key, 'v0', 'v1')).toBe(false);
        expect(await store.compareAndSet(key, 'v0', 'v0')).toBe(false);
        expect(await store.get(key)).toBeNull();
      },
    );

    describe('increment', () => {
      test('counts in parallel without losing an update', async () => {
        const key = fresh();
        const values = await all(20, () => store.increment(key, 100));
        expect(values.toSorted((a, b) => a - b)).toEqual(
          Array.from({ length: 20 }, (_, i) => i + 1),
        );
        expect(await store.get(key)).toBe('20');
      });

      test.skipIf(noTtlProbe)('sets the ttl once, when the counter is created', async () => {
        const key = fresh();
        await all(5, () => store.increment(key, 100));
        await eventually(async () => {
          const ttl = await ttlOf(key);
          expect(ttl).toBeGreaterThan(0);
          expect(ttl).toBeLessThanOrEqual(100);
        });
      });

      test.skipIf(timeTravel)(
        'the window is fixed: later increments do not extend it, an expired counter restarts',
        async () => {
          const key = fresh();
          expect(await store.increment(key, 60)).toBe(1);
          await advance(40);
          expect(await store.increment(key, 60)).toBe(2);
          await advance(21);
          expect(await store.get(key)).toBeNull();
          expect(await store.increment(key, 60)).toBe(1);
          expect(await store.increment(key, 60)).toBe(2);
        },
      );

      test.skipIf(timeTravel)(
        'a counter that was set without a window gets one on its next increment',
        async () => {
          const key = fresh();
          await store.set(key, '7');
          expect(await store.increment(key, 30)).toBe(8);
          await advance(31);
          expect(await store.get(key)).toBeNull();
        },
      );

      test('the real rate limiter admits exactly its limit under parallel callers', async () => {
        const ip = fresh();
        const limit = RATE_LIMITS.challenge.limit;
        // The limiter hashes the address into its keys, so the run prefix is not in them.
        const counters = new Set<string>();
        const counting: Store = {
          get: (key) => store.get(key),
          set: (key, value, options) => store.set(key, value, options),
          compareAndSet: (key, expected, value) => store.compareAndSet(key, expected, value),
          delete: (key) => store.delete(key),
          increment: (key, ttlSeconds) => {
            counters.add(key);
            return store.increment(key, ttlSeconds);
          },
          createIndexed: (...args) => store.createIndexed(...args),
          deleteIndexed: (...args) => store.deleteIndexed(...args),
          moveIndexed: (move) => store.moveIndexed(move),
          setMembers: (key) => store.setMembers(key),
        };
        const outcomes = await all(limit + 6, async () => {
          try {
            await enforceRateLimit(counting, 'challenge', ip, () => 1_800_000_000_000);
            return 'ok';
          } catch {
            return 'limited';
          }
        });
        expect(count(outcomes, 'ok')).toBe(limit);
        expect(count(outcomes, 'limited')).toBe(6);
        for (const key of counters) await store.delete(key);
      });
    });

    describe('compareAndSet', () => {
      test('writes only on an exact match', async () => {
        const key = fresh();
        await store.set(key, 'v0');
        expect(await store.compareAndSet(key, 'other', 'x')).toBe(false);
        expect(await store.compareAndSet(key, 'v0', 'v1')).toBe(true);
        expect(await store.get(key)).toBe('v1');
      });

      test.skipIf(noTtlProbe)('keeps the expiry', async () => {
        const key = fresh();
        await store.set(key, 'v0', { ttlSeconds: 100 });
        expect(await store.compareAndSet(key, 'v0', 'v1')).toBe(true);
        await eventually(async () => expect(await ttlOf(key)).toBeGreaterThan(0));
      });

      test.skipIf(timeTravel)(
        'keeps the expiry, so the replaced record still ends on time',
        async () => {
          const key = fresh();
          await store.set(key, 'v0', { ttlSeconds: 60 });
          await advance(30);
          expect(await store.compareAndSet(key, 'v0', 'v1')).toBe(true);
          await advance(31);
          expect(await store.get(key)).toBeNull();
        },
      );

      test('with the stored value as both sides it only confirms, even for a missing or changed key', async () => {
        const key = fresh();
        await store.set(key, 'v0', { ttlSeconds: 100 });
        expect(await store.compareAndSet(key, 'v0', 'v0')).toBe(true);
        expect(await store.get(key)).toBe('v0');
        expect(await store.compareAndSet(key, 'other', 'other')).toBe(false);
        expect(await store.get(key)).toBe('v0');
        expect(await store.compareAndSet(fresh(), 'v0', 'v0')).toBe(false);
      });

      test('never writes a missing key', async () => {
        const key = fresh();
        expect(await store.compareAndSet(key, 'v0', 'v1')).toBe(false);
        expect(await store.get(key)).toBeNull();
      });

      test('many parallel callers from the same version: exactly one wins', async () => {
        const key = fresh();
        await store.set(key, 'v0');
        const results = await all(40, (i) => store.compareAndSet(key, 'v0', `winner-${i}`));
        expect(count(results, true)).toBe(1);
        expect(await store.get(key)).toBe(`winner-${results.indexOf(true)}`);
      });

      test('a read-modify-write through Repository.updateLink loses no update', async () => {
        const repo = new Repository(store);
        const ws = fresh();
        expect(await repo.createLink(linkRecord(ws, 'counter', { title: '0' }))).toBe('created');
        await all(5, () =>
          repo.updateLink(ws, 'counter', (c) => ({ ...c, title: String(Number(c.title) + 1) })),
        );
        expect((await repo.getLink(ws, 'counter'))?.title).toBe('5');
      });
    });

    describe('delete', () => {
      test('parallel deletes: exactly one reports the removal', async () => {
        const key = fresh();
        await store.set(key, 'v');
        const results = await all(20, () => store.delete(key));
        expect(count(results, true)).toBe(1);
        expect(await store.get(key)).toBeNull();
      });

      test('a challenge is consumed exactly once under parallel callers', async () => {
        const repo = new Repository(store);
        const ws = fresh();
        const record = {
          workspace: ws,
          action: 'claim' as const,
          claimTokenHash: 'h',
          namespaceKeyHash: null,
          expiresAt: '2026-11-10T12:15:00.000Z',
        };
        expect(await repo.createChallenge(ws, 'n1', record)).toBe(true);
        expect(await repo.createChallenge(ws, 'n1', record)).toBe(false);
        const results = await all(15, () => repo.consumeChallenge(ws, 'n1'));
        expect(count(results, true)).toBe(1);
        expect(await repo.getChallenge(ws, 'n1')).toBeNull();
      });
    });

    describe('creation lease', () => {
      test('one holder at a time; only the holder can release it', async () => {
        const repo = new Repository(store);
        const ws = fresh();
        const first = await repo.acquirePageCreation(ws, 'page');
        expect(first).not.toBeNull();
        expect(await repo.acquirePageCreation(ws, 'page')).toBeNull();

        await repo.releasePageCreation(ws, 'page', 'not-the-holder');
        expect(await repo.acquirePageCreation(ws, 'page')).toBeNull();

        await repo.releasePageCreation(ws, 'page', first ?? '');
        const second = await repo.acquirePageCreation(ws, 'page');
        expect(second).not.toBeNull();

        // The former holder releasing late must not delete its successor's lease.
        await repo.releasePageCreation(ws, 'page', first ?? '');
        expect(await repo.acquirePageCreation(ws, 'page')).toBeNull();
      });

      test('parallel acquisitions: exactly one holder', async () => {
        const repo = new Repository(store);
        const ws = fresh();
        const tokens = await all(20, () => repo.acquirePageCreation(ws, 'page'));
        expect(tokens.filter((token) => token !== null)).toHaveLength(1);
      });

      test.skipIf(timeTravel)('a lease whose holder died expires on its own', async () => {
        const repo = new Repository(store);
        const ws = fresh();
        expect(await repo.acquirePageCreation(ws, 'page')).not.toBeNull();
        await advance(24 * 3600);
        expect(await repo.acquirePageCreation(ws, 'page')).not.toBeNull();
      });
    });

    describe('createIndexed', () => {
      test('refuses an existing key and a full set, and creates record and member together', async () => {
        const setKey = fresh();
        const [k1, k2, k3] = [fresh(), fresh(), fresh()];
        expect(await store.createIndexed(k1, 'v', setKey, 'm1', 2)).toBe('created');
        expect(await store.createIndexed(k1, 'other', setKey, 'm1', 2)).toBe('exists');
        expect(await store.createIndexed(k2, 'v', setKey, 'm2', 2)).toBe('created');
        expect(await store.createIndexed(k3, 'v', setKey, 'm3', 2)).toBe('full');
        expect(await store.get(k3)).toBeNull();
        expect((await store.setMembers(setKey)).toSorted()).toEqual(['m1', 'm2']);
        expect(await store.get(k1)).toBe('v');
      });

      test('an existing key is reported as exists even when the set is full', async () => {
        const setKey = fresh();
        const key = fresh();
        expect(await store.createIndexed(key, 'v', setKey, 'm1', 1)).toBe('created');
        expect(await store.createIndexed(key, 'v', setKey, 'm2', 1)).toBe('exists');
      });

      test('an empty set (a cap of zero) is full from the start', async () => {
        expect(await store.createIndexed(fresh(), 'v', fresh(), 'm', 0)).toBe('full');
      });

      test('an unknown set has no members', async () => {
        expect(await store.setMembers(fresh())).toEqual([]);
      });

      test('parallel creates under a cap never exceed it', async () => {
        const setKey = fresh();
        const results = await all(30, (i) =>
          store.createIndexed(fresh(), 'v', setKey, `m${i}`, 10),
        );
        expect(count(results, 'created')).toBe(10);
        expect(count(results, 'full')).toBe(20);
        expect(await store.setMembers(setKey)).toHaveLength(10);
      });

      test('parallel creates of one key: exactly one wins', async () => {
        const key = fresh();
        const setKey = fresh();
        const results = await all(20, (i) => store.createIndexed(key, `v${i}`, setKey, 'm', 5));
        expect(count(results, 'created')).toBe(1);
        expect(count(results, 'exists')).toBe(19);
        expect(await store.get(key)).toBe(`v${results.indexOf('created')}`);
        expect(await store.setMembers(setKey)).toEqual(['m']);
      });

      test('Repository enforces the real per-namespace cap under parallel creation', async () => {
        const repo = new Repository(store);
        const ws = fresh();
        const over = API_LIMITS.linksPerNamespace + 20;
        const results = await allWithin(over, h.maxParallelism ?? over, (i) =>
          repo.createLink(linkRecord(ws, `s${i}`)),
        );
        expect(count(results, 'created')).toBe(API_LIMITS.linksPerNamespace);
        expect(count(results, 'full')).toBe(20);
        expect(await repo.listLinkSlugs(ws)).toHaveLength(API_LIMITS.linksPerNamespace);
      });

      test.skipIf(timeTravel)(
        'a record created here never expires, and an expired plain key is replaced',
        async () => {
          const setKey = fresh();
          const key = fresh();
          await store.set(key, 'stale', { ttlSeconds: 10 });
          await advance(11);
          expect(await store.createIndexed(key, 'v', setKey, 'm', 5)).toBe('created');
          await advance(365 * 24 * 3600);
          expect(await store.get(key)).toBe('v');
          expect(await store.setMembers(setKey)).toEqual(['m']);
        },
      );
    });

    describe('deleteIndexed', () => {
      test('removes record and member together; a missing record still clears a stale member', async () => {
        const setKey = fresh();
        const key = fresh();
        await store.createIndexed(key, 'v', setKey, 'm', 5);
        expect(await store.deleteIndexed(key, setKey, 'm')).toBe(true);
        expect(await store.get(key)).toBeNull();
        expect(await store.setMembers(setKey)).toEqual([]);
        expect(await store.deleteIndexed(key, setKey, 'm')).toBe(false);
      });

      test('with `expected` a changed record is left alone, index included', async () => {
        const setKey = fresh();
        const key = fresh();
        await store.createIndexed(key, 'v1', setKey, 'm', 5);
        expect(await store.deleteIndexed(key, setKey, 'm', 'stale')).toBe(false);
        expect(await store.get(key)).toBe('v1');
        expect(await store.setMembers(setKey)).toEqual(['m']);
        expect(await store.deleteIndexed(key, setKey, 'm', 'v1')).toBe(true);
      });

      test('only the named member leaves the set', async () => {
        const setKey = fresh();
        const [k1, k2] = [fresh(), fresh()];
        await store.createIndexed(k1, 'v', setKey, 'm1', 5);
        await store.createIndexed(k2, 'v', setKey, 'm2', 5);
        expect(await store.deleteIndexed(k1, setKey, 'm1', 'v')).toBe(true);
        expect(await store.setMembers(setKey)).toEqual(['m2']);
        expect(await store.get(k2)).toBe('v');
      });

      test('on a plain key with a never-created set it is an atomic delete-if-equal', async () => {
        const key = fresh();
        await store.set(key, 'token');
        expect(await store.deleteIndexed(key, `${key}:holders`, 'lease', 'other')).toBe(false);
        expect(await store.get(key)).toBe('token');
        expect(await store.deleteIndexed(key, `${key}:holders`, 'lease', 'token')).toBe(true);
        expect(await store.get(key)).toBeNull();
      });

      test('parallel deletes: exactly one reports the removal', async () => {
        const setKey = fresh();
        const key = fresh();
        await store.createIndexed(key, 'v', setKey, 'm', 5);
        const results = await all(20, () => store.deleteIndexed(key, setKey, 'm', 'v'));
        expect(count(results, true)).toBe(1);
        expect(await store.setMembers(setKey)).toEqual([]);
      });

      test('delete and recreate racing never leave a record without its member', async () => {
        const setKey = fresh();
        const key = fresh();
        await store.createIndexed(key, 'v0', setKey, 'm', 5);
        for (let round = 0; round < 15; round++) {
          await Promise.all([
            store.deleteIndexed(key, setKey, 'm', `v${round}`),
            store.createIndexed(key, `v${round + 1}`, setKey, 'm', 5),
          ]);
          // Whatever the order, a live record and its member are both present or both absent.
          const record = await store.get(key);
          const members = await store.setMembers(setKey);
          expect(members.includes('m')).toBe(record !== null);
          if (record === null) await store.createIndexed(key, `v${round + 1}`, setKey, 'm', 5);
        }
      });

      test.skipIf(timeTravel)(
        'an expired plain key counts as gone for a guarded delete',
        async () => {
          const key = fresh();
          await store.set(key, 'token', { ttlSeconds: 10 });
          await advance(11);
          expect(await store.deleteIndexed(key, `${key}:holders`, 'lease', 'token')).toBe(false);
        },
      );
    });

    describe('moveIndexed', () => {
      test('renames the record and its index entry in one step', async () => {
        const s = await seededMove();
        expect(await store.moveIndexed(moveOf(s))).toBe('moved');
        expect(await store.get(s.from)).toBeNull();
        expect(await store.get(s.to)).toBe('new');
        expect(await store.setMembers(s.setKey)).toEqual(['b']);
      });

      test('a taken destination or a changed source changes nothing', async () => {
        const s = await seededMove();
        await store.set(s.to, 'occupied');
        expect(await store.moveIndexed(moveOf(s))).toBe('taken');
        expect(await store.get(s.to)).toBe('occupied');
        expect(await store.get(s.from)).toBe('old');
        expect(await store.setMembers(s.setKey)).toEqual(['a']);

        const t = await seededMove();
        expect(await store.moveIndexed({ ...moveOf(t), expectedFrom: 'stale' })).toBe('missing');
        expect(await store.get(t.to)).toBeNull();
        expect(await store.setMembers(t.setKey)).toEqual(['a']);
      });

      test('a missing source is missing', async () => {
        const s = { setKey: fresh(), from: fresh(), to: fresh() };
        expect(await store.moveIndexed(moveOf(s))).toBe('missing');
        expect(await store.get(s.to)).toBeNull();
      });

      test('the moved record never expires', async () => {
        const s = await seededMove();
        expect(await store.moveIndexed(moveOf(s))).toBe('moved');
        if (ttlSecondsOf) expect(await ttlOf(s.to)).toBeNull();
      });

      test('one source moved to many destinations in parallel: exactly one move, one index entry', async () => {
        const s = await seededMove();
        const targets = Array.from({ length: 10 }, () => fresh());
        const results = await all(targets.length, (i) =>
          store.moveIndexed({ ...moveOf(s, `new${i}`), to: targets[i] ?? '', toMember: `b${i}` }),
        );
        expect(count(results, 'moved')).toBe(1);
        expect(count(results, 'missing')).toBe(9);
        const winner = results.indexOf('moved');
        expect(await store.setMembers(s.setKey)).toEqual([`b${winner}`]);
        expect(await store.get(targets[winner] ?? '')).toBe(`new${winner}`);
      });

      test('two sources moved to one destination in parallel: exactly one wins, the other stays', async () => {
        const setKey = fresh();
        const to = fresh();
        const [f1, f2] = [fresh(), fresh()];
        await store.createIndexed(f1, 'old', setKey, 'a1', 5);
        await store.createIndexed(f2, 'old', setKey, 'a2', 5);
        const base = { to, setKey, toMember: 'b', expectedFrom: 'old', value: 'new' };
        const results = await Promise.all([
          store.moveIndexed({ ...base, from: f1, fromMember: 'a1' }),
          store.moveIndexed({ ...base, from: f2, fromMember: 'a2' }),
        ]);
        expect(results.toSorted()).toEqual(['moved', 'taken']);
        expect((await store.setMembers(setKey)).toSorted()).toHaveLength(2);
        expect(await store.setMembers(setKey)).toContain('b');
      });

      test('moving to the same member name keeps the member', async () => {
        const s = await seededMove();
        expect(await store.moveIndexed({ ...moveOf(s), toMember: 'a' })).toBe('moved');
        expect(await store.setMembers(s.setKey)).toEqual(['a']);
      });

      test.skipIf(timeTravel)('an expired destination is free', async () => {
        const s = await seededMove();
        await store.set(s.to, 'old-occupant', { ttlSeconds: 10 });
        await advance(11);
        expect(await store.moveIndexed(moveOf(s))).toBe('moved');
        expect(await store.get(s.to)).toBe('new');
        await advance(365 * 24 * 3600);
        expect(await store.get(s.to)).toBe('new');
      });
    });
  });
}
