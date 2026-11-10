/**
 * Persistent state: owner keys, per-workspace opt-in for automatic interception, and the
 * two caches. The storage area is injected so tests need no browser.
 *
 * Proofs live in a separate (volatile) area when one is given: a session-scoped area
 * means the cache cannot grow without bound across years of browsing.
 */
import { LINK_CACHE_TTL_MS, PROOF_TTL_MS } from './config';

export interface StorageArea {
  get(key: string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface CachedLink {
  redirectUrl: string;
  fastUrl: string | null;
}

export interface KeyStore {
  getKey(ws: string): Promise<string | null>;
  setKey(ws: string, key: string): Promise<void>;
  removeKey(ws: string): Promise<void>;
  /** Workspaces the user has added, has a key for, or enabled; for the options page. */
  listWorkspaces(): Promise<string[]>;
  addWorkspace(ws: string): Promise<void>;
  isAutoEnabled(ws: string): Promise<boolean>;
  setAutoEnabled(ws: string, on: boolean): Promise<void>;
  /** null = absent or expired. */
  getPublicProof(proofKey: string, now: number): Promise<boolean | null>;
  setPublicProof(proofKey: string, ok: boolean, now: number): Promise<void>;
  getLinkCache(pageId: string, now: number): Promise<CachedLink | null>;
  setLinkCache(pageId: string, link: CachedLink, now: number): Promise<void>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function createKeyStore(local: StorageArea, volatile: StorageArea = local): KeyStore {
  async function read(area: StorageArea, key: string): Promise<unknown> {
    return (await area.get(key))[key];
  }

  // One storage key per workspace: independent writes cannot overwrite each other, even
  // from two options pages with separate store instances.
  function addWorkspace(ws: string): Promise<void> {
    return local.set({ [`ws:${ws}`]: true });
  }

  return {
    async getKey(ws) {
      const v = await read(local, `key:${ws}`);
      return typeof v === 'string' && v !== '' ? v : null;
    },
    async setKey(ws, key) {
      await local.set({ [`key:${ws}`]: key });
      await addWorkspace(ws);
    },
    removeKey: (ws) => local.remove(`key:${ws}`),
    async listWorkspaces() {
      const all = await local.get(null);
      return Object.keys(all)
        .filter((k) => k.startsWith('ws:'))
        .map((k) => k.slice(3))
        .toSorted();
    },
    addWorkspace,
    async isAutoEnabled(ws) {
      return (await read(local, `auto:${ws}`)) === true;
    },
    async setAutoEnabled(ws, on) {
      await local.set({ [`auto:${ws}`]: on });
      await addWorkspace(ws);
    },
    async getPublicProof(proofKey, now) {
      const v = await read(volatile, `proof:${proofKey}`);
      if (!isObject(v) || typeof v.ok !== 'boolean' || typeof v.at !== 'number') return null;
      const ttl = v.ok ? PROOF_TTL_MS.positive : PROOF_TTL_MS.negative;
      return now - v.at < ttl && now >= v.at ? v.ok : null;
    },
    async setPublicProof(proofKey, ok, now) {
      await volatile.set({ [`proof:${proofKey}`]: { ok, at: now } });
    },
    async getLinkCache(pageId, now) {
      const v = await read(local, `link:${pageId}`);
      if (!isObject(v) || typeof v.redirectUrl !== 'string' || typeof v.at !== 'number') {
        return null;
      }
      if (!(now - v.at < LINK_CACHE_TTL_MS && now >= v.at)) return null;
      return {
        redirectUrl: v.redirectUrl,
        fastUrl: typeof v.fastUrl === 'string' ? v.fastUrl : null,
      };
    },
    async setLinkCache(pageId, link, now) {
      await local.set({ [`link:${pageId}`]: { ...link, at: now } });
    },
  };
}
