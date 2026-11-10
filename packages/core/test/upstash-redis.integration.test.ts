/**
 * UpstashStore against a REAL Redis (opt-in: `bun run test:redis`, skipped otherwise).
 * The in-memory store is trivially atomic, so only a real server can show that the Lua
 * scripts hold their guarantees under parallel callers. Every test uses its own random key
 * prefix, so runs never see each other's data and nothing needs flushing.
 */
import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { API_LIMITS } from '../src/api-types';
import { Repository, type LinkRecord } from '../src/records';
import { UpstashStore } from '../src/upstash-store';

const url = process.env.REDIS_REST_TEST_URL;
const token = process.env.REDIS_REST_TEST_TOKEN;
const live = url !== undefined && token !== undefined;
const suite = live ? describe : describe.skip;

const store = new UpstashStore({ url: url ?? '', token: token ?? '' });

/**
 * Raw command outside the store, to observe what the store did to Redis itself. It is not the
 * store's client, so on a replicated endpoint it carries no read-your-writes token and may
 * briefly see older data: assertions on it go through `eventually`.
 */
async function raw(...command: Array<string | number>): Promise<unknown> {
  const response = await fetch(url ?? '', {
    method: 'POST',
    headers: { authorization: `Bearer ${token ?? ''}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
  const json: { result?: unknown; error?: string } = await response.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}

/** Polls until the check passes, for at most `timeoutMs`; the last failure is thrown. */
async function eventually(check: () => Promise<void>, timeoutMs = 5000): Promise<void> {
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

const ttlOf = async (key: string): Promise<number> => Number(await raw('TTL', key));

const fresh = (): string => `t:${randomBytes(6).toString('hex')}`;
const all = <T>(count: number, make: (i: number) => Promise<T>): Promise<T[]> =>
  Promise.all(Array.from({ length: count }, (_, i) => make(i)));
const count = <T>(items: readonly T[], wanted: T): number =>
  items.filter((item) => item === wanted).length;

async function seededMove(): Promise<{ setKey: string; from: string; to: string }> {
  const setKey = fresh();
  const from = fresh();
  await store.createIndexed(from, 'old', setKey, 'a', 5);
  return { setKey, from, to: fresh() };
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

suite('UpstashStore on real Redis', () => {
  test('reports the server it ran against', async () => {
    const info = String(await raw('INFO', 'server'));
    const version = /(?:redis|valkey)_version:(\S+)/.exec(info)?.[1];
    console.log(`redis server version: ${version}`);
    expect(version).toBeDefined();
  });

  test('values come back as the exact string stored, never parsed', async () => {
    const key = fresh();
    for (const text of ['{"a":1}', '12345', 'true', 'null', '"quoted"', '', 'ünï\ncode']) {
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
    await eventually(async () => expect(await ttlOf(key)).toBeGreaterThan(0));
    expect(await store.delete(key)).toBe(true);
    expect(await store.delete(key)).toBe(false);
  });

  test('increment counts in parallel and sets the ttl exactly once', async () => {
    const key = fresh();
    const values = await all(20, () => store.increment(key, 100));
    expect(values.toSorted((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    await eventually(async () => {
      const ttl = await ttlOf(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(100);
    });
  });

  describe('compareAndSet', () => {
    test('writes only on an exact match and keeps the expiry', async () => {
      const key = fresh();
      await store.set(key, 'v0', { ttlSeconds: 100 });
      expect(await store.compareAndSet(key, 'other', 'x')).toBe(false);
      expect(await store.compareAndSet(key, 'v0', 'v1')).toBe(true);
      expect(await store.get(key)).toBe('v1');
      await eventually(async () => expect(await ttlOf(key)).toBeGreaterThan(0));
    });

    test('with the stored value as both sides it only confirms, even for a missing or changed key', async () => {
      const key = fresh();
      await store.set(key, 'v0', { ttlSeconds: 100 });
      expect(await store.compareAndSet(key, 'v0', 'v0')).toBe(true);
      expect(await store.get(key)).toBe('v0');
      await eventually(async () => expect(await ttlOf(key)).toBeGreaterThan(0));
      expect(await store.compareAndSet(key, 'other', 'other')).toBe(false);
      expect(await store.get(key)).toBe('v0');
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
      expect(await repo.createLink(link(ws, 'counter', { title: '0' }))).toBe('created');
      await all(5, () =>
        repo.updateLink(ws, 'counter', (c) => ({ ...c, title: String(Number(c.title) + 1) })),
      );
      expect((await repo.getLink(ws, 'counter'))?.title).toBe('5');
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

    test('parallel creates under a cap never exceed it', async () => {
      const setKey = fresh();
      const results = await all(30, (i) => store.createIndexed(fresh(), 'v', setKey, `m${i}`, 10));
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
      const results = await all(over, (i) => repo.createLink(link(ws, `s${i}`)));
      expect(count(results, 'created')).toBe(API_LIMITS.linksPerNamespace);
      expect(count(results, 'full')).toBe(20);
      expect(await repo.listLinkSlugs(ws)).toHaveLength(API_LIMITS.linksPerNamespace);
    });
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

    test('parallel deletes: exactly one reports the removal', async () => {
      const setKey = fresh();
      const key = fresh();
      await store.createIndexed(key, 'v', setKey, 'm', 5);
      const results = await all(20, () => store.deleteIndexed(key, setKey, 'm', 'v'));
      expect(count(results, true)).toBe(1);
      expect(await store.setMembers(setKey)).toEqual([]);
    });
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
  });
});

function link(workspace: string, slug: string, over: Partial<LinkRecord> = {}): LinkRecord {
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
