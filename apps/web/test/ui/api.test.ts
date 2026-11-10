/// <reference types="bun" />

import { afterEach, describe, expect, test, vi } from 'bun:test';
import { createApi, type Api, type FetchLike } from '../../lib/client/api';
import { REQUEST_TIMEOUT_MS, WRITE_TIMEOUT_MS } from '../../lib/client/deadline';
import { ApiCallError, describeError } from '../../lib/client/errors';

interface Seen {
  input: string;
  init: RequestInit;
}

function recorder(respond: (input: string) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchLike: FetchLike = async (input, init) => {
    seen.push({ input, init: init ?? {} });
    return respond(input);
  };
  return { seen, api: createApi(fetchLike) };
}

const ok = (body: object) => new Response(JSON.stringify(body), { status: 200 });

describe('api client', () => {
  test('sends the owner key only as a Bearer header to a same-origin relative path', async () => {
    const { api, seen } = recorder(() => ok({ workspace: 'thsm', links: [] }));
    await api.listLinks('thsm', 'KEY');
    const call = seen[0]!;
    expect(call.input).toBe('/api/ns/thsm/links');
    expect(call.input).not.toContain('KEY');
    expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer KEY');
    expect(call.init.credentials).toBe('omit');
    expect(call.init.body).toBeUndefined();
  });

  test('never puts the key or claimToken into URLs or the key into bodies', async () => {
    const { api, seen } = recorder(() => ok({ ok: true }));
    await api.createLink({ url: 'https://x.notion.site/a' }, 'KEY');
    await api.verify('https://x.notion.site/a', 'n', 'TOKEN');
    for (const call of seen) {
      expect(call.input).not.toContain('KEY');
      expect(call.input).not.toContain('TOKEN');
      expect(String(call.init.body ?? '')).not.toContain('KEY');
    }
    expect(JSON.parse(String(seen[1]!.init.body))).toEqual({
      url: 'https://x.notion.site/a',
      nonce: 'n',
      claimToken: 'TOKEN',
    });
  });

  test('encodes path segments', async () => {
    const { api, seen } = recorder(() => ok({ deleted: true }));
    await api.deleteLink('a/b', 'c d', 'K');
    expect(seen[0]!.input).toBe('/api/links/a%2Fb/c%20d');
    expect(seen[0]!.init.method).toBe('DELETE');
  });

  test('preview carries a key only when one is given', async () => {
    const { api, seen } = recorder(() => ok({}));
    await api.preview('https://x.notion.site/a', null);
    await api.preview('https://x.notion.site/a', 'K');
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
    expect((seen[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer K');
  });

  test('typed error bodies become ApiCallError with code and status', async () => {
    const { api } = recorder(
      () =>
        new Response(JSON.stringify({ error: { code: 'slug_taken', message: 'x' } }), {
          status: 409,
        }),
    );
    const error = await api.createLink({ url: 'u' }, 'K').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiCallError);
    expect((error as ApiCallError).code).toBe('slug_taken');
    expect((error as ApiCallError).status).toBe(409);
  });

  test('a rejected fetch is a network error without leaking the cause', async () => {
    const api = createApi(async () => {
      throw new TypeError('Failed to fetch https://x?key=K');
    });
    const error = (await api.preview('u', null).catch((e: unknown) => e)) as ApiCallError;
    expect(error.code).toBe('network');
    expect(error.message).not.toContain('key=');
  });

  test('sweep: an unrouted 404 (HTML) means the endpoint is not deployed', async () => {
    const { api } = recorder(() => new Response('<html>404</html>', { status: 404 }));
    const error = (await api.sweep('thsm', 'K').catch((e: unknown) => e)) as ApiCallError;
    expect(error.code).toBe('not_implemented');
  });

  test('sweep: a typed not_found stays not_found', async () => {
    const { api } = recorder(
      () =>
        new Response(JSON.stringify({ error: { code: 'not_found', message: 'x' } }), {
          status: 404,
        }),
    );
    const error = (await api.sweep('thsm', 'K').catch((e: unknown) => e)) as ApiCallError;
    expect(error.code).toBe('not_found');
  });

  test('sweep posts to the namespace route with the key as a header', async () => {
    const { api, seen } = recorder(() =>
      ok({ workspace: 'thsm', removedLinks: 2, cleanupComplete: true }),
    );
    const result = await api.sweep('thsm', 'K');
    expect(result.removedLinks).toBe(2);
    expect(seen[0]!.input).toBe('/api/ns/thsm/sweep');
    expect(seen[0]!.init.method).toBe('POST');
  });
});

const never = () => new Promise<Response>(() => {});

const rejectsOnAbort: FetchLike = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('aborted', 'AbortError')),
    );
  });

/** Lets the deadline pass and returns what the request ended with. */
async function outcome(pending: Promise<unknown>): Promise<unknown> {
  const settled = pending.catch((e: unknown) => e);
  vi.advanceTimersByTime(WRITE_TIMEOUT_MS);
  return settled;
}

/** An API whose server never answers, on a fake clock; `signals` are the requests' abort signals. */
function hung() {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const fetchLike: FetchLike = (_input, init) => {
    if (init?.signal) signals.push(init.signal);
    return never();
  };
  return { signals, api: createApi(fetchLike) };
}

describe('request deadline', () => {
  afterEach(() => vi.useRealTimers());

  test.each([
    ['preview', (api: Api) => api.preview('https://x.notion.site/a', null)],
    ['challenge', (api: Api) => api.challenge('https://x.notion.site/a', 'claim')],
    ['verify', (api: Api) => api.verify('https://x.notion.site/a', 'n', 't')],
    ['createLink', (api: Api) => api.createLink({ url: 'https://x.notion.site/a' }, 'K')],
    ['updateLink', (api: Api) => api.updateLink('thsm', 'a', { fast: false }, 'K')],
    ['deleteLink', (api: Api) => api.deleteLink('thsm', 'a', 'K')],
    ['listLinks', (api: Api) => api.listLinks('thsm', 'K')],
    ['sweep', (api: Api) => api.sweep('thsm', 'K')],
  ])('%s: a request that never answers ends in a retryable timeout', async (_name, run) => {
    const { api } = hung();
    const error = (await outcome(run(api))) as ApiCallError;
    expect(error).toBeInstanceOf(ApiCallError);
    expect(error.code).toBe('timeout');
    expect(describeError(error)).toContain('try again');
  });

  test('nothing times out before the deadline', async () => {
    const { api } = hung();
    let settled = false;
    void api.listLinks('thsm', 'K').then(
      () => (settled = true),
      () => (settled = true),
    );
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS - 1);
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  test('the hung request is aborted, not left running', async () => {
    const { api, signals } = hung();
    await outcome(api.listLinks('thsm', 'K'));
    expect(signals[0]!.aborted).toBe(true);
  });

  test('a body that never finishes streaming also times out', async () => {
    vi.useFakeTimers();
    const stuckBody = { ok: true, status: 200, json: never } as unknown as Response;
    const api = createApi(async () => stuckBody);
    const error = (await outcome(api.listLinks('thsm', 'K'))) as ApiCallError;
    expect(error.code).toBe('timeout');
  });

  test('both outlive the 60 s a route may run, a write by more than a read', async () => {
    const { api } = hung();
    const outcomes: string[] = [];
    const watch = (name: string, pending: Promise<unknown>) =>
      void pending.then(
        () => outcomes.push(`${name}:ok`),
        (error: unknown) => outcomes.push(`${name}:${(error as ApiCallError).code}`),
      );
    watch('read', api.listLinks('thsm', 'K'));
    watch('verify', api.verify('https://x.notion.site/a', 'n', 't'));
    watch('sweep', api.sweep('thsm', 'K'));
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(outcomes).toEqual(['read:timeout']);
    vi.advanceTimersByTime(WRITE_TIMEOUT_MS - REQUEST_TIMEOUT_MS);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(outcomes.toSorted()).toEqual(['read:timeout', 'sweep:timeout', 'verify:timeout']);
  });

  test('an abort by the caller stays an AbortError, not a timeout', async () => {
    const abort = new AbortController();
    const api = createApi(rejectsOnAbort);
    const pending = api.preview('https://x.notion.site/a', null, abort.signal);
    abort.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
  });

  test('an abort that happened before the call is passed on to the request', async () => {
    const abort = new AbortController();
    abort.abort();
    // Like a real fetch: an already aborted signal rejects at once.
    const api = createApi((_input, init) =>
      init?.signal?.aborted ? Promise.reject(new DOMException('aborted', 'AbortError')) : never(),
    );
    const error = await api
      .preview('https://x.notion.site/a', null, abort.signal)
      .catch((e: unknown) => e);
    expect((error as DOMException).name).toBe('AbortError');
  });
});
