/**
 * Ownership without accounts (spec section 4): the claim/rotate challenge state machine.
 *
 * Security properties, each covered by tests:
 * - The public `nonce` alone is useless; verification also needs the private `claimToken`
 *   (only its SHA-256 is stored, compared in constant time).
 * - A challenge is bound to one namespace and one action, expires after 15 minutes, and is
 *   consumed by an atomic delete: of two concurrent verifications only one proceeds.
 * - A wrong claimToken does not consume the challenge (a nonce reader could otherwise burn
 *   it) but counts toward a cap of 5, after which the challenge is deleted.
 * - A missing nonce on the page does not consume it either (Notion may still be
 *   publishing the edit) and costs no attempt; verify is rate limited per IP instead.
 * - The owner key is random 256 bit, returned once; only its SHA-256 is stored.
 */
import type { ChallengeAction, ChallengeResponse, VerifyResponse } from './api-types';
import { randomNonceChars, randomToken, sha256Hex, timingSafeEqual } from './crypto';
import { ApiError } from './errors';
import type { PageFetcher, PageFetchResult } from './notion-fetcher';
import type { ParsedNotionUrl } from './notion-url';
import {
  CHALLENGE_MAX_ATTEMPTS,
  CHALLENGE_TTL_SECONDS,
  type ChallengeRecord,
  type LinkRecord,
  type Repository,
} from './records';

export interface OwnershipDeps {
  repo: Repository;
  fetcher: PageFetcher;
  now: () => Date;
  /** Called for every link removed during rotation so caches can be purged. */
  onLinkRemoved: (workspace: string, slug: string) => Promise<void>;
}

type PublicPage = Extract<PageFetchResult, { kind: 'public' }>;

const NONCE_PATTERN = /^ntn-verify-[a-z0-9]{10}$/;
export const OWNER_KEY_PREFIX = 'ntnk_';
const ROTATION_RECHECK_CONCURRENCY = 10;

export function isNonce(value: string): boolean {
  return NONCE_PATTERN.test(value);
}

async function requirePublicPage(fetcher: PageFetcher, page: ParsedNotionUrl) {
  const result = await fetcher.fetchPage(page);
  if (result.kind === 'not_public') {
    throw new ApiError(
      'not_public',
      'That page is not public. In Notion use Share, then Publish, and try again.',
    );
  }
  return result;
}

/** What the namespace needs from a client that has no valid key. */
export async function requiredActionFor(
  repo: Repository,
  workspace: string,
): Promise<ChallengeAction> {
  return (await repo.getNamespace(workspace)) === null ? 'claim' : 'rotate';
}

/** True when `ownerKey` is the current key of the namespace. */
export async function isOwner(
  repo: Repository,
  workspace: string,
  ownerKey: string | null,
): Promise<boolean> {
  if (ownerKey === null || !ownerKey.startsWith(OWNER_KEY_PREFIX)) return false;
  const namespace = await repo.getNamespace(workspace);
  if (namespace === null) return false;
  return timingSafeEqual(await sha256Hex(ownerKey), namespace.keyHash);
}

export async function issueChallenge(
  deps: OwnershipDeps,
  page: ParsedNotionUrl,
  action: ChallengeAction,
): Promise<ChallengeResponse> {
  const resolved = await requirePublicPage(deps.fetcher, page);
  const workspace = resolved.workspace;
  const claimed = (await deps.repo.getNamespace(workspace)) !== null;
  if (action === 'claim' && claimed) {
    throw new ApiError(
      'namespace_claimed',
      `The namespace "${workspace}" is already claimed. If you own the workspace and lost the key, request a rotate challenge.`,
    );
  }
  if (action === 'rotate' && !claimed) {
    throw new ApiError(
      'namespace_not_claimed',
      `The namespace "${workspace}" has not been claimed yet; request a claim challenge.`,
    );
  }

  const claimToken = randomToken();
  const claimTokenHash = await sha256Hex(claimToken);
  const expiresAt = new Date(deps.now().getTime() + CHALLENGE_TTL_SECONDS * 1000).toISOString();
  for (let attempt = 0; attempt < 5; attempt++) {
    const nonce = `ntn-verify-${randomNonceChars(10)}`;
    if (
      await deps.repo.createChallenge(workspace, nonce, {
        workspace,
        action,
        claimTokenHash,
        expiresAt,
      })
    ) {
      return { workspace, action, nonce, claimToken, expiresAt };
    }
  }
  throw new ApiError('upstream_error', 'Could not allocate a challenge. Try again.');
}

/** A wrong token does not consume the challenge but counts toward the attempt cap (spec 4.6). */
async function rejectWrongToken(
  repo: Repository,
  workspace: string,
  nonce: string,
): Promise<never> {
  const attempts = await repo.countFailedAttempt(workspace, nonce);
  if (attempts >= CHALLENGE_MAX_ATTEMPTS) {
    await repo.consumeChallenge(workspace, nonce);
    throw new ApiError(
      'challenge_expired',
      'Too many wrong attempts; this challenge was deleted. Request a new one.',
    );
  }
  throw new ApiError(
    'challenge_invalid',
    `The claim token does not match this challenge (${CHALLENGE_MAX_ATTEMPTS - attempts} attempts left).`,
  );
}

export interface SweepResult {
  removedLinks: number;
  complete: boolean;
}

/** Mints the owner key and stores its hash: `claim` sets it atomically, `rotate` replaces it. */
async function issueOwnerKey(
  deps: OwnershipDeps,
  workspace: string,
  action: ChallengeAction,
): Promise<VerifyResponse> {
  const ownerKey = `${OWNER_KEY_PREFIX}${randomToken()}`;
  const keyHash = await sha256Hex(ownerKey);
  const nowIso = deps.now().toISOString();
  if (action === 'claim') {
    const claimed = await deps.repo.claimNamespace(workspace, {
      keyHash,
      claimedAt: nowIso,
      rotatedAt: null,
    });
    if (!claimed) {
      throw new ApiError(
        'namespace_claimed',
        `The namespace "${workspace}" was claimed by someone else in the meantime.`,
      );
    }
    return { workspace, action: 'claim', ownerKey, removedLinks: 0, cleanupComplete: true };
  }

  const existing = await deps.repo.getNamespaceSnapshot(workspace);
  if (existing === null) {
    throw new ApiError(
      'namespace_not_claimed',
      `The namespace "${workspace}" no longer exists; request a claim challenge.`,
    );
  }
  // The key is replaced first (version-checked); the sweep that follows is best-effort and
  // re-runnable, so no failure after a deletion can leave a half-undone rotation.
  const next = { keyHash, claimedAt: existing.record.claimedAt, rotatedAt: nowIso };
  if (!(await deps.repo.replaceNamespace(workspace, existing, next))) {
    // Never hand out a key that another rotation has just invalidated.
    throw new ApiError(
      'challenge_expired',
      'Another rotation of this namespace finished first. Request a new challenge if you still need a key.',
    );
  }
  const sweep = await sweepGoneLinks(deps, workspace);
  return {
    workspace,
    action: 'rotate',
    ownerKey,
    removedLinks: sweep.removedLinks,
    cleanupComplete: sweep.complete,
  };
}

interface LocatedChallenge {
  workspace: string;
  challenge: ChallengeRecord | null;
  /** The fetched page when locating the challenge already needed it. */
  resolved: PublicPage | null;
}

/**
 * Challenges live under the workspace Notion resolves the page to. A URL's own workspace
 * hint is only trusted for the lookup when it finds something: `notion.so/<name>/<id>` carries
 * Notion's internal name, which need not be the published domain the challenge was issued for.
 */
async function locateChallenge(
  deps: OwnershipDeps,
  page: ParsedNotionUrl,
  nonce: string,
): Promise<LocatedChallenge> {
  if (page.workspaceHint !== null) {
    const hinted = await deps.repo.getChallenge(page.workspaceHint, nonce);
    if (hinted !== null) {
      return { workspace: page.workspaceHint, challenge: hinted, resolved: null };
    }
  }
  const resolved = await requirePublicPage(deps.fetcher, page);
  const challenge =
    resolved.workspace === page.workspaceHint
      ? null
      : await deps.repo.getChallenge(resolved.workspace, nonce);
  return { workspace: resolved.workspace, challenge, resolved };
}

export async function verifyChallenge(
  deps: OwnershipDeps,
  page: ParsedNotionUrl,
  nonce: string,
  claimToken: string,
): Promise<VerifyResponse> {
  if (!isNonce(nonce)) {
    throw new ApiError('challenge_invalid', 'That is not a valid challenge nonce.');
  }
  const located = await locateChallenge(deps, page, nonce);
  const { workspace, challenge } = located;
  if (challenge === null || new Date(challenge.expiresAt).getTime() <= deps.now().getTime()) {
    if (challenge !== null) await deps.repo.consumeChallenge(workspace, nonce);
    throw new ApiError(
      'challenge_expired',
      'This challenge expired or was already used. Request a new one.',
    );
  }

  const presentedHash = await sha256Hex(claimToken);
  if (!timingSafeEqual(presentedHash, challenge.claimTokenHash)) {
    return rejectWrongToken(deps.repo, workspace, nonce);
  }

  const resolved = located.resolved ?? (await requirePublicPage(deps.fetcher, page));
  if (resolved.workspace !== workspace) {
    throw new ApiError(
      'challenge_invalid',
      `That page belongs to "${resolved.workspace}", not to "${workspace}".`,
    );
  }
  if (!resolved.metadata.title.includes(nonce)) {
    throw new ApiError(
      'nonce_not_found',
      `The title of that page does not contain ${nonce} yet. Put it into the page title, wait a few seconds for Notion to publish it, and verify again.`,
    );
  }

  // Single use: only the request whose delete succeeds may proceed.
  if (!(await deps.repo.consumeChallenge(workspace, nonce))) {
    throw new ApiError('challenge_expired', 'This challenge was already used. Request a new one.');
  }

  try {
    return await issueOwnerKey(deps, workspace, challenge.action);
  } catch (error) {
    // A failed rotation must not burn the challenge; losing the race to another rotation must.
    const lostRace = error instanceof ApiError && error.code === 'challenge_expired';
    if (challenge.action === 'rotate' && !lostRace) {
      await deps.repo.createChallenge(workspace, nonce, challenge);
    }
    throw error;
  }
}

/**
 * The link is already deleted and the challenge already consumed. A failing cache purge must
 * not abort the sweep half-way, which would leave stale links the rotation exists to remove.
 */
async function purgeAfterRotation(
  deps: OwnershipDeps,
  workspace: string,
  slug: string,
): Promise<void> {
  try {
    await deps.onLinkRemoved(workspace, slug);
  } catch {
    // The cached page for a deleted link expires on its own.
  }
}

/**
 * After a rotation the domain may have changed hands (spec 4.7): every link whose target
 * no longer resolves publicly under this workspace is deleted. Transient Notion failures
 * keep the link; deleting on a blip would be worse than a stale link. Best-effort and
 * idempotent: a storage failure stops the sweep and reports it incomplete, never throws, so
 * the rotation that triggered it is not undone. Deleted links are never restored.
 */
export async function sweepGoneLinks(deps: OwnershipDeps, workspace: string): Promise<SweepResult> {
  let removed = 0;
  try {
    const snapshots = await deps.repo.listLinkSnapshots(workspace);
    for (let i = 0; i < snapshots.length; i += ROTATION_RECHECK_CONCURRENCY) {
      const batch = snapshots.slice(i, i + ROTATION_RECHECK_CONCURRENCY);
      const gone = await Promise.all(
        batch.map(async (s) => ((await targetIsGone(deps, s.link)) ? s : null)),
      );
      for (const snapshot of gone) {
        if (snapshot === null) continue;
        // Version-checked: a link recreated under the same slug meanwhile is not ours to remove.
        if (!(await deps.repo.deleteLinkSnapshot(snapshot))) continue;
        removed++;
        await purgeAfterRotation(deps, workspace, snapshot.link.slug);
      }
    }
  } catch {
    return { removedLinks: removed, complete: false };
  }
  return { removedLinks: removed, complete: true };
}

async function targetIsGone(deps: OwnershipDeps, link: LinkRecord): Promise<boolean> {
  try {
    const result = await deps.fetcher.fetchPage({
      pageId: link.pageId,
      workspaceHint: link.workspace,
    });
    return result.kind !== 'public' || result.workspace !== link.workspace;
  } catch {
    return false; // Transient Notion trouble: keep the link.
  }
}
