/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import type { LinkView } from '../../../../packages/core/src/api-types';
import { createController, type Controller } from '../../lib/client/controller';
import {
  createStore,
  flowSteps,
  initialState,
  reducer,
  previewCard,
  visibleUrlError,
  type Action,
  type FlowState,
  pendingActions,
  type Store,
} from '../../lib/client/flow';
import { loadKey } from '../../lib/client/keys';
import {
  MemoryStorage,
  PAGE_URL,
  apiError,
  type Call,
  challengeFixture,
  fakeApi,
  linkFixture,
  previewFixture,
  verifyFixture,
} from './helpers';

const ORIGIN = 'https://ntn.test';
const KEY_NAME = `ntn-link:owner-key:${ORIGIN}:thsm`;

interface Ctx {
  store: Store<FlowState, Action>;
  controller: Controller;
  storage: MemoryStorage;
  calls: Call[];
  type(url?: string): void;
}

function setup(script: Parameters<typeof fakeApi>[0] = {}, storage = new MemoryStorage()): Ctx {
  const { api, calls } = fakeApi(script);
  const store = createStore(reducer, initialState);
  const controller: Controller = createController(store, { api, storage, origin: ORIGIN }, storage);
  const type = (url = PAGE_URL) => store.dispatch({ type: 'url_changed', url });
  return { store, controller, storage, calls, type };
}

async function toAwaitingProof(ctx: Ctx) {
  ctx.type();
  await ctx.controller.loadPreview();
  await ctx.controller.create();
  await ctx.controller.requestChallenge();
}

async function toCreated(ctx: Ctx) {
  await toAwaitingProof(ctx);
  await ctx.controller.verify();
  await ctx.controller.create();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('reducer', () => {
  test('changing the URL discards preview, verification and result', () => {
    let state = reducer(initialState, { type: 'url_changed', url: 'a' });
    state = reducer(state, { type: 'preview_started' });
    state = reducer(state, {
      type: 'preview_loaded',
      preview: previewFixture(),
      keyUntested: false,
    });
    expect(state.phase).toBe('ready');
    state = reducer(state, { type: 'url_changed', url: 'b' });
    expect(state).toEqual({ ...initialState, url: 'b' });
  });

  test('a stale preview answer after the URL changed is ignored', () => {
    let state = reducer(initialState, { type: 'url_changed', url: 'a' });
    state = reducer(state, { type: 'preview_started' });
    state = reducer(state, { type: 'url_changed', url: 'b' });
    const after = reducer(state, {
      type: 'preview_loaded',
      preview: previewFixture(),
      keyUntested: false,
    });
    expect(after.phase).toBe('idle');
    expect(after.preview).toBeNull();
  });

  test('a user-edited slug survives a later preview', () => {
    let state = reducer(initialState, { type: 'preview_started' });
    state = { ...state, slugTouched: true, slug: 'mine' };
    state = reducer(state, {
      type: 'preview_loaded',
      preview: previewFixture(),
      keyUntested: false,
    });
    expect(state.slug).toBe('mine');
  });

  test('slug edits are lower-cased and clear a slug error only', () => {
    const base = {
      ...initialState,
      error: { code: 'slug_taken', message: 'm', scope: 'slug' as const },
    };
    expect(reducer(base, { type: 'slug_changed', slug: 'AbC' })).toMatchObject({
      slug: 'abc',
      error: null,
    });
    const general = {
      ...initialState,
      error: { code: 'network', message: 'm', scope: 'general' as const },
    };
    expect(reducer(general, { type: 'slug_changed', slug: 'x' }).error).not.toBeNull();
  });
});

const failure = (code: string, scope: 'url' | 'slug' | 'general') => ({
  code,
  message: 'm',
  scope,
});

describe('card preview', () => {
  const base = { ...initialState, preview: previewFixture() };

  test('shows the Notion card until an override is typed', () => {
    expect(previewCard(base)?.title).toBe('Наши с Леночкой Путешествия');
    expect(previewCard(base)?.description).toBe('Описание');
  });

  test('applies overrides with the same trimming as creation, and falls back when cleared', () => {
    const edited = { ...base, title: '  Мой заголовок ', description: ' Моё описание ' };
    expect(previewCard(edited)).toMatchObject({
      title: 'Мой заголовок',
      description: 'Моё описание',
    });
    const cleared = { ...edited, title: '   ', description: '' };
    expect(previewCard(cleared)).toMatchObject({
      title: 'Наши с Леночкой Путешествия',
      description: 'Описание',
    });
  });

  test('is null without a preview', () => {
    expect(previewCard(initialState)).toBeNull();
  });
});

describe('where errors are shown', () => {
  test.each(['network', 'upstream_error', 'rate_limited'])(
    'a failed preview (%s) is shown at the URL field even though it is not URL-scoped',
    (code) => {
      let state = reducer(initialState, { type: 'url_changed', url: 'a' });
      state = reducer(state, { type: 'preview_started' });
      state = reducer(state, { type: 'preview_failed', error: failure(code, 'general') });
      expect(visibleUrlError(state)?.code).toBe(code);
    },
  );

  test('create-time general errors stay in the form, not at the URL field', () => {
    const state = {
      ...initialState,
      phase: 'ready' as const,
      preview: previewFixture(),
      error: failure('network', 'general'),
    };
    expect(visibleUrlError(state)).toBeNull();
  });

  test('during verification errors belong to the verification step only', () => {
    const state = {
      ...initialState,
      phase: 'awaiting_proof' as const,
      preview: previewFixture(),
      error: failure('not_public', 'url'),
    };
    expect(visibleUrlError(state)).toBeNull();
  });
});

describe('create flow', () => {
  test('preview of an unclaimed workspace proposes the slug and flags verification', async () => {
    const { store, controller, type } = setup();
    type();
    await controller.loadPreview();
    const state = store.getState();
    expect(state.phase).toBe('ready');
    expect(state.slug).toBe('nashi-s-lenochkoy-puteshestviya');
    expect(state.preview?.needsVerification).toBe(true);
  });

  test('preview failure surfaces an English message on the URL field', async () => {
    const { store, controller, type } = setup({ preview: [apiError('not_public', 422)] });
    type();
    await controller.loadPreview();
    expect(store.getState().phase).toBe('idle');
    expect(store.getState().error).toMatchObject({ code: 'not_public', scope: 'url' });
    expect(store.getState().error?.message).toMatch(/not public/);
  });

  test('a stored key is sent with the preview of its own workspace only', async () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY_NAME, 'K-THSM');
    const { controller, calls, type } = setup({}, storage);
    type();
    await controller.loadPreview();
    expect(calls[0]!.name).toBe('preview');
    expect(calls[0]!.args.slice(0, 2)).toEqual([PAGE_URL, 'K-THSM']);
    type('https://other.notion.site/413d447ac4b180169985c93eea7f02f9');
    await controller.loadPreview();
    expect(calls[1]!.args[1]).toBeNull();
  });

  test('without a key, Create goes straight to the ownership step (no API call)', async () => {
    const { store, controller, calls, type } = setup();
    type();
    await controller.loadPreview();
    await controller.create();
    expect(store.getState().phase).toBe('needs_verification');
    expect(store.getState().verifyAction).toBe('claim');
    expect(calls.map((c) => c.name)).toEqual(['preview']);
  });

  test('full journey: preview, verification, key stored, form unlocked, link created', async () => {
    const ctx = setup({ createLink: [{ link: linkFixture('nashi-s-lenochkoy-puteshestviya') }] });
    ctx.type();
    await ctx.controller.loadPreview();
    ctx.store.dispatch({ type: 'title_changed', title: '  Мой заголовок ' });
    await ctx.controller.create();
    await ctx.controller.requestChallenge();
    expect(ctx.store.getState().phase).toBe('awaiting_proof');
    expect(ctx.store.getState().verification?.nonce).toBe(challengeFixture.nonce);

    await ctx.controller.verify();
    let state = ctx.store.getState();
    // Verification must NOT create the link: the proof code is still in the Notion title.
    expect(state.phase).toBe('ready');
    expect(state.notice).toBe('verified');
    expect(state.preview?.needsVerification).toBe(false);
    expect(state.verification).toBeNull();
    expect(ctx.calls.some((c) => c.name === 'createLink')).toBe(false);
    expect(loadKey(ctx.storage, ORIGIN, 'thsm')).toBe(verifyFixture.ownerKey);

    await ctx.controller.create();
    state = ctx.store.getState();
    expect(state.phase).toBe('created');
    expect(state.result?.keySaved).toBe(true);
    const create = ctx.calls.find((c) => c.name === 'createLink')!;
    expect(create.args[0]).toEqual({
      url: PAGE_URL,
      slug: 'nashi-s-lenochkoy-puteshestviya',
      fast: true,
      overrides: { title: 'Мой заголовок' },
    });
    expect(create.args[1]).toBe(verifyFixture.ownerKey);
  });

  test('verify submits the proof page URL when one is given, else the linked page', async () => {
    const other = 'https://thsm.notion.site/Other-0123456789abcdef0123456789abcdef';
    const withProof = setup();
    await toAwaitingProof(withProof);
    withProof.store.dispatch({ type: 'proof_url_changed', url: `  ${other} ` });
    await withProof.controller.verify();
    expect(withProof.calls.find((c) => c.name === 'verify')!.args[0]).toBe(other);

    const plain = setup();
    await toAwaitingProof(plain);
    await plain.controller.verify();
    expect(plain.calls.find((c) => c.name === 'verify')!.args[0]).toBe(PAGE_URL);
  });

  test('the claimToken is never stored; the owner key only in the key slot', async () => {
    const ctx = setup();
    await toAwaitingProof(ctx);
    await ctx.controller.verify();
    expect(JSON.stringify([...ctx.storage.map.entries()])).not.toContain(
      challengeFixture.claimToken,
    );
    expect([...ctx.storage.map.keys()]).toEqual([KEY_NAME]);
    expect(JSON.stringify(ctx.store.getState())).not.toContain(challengeFixture.claimToken);
    expect(JSON.stringify(ctx.store.getState())).not.toContain(verifyFixture.ownerKey);
  });

  test('nothing is logged to the console during the journey', async () => {
    const original = { ...console };
    const logged: unknown[][] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      console[method] = (...args: unknown[]) => void logged.push(args);
    }
    try {
      const ctx = setup({ verify: [apiError('nonce_not_found', 422), verifyFixture] });
      await toAwaitingProof(ctx);
      await ctx.controller.verify();
      await ctx.controller.verify();
    } finally {
      Object.assign(console, original);
    }
    expect(logged).toEqual([]);
  });

  test('nonce_not_found keeps the same challenge so the user can retry after fixing the page', async () => {
    const ctx = setup({ verify: [apiError('nonce_not_found', 422), verifyFixture] });
    await toAwaitingProof(ctx);
    await ctx.controller.verify();
    expect(ctx.store.getState().phase).toBe('awaiting_proof');
    expect(ctx.store.getState().verification?.claimToken).toBe(challengeFixture.claimToken);
    expect(ctx.store.getState().error?.code).toBe('nonce_not_found');
    await ctx.controller.verify();
    expect(ctx.store.getState().phase).toBe('ready');
    expect(loadKey(ctx.storage, ORIGIN, 'thsm')).toBe(verifyFixture.ownerKey);
  });

  test.each(['challenge_expired', 'challenge_invalid'] as const)(
    '%s drops the token and asks for a new code',
    async (code) => {
      const ctx = setup({ verify: [apiError(code, 410)] });
      await toAwaitingProof(ctx);
      await ctx.controller.verify();
      expect(ctx.store.getState().phase).toBe('needs_verification');
      expect(ctx.store.getState().verification).toBeNull();
      expect(ctx.store.getState().error?.code).toBe(code);
    },
  );

  test('a stale stored key (unauthorized) is forgotten and the ownership flow restarts as rotate', async () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY_NAME, 'OLD');
    const { store, controller, type } = setup(
      {
        preview: [
          previewFixture({
            needsVerification: false,
            suggestedAction: null,
            namespaceClaimed: true,
          }),
        ],
        createLink: [apiError('unauthorized', 401)],
      },
      storage,
    );
    type();
    await controller.loadPreview();
    await controller.create();
    expect(store.getState().phase).toBe('needs_verification');
    expect(store.getState().verifyAction).toBe('rotate');
    expect(loadKey(storage, ORIGIN, 'thsm')).toBeNull();
  });

  test('server-driven needs_verification uses the action the server names', async () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY_NAME, 'K');
    const { store, controller, type } = setup(
      {
        preview: [previewFixture({ needsVerification: false, suggestedAction: null })],
        createLink: [apiError('needs_verification', 403, { action: 'rotate' })],
      },
      storage,
    );
    type();
    await controller.loadPreview();
    await controller.create();
    expect(store.getState().verifyAction).toBe('rotate');
  });

  test('a stored key is tried even when the preview said needsVerification (the server decides)', async () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY_NAME, 'MAYBE-GOOD');
    const { store, controller, calls, type } = setup(
      { preview: [previewFixture({ namespaceClaimed: true, suggestedAction: 'rotate' })] },
      storage,
    );
    type('https://www.notion.so/thsm/Page-413d447ac4b180169985c93eea7f02f9');
    await controller.loadPreview();
    await controller.create();
    expect(calls.find((c) => c.name === 'createLink')!.args[1]).toBe('MAYBE-GOOD');
    expect(store.getState().phase).toBe('created');
  });

  test('a stored key the preview request did not carry keeps the create step current, even after slug_taken', async () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY_NAME, 'MAYBE-GOOD');
    const { store, controller, type } = setup(
      {
        preview: [previewFixture({ namespaceClaimed: true, suggestedAction: 'rotate' })],
        createLink: [apiError('slug_taken', 409)],
      },
      storage,
    );
    const highlighted = () =>
      flowSteps(store.getState())
        .filter((step) => step.status === 'current' || step.status === 'busy')
        .map((step) => step.id);
    type('https://www.notion.so/thsm/Page-413d447ac4b180169985c93eea7f02f9');
    await controller.loadPreview();
    expect(highlighted()).toEqual(['create']);
    await controller.create();
    expect(store.getState().error).toMatchObject({ code: 'slug_taken' });
    expect(highlighted()).toEqual(['create']);
  });

  test('a key stored for another workspace than the one hinted by the URL is still untested', async () => {
    const storage = new MemoryStorage();
    storage.setItem(`ntn-link:owner-key:${ORIGIN}:other`, 'FOR-OTHER');
    storage.setItem(KEY_NAME, 'FOR-THSM');
    const { store, controller, type } = setup({ preview: [previewFixture()] }, storage);
    type('https://other.notion.site/Page-413d447ac4b180169985c93eea7f02f9');
    await controller.loadPreview();
    expect(store.getState().keyUntested).toBe(true);
    expect(flowSteps(store.getState()).find((s) => s.status === 'current')?.id).toBe('create');
  });

  test('a key replaced while the preview was in flight is still untested', async () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY_NAME, 'OLD');
    const gate = deferred<ReturnType<typeof previewFixture>>();
    const { store, controller, type } = setup({ preview: [gate.promise] }, storage);
    type();
    const pending = controller.loadPreview();
    storage.setItem(KEY_NAME, 'NEW');
    gate.resolve(previewFixture());
    await pending;
    expect(store.getState().keyUntested).toBe(true);
  });

  test('the key the preview carried is judged by the server, not untested', async () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY_NAME, 'K');
    const { store, controller, type } = setup({ preview: [previewFixture()] }, storage);
    type();
    await controller.loadPreview();
    expect(store.getState().keyUntested).toBe(false);
    expect(flowSteps(store.getState()).find((s) => s.status === 'current')?.id).toBe('verify');
  });

  test('slug_taken after a fresh verification keeps the new key for the retry', async () => {
    const ctx = setup({
      createLink: [apiError('slug_taken', 409), { link: linkFixture('other') }],
    });
    await toAwaitingProof(ctx);
    await ctx.controller.verify();
    await ctx.controller.create();
    expect(ctx.store.getState().error).toMatchObject({ code: 'slug_taken' });
    expect(loadKey(ctx.storage, ORIGIN, 'thsm')).toBe(verifyFixture.ownerKey);
    ctx.store.dispatch({ type: 'slug_changed', slug: 'other' });
    await ctx.controller.create();
    expect(ctx.store.getState().phase).toBe('created');
    const sent = ctx.calls.filter((c) => c.name === 'createLink');
    expect(sent.map((c) => c.args[1])).toEqual([verifyFixture.ownerKey, verifyFixture.ownerKey]);
  });

  test('an abandoned flow does not act on the one that replaced it', async () => {
    const gate = deferred<typeof verifyFixture>();
    const ctx = setup({ verify: [gate.promise] });
    await toAwaitingProof(ctx);
    const pending = ctx.controller.verify();
    ctx.type('https://thsm.notion.site/Another-00000000000000000000000000000001');
    await ctx.controller.loadPreview();
    expect(ctx.store.getState().phase).toBe('ready');
    gate.resolve(verifyFixture);
    await pending;
    const state = ctx.store.getState();
    expect(state.phase).toBe('ready');
    expect(state.notice).toBeNull();
    expect(state.url).toContain('Another');
    expect(ctx.calls.some((c) => c.name === 'createLink')).toBe(false);
    // The key itself is valid for its workspace regardless of what the user did meanwhile.
    expect(loadKey(ctx.storage, ORIGIN, 'thsm')).toBe(verifyFixture.ownerKey);
  });

  test('an older verification answer cannot overwrite the key of a newer one', async () => {
    const gate = deferred<typeof verifyFixture>();
    const ctx = setup({ verify: [gate.promise, { ...verifyFixture, ownerKey: 'K2' }] });
    await toAwaitingProof(ctx);
    const older = ctx.controller.verify();
    // The user starts over for the same workspace and finishes that verification first.
    ctx.type('https://thsm.notion.site/Again-00000000000000000000000000000002');
    await ctx.controller.loadPreview();
    await ctx.controller.create();
    await ctx.controller.requestChallenge();
    await ctx.controller.verify();
    expect(loadKey(ctx.storage, ORIGIN, 'thsm')).toBe('K2');
    gate.resolve({ ...verifyFixture, ownerKey: 'K1' });
    await older;
    expect(loadKey(ctx.storage, ORIGIN, 'thsm')).toBe('K2');
  });

  test('restarting the preview for the same URL invalidates a create still in flight', async () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY_NAME, 'K');
    const first = deferred<{ link: LinkView }>();
    const second = deferred<{ link: LinkView }>();
    const ctx = setup(
      {
        preview: [
          previewFixture({ needsVerification: false }),
          previewFixture({ needsVerification: false }),
        ],
        createLink: [first.promise, second.promise],
      },
      storage,
    );
    ctx.type();
    await ctx.controller.loadPreview();
    ctx.store.dispatch({ type: 'slug_changed', slug: 'first' });
    const pendingFirst = ctx.controller.create();
    await ctx.controller.loadPreview(); // Enter pressed in the unchanged URL field
    ctx.store.dispatch({ type: 'slug_changed', slug: 'second' });
    const pendingSecond = ctx.controller.create();
    first.resolve({ link: linkFixture('first') });
    await pendingFirst;
    expect(ctx.store.getState().result).toBeNull();
    second.resolve({ link: linkFixture('second') });
    await pendingSecond;
    expect(ctx.store.getState().result?.link.slug).toBe('second');
  });

  test('namespace_claimed on the challenge switches the action to rotate for the retry', async () => {
    const ctx = setup({ challenge: [apiError('namespace_claimed', 409)] });
    ctx.type();
    await ctx.controller.loadPreview();
    await ctx.controller.create();
    expect(ctx.store.getState().verifyAction).toBe('claim');
    await ctx.controller.requestChallenge();
    expect(ctx.store.getState().phase).toBe('needs_verification');
    expect(ctx.store.getState().verifyAction).toBe('rotate');
    await ctx.controller.requestChallenge();
    const sent = ctx.calls.filter((c) => c.name === 'challenge').map((c) => c.args[1]);
    expect(sent).toEqual(['claim', 'rotate']);
  });

  test('namespace_not_claimed on the challenge switches the action back to claim', async () => {
    const ctx = setup({
      preview: [previewFixture({ namespaceClaimed: true, suggestedAction: 'rotate' })],
      challenge: [apiError('namespace_not_claimed', 409)],
    });
    ctx.type();
    await ctx.controller.loadPreview();
    await ctx.controller.create();
    await ctx.controller.requestChallenge();
    expect(ctx.store.getState().verifyAction).toBe('claim');
  });

  test('a late challenge answer for an abandoned URL is dropped', async () => {
    const gate = deferred<typeof challengeFixture>();
    const ctx = setup({ challenge: [gate.promise] });
    ctx.type();
    await ctx.controller.loadPreview();
    await ctx.controller.create();
    const pending = ctx.controller.requestChallenge();
    ctx.type('https://thsm.notion.site/Another-00000000000000000000000000000001');
    gate.resolve(challengeFixture);
    await pending;
    expect(ctx.store.getState().verification).toBeNull();
    expect(ctx.store.getState().phase).toBe('idle');
  });

  test('slug_taken returns to the form with the error on the slug field', async () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY_NAME, 'K');
    const { store, controller, type } = setup(
      {
        preview: [previewFixture({ needsVerification: false })],
        createLink: [apiError('slug_taken', 409)],
      },
      storage,
    );
    type();
    await controller.loadPreview();
    await controller.create();
    expect(store.getState().phase).toBe('ready');
    expect(store.getState().error).toMatchObject({ code: 'slug_taken', scope: 'slug' });
  });

  test('an invalid slug is never sent', async () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY_NAME, 'K');
    const { store, controller, calls, type } = setup(
      { preview: [previewFixture({ needsVerification: false })] },
      storage,
    );
    type();
    await controller.loadPreview();
    store.dispatch({ type: 'slug_changed', slug: 'Bad Slug' });
    await controller.create();
    expect(calls.some((c) => c.name === 'createLink')).toBe(false);
  });

  test('when the browser refuses to store the key it is used from memory and the user is told', async () => {
    const storage = new MemoryStorage();
    storage.fail = true;
    const ctx = setup({}, storage);
    await toAwaitingProof(ctx);
    await ctx.controller.verify();
    await ctx.controller.create();
    expect(ctx.store.getState().phase).toBe('created');
    expect(ctx.store.getState().result?.keySaved).toBe(false);
    expect(ctx.calls.find((c) => c.name === 'createLink')!.args[1]).toBe(verifyFixture.ownerKey);
    expect(storage.map.size).toBe(0);
  });

  test('network failure while creating keeps the form and shows a retryable message', async () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY_NAME, 'K');
    const { store, controller, type } = setup(
      {
        preview: [previewFixture({ needsVerification: false })],
        createLink: [apiError('network', 0)],
      },
      storage,
    );
    type();
    await controller.loadPreview();
    await controller.create();
    expect(store.getState().phase).toBe('ready');
    expect(store.getState().error?.code).toBe('network');
  });
});

describe('result panel actions', () => {
  test('fast toggle PATCHes {fast} with the stored key', async () => {
    const ctx = setup();
    await toCreated(ctx);
    await ctx.controller.setFast(false);
    const patch = ctx.calls.find((c) => c.name === 'updateLink')!;
    expect(patch.args.slice(0, 3)).toEqual(['thsm', 'nashi', { fast: false }]);
    expect(patch.args[3]).toBe(verifyFixture.ownerKey);
  });

  test('a fast-toggle answer for another link is ignored', () => {
    const created = reducer(
      { ...initialState, phase: 'creating' },
      { type: 'create_succeeded', link: linkFixture('b'), keySaved: true },
    );
    const after = reducer(created, {
      type: 'link_fast_changed',
      workspace: 'thsm',
      slug: 'a',
      fast: false,
    });
    expect(after.result?.link.fast).toBe(true);
    const own = reducer(created, {
      type: 'link_fast_changed',
      workspace: 'thsm',
      slug: 'b',
      fast: false,
    });
    expect(own.result?.link.fast).toBe(false);
    expect(own.result?.link.fastUrl).toBeNull();
  });

  test('a failed fast toggle shows an error but keeps the result', async () => {
    const ctx = setup({ updateLink: [apiError('upstream_error', 502)] });
    await toCreated(ctx);
    await ctx.controller.setFast(false);
    expect(ctx.store.getState().phase).toBe('created');
    expect(ctx.store.getState().error?.message).toMatch(/fast mode/i);
  });
});

describe('cleanup after rotation', () => {
  const incomplete = {
    ...verifyFixture,
    action: 'rotate' as const,
    removedLinks: 3,
    cleanupComplete: false,
  };

  async function rotated(script: Parameters<typeof fakeApi>[0] = {}) {
    const ctx = setup({ verify: [incomplete], ...script });
    await toAwaitingProof(ctx);
    await ctx.controller.verify();
    return ctx;
  }

  test('an unfinished cleanup of one workspace survives a clean verification of another', async () => {
    const other = { ...verifyFixture, workspace: 'other', ownerKey: 'OTHER-KEY' };
    const ctx = setup({
      verify: [incomplete, other],
      preview: [previewFixture(), previewFixture({ workspace: 'other' })],
    });
    await toAwaitingProof(ctx);
    await ctx.controller.verify();
    ctx.type('https://other.notion.site/413d447ac4b180169985c93eea7f02f9');
    await ctx.controller.loadPreview();
    await ctx.controller.create();
    await ctx.controller.requestChallenge();
    await ctx.controller.verify();
    expect(ctx.store.getState().cleanups).toHaveLength(1);
    expect(ctx.store.getState().cleanups[0]).toMatchObject({
      workspace: 'thsm',
      status: 'pending',
    });
  });

  test('a late sweep answer cannot overwrite a newer cleanup entry of the same workspace', async () => {
    const gate = deferred<{ workspace: string; removedLinks: number; cleanupComplete: boolean }>();
    const ctx = await rotated({ sweep: [gate.promise] });
    const pending = ctx.controller.runCleanup('thsm');
    expect(ctx.store.getState().cleanups[0]?.status).toBe('running');
    // A fresh rotation of the same workspace installs a new pending entry meanwhile.
    ctx.store.dispatch({
      type: 'cleanup_set',
      workspace: 'thsm',
      cleanup: { workspace: 'thsm', removedLinks: 9, status: 'pending', message: null },
    });
    gate.resolve({ workspace: 'thsm', removedLinks: 1, cleanupComplete: true });
    await pending;
    expect(ctx.store.getState().cleanups[0]).toMatchObject({ removedLinks: 9, status: 'pending' });
  });

  test('cleanupComplete=false offers a finish-cleanup action', async () => {
    const { store } = await rotated();
    expect(store.getState().cleanups[0]).toMatchObject({
      workspace: 'thsm',
      removedLinks: 3,
      status: 'pending',
    });
  });

  test('cleanupComplete=true shows none', async () => {
    const ctx = setup();
    await toAwaitingProof(ctx);
    await ctx.controller.verify();
    expect(ctx.store.getState().cleanups).toEqual([]);
  });

  test('running it calls the sweep endpoint with the new key and reports completion', async () => {
    const ctx = await rotated({
      sweep: [{ workspace: 'thsm', removedLinks: 2, cleanupComplete: true }],
    });
    await ctx.controller.runCleanup('thsm');
    const sweep = ctx.calls.find((c) => c.name === 'sweep')!;
    expect(sweep.args).toEqual(['thsm', verifyFixture.ownerKey]);
    expect(ctx.store.getState().cleanups[0]).toMatchObject({ status: 'done', removedLinks: 5 });
  });

  test('an incomplete sweep can be run again', async () => {
    const ctx = await rotated({
      sweep: [{ workspace: 'thsm', removedLinks: 0, cleanupComplete: false }],
    });
    await ctx.controller.runCleanup('thsm');
    expect(ctx.store.getState().cleanups[0]?.status).toBe('incomplete');
  });

  test('a server without the endpoint is reported as unsupported', async () => {
    const ctx = await rotated({ sweep: [apiError('not_implemented', 404)] });
    await ctx.controller.runCleanup('thsm');
    expect(ctx.store.getState().cleanups[0]?.status).toBe('unsupported');
    expect(ctx.store.getState().cleanups[0]?.message).toMatch(/does not support/);
  });
});

describe('my links', () => {
  test('lists workspaces with a stored key for this origin only', () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY_NAME, 'K');
    storage.setItem('ntn-link:owner-key:https://evil.test:thsm2', 'K');
    const { controller } = setup({}, storage);
    expect(controller.listWorkspaces()).toEqual(['thsm']);
  });

  test('loads links with the stored key; a rejected key is forgotten', async () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY_NAME, 'K');
    const ok = setup({}, storage);
    expect((await ok.controller.loadLinks('thsm')).links).toHaveLength(1);

    const bad = setup({ listLinks: [apiError('unauthorized', 401)] }, storage);
    const result = await bad.controller.loadLinks('thsm');
    expect(result.status).toBe('error');
    expect(loadKey(storage, ORIGIN, 'thsm')).toBeNull();
  });

  test('a late unauthorized for an old key does not erase the replacement key', async () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY_NAME, 'OLD');
    const gate = deferred<never>();
    const ctx = setup({ listLinks: [gate.promise] }, storage);
    const pending = ctx.controller.loadLinks('thsm');
    storage.setItem(KEY_NAME, 'NEW');
    gate.reject(apiError('unauthorized', 401));
    await pending;
    expect(loadKey(storage, ORIGIN, 'thsm')).toBe('NEW');
  });

  test('delete returns null on success and an English message on failure', async () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY_NAME, 'K');
    const ctx = setup({ deleteLink: [{ deleted: true }, apiError('not_found', 404)] }, storage);
    expect(await ctx.controller.deleteLink('thsm', 'a')).toBeNull();
    expect(await ctx.controller.deleteLink('thsm', 'a')).toMatch(/^[A-Z]/);
    expect(ctx.calls[0]).toMatchObject({ name: 'deleteLink', args: ['thsm', 'a', 'K'] });
  });
});

const withKey = () => {
  const storage = new MemoryStorage();
  storage.setItem(KEY_NAME, 'K');
  return storage;
};

const pending = (ctx: Ctx) => pendingActions(ctx.store.getState());

describe('pending actions are visible from click to answer', () => {
  test('nothing is pending at rest', () => {
    expect(pendingActions(initialState)).toEqual([]);
  });

  test('preview: busy while the request is out, idle after', async () => {
    const gate = deferred<unknown>();
    const ctx = setup({ preview: [gate.promise] });
    ctx.type();
    const run = ctx.controller.loadPreview();
    expect(pending(ctx)).toEqual(['preview']);
    gate.resolve(previewFixture());
    await run;
    expect(pending(ctx)).toEqual([]);
  });

  test('create with a key: busy while the request is out, idle after', async () => {
    const gate = deferred<unknown>();
    const ctx = setup({ createLink: [gate.promise] }, withKey());
    ctx.type();
    await ctx.controller.loadPreview();
    const run = ctx.controller.create();
    expect(pending(ctx)).toEqual(['create']);
    gate.resolve({ link: linkFixture() });
    await run;
    expect(pending(ctx)).toEqual([]);
    expect(ctx.store.getState().phase).toBe('created');
  });

  test('create without a key moves to verification at once and sends nothing', async () => {
    const ctx = setup();
    ctx.type();
    await ctx.controller.loadPreview();
    await ctx.controller.create();
    expect(ctx.store.getState().phase).toBe('needs_verification');
    expect(ctx.calls.map((c) => c.name)).toEqual(['preview']);
    expect(pending(ctx)).toEqual([]);
  });

  test('request code: busy while the request is out, idle after', async () => {
    const gate = deferred<unknown>();
    const ctx = setup({ challenge: [gate.promise] });
    ctx.type();
    await ctx.controller.loadPreview();
    await ctx.controller.create();
    const run = ctx.controller.requestChallenge();
    expect(pending(ctx)).toEqual(['challenge']);
    gate.resolve(challengeFixture);
    await run;
    expect(pending(ctx)).toEqual([]);
  });

  test('verify: busy while the request is out, idle after', async () => {
    const gate = deferred<unknown>();
    const ctx = setup({ verify: [gate.promise] });
    await toAwaitingProof(ctx);
    const run = ctx.controller.verify();
    expect(pending(ctx)).toEqual(['verify']);
    gate.resolve(verifyFixture);
    await run;
    expect(pending(ctx)).toEqual([]);
  });

  test('fast switch: busy while saving, idle after success or failure, no double submit', async () => {
    const gate = deferred<unknown>();
    const ctx = setup({ updateLink: [gate.promise, apiError('timeout', 0)] });
    await toCreated(ctx);
    const run = ctx.controller.setFast(false);
    expect(pending(ctx)).toEqual(['fast']);
    await ctx.controller.setFast(true);
    expect(ctx.calls.filter((c) => c.name === 'updateLink')).toHaveLength(1);
    gate.resolve({ link: linkFixture('nashi', { fast: false }) });
    await run;
    expect(pending(ctx)).toEqual([]);
    await ctx.controller.setFast(true);
    expect(pending(ctx)).toEqual([]);
    expect(ctx.store.getState().error?.message).toMatch(/try again/i);
  });

  test('a new preview ends the fast-switch busy state of the link it replaces', () => {
    let state = reducer(
      { ...initialState, phase: 'creating' },
      { type: 'create_succeeded', link: linkFixture('a'), keySaved: true },
    );
    state = reducer(state, { type: 'link_fast_started' });
    expect(pendingActions(state)).toEqual(['fast']);
    state = reducer(state, { type: 'preview_started' });
    expect(pendingActions(state)).toEqual(['preview']);
    state = reducer(state, {
      type: 'link_fast_changed',
      workspace: 'thsm',
      slug: 'a',
      fast: false,
    });
    expect(state.fastSaving).toBe(false);
    expect(state.result).toBeNull();
  });

  test('cleanup: busy while the sweep runs, idle after', async () => {
    const gate = deferred<{ workspace: string; removedLinks: number; cleanupComplete: boolean }>();
    const ctx = setup({
      verify: [{ ...verifyFixture, removedLinks: 1, cleanupComplete: false }],
      sweep: [gate.promise],
    });
    await toAwaitingProof(ctx);
    await ctx.controller.verify();
    const run = ctx.controller.runCleanup('thsm');
    expect(pending(ctx)).toEqual(['cleanup']);
    gate.resolve({ workspace: 'thsm', removedLinks: 0, cleanupComplete: true });
    await run;
    expect(pending(ctx)).toEqual([]);
  });
});

const timeout = () => apiError('timeout', 0);

describe('a request that timed out is an error the person can retry', () => {
  test('preview: the URL field shows the error and Enter retries', async () => {
    const ctx = setup({ preview: [timeout()] });
    ctx.type();
    await ctx.controller.loadPreview();
    const state = ctx.store.getState();
    expect(state.phase).toBe('idle');
    expect(pendingActions(state)).toEqual([]);
    expect(visibleUrlError(state)?.message).toMatch(/did not answer in time/);
    await ctx.controller.loadPreview();
    expect(ctx.store.getState().phase).toBe('ready');
    expect(ctx.store.getState().error).toBeNull();
  });

  test('create: back to a usable form with the error, and pressing again works', async () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY_NAME, 'K');
    const ctx = setup({ createLink: [timeout()] }, storage);
    ctx.type();
    await ctx.controller.loadPreview();
    await ctx.controller.create();
    const state = ctx.store.getState();
    expect(state.phase).toBe('ready');
    expect(state.error).toMatchObject({ code: 'timeout', scope: 'general' });
    expect(loadKey(storage, ORIGIN, 'thsm')).toBe('K');
    await ctx.controller.create();
    expect(ctx.store.getState().phase).toBe('created');
  });

  test('request code: back to the button with the error, and pressing again works', async () => {
    const ctx = setup({ challenge: [timeout()] });
    ctx.type();
    await ctx.controller.loadPreview();
    await ctx.controller.create();
    await ctx.controller.requestChallenge();
    expect(ctx.store.getState().phase).toBe('needs_verification');
    expect(ctx.store.getState().error?.code).toBe('timeout');
    await ctx.controller.requestChallenge();
    expect(ctx.store.getState().phase).toBe('awaiting_proof');
    expect(ctx.store.getState().error).toBeNull();
  });

  test('verify: back to the code with the error, and pressing again works', async () => {
    const ctx = setup({ verify: [timeout()] });
    await toAwaitingProof(ctx);
    await ctx.controller.verify();
    expect(ctx.store.getState().phase).toBe('awaiting_proof');
    expect(ctx.store.getState().error?.code).toBe('timeout');
    expect(ctx.store.getState().verification?.nonce).toBe(challengeFixture.nonce);
    await ctx.controller.verify();
    expect(ctx.store.getState().phase).toBe('ready');
  });

  test('delete and list report the timeout in words', async () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY_NAME, 'K');
    const ctx = setup({ deleteLink: [timeout()], listLinks: [timeout()] }, storage);
    expect(await ctx.controller.deleteLink('thsm', 'a')).toMatch(/did not answer in time/);
    expect((await ctx.controller.loadLinks('thsm')).error).toMatch(/did not answer in time/);
  });
});
