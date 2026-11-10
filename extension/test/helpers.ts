import { createKeyStore, type KeyStore, type StorageArea } from '../src/keys';

export const ORIGIN = 'https://x.example';
export const PAGE_ID = '413d447ac4b180169985c93eea7f02f9';
export const NOTION_PAGE = `https://thsm.notion.site/Our-Trips-${PAGE_ID}?source=copy_link`;

export function memoryArea(): StorageArea {
  const data = new Map<string, unknown>();
  return {
    get: async (key) =>
      key === null ? Object.fromEntries(data) : data.has(key) ? { [key]: data.get(key) } : {},
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
    remove: async (key) => {
      data.delete(key);
    },
  };
}

export function memoryKeys(): KeyStore {
  return createKeyStore(memoryArea());
}

export class Clock {
  constructor(public t = 1_000_000) {}
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

/** A Response whose `url` is what a real post-redirect response would report. */
export function response(status: number, body: string | object, url: string): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const res = new Response(text, { status });
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

export interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** Records every request; `handler` decides the answer (or hangs / throws). */
export function scriptedFetch(handler: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return {
    fetch: impl,
    calls,
    toOrigin: () => calls.filter((c) => new URL(c.url).host === new URL(ORIGIN).host),
  };
}

const dashed = (id: string): string =>
  [id.slice(0, 8), id.slice(8, 12), id.slice(12, 16), id.slice(16, 20), id.slice(20)].join('-');

/** Notion's unauthenticated record answer: the block for public pages, `{role:"none"}` else. */
export function notionRecordAnswer(id: string, isPublic: boolean): object {
  const key = dashed(id);
  return {
    recordMap: {
      block: {
        [key]: {
          value: isPublic ? { value: { id: key, type: 'page' }, role: 'reader' } : { role: 'none' },
        },
      },
    },
  };
}
