/**
 * Side-effecting half of the flow: talks to the API, reads/writes the owner key, and drives
 * the store. Everything it needs is injected, so tests run it with a fake API and storage.
 * Never logs: no console calls, so the owner key and claimToken cannot reach the console.
 */
import type {
  CreateLinkRequest,
  LinkView,
  VerifyResponse,
} from '../../../../packages/core/src/api-types';
import { ApiCallError, describeError } from './errors';
import { type Api, type SweepResponse } from './api';
import { type Action, type Cleanup, type FlowError, type FlowState, type Store } from './flow';
import {
  forgetKey,
  forgetKeyIfCurrent,
  loadKey,
  saveKey,
  storedWorkspaces,
  type KeyStorage,
} from './keys';
import { en } from './strings';
import { checkSlug } from './slug';
import { workspaceHint } from './text';

export interface ControllerDeps {
  api: Api;
  storage: KeyStorage | null;
  origin: string;
}

export interface WorkspaceLinks {
  workspace: string;
  status: 'loading' | 'ready' | 'error';
  links: LinkView[];
  error: string | null;
}

export interface Controller {
  /** Fetches a preview of the current URL (call after the input settled). */
  loadPreview(): Promise<void>;
  create(): Promise<void>;
  requestChallenge(): Promise<void>;
  verify(): Promise<void>;
  setFast(fast: boolean): Promise<void>;
  runCleanup(workspace: string): Promise<void>;
  /** My-links support. */
  listWorkspaces(): string[];
  loadLinks(workspace: string): Promise<WorkspaceLinks>;
  deleteLink(workspace: string, slug: string): Promise<string | null>;
  forgetWorkspace(workspace: string): void;
}

export function toFlowError(error: unknown): FlowError {
  const code = error instanceof ApiCallError ? error.code : 'unexpected';
  const scope =
    code === 'slug_taken' || code === 'slug_invalid' || code === 'slug_reserved'
      ? 'slug'
      : code === 'not_notion_url' ||
          code === 'not_public' ||
          code === 'gone' ||
          code === 'unsupported_workspace'
        ? 'url'
        : 'general';
  return { code, message: describeError(error), scope };
}

/** Errors meaning "your key is missing/stale": the ownership flow can fix them. */
const KEY_PROBLEMS = new Set([
  'needs_verification',
  'unauthorized',
  'namespace_claimed',
  'namespace_not_claimed',
]);

function pendingCleanup(result: VerifyResponse): Cleanup | null {
  if (result.cleanupComplete) return null;
  return {
    workspace: result.workspace,
    removedLinks: result.removedLinks,
    status: 'pending',
    message: null,
  };
}

function createRequestOf(s: FlowState): CreateLinkRequest {
  const title = s.title.trim();
  const description = s.description.trim();
  const overrides = { ...(title ? { title } : {}), ...(description ? { description } : {}) };
  return {
    url: s.url.trim(),
    slug: s.slug,
    fast: s.fast,
    ...(title || description ? { overrides } : {}),
  };
}

export function createController(
  store: Store<FlowState, Action>,
  { api, storage, origin }: ControllerDeps,
  listableStorage: (KeyStorage & { length: number; key(i: number): string | null }) | null = null,
): Controller {
  let previewAbort: AbortController | null = null;
  /** Owner keys the browser refused to persist: usable until the page is closed, never stored. */
  const memoryKeys = new Map<string, string>();

  const state = () => store.getState();
  const keyFor = (workspace: string): string | null =>
    loadKey(storage, origin, workspace) ?? memoryKeys.get(workspace) ?? null;

  // Every async step remembers which flow (URL) started it and drops its result if the user has
  // moved on, so an abandoned flow can never act on the one that replaced it.
  let flow = 0;
  let verifyTickets = 0;
  /** Newest verification whose key was applied, per workspace: older answers must not overwrite it. */
  const appliedTicket = new Map<string, number>();
  let flowUrl = state().url;
  store.subscribe(() => {
    if (state().url !== flowUrl) {
      flowUrl = state().url;
      flow += 1;
    }
  });

  async function loadPreview() {
    // A restarted preview invalidates everything still in flight for this URL.
    flow += 1;
    const url = state().url.trim();
    previewAbort?.abort();
    if (url === '') return;
    const abort = new AbortController();
    previewAbort = abort;
    store.dispatch({ type: 'preview_started' });
    const hint = workspaceHint(url);
    const key = hint ? keyFor(hint) : null;
    try {
      const preview = await api.preview(url, key, abort.signal);
      if (abort.signal.aborted) return;
      store.dispatch({ type: 'preview_loaded', preview });
    } catch (error) {
      if (abort.signal.aborted) return;
      store.dispatch({ type: 'preview_failed', error: toFlowError(error) });
    }
  }

  function discardKey(workspace: string, key: string) {
    forgetKeyIfCurrent(storage, origin, workspace, key);
    if (memoryKeys.get(workspace) === key) memoryKeys.delete(workspace);
  }

  async function create() {
    const s = state();
    const preview = s.preview;
    if (!preview || s.phase !== 'ready' || checkSlug(s.slug) !== 'ok') return;
    const key = keyFor(preview.workspace);
    if (key === null) {
      store.dispatch({
        type: 'verification_needed',
        action: preview.suggestedAction ?? (preview.namespaceClaimed ? 'rotate' : 'claim'),
        error: null,
      });
      return;
    }
    // Always try a stored key: the server is the judge of whether it fits.
    const mine = flow;
    store.dispatch({ type: 'create_started' });
    try {
      const { link } = await api.createLink(createRequestOf(s), key);
      if (mine !== flow) return;
      store.dispatch({
        type: 'create_succeeded',
        link,
        keySaved: loadKey(storage, origin, preview.workspace) === key,
      });
    } catch (error) {
      onCreateFailed(error, preview.workspace, key, mine);
    }
  }

  function onCreateFailed(error: unknown, workspace: string, key: string, mine: number) {
    if (error instanceof ApiCallError && KEY_PROBLEMS.has(error.code)) {
      // The key is stale or wrong for this workspace: drop exactly it and verify again.
      discardKey(workspace, key);
      if (mine !== flow) return;
      store.dispatch({
        type: 'verification_needed',
        action: error.action ?? (error.code === 'namespace_not_claimed' ? 'claim' : 'rotate'),
        error: null,
      });
      return;
    }
    if (mine !== flow) return;
    store.dispatch({ type: 'create_failed', error: toFlowError(error) });
  }

  async function requestChallenge() {
    const s = state();
    if (s.phase !== 'needs_verification') return;
    const mine = flow;
    store.dispatch({ type: 'challenge_started' });
    try {
      const response = await api.challenge(s.url.trim(), s.verifyAction);
      if (mine !== flow) return;
      store.dispatch({
        type: 'challenge_received',
        verification: {
          action: response.action,
          nonce: response.nonce,
          claimToken: response.claimToken,
          expiresAt: response.expiresAt,
        },
      });
    } catch (error) {
      if (mine !== flow) return;
      // Ownership changed since the preview (another tab or device): switch to the matching action.
      const action =
        error instanceof ApiCallError && error.code === 'namespace_claimed'
          ? 'rotate'
          : error instanceof ApiCallError && error.code === 'namespace_not_claimed'
            ? 'claim'
            : undefined;
      store.dispatch({ type: 'challenge_failed', error: toFlowError(error), action });
    }
  }

  /** Stores the key unless a newer verification for the workspace already won. */
  function rememberKey(result: VerifyResponse, ticket: number): boolean {
    if ((appliedTicket.get(result.workspace) ?? 0) > ticket) return false;
    appliedTicket.set(result.workspace, ticket);
    if (saveKey(storage, origin, result.workspace, result.ownerKey)) {
      memoryKeys.delete(result.workspace);
    } else {
      memoryKeys.set(result.workspace, result.ownerKey);
    }
    return true;
  }

  async function verify() {
    const s = state();
    const verification = s.verification;
    if (s.phase !== 'awaiting_proof' || !verification) return;
    const mine = flow;
    const ticket = (verifyTickets += 1);
    const proofUrl = s.proofUrl.trim() || s.url.trim();
    store.dispatch({ type: 'verify_started' });
    let result;
    try {
      result = await api.verify(proofUrl, verification.nonce, verification.claimToken);
    } catch (error) {
      if (mine !== flow) return;
      const code = error instanceof ApiCallError ? error.code : '';
      // nonce_not_found is retryable with the same code (the page title may not be live yet).
      const restart = code === 'challenge_expired' || code === 'challenge_invalid';
      store.dispatch({ type: 'verify_failed', error: toFlowError(error), restart });
      return;
    }
    // The new key is valid whatever the user did meanwhile: keep it for its workspace.
    if (!rememberKey(result, ticket)) return;
    store.dispatch({
      type: 'cleanup_set',
      workspace: result.workspace,
      cleanup: pendingCleanup(result),
    });
    if (mine !== flow) return;
    store.dispatch({ type: 'verified' });
  }

  async function setFast(fast: boolean) {
    const result = state().result;
    if (!result) return;
    const { workspace, slug } = result.link;
    const key = keyFor(workspace);
    if (!key) return;
    if (state().fastSaving) return;
    store.dispatch({ type: 'link_fast_started' });
    try {
      const { link } = await api.updateLink(workspace, slug, { fast }, key);
      store.dispatch({ type: 'link_fast_changed', workspace, slug, fast: link.fast });
    } catch (error) {
      const current = state().result?.link;
      if (current?.workspace !== workspace || current.slug !== slug) return;
      store.dispatch({
        type: 'action_failed',
        error: {
          ...toFlowError(error),
          scope: 'general',
          message: `${en.fastUpdateFailed}: ${describeError(error)}`,
        },
      });
    }
  }

  async function runCleanup(workspace: string) {
    const cleanup = state().cleanups.find((entry) => entry.workspace === workspace);
    if (!cleanup || cleanup.status === 'running') return;
    const key = keyFor(workspace);
    if (!key) return;
    const running: Cleanup = { ...cleanup, status: 'running', message: null };
    store.dispatch({ type: 'cleanup_set', workspace, cleanup: running });
    // Apply the outcome only if this exact sweep is still the workspace's current entry.
    const settle = (next: Cleanup) => {
      if (state().cleanups.find((entry) => entry.workspace === workspace) === running) {
        store.dispatch({ type: 'cleanup_set', workspace, cleanup: next });
      }
    };
    try {
      const response: SweepResponse = await api.sweep(workspace, key);
      const removedLinks = cleanup.removedLinks + response.removedLinks;
      settle(
        response.cleanupComplete
          ? { ...cleanup, removedLinks, status: 'done', message: en.cleanupDone(removedLinks) }
          : {
              ...cleanup,
              removedLinks,
              status: 'incomplete',
              message: en.cleanupIncomplete(removedLinks),
            },
      );
    } catch (error) {
      const unsupported = error instanceof ApiCallError && error.code === 'not_implemented';
      settle({
        ...cleanup,
        status: unsupported ? 'unsupported' : 'error',
        message: unsupported ? en.cleanupUnsupported : describeError(error),
      });
    }
  }

  return {
    loadPreview,
    create,
    requestChallenge,
    verify,
    setFast,
    runCleanup,
    listWorkspaces: () => storedWorkspaces(listableStorage, origin),
    async loadLinks(workspace) {
      const key = keyFor(workspace);
      if (!key) {
        return { workspace, status: 'error', links: [], error: en.errors.unauthorized };
      }
      try {
        const { links } = await api.listLinks(workspace, key);
        return { workspace, status: 'ready', links, error: null };
      } catch (error) {
        if (error instanceof ApiCallError && KEY_PROBLEMS.has(error.code)) {
          forgetKeyIfCurrent(storage, origin, workspace, key);
        }
        return { workspace, status: 'error', links: [], error: describeError(error) };
      }
    },
    async deleteLink(workspace, slug) {
      const key = keyFor(workspace);
      if (!key) return en.errors.unauthorized;
      try {
        await api.deleteLink(workspace, slug, key);
        return null;
      } catch (error) {
        return describeError(error);
      }
    },
    forgetWorkspace(workspace) {
      forgetKey(storage, origin, workspace);
      memoryKeys.delete(workspace);
    },
  };
}
