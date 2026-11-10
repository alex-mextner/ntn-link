import { describe, expect, test } from 'bun:test';
import { answerResolve, handleCopy, type CopyDeps, type NotifyState } from '../src/background';
import type { ResolveResult } from '../src/link-service';
import {
  requestChallenge,
  saveOwnerKey,
  setAutoWorkspace,
  verifyChallenge,
} from '../src/options-logic';
import { createKeyStore } from '../src/keys';
import { NOTION_PAGE, ORIGIN, memoryArea, memoryKeys, response, scriptedFetch } from './helpers';

function fakes(result: ResolveResult | 'throw', tabUrl: string | null = NOTION_PAGE) {
  const log = {
    copied: [] as string[],
    notes: [] as Array<[NotifyState, string]>,
    opened: [] as string[],
    kinds: [] as string[],
  };
  const deps: CopyDeps = {
    activeTabUrl: async () => tabUrl ?? undefined,
    resolve: async (_url, kind) => {
      log.kinds.push(kind);
      if (result === 'throw') throw new Error('boom');
      return result;
    },
    copy: async (text) => {
      log.copied.push(text);
    },
    notify: async (state, text) => {
      log.notes.push([state, text]);
    },
    openOptions: async (path) => {
      log.opened.push(path);
    },
  };
  return { deps, log };
}

describe('handleCopy', () => {
  test('ok: copies once and notifies ok', async () => {
    const f = fakes({ ok: true, link: 'https://x.example/a/b' });
    await handleCopy('fast', f.deps);
    expect(f.log.copied).toEqual(['https://x.example/a/b']);
    expect(f.log.notes.map((n) => n[0])).toEqual(['ok']);
    expect(f.log.kinds).toEqual(['fast']);
  });

  test('no_key: opens options with the encoded tab URL and copies nothing', async () => {
    const f = fakes({ ok: false, reason: 'no_key', message: 'No owner key' });
    await handleCopy('pretty', f.deps);
    expect(f.log.copied).toEqual([]);
    expect(f.log.opened).toEqual([`options.html?url=${encodeURIComponent(NOTION_PAGE)}`]);
    expect(f.log.notes[0]?.[0]).toBe('no_key');
  });

  test('not_notion: fixed human message, no copy', async () => {
    const f = fakes({ ok: false, reason: 'not_notion', message: 'internal' });
    await handleCopy('pretty', f.deps);
    expect(f.log.notes).toEqual([['error', 'Open a public Notion page first']]);
    expect(f.log.copied).toEqual([]);
  });

  test.each(['timeout', 'api_error'] as const)('%s: message shown, no copy', async (reason) => {
    const f = fakes({ ok: false, reason, message: 'Try later' });
    await handleCopy('pretty', f.deps);
    expect(f.log.notes).toEqual([['error', 'Try later']]);
    expect(f.log.copied).toEqual([]);
  });

  test('undefined tab URL: error notify, no throw', async () => {
    const f = fakes({ ok: true, link: 'x' }, null);
    await expect(handleCopy('pretty', f.deps)).resolves.toBeUndefined();
    expect(f.log.notes[0]?.[0]).toBe('error');
    expect(f.log.copied).toEqual([]);
  });

  test('resolver that throws is contained', async () => {
    const f = fakes('throw');
    await expect(handleCopy('pretty', f.deps)).resolves.toBeUndefined();
    expect(f.log.notes[0]?.[0]).toBe('error');
  });
});

const policyDeps = () => {
  const net = scriptedFetch((c) => response(404, 'no', c.url));
  return {
    keys: memoryKeys(),
    fetch: net.fetch,
    now: () => 1,
    timeoutMs: 20,
    origin: ORIGIN,
    net,
  };
};

describe('handleCopy overlap', () => {
  test('a slow earlier action does not overwrite a newer copy', async () => {
    const copied: string[] = [];
    const gates: Array<(r: ResolveResult) => void> = [];
    const base = fakes({ ok: true, link: 'x' }).deps;
    const deps: CopyDeps = {
      ...base,
      resolve: () => new Promise((r) => gates.push(r)),
      copy: async (t) => {
        copied.push(t);
      },
    };
    const first = handleCopy('pretty', deps);
    const second = handleCopy('pretty', deps);
    await Bun.sleep(5);
    gates[1]?.({ ok: true, link: 'B' });
    await second;
    gates[0]?.({ ok: true, link: 'A' });
    await first;
    expect(copied).toEqual(['B']);
  });
});

describe('answerResolve budget', () => {
  test('an exhausted page budget yields null with no requests', async () => {
    const d = policyDeps();
    expect(
      await answerResolve({ type: 'ntn-resolve', url: NOTION_PAGE, budgetMs: 100 }, d),
    ).toBeNull();
    expect(d.net.calls).toHaveLength(0);
  });
});

describe('answerResolve', () => {
  test('other message types are not ours', () => {
    expect(answerResolve({ type: 'ntn-offscreen-copy', text: 'x' }, policyDeps())).toBeUndefined();
    expect(answerResolve('hello', policyDeps())).toBeUndefined();
  });

  test('a malformed resolve request yields null with no requests', async () => {
    const d = policyDeps();
    expect(await answerResolve({ type: 'ntn-resolve', url: 5 }, d)).toBeNull();
    expect(d.net.calls).toHaveLength(0);
  });

  test('a request from a default (not enabled) workspace yields null with no requests', async () => {
    const d = policyDeps();
    expect(await answerResolve({ type: 'ntn-resolve', url: NOTION_PAGE }, d)).toBeNull();
    expect(d.net.calls).toHaveLength(0);
  });
});

describe('options logic', () => {
  test('concurrent key saves keep every workspace listed', async () => {
    const area = memoryArea();
    const keys = createKeyStore(area);
    const other = createKeyStore(area);
    await Promise.all([
      saveOwnerKey(other, 'alpha', 'a'.repeat(32)),
      saveOwnerKey(keys, 'beta', 'b'.repeat(32)),
      setAutoWorkspace(keys, 'gamma', true),
    ]);
    expect(await keys.listWorkspaces()).toEqual(['alpha', 'beta', 'gamma']);
  });

  test('auto interception is off by default and persists once toggled', async () => {
    const keys = memoryKeys();
    expect(await keys.isAutoEnabled('thsm')).toBe(false);
    expect(await setAutoWorkspace(keys, ' THSM ', true)).toEqual({ ok: true, workspace: 'thsm' });
    expect(await keys.isAutoEnabled('thsm')).toBe(true);
    expect(await keys.listWorkspaces()).toEqual(['thsm']);
    await setAutoWorkspace(keys, 'thsm', false);
    expect(await keys.isAutoEnabled('thsm')).toBe(false);
  });

  test.each(['', 'a b', 'thsm.notion.site', 'x/y', 'api', 'www'])(
    'invalid workspace %p is rejected and stores nothing',
    async (ws) => {
      const keys = memoryKeys();
      expect((await setAutoWorkspace(keys, ws, true)).ok).toBe(false);
      expect(await keys.listWorkspaces()).toEqual([]);
    },
  );

  test('saving a key does not switch interception on', async () => {
    const keys = memoryKeys();
    expect(await saveOwnerKey(keys, 'thsm', 'x'.repeat(32))).toMatchObject({ ok: true });
    expect(await keys.getKey('thsm')).toBe('x'.repeat(32));
    expect(await keys.isAutoEnabled('thsm')).toBe(false);
    expect((await saveOwnerKey(keys, 'thsm', 'short')).ok).toBe(false);
  });

  test('claim flow: challenge then verify stores the key; claimToken is sent, never stored', async () => {
    const keys = memoryKeys();
    const net = scriptedFetch((c) =>
      c.url.endsWith('/api/challenge')
        ? response(
            200,
            {
              workspace: 'thsm',
              action: 'claim',
              nonce: 'ntn-verify-abc',
              claimToken: 'tok-123',
              expiresAt: '2026-11-10T05:00:00Z',
            },
            c.url,
          )
        : response(
            200,
            { workspace: 'thsm', action: 'claim', ownerKey: 'k'.repeat(40), removedLinks: 0 },
            c.url,
          ),
    );
    const deps = { origin: ORIGIN, fetch: net.fetch };
    const ch = await requestChallenge(deps, NOTION_PAGE, 'claim');
    expect(ch).toMatchObject({ ok: true, nonce: 'ntn-verify-abc', claimToken: 'tok-123' });
    if (!ch.ok) return;
    const v = await verifyChallenge(deps, keys, {
      url: NOTION_PAGE,
      nonce: ch.nonce,
      claimToken: ch.claimToken,
    });
    expect(v).toMatchObject({ ok: true, workspace: 'thsm' });
    expect(await keys.getKey('thsm')).toBe('k'.repeat(40));
    expect(JSON.parse(String(net.calls[1]?.init?.body))).toEqual({
      url: NOTION_PAGE,
      nonce: 'ntn-verify-abc',
      claimToken: 'tok-123',
    });
  });

  test('typed errors from the API are shown as is and store no key', async () => {
    const keys = memoryKeys();
    const net = scriptedFetch((c) =>
      response(
        403,
        { error: { code: 'challenge_invalid', message: 'The nonce was not found on the page.' } },
        c.url,
      ),
    );
    const v = await verifyChallenge({ origin: ORIGIN, fetch: net.fetch }, keys, {
      url: NOTION_PAGE,
      nonce: 'n',
      claimToken: 't',
    });
    expect(v).toEqual({ ok: false, message: 'The nonce was not found on the page.' });
    expect(await keys.getKey('thsm')).toBeNull();
  });
});
