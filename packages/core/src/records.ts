/**
 * Typed storage records (spec section 5, storage keys) and the repository that owns
 * every key format. Stored JSON is validated on read; a record that fails validation is
 * a fault, never a silent "missing" (a corrupt `ns:` record must not look unclaimed).
 */
import { z } from 'zod';
import { API_LIMITS } from './api-types';
import { randomToken } from './crypto';
import { ApiError } from './errors';
import type { Store } from './store';

export const namespaceRecordSchema = z.object({
  keyHash: z.string(),
  claimedAt: z.string(),
  rotatedAt: z.string().nullable(),
});
export type NamespaceRecord = z.infer<typeof namespaceRecordSchema>;

export const challengeRecordSchema = z.object({
  workspace: z.string(),
  action: z.enum(['claim', 'rotate']),
  claimTokenHash: z.string(),
  /**
   * For `rotate`: the keyHash of the namespace version the challenge was issued against, so
   * a rotation that was overtaken by another one cannot replace (or mint) a newer key.
   * Null for `claim`, which has no earlier version. Challenges stored before this field
   * existed read as null: a legacy claim still works, a legacy rotate fails as overtaken.
   */
  namespaceKeyHash: z.string().nullable().default(null),
  expiresAt: z.string(),
});
export type ChallengeRecord = z.infer<typeof challengeRecordSchema>;

export const linkRecordSchema = z.object({
  workspace: z.string(),
  slug: z.string(),
  pageId: z.string(),
  canonicalUrl: z.string(),
  /** Last fetched Notion values; overrides win when rendering. */
  title: z.string(),
  description: z.string(),
  /** Notion's social image URL as served in og:image; re-resolved on every card request. */
  imageUrl: z.string().nullable(),
  language: z.string().nullable(),
  fetchedAt: z.string(),
  createdAt: z.string(),
  overrides: z.object({ title: z.string().optional(), description: z.string().optional() }),
  fast: z.boolean(),
  canonicalMode: z.enum(['self', 'notion']),
  /** Set when a refresh found the page no longer public; cleared when it is public again. */
  goneAt: z.string().nullable(),
  /**
   * keyHash of the namespace version whose post-rotation sweep last confirmed this link's
   * target is still public here; lets repeated, time-bounded sweeps converge. Absent until swept.
   */
  sweptVersion: z.string().nullable().optional(),
  /**
   * Short digest of the page text and icon drawn on the generated card (the card of a page
   * without a cover), taken when the link was created or last refreshed; part of the card image
   * version so an edit of the page's opening text or icon gives the card a new image URL. Null
   * for a page with a cover; absent on records written before this field existed.
   */
  excerptDigest: z.string().nullable().optional(),
  /** Failed sweep fetches of this link for `version`; links with fewer failures are retried first. */
  sweepTried: z.object({ version: z.string(), count: z.number() }).nullable().optional(),
});
export type LinkRecord = z.infer<typeof linkRecordSchema>;

function parseRecord<T>(schema: z.ZodType<T>, raw: string | null, what: string): T | null {
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ApiError('server_misconfigured', `Stored ${what} record is corrupt.`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success)
    throw new ApiError('server_misconfigured', `Stored ${what} record is invalid.`);
  return parsed.data;
}

export const CHALLENGE_TTL_SECONDS = 15 * 60;
export const CHALLENGE_MAX_ATTEMPTS = 5;
const LINK_UPDATE_ATTEMPTS = 5;

export interface NamespaceSnapshot {
  record: NamespaceRecord;
  raw: string;
}

export interface LinkSnapshot {
  link: LinkRecord;
  raw: string;
}

const linkKey = (ws: string, slug: string): string => `link:${ws}/${slug}`;
const pageCreationKey = (ws: string, pageId: string): string => `pagelock:${ws}/${pageId}`;
/** Longer than any function invocation can live (Vercel maxDuration 60 s), so a live holder never loses its lease. */
const PAGE_CREATION_LOCK_SECONDS = 120;
const linkIndexKey = (ws: string): string => `nslinks:${ws}`;

export type MoveLinkResult =
  { kind: 'moved'; link: LinkRecord } | { kind: 'missing' } | { kind: 'taken' };

export class Repository {
  readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  async getNamespace(ws: string): Promise<NamespaceRecord | null> {
    return parseRecord(namespaceRecordSchema, await this.store.get(`ns:${ws}`), 'namespace');
  }
  /** The namespace together with its exact stored text, for a version-checked replace. */
  async getNamespaceSnapshot(ws: string): Promise<NamespaceSnapshot | null> {
    const raw = await this.store.get(`ns:${ws}`);
    const record = parseRecord(namespaceRecordSchema, raw, 'namespace');
    return raw === null || record === null ? null : { record, raw };
  }
  /** Atomic claim: false when the namespace already exists. */
  async claimNamespace(ws: string, record: NamespaceRecord): Promise<boolean> {
    return this.store.set(`ns:${ws}`, JSON.stringify(record), { ifAbsent: true });
  }
  /** The exact text `record` is stored as, so it can be written and later recognised. */
  snapshotOf(record: NamespaceRecord): NamespaceSnapshot {
    return { record, raw: JSON.stringify(record) };
  }
  /** Replaces the namespace only if it is still `previous`; false means another rotation won. */
  async replaceNamespace(
    ws: string,
    previous: NamespaceSnapshot,
    next: NamespaceSnapshot,
  ): Promise<boolean> {
    return this.store.compareAndSet(`ns:${ws}`, previous.raw, next.raw);
  }
  /**
   * True while the namespace still holds exactly `snapshot`. Goes through the store's
   * compare-and-set (a no-op write that is decided on the primary) rather than a read, because
   * a replicated backend may answer reads from a replica that has not seen the latest rotation.
   */
  async namespaceHolds(ws: string, snapshot: NamespaceSnapshot): Promise<boolean> {
    return this.store.compareAndSet(`ns:${ws}`, snapshot.raw, snapshot.raw);
  }

  async getLink(ws: string, slug: string): Promise<LinkRecord | null> {
    return parseRecord(linkRecordSchema, await this.store.get(linkKey(ws, slug)), 'link');
  }
  /**
   * Atomic reservation (record and index entry together) under the per-namespace cap:
   * 'exists' when the slug is taken, 'full' when the namespace already holds the maximum.
   */
  async createLink(record: LinkRecord): Promise<'created' | 'exists' | 'full'> {
    return this.store.createIndexed(
      linkKey(record.workspace, record.slug),
      JSON.stringify(record),
      linkIndexKey(record.workspace),
      record.slug,
      API_LIMITS.linksPerNamespace,
    );
  }
  /**
   * Read-modify-write that cannot resurrect or clobber: the write lands only if the record
   * is still exactly what `mutate` saw, otherwise the whole step is retried on fresh data.
   * Resolves null when the link is gone; `mutate` returns its argument to decline the change.
   */
  async updateLink(
    ws: string,
    slug: string,
    mutate: (current: LinkRecord) => LinkRecord,
  ): Promise<LinkRecord | null> {
    const key = linkKey(ws, slug);
    for (let attempt = 0; attempt < LINK_UPDATE_ATTEMPTS; attempt++) {
      const raw = await this.store.get(key);
      const current = parseRecord(linkRecordSchema, raw, 'link');
      if (raw === null || current === null) return null;
      const next = mutate(current);
      if (next === current) return current;
      if (await this.store.compareAndSet(key, raw, JSON.stringify(next))) return next;
    }
    throw new ApiError('upstream_error', 'The link is being changed concurrently. Try again.');
  }
  /** Resolves true when the link existed. The index entry goes with it, atomically. */
  async deleteLink(ws: string, slug: string): Promise<boolean> {
    return this.store.deleteIndexed(linkKey(ws, slug), linkIndexKey(ws), slug);
  }
  /**
   * Renames a link atomically. A source that was deleted or replaced after it was read is
   * never resurrected under the new slug, and a taken destination changes nothing.
   */
  async moveLink(
    ws: string,
    slug: string,
    newSlug: string,
    mutate: (current: LinkRecord) => LinkRecord,
  ): Promise<MoveLinkResult> {
    const raw = await this.store.get(linkKey(ws, slug));
    const current = parseRecord(linkRecordSchema, raw, 'link');
    if (raw === null || current === null) return { kind: 'missing' };
    const link = { ...mutate(current), slug: newSlug };
    const outcome = await this.store.moveIndexed({
      from: linkKey(ws, slug),
      to: linkKey(ws, newSlug),
      setKey: linkIndexKey(ws),
      fromMember: slug,
      toMember: newSlug,
      expectedFrom: raw,
      value: JSON.stringify(link),
    });
    return outcome === 'moved' ? { kind: 'moved', link } : { kind: outcome };
  }
  async listLinkSlugs(ws: string): Promise<string[]> {
    return this.store.setMembers(linkIndexKey(ws));
  }
  /** Records together with the exact stored text, so a later delete can be version-checked. */
  async listLinkSnapshots(ws: string): Promise<LinkSnapshot[]> {
    const slugs = await this.listLinkSlugs(ws);
    const raws = await Promise.all(slugs.map((slug) => this.store.get(linkKey(ws, slug))));
    const snapshots: LinkSnapshot[] = [];
    for (const raw of raws) {
      const link = parseRecord(linkRecordSchema, raw, 'link');
      if (raw !== null && link !== null) snapshots.push({ link, raw });
    }
    return snapshots;
  }
  /** Deletes the link only if it is still the version in `snapshot`. */
  async deleteLinkSnapshot(snapshot: LinkSnapshot): Promise<boolean> {
    const { workspace, slug } = snapshot.link;
    return this.store.deleteIndexed(
      linkKey(workspace, slug),
      linkIndexKey(workspace),
      slug,
      snapshot.raw,
    );
  }
  /**
   * Lease serialising the automatic (no explicit slug) creation of a link for one page, so a
   * retry overlapping its original request cannot create a second link. Resolves the holder's
   * token, or null when somebody else holds it. The lease outlives any function invocation, so
   * it only expires on its own when the holder died.
   */
  async acquirePageCreation(ws: string, pageId: string): Promise<string | null> {
    const token = randomToken();
    const acquired = await this.store.set(pageCreationKey(ws, pageId), token, {
      ifAbsent: true,
      ttlSeconds: PAGE_CREATION_LOCK_SECONDS,
    });
    return acquired ? token : null;
  }
  /** Releases only the holder's own lease: a successor's lease is never deleted. */
  async releasePageCreation(ws: string, pageId: string, token: string): Promise<void> {
    const key = pageCreationKey(ws, pageId);
    // `deleteIndexed` is the store's atomic delete-if-equal; the index set is a throwaway no-op.
    await this.store.deleteIndexed(key, `${key}:holders`, 'lease', token);
  }
  async listLinks(ws: string): Promise<LinkRecord[]> {
    return (await this.listLinkSnapshots(ws)).map((snapshot) => snapshot.link);
  }

  async getChallenge(ws: string, nonce: string): Promise<ChallengeRecord | null> {
    return parseRecord(
      challengeRecordSchema,
      await this.store.get(`challenge:${ws}:${nonce}`),
      'challenge',
    );
  }
  async createChallenge(ws: string, nonce: string, record: ChallengeRecord): Promise<boolean> {
    return this.store.set(`challenge:${ws}:${nonce}`, JSON.stringify(record), {
      ifAbsent: true,
      ttlSeconds: CHALLENGE_TTL_SECONDS,
    });
  }
  /** True only for the single caller that removed it. */
  async consumeChallenge(ws: string, nonce: string): Promise<boolean> {
    return this.store.delete(`challenge:${ws}:${nonce}`);
  }
  /** Counts a wrong claimToken; the counter lives as long as the challenge could. */
  async countFailedAttempt(ws: string, nonce: string): Promise<number> {
    return this.store.increment(`challenge-attempts:${ws}:${nonce}`, CHALLENGE_TTL_SECONDS);
  }
}
