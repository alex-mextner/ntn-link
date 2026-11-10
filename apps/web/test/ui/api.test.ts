/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { createApi, type FetchLike } from '../../lib/client/api';
import { ApiCallError } from '../../lib/client/errors';

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
