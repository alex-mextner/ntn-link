import type {
  ChallengeResponse,
  LinkView,
  PreviewResponse,
  VerifyResponse,
} from '../../../../packages/core/src/api-types';
import type { Api, SweepResponse } from '../../lib/client/api';
import { ApiCallError } from '../../lib/client/errors';
import type { KeyStorage } from '../../lib/client/keys';

export class MemoryStorage implements KeyStorage {
  readonly map = new Map<string, string>();
  fail = false;
  get length() {
    return this.map.size;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.fail) throw new DOMException('quota', 'QuotaExceededError');
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

export const PAGE_URL = 'https://thsm.notion.site/413d447ac4b180169985c93eea7f02f9';

export function previewFixture(overrides: Partial<PreviewResponse> = {}): PreviewResponse {
  return {
    workspace: 'thsm',
    pageId: '413d447a-c4b1-8016-9985-c93eea7f02f9',
    canonicalUrl: PAGE_URL,
    card: {
      title: 'Наши с Леночкой Путешествия',
      description: 'Описание',
      imageUrl: null,
      language: 'ru',
    },
    proposedSlug: 'nashi-s-lenochkoy-puteshestviya',
    namespaceClaimed: false,
    needsVerification: true,
    suggestedAction: 'claim',
    ...overrides,
  };
}

export function linkFixture(slug = 'nashi', overrides: Partial<LinkView> = {}): LinkView {
  return {
    workspace: 'thsm',
    slug,
    pageId: '413d447a-c4b1-8016-9985-c93eea7f02f9',
    canonicalUrl: PAGE_URL,
    card: { title: 'T', description: 'D', imageUrl: null, language: 'ru' },
    overrides: {},
    fast: true,
    canonicalMode: 'self',
    createdAt: '2026-11-10T00:00:00.000Z',
    redirectUrl: `https://ntn.test/thsm/${slug}`,
    fastUrl: `https://ntn.test/thsm/${slug}/read`,
    ...overrides,
  };
}

export const challengeFixture: ChallengeResponse = {
  workspace: 'thsm',
  action: 'claim',
  nonce: 'ntn-abc123',
  claimToken: 'SECRET-CLAIM-TOKEN',
  expiresAt: '2026-11-10T00:15:00.000Z',
};

export const verifyFixture: VerifyResponse = {
  workspace: 'thsm',
  action: 'claim',
  ownerKey: 'SECRET-OWNER-KEY',
  removedLinks: 0,
  cleanupComplete: true,
};

export interface Call {
  name: string;
  args: unknown[];
}

/** Scriptable fake API: each method pops the next queued outcome (value or error) or falls back to a default. */
export function fakeApi(script: Partial<Record<keyof Api, Array<unknown | Error>>> = {}) {
  const calls: Call[] = [];
  const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...(v ?? [])]]));
  const defaults: Record<string, unknown> = {
    preview: previewFixture(),
    challenge: challengeFixture,
    verify: verifyFixture,
    createLink: { link: linkFixture() },
    updateLink: { link: linkFixture() },
    deleteLink: { deleted: true },
    listLinks: { workspace: 'thsm', links: [linkFixture()] },
    sweep: { workspace: 'thsm', removedLinks: 0, cleanupComplete: true } satisfies SweepResponse,
  };
  const api = new Proxy({} as Api, {
    get:
      (_t, name: string) =>
      async (...args: unknown[]) => {
        calls.push({ name, args });
        const queue = queues.get(name);
        const next = queue && queue.length > 0 ? queue.shift() : defaults[name];
        if (next instanceof Error) throw next;
        return next;
      },
  });
  return { api, calls };
}

export const apiError = (code: ApiCallError['code'], status = 400, extra = {}) =>
  new ApiCallError(code, status, extra);
