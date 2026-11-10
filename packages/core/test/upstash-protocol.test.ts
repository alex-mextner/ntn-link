/**
 * UpstashStore's HTTP behaviour at the boundary that needs no server: the official client's
 * read-your-writes sync token is wired through, values stay plain strings, and storage
 * faults surface as ApiError. Atomicity of the Lua scripts is covered against a real Redis in
 * upstash-redis.integration.test.ts.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { ApiError } from '../src/errors';
import { UpstashStore } from '../src/upstash-store';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Handler = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
function stubFetch(handler: Handler): void {
  globalThis.fetch = Object.assign(handler, { preconnect: () => {} });
}

const newStore = (): UpstashStore => new UpstashStore({ url: 'https://redis.test', token: 't' });

describe('UpstashStore read-your-writes', () => {
  test('a read after a write carries the sync token the write returned', async () => {
    const seen: Array<string | null> = [];
    stubFetch(async (_url, init) => {
      const headers = new Headers(init?.headers);
      seen.push(headers.get('upstash-sync-token'));
      return Response.json(
        { result: seen.length === 1 ? 'OK' : 'v' },
        { headers: { 'upstash-sync-token': `w${seen.length}` } },
      );
    });
    const store = newStore();
    await store.set('k', 'v');
    expect(await store.get('k')).toBe('v');
    expect(seen.slice(1)).toEqual(['w1']);
    expect(seen[0] ?? '').toBe('');
  });
});

describe('UpstashStore values', () => {
  test('a stored JSON text comes back as the same string, not a parsed object', async () => {
    const text = '{"keyHash":"abc","claimedAt":"2026-11-10T12:00:00.000Z"}';
    stubFetch(async () => Response.json({ result: text }));
    expect(await newStore().get('ns:x')).toBe(text);
  });

  test('a numeric-looking string stays a string', async () => {
    stubFetch(async () => Response.json({ result: '12345' }));
    expect(await newStore().get('k')).toBe('12345');
  });
});

const replying = (result: unknown): UpstashStore => {
  stubFetch(async () => Response.json({ result }));
  return newStore();
};
const expectUpstreamError = async (pending: Promise<unknown>): Promise<void> => {
  const failure = await pending.catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ApiError);
  expect(failure).toMatchObject({ code: 'upstream_error' });
};

describe('UpstashStore malformed replies', () => {
  test('a 200 reply with an object where a string belongs is a fault, not a missing record', async () => {
    await expectUpstreamError(replying({ keyHash: 'abc' }).get('ns:x'));
    await expectUpstreamError(replying(7).get('ns:x'));
  });

  test('a set reply that is not an array of strings is a fault', async () => {
    await expectUpstreamError(replying({ a: 1 }).setMembers('s'));
    await expectUpstreamError(replying(['a', 1]).setMembers('s'));
  });

  test('script and command results outside the documented values are faults', async () => {
    await expectUpstreamError(replying('yes').compareAndSet('k', 'a', 'b'));
    await expectUpstreamError(replying(5).createIndexed('k', 'v', 's', 'm', 3));
    await expectUpstreamError(replying(null).deleteIndexed('k', 's', 'm'));
    await expectUpstreamError(
      replying('x').moveIndexed({
        from: 'a',
        to: 'b',
        setKey: 's',
        fromMember: 'f',
        toMember: 't',
        expectedFrom: 'v',
        value: 'n',
      }),
    );
    await expectUpstreamError(replying('x').increment('k', 60));
    await expectUpstreamError(replying(3).delete('k'));
    await expectUpstreamError(replying('NOPE').set('k', 'v'));
  });

  test('well-formed replies still map to the Store contract', async () => {
    expect(await replying(null).get('k')).toBeNull();
    expect(await replying(['a', 'b']).setMembers('s')).toEqual(['a', 'b']);
    expect(await replying(1).createIndexed('k', 'v', 's', 'm', 3)).toBe('created');
    expect(await replying(2).createIndexed('k', 'v', 's', 'm', 3)).toBe('full');
    expect(await replying(0).createIndexed('k', 'v', 's', 'm', 3)).toBe('exists');
    expect(await replying(null).set('k', 'v', { ifAbsent: true })).toBe(false);
  });
});

describe('UpstashStore faults', () => {
  test('an unreachable backend is an upstream_error, not a raw fetch error', async () => {
    stubFetch(async () => {
      throw new TypeError('network down');
    });
    const failure = await newStore()
      .get('k')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ code: 'upstream_error' });
  });

  test('a command the backend rejects is an upstream_error that does not echo the command', async () => {
    stubFetch(async () => Response.json({ error: 'ERR boom' }, { status: 400 }));
    const failure = await newStore()
      .set('secret-key', 'secret-value')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ code: 'upstream_error' });
    expect(String((failure as Error).message)).not.toContain('secret');
  });

  test('a failed request is not retried, so a counter cannot be applied twice', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls++;
      throw new TypeError('connection reset');
    });
    await newStore()
      .increment('k', 60)
      .catch(() => undefined);
    expect(calls).toBe(1);
  });
});

/** Like real fetch: never answers, but rejects with the signal's reason when it aborts. */
function hangingFetch(): void {
  stubFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
  );
}

describe('UpstashStore timeouts and failure logging', () => {
  test('a backend that never answers is an upstream_error within the timeout, for every command kind', async () => {
    hangingFetch();
    const log = spyOn(console, 'error').mockImplementation(() => {});
    const store = new UpstashStore({ url: 'https://redis.test', token: 't', timeoutMs: 40 });
    const started = Date.now();
    for (const call of [
      () => store.get('k'),
      () => store.increment('k', 60),
      () => store.compareAndSet('k', 'a', 'b'),
    ]) {
      const failure = await call().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure).toMatchObject({ code: 'upstream_error', status: 502 });
    }
    expect(Date.now() - started).toBeLessThan(1500);
    log.mockRestore();
  });

  test('each request gets a fresh deadline, a later call is not born aborted', async () => {
    let calls = 0;
    stubFetch(async (_url, init) => {
      calls++;
      expect(init?.signal?.aborted).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, calls === 1 ? 60 : 0));
      return Response.json({ result: 'v' });
    });
    const store = new UpstashStore({ url: 'https://redis.test', token: 't', timeoutMs: 40 });
    expect(await store.get('a')).toBe('v');
    expect(await store.get('b')).toBe('v');
  });

  test('logs one structured line with command and class, and never a secret', async () => {
    // Built at run time: a token-shaped literal in the source trips the repo secret scan.
    const secret = btoa('synthetic-credential-for-redaction-test');
    stubFetch(async () => {
      throw new TypeError(`connect failed https://default:${secret}@redis.test/ token ${secret}`);
    });
    const log = spyOn(console, 'error').mockImplementation(() => {});
    const store = newStore();
    await store.set('user-key-123', 'user-value-456').catch(() => undefined);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      event: 'storage_failure',
      command: 'SET',
      errorClass: 'TypeError',
      kind: 'network',
    });
    for (const forbidden of [secret, 'redis.test', 'user-key-123', 'user-value-456']) {
      expect(line).not.toContain(forbidden);
    }
    log.mockRestore();
  });

  test('backend error text and its echoed command never reach the log', async () => {
    stubFetch(async () => Response.json({ error: 'ERR boom' }, { status: 400 }));
    const log = spyOn(console, 'error').mockImplementation(() => {});
    await newStore()
      .set('secret-key', 'secret-value')
      .catch(() => undefined);
    const line = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({ kind: 'backend-error' });
    expect(line).not.toContain('secret');
    expect(line).not.toContain('boom');
    log.mockRestore();
  });

  test('a truncated reply never puts the stored value into the log', async () => {
    stubFetch(async () => new Response('{"result":"PIN 1234 and a few more words"'));
    const log = spyOn(console, 'error').mockImplementation(() => {});
    const failure = await newStore()
      .get('k')
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'upstream_error' });
    const line = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({ kind: 'bad-reply' });
    for (const forbidden of ['PIN', '1234', 'words']) expect(line).not.toContain(forbidden);
    log.mockRestore();
  });

  test('identical failures are logged once per window, different ones separately', async () => {
    stubFetch(async () => {
      throw new TypeError('down');
    });
    const log = spyOn(console, 'error').mockImplementation(() => {});
    const store = newStore();
    for (let n = 0; n < 5; n++) await store.get('k').catch(() => undefined);
    expect(log).toHaveBeenCalledTimes(1);
    await store.delete('k').catch(() => undefined);
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});
