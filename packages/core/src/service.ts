/**
 * Application service behind every API and public route. Route handlers only translate
 * HTTP to these calls, so behaviour is testable without a server and identical for all
 * clients. Everything that can fail throws `ApiError`.
 */
import type {
  ChallengeRequest,
  ChallengeResponse,
  CreateLinkRequest,
  CreateLinkResponse,
  LinkView,
  ListLinksResponse,
  SweepLinksResponse,
  PreviewRequest,
  PreviewResponse,
  UpdateLinkRequest,
  UpdateLinkResponse,
  VerifyRequest,
  VerifyResponse,
  CardData,
} from './api-types';
import { API_LIMITS } from './api-types';
import { TtlCache } from './card-cache';
import { ApiError } from './errors';
import { withImageWidth } from './metadata';
import type { PageFetcher, PageFetchResult } from './notion-fetcher';
import { isNotionGeneratedCardUrl, isNotionPlaceholderImageUrl } from './notion-placeholder';
import { parseNotionUrl, canonicalNotionUrl, isUsableWorkspace } from './notion-url';
import { renderGoneHtml, renderRedirectHtml } from './og-html';
import { loadCardExcerpt } from './render/excerpt';
import {
  isOwner,
  issueChallenge,
  requiredActionFor,
  DEFAULT_SWEEP_BUDGET,
  sweepGoneLinks,
  type SweepBudget,
  verifyChallenge,
  type OwnershipDeps,
} from './ownership';
import { Repository, type LinkRecord } from './records';
import { checkSlug, slugCandidate, slugify } from './slug';
import type { Store } from './store';

export const CARD_IMAGE_WIDTH = 1200;
/** Metadata is refreshed lazily when older than this (spec 5.2). */
export const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
const SLUG_SUFFIX_ATTEMPTS = 30;
const PAGE_LOCK_POLL_MS = 100;
const PAGE_LOCK_WAIT_ATTEMPTS = 50;
/**
 * How long a resolved card image is reused per instance before Notion is asked again. Short
 * because an unpublished page must stop serving its image promptly; never served past it.
 */
export const CARD_CACHE_TTL_MS = 60 * 1000;
const CARD_CACHE_ENTRIES = 500;

export interface ServiceDeps {
  store: Store;
  fetcher: PageFetcher;
  /** `https://ntn.link`, no trailing slash. */
  origin: string;
  now?: () => Date;
  /** Purge edge caches for both link forms of `<ws>/<slug>`. */
  purge?: (workspace: string, slug: string) => Promise<void>;
  /** Overrides of `DEFAULT_SWEEP_BUDGET`, mainly for tests. */
  sweepBudget?: Partial<SweepBudget>;
  /**
   * First lines of a page's text for the card of a page without a cover; must resolve to
   * `[]` rather than reject. Defaults to reading them from Notion.
   */
  loadExcerpt?: (workspace: string, pageId: string) => Promise<string[]>;
}

/** Who is calling a link-mutating endpoint. */
export type Caller = { kind: 'owner'; ownerKey: string | null } | { kind: 'operator' };

export type RedirectPageResult =
  | { kind: 'page'; html: string; needsRefresh: boolean }
  | { kind: 'gone'; html: string; needsRefresh: boolean }
  | { kind: 'not_found' };

export type CardSource =
  | { kind: 'notion-image'; pageId: string; url: string; title: string; description: string }
  | { kind: 'generated'; pageId: string; title: string; description: string };

/** `CreateLinkResponse` plus whether this call created the link (HTTP 201) or found it (200). */
export interface CreateLinkOutcome extends CreateLinkResponse {
  created: boolean;
}

export interface Service {
  preview(request: PreviewRequest, ownerKey: string | null): Promise<PreviewResponse>;
  issueChallenge(request: ChallengeRequest): Promise<ChallengeResponse>;
  verify(request: VerifyRequest): Promise<VerifyResponse>;
  /**
   * Creates a link. Without an explicit `slug`, a page that already has a link in the namespace
   * yields that link (`created: false`) instead of a second `-2` link; an explicit slug always
   * creates a new link.
   */
  createLink(request: CreateLinkRequest, ownerKey: string | null): Promise<CreateLinkOutcome>;
  updateLink(
    workspace: string,
    slug: string,
    request: UpdateLinkRequest,
    ownerKey: string | null,
  ): Promise<UpdateLinkResponse>;
  deleteLink(workspace: string, slug: string, caller: Caller): Promise<void>;
  listLinks(workspace: string, ownerKey: string | null): Promise<ListLinksResponse>;
  /** Redirect-page HTML for `GET /<ws>/<slug>`. */
  redirectPage(workspace: string, slug: string): Promise<RedirectPageResult>;
  /** Re-fetches Notion data for a stored link; failures are swallowed by design. */
  refreshLink(workspace: string, slug: string): Promise<void>;
  /** Re-runs the post-rotation cleanup (removes links whose target is gone); owner only. */
  sweepLinks(workspace: string, ownerKey: string | null): Promise<SweepLinksResponse>;
  /**
   * What `GET /img/<ws>/<slug>` should serve. The Notion image is resolved against Notion
   * (signed URLs expire) and reused per instance for `CARD_CACHE_TTL_MS`.
   */
  cardSource(workspace: string, slug: string): Promise<CardSource | null>;
  /**
   * Leading text lines of a page, drawn on the generated card. Takes the page id of the
   * `cardSource` snapshot (not the slug), so a slug recreated for another page in between can
   * never pair one page's title with another's text; `[]` when Notion does not answer.
   */
  pageExcerpt(workspace: string, pageId: string): Promise<string[]>;
  /** The stored link for the fast variant; null when missing or no longer public. */
  getLink(workspace: string, slug: string): Promise<LinkRecord | null>;
  readonly store: Store;
  readonly origin: string;
}

function effectiveCard(record: LinkRecord, imageUrl: string | null): CardData {
  return {
    title: record.overrides.title ?? record.title,
    description: record.overrides.description ?? record.description,
    imageUrl,
    language: record.language,
  };
}

function linkLimitError(): ApiError {
  return new ApiError(
    'link_limit',
    `A namespace can hold at most ${API_LIMITS.linksPerNamespace} links.`,
  );
}

/** Applies an owner's PATCH to a stored link; `null` removes an override. */
function applyUpdate(current: LinkRecord, request: UpdateLinkRequest): LinkRecord {
  const overrides = { ...current.overrides };
  for (const field of ['title', 'description'] as const) {
    const value = request.overrides?.[field];
    if (value === null) delete overrides[field];
    else if (value !== undefined) overrides[field] = value;
  }
  return {
    ...current,
    overrides,
    fast: request.fast ?? current.fast,
    canonicalMode: request.canonicalMode ?? current.canonicalMode,
  };
}

function applyFetchResult(latest: LinkRecord, result: PageFetchResult, nowIso: string): LinkRecord {
  if (result.kind === 'not_public' || result.workspace !== latest.workspace) {
    return { ...latest, goneAt: latest.goneAt ?? nowIso, fetchedAt: nowIso };
  }
  return {
    ...latest,
    title: result.metadata.title,
    description: result.metadata.description,
    imageUrl: result.metadata.imageUrl,
    language: result.metadata.language,
    fetchedAt: nowIso,
    goneAt: null,
  };
}

/** Rejects reserved and malformed explicit slugs with their typed errors. */
function assertUsableSlug(slug: string): void {
  const check = checkSlug(slug);
  if (check === 'reserved') {
    throw new ApiError(
      'slug_reserved',
      `"${slug}" is a reserved word and cannot be used as a slug.`,
    );
  }
  if (check === 'invalid') {
    throw new ApiError(
      'slug_invalid',
      'A slug is 1-64 characters: lowercase a-z, 0-9 and single hyphens.',
    );
  }
}

export function createService(deps: ServiceDeps): Service {
  const repo = new Repository(deps.store);
  const now = deps.now ?? (() => new Date());
  const purgeEdge = deps.purge ?? (async () => {});
  const loadExcerpt =
    deps.loadExcerpt ?? ((workspace, pageId) => loadCardExcerpt({ workspace, pageId }));
  // The image URL Notion currently serves for a link; memory only, never stored (it is signed
  // and expires). Resolved per page id, so a recreated slug never inherits it.
  const cardImages = new TtlCache<string | null>({
    ttlMs: CARD_CACHE_TTL_MS,
    maxEntries: CARD_CACHE_ENTRIES,
    now: () => now().getTime(),
  });
  const purge = async (workspace: string, slug: string): Promise<void> => {
    cardImages.delete(`${workspace}/${slug}`);
    await purgeEdge(workspace, slug);
  };
  const ownership: OwnershipDeps = {
    repo,
    fetcher: deps.fetcher,
    now,
    onLinkRemoved: purge,
    sweepBudget: { ...DEFAULT_SWEEP_BUDGET, ...deps.sweepBudget },
  };

  const redirectUrl = (ws: string, slug: string): string => `${deps.origin}/${ws}/${slug}`;

  function view(record: LinkRecord): LinkView {
    return {
      workspace: record.workspace,
      slug: record.slug,
      pageId: record.pageId,
      canonicalUrl: record.canonicalUrl,
      card: effectiveCard(record, `${deps.origin}/img/${record.workspace}/${record.slug}`),
      overrides: record.overrides,
      fast: record.fast,
      canonicalMode: record.canonicalMode,
      createdAt: record.createdAt,
      redirectUrl: redirectUrl(record.workspace, record.slug),
      fastUrl: record.fast ? `${redirectUrl(record.workspace, record.slug)}/read` : null,
    };
  }

  async function fetchPublic(url: string) {
    const result = await deps.fetcher.fetchPage(parseNotionUrl(url));
    if (result.kind === 'not_public') {
      throw new ApiError(
        'not_public',
        'That page is not public. In Notion use Share, then Publish, and try again.',
      );
    }
    return result;
  }

  async function requireOwnerOf(workspace: string, ownerKey: string | null): Promise<void> {
    if (!(await isOwner(repo, workspace, ownerKey))) {
      throw new ApiError(
        'unauthorized',
        'A valid owner key for this namespace is required (Authorization: Bearer <key>).',
      );
    }
  }

  async function requireCaller(workspace: string, caller: Caller): Promise<void> {
    if (caller.kind === 'operator') return;
    await requireOwnerOf(workspace, caller.ownerKey);
  }

  async function reserveSlug(
    record: Omit<LinkRecord, 'slug'>,
    explicit: string | undefined,
    base: string,
  ): Promise<LinkRecord> {
    if (explicit !== undefined) {
      assertUsableSlug(explicit);
      const candidate = { ...record, slug: explicit };
      const outcome = await repo.createLink(candidate);
      if (outcome === 'full') throw linkLimitError();
      if (outcome === 'exists') {
        throw new ApiError('slug_taken', `"${explicit}" is already taken in ${record.workspace}.`);
      }
      return candidate;
    }
    for (let attempt = 1; attempt <= SLUG_SUFFIX_ATTEMPTS; attempt++) {
      const candidate = { ...record, slug: slugCandidate(base, attempt) };
      const outcome = await repo.createLink(candidate);
      if (outcome === 'full') throw linkLimitError();
      if (outcome === 'created') return candidate;
    }
    throw new ApiError('slug_taken', 'Could not find a free slug automatically; choose one.');
  }

  async function proposeSlug(workspace: string, title: string): Promise<string> {
    const base = slugify(title);
    for (let attempt = 1; attempt <= SLUG_SUFFIX_ATTEMPTS; attempt++) {
      const candidate = slugCandidate(base, attempt);
      if ((await repo.getLink(workspace, candidate)) === null) return candidate;
    }
    return slugCandidate(base, SLUG_SUFFIX_ATTEMPTS + 1);
  }

  async function fetchFresh(record: LinkRecord): Promise<PageFetchResult | null> {
    try {
      return await deps.fetcher.fetchPage({
        pageId: record.pageId,
        workspaceHint: record.workspace,
      });
    } catch {
      return null;
    }
  }

  async function findPageLink(workspace: string, pageId: string): Promise<LinkRecord | undefined> {
    return (await repo.listLinks(workspace))
      .filter((record) => record.pageId === pageId)
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  }

  /**
   * Runs the automatic creation of a link for a page one request at a time and answers with the
   * page's existing link when there is one. A request that finds the lock taken waits for the
   * holder's link instead of racing it.
   */
  async function withPageCreationLock(
    workspace: string,
    pageId: string,
    create: () => Promise<CreateLinkOutcome>,
    reuse: (existing: LinkRecord) => Promise<CreateLinkOutcome>,
  ): Promise<CreateLinkOutcome> {
    for (let attempt = 0; attempt <= PAGE_LOCK_WAIT_ATTEMPTS; attempt++) {
      const lease = await repo.acquirePageCreation(workspace, pageId);
      if (lease !== null) {
        try {
          const existing = await findPageLink(workspace, pageId);
          return existing === undefined ? await create() : await reuse(existing);
        } finally {
          await repo.releasePageCreation(workspace, pageId, lease);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, PAGE_LOCK_POLL_MS));
      const existing = await findPageLink(workspace, pageId);
      if (existing !== undefined) return reuse(existing);
    }
    throw new ApiError(
      'upstream_error',
      'Another request is creating a link for this page. Try again.',
    );
  }

  return {
    store: deps.store,
    origin: deps.origin,

    async preview(request, ownerKey) {
      const page = await fetchPublic(request.url);
      const claimed = (await repo.getNamespace(page.workspace)) !== null;
      const owner = await isOwner(repo, page.workspace, ownerKey);
      const meta = page.metadata;
      return {
        workspace: page.workspace,
        pageId: page.pageId,
        canonicalUrl: page.canonicalUrl,
        card: {
          title: meta.title,
          description: meta.description,
          imageUrl: meta.imageUrl === null ? null : withImageWidth(meta.imageUrl, CARD_IMAGE_WIDTH),
          language: meta.language,
        },
        excerpt: meta.imageUrl === null ? await loadExcerpt(page.workspace, page.pageId) : [],
        proposedSlug: await proposeSlug(page.workspace, meta.title),
        namespaceClaimed: claimed,
        needsVerification: !owner,
        suggestedAction: owner ? null : claimed ? 'rotate' : 'claim',
      };
    },

    issueChallenge: (request) =>
      issueChallenge(ownership, parseNotionUrl(request.url), request.action),

    verify: (request) =>
      verifyChallenge(ownership, parseNotionUrl(request.url), request.nonce, request.claimToken),

    async createLink(request, ownerKey) {
      const page = await fetchPublic(request.url);
      if (!isUsableWorkspace(page.workspace)) {
        throw new ApiError(
          'unsupported_workspace',
          `"${page.workspace}" cannot be used as a namespace.`,
        );
      }
      if (!(await isOwner(repo, page.workspace, ownerKey))) {
        throw new ApiError(
          'needs_verification',
          'Prove you control this Notion workspace first: request a challenge, put the nonce into a page title, then verify.',
          { action: await requiredActionFor(repo, page.workspace) },
        );
      }
      const meta = page.metadata;
      const create = async (): Promise<CreateLinkOutcome> => {
        const overrides = request.overrides ?? {};
        const nowIso = now().toISOString();
        const created = await reserveSlug(
          {
            workspace: page.workspace,
            pageId: page.pageId,
            canonicalUrl: page.canonicalUrl,
            title: meta.title,
            description: meta.description,
            imageUrl: meta.imageUrl,
            language: meta.language,
            fetchedAt: nowIso,
            createdAt: nowIso,
            overrides,
            fast: request.fast ?? true,
            canonicalMode: 'self',
            goneAt: null,
          },
          request.slug,
          slugify(overrides.title ?? meta.title),
        );
        await purge(created.workspace, created.slug);
        return { link: view(created), created: true };
      };
      if (request.slug !== undefined) return create();
      // Idempotent for clients that retry after a timeout: the page already has a link here.
      const reuse = async (existing: LinkRecord): Promise<CreateLinkOutcome> => {
        if (existing.goneAt === null) return { link: view(existing), created: false };
        // The page is public again (just fetched), so the returned link must serve it again.
        const nowIso = now().toISOString();
        const revived = await repo.updateLink(existing.workspace, existing.slug, (latest) =>
          latest.pageId === page.pageId ? applyFetchResult(latest, page, nowIso) : latest,
        );
        await purge(existing.workspace, existing.slug);
        return { link: view(revived ?? existing), created: false };
      };
      return withPageCreationLock(page.workspace, page.pageId, create, reuse);
    },

    async updateLink(workspace, slug, request, ownerKey) {
      await requireOwnerOf(workspace, ownerKey);
      if (request.slug !== undefined && request.slug !== slug) {
        assertUsableSlug(request.slug);
        const moved = await repo.moveLink(workspace, slug, request.slug, (current) =>
          applyUpdate(current, request),
        );
        if (moved.kind === 'missing') throw new ApiError('not_found', 'No such link.');
        if (moved.kind === 'taken') {
          throw new ApiError('slug_taken', `"${request.slug}" is already taken in ${workspace}.`);
        }
        await purge(workspace, slug);
        await purge(workspace, request.slug);
        return { link: view(moved.link) };
      }
      const updated = await repo.updateLink(workspace, slug, (current) =>
        applyUpdate(current, request),
      );
      if (updated === null) throw new ApiError('not_found', 'No such link.');
      await purge(workspace, slug);
      return { link: view(updated) };
    },

    async deleteLink(workspace, slug, caller) {
      await requireCaller(workspace, caller);
      if (!(await repo.deleteLink(workspace, slug)))
        throw new ApiError('not_found', 'No such link.');
      await purge(workspace, slug);
    },

    async listLinks(workspace, ownerKey) {
      await requireOwnerOf(workspace, ownerKey);
      const records = await repo.listLinks(workspace);
      records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return { workspace, links: records.map(view) };
    },

    async redirectPage(workspace, slug) {
      const record = await repo.getLink(workspace, slug);
      if (record === null) return { kind: 'not_found' };
      const stale = now().getTime() - new Date(record.fetchedAt).getTime() > REFRESH_AFTER_MS;
      // A gone link is re-checked like any other so it recovers once the page is public again.
      if (record.goneAt !== null)
        return { kind: 'gone', html: renderGoneHtml(), needsRefresh: stale };
      const card = effectiveCard(record, null);
      const html = renderRedirectHtml({
        title: card.title,
        description: card.description,
        imageUrl: `${deps.origin}/img/${workspace}/${slug}`,
        pageUrl: redirectUrl(workspace, slug),
        // Rebuilt from validated parts, never taken from stored free text.
        targetUrl: canonicalNotionUrl(record.workspace, record.pageId),
        language: record.language,
      });
      return { kind: 'page', html, needsRefresh: stale };
    },

    async sweepLinks(workspace, ownerKey) {
      await requireOwnerOf(workspace, ownerKey);
      const namespace = await repo.getNamespace(workspace);
      if (namespace === null) {
        throw new ApiError('namespace_not_claimed', `The namespace "${workspace}" is not claimed.`);
      }
      const { removedLinks, complete } = await sweepGoneLinks(
        ownership,
        workspace,
        namespace.keyHash,
      );
      return { workspace, removedLinks, cleanupComplete: complete };
    },

    async refreshLink(workspace, slug) {
      const record = await repo.getLink(workspace, slug);
      if (record === null) return;
      const result = await fetchFresh(record);
      if (result === null) return; // Transient Notion trouble: keep serving the stored card.
      const nowIso = now().toISOString();
      const refreshed = await repo.updateLink(workspace, slug, (latest) =>
        // The slug may have been deleted and reused for another page while Notion answered.
        latest.pageId === record.pageId ? applyFetchResult(latest, result, nowIso) : latest,
      );
      if (refreshed !== null) await purge(workspace, slug);
    },

    async cardSource(workspace, slug) {
      const record = await repo.getLink(workspace, slug);
      if (record === null) return null;
      const card = effectiveCard(record, null);
      const imageUrl = await cardImages.get(`${workspace}/${slug}`, record.pageId, async () => {
        // The stored URL is only a fallback for transient fetch failures: a page that is no
        // longer public, or moved to another workspace, must not keep serving its image.
        const fresh = await fetchFresh(record);
        if (fresh === null) {
          // A stored "Made with Notion" card cannot be told from an upload without the page
          // data, which is exactly what is unavailable here: do not serve it.
          const stored = record.imageUrl;
          const generated = stored !== null && isNotionGeneratedCardUrl(stored);
          return { value: generated ? null : stored, cacheable: false };
        }
        const stillHere = fresh.kind === 'public' && fresh.workspace === record.workspace;
        return { value: stillHere ? fresh.metadata.imageUrl : null, cacheable: true };
      });
      if (imageUrl === null || isNotionPlaceholderImageUrl(imageUrl) || record.goneAt !== null) {
        return {
          kind: 'generated',
          pageId: record.pageId,
          title: card.title,
          description: card.description,
        };
      }
      return {
        kind: 'notion-image',
        pageId: record.pageId,
        url: withImageWidth(imageUrl, CARD_IMAGE_WIDTH),
        title: card.title,
        description: card.description,
      };
    },

    pageExcerpt: (workspace, pageId) => loadExcerpt(workspace, pageId),

    async getLink(workspace, slug) {
      const record = await repo.getLink(workspace, slug);
      return record !== null && record.goneAt === null ? record : null;
    },
  };
}
