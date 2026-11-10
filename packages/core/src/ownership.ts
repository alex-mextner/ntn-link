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
 * - A rotate challenge is bound to the key version it was issued against: once any rotation
 *   has replaced the key, older challenges fail, and a rotation whose key was overtaken
 *   while it was still sweeping fails instead of returning a dead key.
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
  type NamespaceRecord,
  type NamespaceSnapshot,
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

/**
 * The namespace record, confirmed against the primary. A rotate challenge binds to the key
 * hash seen here, and verify later fails with `challenge_expired` (consuming the challenge) if
 * that hash is not the current one, so a lagging replica's previous hash must never be
 * bound. A present record is therefore re-checked with a no-op compare-and-set; if it changed
 * in between, it is read again.
 */
async function readConfirmedNamespace(
  repo: Repository,
  workspace: string,
): Promise<NamespaceRecord | null> {
  for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
    const snapshot = await repo.getNamespaceSnapshot(workspace);
    if (snapshot === null) return null;
    if (await repo.namespaceHolds(workspace, snapshot)) return snapshot.record;
  }
  throw new ApiError(
    'upstream_error',
    'The namespace changed while the challenge was being prepared. Try again.',
  );
}

export async function issueChallenge(
  deps: OwnershipDeps,
  page: ParsedNotionUrl,
  action: ChallengeAction,
): Promise<ChallengeResponse> {
  const resolved = await requirePublicPage(deps.fetcher, page);
  const workspace = resolved.workspace;
  const namespace = (await readConfirmedNamespace(deps.repo, workspace)) ?? null;
  const claimed = namespace !== null;
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
        namespaceKeyHash: namespace?.keyHash ?? null,
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

/**
 * The rotation may or may not have been applied and storage cannot say. Failing closed is the
 * only answer that never returns a possibly dead key; the challenge is consumed (it is bound
 * to a key version that may be gone) and a new rotate challenge always recovers, because
 * whoever controls the page can prove it again.
 */
class UnconfirmedRotationError extends ApiError {
  constructor() {
    super(
      'upstream_error',
      'The storage backend could not confirm the key rotation. Request a new rotate challenge to get a working key.',
    );
  }
}

function overtaken(): ApiError {
  return new ApiError(
    'challenge_expired',
    'Another rotation of this namespace finished first. Request a new challenge if you still need a key.',
  );
}

const CONFIRM_ATTEMPTS = 3;

/** Whether the namespace still holds `snapshot`; null when storage never answered. */
async function stillHolds(
  repo: Repository,
  workspace: string,
  snapshot: NamespaceSnapshot,
): Promise<boolean | null> {
  for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
    try {
      return await repo.namespaceHolds(workspace, snapshot);
    } catch {
      // Retry: one failed call says nothing about who owns the namespace.
    }
  }
  return null;
}

/**
 * The replacement threw: the write may have been applied with only its reply lost, so the
 * primary is asked what is stored. Returns when `next` is stored; otherwise throws `error`
 * (nothing changed), `overtaken()` (someone else wrote) or an unconfirmed-rotation error.
 */
async function requireReplacementApplied(
  repo: Repository,
  workspace: string,
  existing: NamespaceSnapshot,
  next: NamespaceSnapshot,
  error: unknown,
): Promise<void> {
  const ours = await stillHolds(repo, workspace, next);
  if (ours === null) throw new UnconfirmedRotationError();
  if (ours) return;
  const untouched = await stillHolds(repo, workspace, existing);
  if (untouched === null) throw new UnconfirmedRotationError();
  // Untouched: a plain storage failure. Anything else was written by someone else.
  throw untouched ? error : overtaken();
}

/**
 * Replaces the key of a claimed namespace. The key is replaced first (version-checked); the
 * sweep that follows is best-effort and re-runnable, so no failure after a deletion can
 * leave a half-undone rotation. The key is only returned once it is confirmed to still be
 * the current one: it must never be a key another rotation has already invalidated.
 */
async function rotateOwnerKey(
  deps: OwnershipDeps,
  workspace: string,
  challenge: ChallengeRecord,
  ownerKey: string,
  keyHash: string,
): Promise<VerifyResponse> {
  const existing = await deps.repo.getNamespaceSnapshot(workspace);
  if (existing === null) {
    throw new ApiError(
      'namespace_not_claimed',
      `The namespace "${workspace}" no longer exists; request a claim challenge.`,
    );
  }
  if (existing.record.keyHash !== challenge.namespaceKeyHash) throw overtaken();
  const next = deps.repo.snapshotOf({
    keyHash,
    claimedAt: existing.record.claimedAt,
    rotatedAt: deps.now().toISOString(),
  });
  let replaced: boolean;
  try {
    // Compare-and-set on the exact text read above: a rotation landing in between loses.
    replaced = await deps.repo.replaceNamespace(workspace, existing, next);
  } catch (error) {
    await requireReplacementApplied(deps.repo, workspace, existing, next, error);
    replaced = true;
  }
  if (!replaced) throw overtaken();

  const sweep = await sweepGoneLinks(deps, workspace);
  // Another rotation may have completed while this one was sweeping.
  const confirmed = await stillHolds(deps.repo, workspace, next);
  if (confirmed === null) throw new UnconfirmedRotationError();
  if (!confirmed) throw overtaken();
  return {
    workspace,
    action: 'rotate',
    ownerKey,
    removedLinks: sweep.removedLinks,
    cleanupComplete: sweep.complete,
  };
}

/** Mints the owner key and stores its hash: `claim` sets it atomically, `rotate` replaces it. */
async function issueOwnerKey(
  deps: OwnershipDeps,
  workspace: string,
  challenge: ChallengeRecord,
): Promise<VerifyResponse> {
  const action = challenge.action;
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

  return rotateOwnerKey(deps, workspace, challenge, ownerKey, keyHash);
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
    return await issueOwnerKey(deps, workspace, challenge);
  } catch (error) {
    // A failed rotation must not burn the challenge; losing the race to another rotation must,
    // and so must an unconfirmed one (see UnconfirmedRotationError).
    const lostRace = error instanceof ApiError && error.code === 'challenge_expired';
    const unconfirmed = error instanceof UnconfirmedRotationError;
    if (challenge.action === 'rotate' && !lostRace && !unconfirmed) {
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
