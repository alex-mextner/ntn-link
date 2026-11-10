/**
 * Test doubles for the Notion side. `FakeNotion` behaves like the real fetcher at the
 * boundary that matters: unknown pages are "not public" (Notion answers 404), a workspace
 * hint that is not the published domain still resolves by page id (the real fetcher falls
 * back to `www.notion.so/<id>`), and titles can be edited between calls.
 */
import { ApiError } from '../src/errors';
import { extractMetadata } from '../src/metadata';
import { MemoryStore } from '../src/memory-store';
import type { PageFetcher, PageFetchResult } from '../src/notion-fetcher';
import { canonicalNotionUrl, type ParsedNotionUrl } from '../src/notion-url';
import { createService, type Service } from '../src/service';

export interface FakePage {
  workspace: string;
  title: string;
  description?: string;
  imageUrl?: string | null;
}

export class FakeNotion implements PageFetcher {
  readonly pages = new Map<string, FakePage>();
  readonly failing = new Set<string>();
  fetches = 0;

  add(pageId: string, page: FakePage): void {
    this.pages.set(pageId, page);
  }

  async fetchPage(request: ParsedNotionUrl): Promise<PageFetchResult> {
    this.fetches++;
    if (this.failing.has(request.pageId)) throw new ApiError('upstream_error', 'Notion is down.');
    const page = this.pages.get(request.pageId);
    if (!page) return { kind: 'not_public' };
    return {
      kind: 'public',
      workspace: page.workspace,
      pageId: request.pageId,
      canonicalUrl: canonicalNotionUrl(page.workspace, request.pageId),
      metadata: {
        ...extractMetadata(
          `<meta property="og:title" content="${page.title} | Notion">` +
            `<meta property="og:description" content="${page.description ?? ''}">`,
        ),
        imageUrl: page.imageUrl ?? null,
      },
    };
  }
}

export class Clock {
  #ms = Date.parse('2026-11-10T12:00:00Z');
  readonly now = (): Date => new Date(this.#ms);
  readonly ms = (): number => this.#ms;
  advanceMinutes(minutes: number): void {
    this.#ms += minutes * 60_000;
  }
  advanceHours(hours: number): void {
    this.advanceMinutes(hours * 60);
  }
}

export const id = (n: number): string => n.toString(16).padStart(32, '0');
export const pageUrl = (ws: string, n: number): string => `https://${ws}.notion.site/${id(n)}`;

export interface Harness {
  notion: FakeNotion;
  clock: Clock;
  store: MemoryStore;
  service: Service;
  purged: string[];
}

export function harness(): Harness {
  const notion = new FakeNotion();
  const clock = new Clock();
  const store = new MemoryStore(clock.ms);
  const purged: string[] = [];
  const service = createService({
    store,
    fetcher: notion,
    origin: 'https://ntn.test',
    now: clock.now,
    purge: async (ws, slug) => {
      purged.push(`${ws}/${slug}`);
    },
  });
  return { notion, clock, store, service, purged };
}

/** Runs the whole claim flow for a workspace and returns its owner key. */
export async function claim(h: Harness, ws: string, pageNo: number): Promise<string> {
  const challenge = await h.service.issueChallenge({ url: pageUrl(ws, pageNo), action: 'claim' });
  const page = h.notion.pages.get(id(pageNo));
  if (!page) throw new Error('page not registered');
  const original = page.title;
  page.title = `${original} ${challenge.nonce}`;
  const result = await h.service.verify({
    url: pageUrl(ws, pageNo),
    nonce: challenge.nonce,
    claimToken: challenge.claimToken,
  });
  page.title = original;
  return result.ownerKey;
}

export async function failureCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
  return 'no error';
}
