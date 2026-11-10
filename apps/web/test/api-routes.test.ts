/**
 * Route-level behaviour of the JSON API: the Next route handlers are called directly with a
 * `Request`, backed by the core service over a MemoryStore and a fake Notion. Covers what the
 * HTTP layer owns: owner-key auth, rate limits, status codes and the error envelope.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { RATE_LIMITS } from '@ntn-link/core';
import { claim, harness, id, pageUrl, type Harness } from '../../../packages/core/test/helpers';
import { POST as createLink } from '../app/api/links/route';
import { POST as sweep } from '../app/api/ns/[workspace]/sweep/route';

const RUNTIME_KEY = Symbol.for('ntn-link.runtime');

let h: Harness;
let key: string;

beforeEach(async () => {
  h = harness();
  (globalThis as Record<symbol, unknown>)[RUNTIME_KEY] = { service: h.service, testFetcher: null };
  h.notion.add(id(1), { workspace: 'thsm', title: 'Home' });
  h.notion.add(id(2), { workspace: 'thsm', title: 'Trips' });
  key = await claim(h, 'thsm', 1);
});

const post = (path: string, body: unknown, bearer?: string): Request =>
  new Request(`https://ntn.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const sweepCall = (workspace: string, bearer?: string): Promise<Response> =>
  sweep(post(`/api/ns/${workspace}/sweep`, undefined, bearer), {
    params: Promise.resolve({ workspace }),
  });

describe('POST /api/ns/<ws>/sweep', () => {
  test('rejects a missing or foreign key with the typed 401 envelope', async () => {
    h.notion.add(id(3), { workspace: 'other', title: 'Foreign' });
    const foreign = await claim(h, 'other', 3);
    for (const bearer of [undefined, 'ntnk_wrong', foreign]) {
      const response = await sweepCall('thsm', bearer);
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        error: { code: 'unauthorized', message: expect.any(String) },
      });
    }
  });

  test('the owner key sweeps gone links and a second call is an idempotent no-op', async () => {
    h.notion.add(id(11), { workspace: 'thsm', title: 'Gone soon' });
    await createLink(post('/api/links', { url: pageUrl('thsm', 11) }, key));
    h.notion.pages.delete(id(11));

    const first = await sweepCall('thsm', key);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      workspace: 'thsm',
      removedLinks: 1,
      cleanupComplete: true,
    });
    const second = await sweepCall('thsm', key);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      workspace: 'thsm',
      removedLinks: 0,
      cleanupComplete: true,
    });
  });

  test('is rate limited per RATE_LIMITS.sweep with a 429 and Retry-After', async () => {
    for (let i = 0; i < RATE_LIMITS.sweep.limit; i++) {
      expect((await sweepCall('thsm', key)).status).toBe(200);
    }
    const limited = await sweepCall('thsm', key);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
  });
});

describe('POST /api/links', () => {
  test('answers 201 for a new link and 200 with the same link on a retry', async () => {
    const first = await createLink(post('/api/links', { url: pageUrl('thsm', 2) }, key));
    expect(first.status).toBe(201);
    const created = await first.json();
    expect(Object.keys(created)).toEqual(['link']);

    const retry = await createLink(post('/api/links', { url: pageUrl('thsm', 2) }, key));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(created);

    const explicit = await createLink(
      post('/api/links', { url: pageUrl('thsm', 2), slug: 'second' }, key),
    );
    expect(explicit.status).toBe(201);
  });

  test('maps failures to the error envelope and status', async () => {
    const noKey = await createLink(post('/api/links', { url: pageUrl('thsm', 2) }));
    expect(noKey.status).toBe(403);
    expect(await noKey.json()).toMatchObject({
      error: { code: 'needs_verification', action: 'rotate' },
    });

    const badBody = await createLink(post('/api/links', { url: 42 }, key));
    expect(badBody.status).toBe(400);
    expect(await badBody.json()).toMatchObject({ error: { code: 'invalid_request' } });

    const notJson = await createLink(
      new Request('https://ntn.test/api/links', { method: 'POST', body: 'nope' }),
    );
    expect(notJson.status).toBe(400);

    const missing = await createLink(post('/api/links', { url: pageUrl('thsm', 404) }, key));
    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({ error: { code: 'not_public' } });

    await createLink(post('/api/links', { url: pageUrl('thsm', 2), slug: 'taken' }, key));
    const taken = await createLink(
      post('/api/links', { url: pageUrl('thsm', 1), slug: 'taken' }, key),
    );
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: { code: 'slug_taken' } });
  });
});
