/**
 * Options-page logic without DOM: workspace opt-in, key entry and the claim flow.
 * `claimToken` is returned to the caller and never stored here; the page keeps it in
 * memory only.
 */
import type { ChallengeAction } from '../../packages/core/src/api-types';
import { isUsableWorkspace } from '../../packages/core/src/notion-url';
import { callApi, isRecord } from './api';
import type { KeyStore } from './keys';
import { classifyPageUrl } from './notion-url';

export type Outcome<T> = ({ ok: true } & T) | { ok: false; message: string };

export function normalizeWorkspace(input: string): string | null {
  const ws = input.trim().toLowerCase();
  return /^[a-z0-9-]+$/.test(ws) && isUsableWorkspace(ws) ? ws : null;
}

/** Workspace named by a `?url=` prefill or a pasted Notion URL, if any. */
export function workspaceFromUrl(url: string): string | null {
  return classifyPageUrl(url)?.workspace ?? null;
}

/** Adds the workspace to the list and switches automatic interception on or off for it. */
export async function setAutoWorkspace(
  keys: KeyStore,
  input: string,
  on: boolean,
): Promise<Outcome<{ workspace: string }>> {
  const ws = normalizeWorkspace(input);
  if (ws === null) {
    return {
      ok: false,
      message: 'A workspace name uses only a-z, 0-9 and "-" (the part before .notion.site).',
    };
  }
  await keys.setAutoEnabled(ws, on);
  return { ok: true, workspace: ws };
}

export async function saveOwnerKey(
  keys: KeyStore,
  workspaceInput: string,
  keyInput: string,
): Promise<Outcome<{ workspace: string }>> {
  const ws = normalizeWorkspace(workspaceInput);
  if (ws === null) return { ok: false, message: 'Enter the workspace name first.' };
  const key = keyInput.trim();
  if (key.length < 16 || /\s/.test(key)) {
    return { ok: false, message: 'That does not look like an owner key.' };
  }
  await keys.setKey(ws, key);
  return { ok: true, workspace: ws };
}

export interface ClaimDeps {
  origin: string;
  fetch: typeof fetch;
}

export async function requestChallenge(
  deps: ClaimDeps,
  url: string,
  action: ChallengeAction,
): Promise<Outcome<{ workspace: string; nonce: string; claimToken: string; expiresAt: string }>> {
  const res = await callApi({
    ...deps,
    path: '/api/challenge',
    method: 'POST',
    body: { url, action },
  });
  if (!res.ok) return { ok: false, message: res.message };
  const b = res.body;
  if (
    !isRecord(b) ||
    typeof b.workspace !== 'string' ||
    typeof b.nonce !== 'string' ||
    typeof b.claimToken !== 'string' ||
    typeof b.expiresAt !== 'string'
  ) {
    return { ok: false, message: 'Unexpected answer from ntn-link.' };
  }
  return {
    ok: true,
    workspace: b.workspace,
    nonce: b.nonce,
    claimToken: b.claimToken,
    expiresAt: b.expiresAt,
  };
}

export async function verifyChallenge(
  deps: ClaimDeps,
  keys: KeyStore,
  args: { url: string; nonce: string; claimToken: string },
): Promise<Outcome<{ workspace: string; removedLinks: number }>> {
  const res = await callApi({ ...deps, path: '/api/verify', method: 'POST', body: args });
  if (!res.ok) return { ok: false, message: res.message };
  const b = res.body;
  if (!isRecord(b) || typeof b.workspace !== 'string' || typeof b.ownerKey !== 'string') {
    return { ok: false, message: 'Unexpected answer from ntn-link.' };
  }
  await keys.setKey(b.workspace, b.ownerKey);
  return {
    ok: true,
    workspace: b.workspace,
    removedLinks: typeof b.removedLinks === 'number' ? b.removedLinks : 0,
  };
}
