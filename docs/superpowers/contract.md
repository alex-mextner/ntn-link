# ntn-link contract (as implemented in `@ntn-link/core`)

Single reference for the slices that consume core (web routes, fast variant, CLI, extension).
It describes what `packages/core/src` exports today; where it and the code differ, the code
wins and this file is stale. Sources: `api-types.ts` (wire contract), `api-schemas.ts`
(request validation), `errors.ts`, `service.ts`, `store.ts`, `records.ts`, `rate-limit.ts`.
Design intent lives in `docs/superpowers/specs/2026-11-10-ntn-link-design.md` (spec wins over the plan).

Import from the package root: `import { ... } from '@ntn-link/core'` (`packages/core/src/index.ts`).
`api-types.ts` is type-only apart from `ERROR_CODES`, `ERROR_STATUS` and `API_LIMITS`, so a
client can `import type` from it.

## HTTP API

All bodies are JSON. Success is HTTP 200, except `POST /api/links` which answers 201 when it creates a link
(and 200 with the existing link when it is a retry, see below).
Errors are always `{ "error": { "code", "message", "action?", "retryAfterSeconds?" } }` with the
status from the table below; clients may rely on `code`, not on the status.

The owner key travels only as `Authorization: Bearer <ownerKey>` (prefix `ntnk_`), never in a
body or URL. The operator delete uses the `X-Admin-Token` header instead of the owner key.
(`api-types.ts` documents both headers; the token comparison itself is done by the web layer,
core only receives `Caller = { kind: 'operator' }`.)

| Method | Path                       | Request             | Response              | Auth                      |
| ------ | -------------------------- | ------------------- | --------------------- | ------------------------- |
| POST   | `/api/preview`             | `PreviewRequest`    | `PreviewResponse`     | optional Bearer key       |
| POST   | `/api/challenge`           | `ChallengeRequest`  | `ChallengeResponse`   | none                      |
| POST   | `/api/verify`              | `VerifyRequest`     | `VerifyResponse`      | none                      |
| POST   | `/api/links`               | `CreateLinkRequest` | `CreateLinkResponse`  | Bearer key (201 / 200)    |
| PATCH  | `/api/links/<ws>/<slug>`   | `UpdateLinkRequest` | `UpdateLinkResponse`  | Bearer key                |
| DELETE | `/api/links/<ws>/<slug>`   | -                   | `{ "deleted": true }` | Bearer key or admin token |
| GET    | `/api/ns/<ws>/links`       | -                   | `ListLinksResponse`   | Bearer key                |
| POST   | `/api/ns/<ws>/sweep`       | - (empty body)      | `SweepLinksResponse`  | Bearer key                |

Public routes (not JSON API): `GET /<ws>/<slug>` (HTML with OG tags and an immediate redirect
to Notion), `GET /<ws>/<slug>/read` (fast static copy), `GET /img/<ws>/<slug>` (card image:
proxied Notion image or generated title card).

Request bodies are validated by zod schemas exported from core: `previewRequestSchema`,
`challengeRequestSchema`, `verifyRequestSchema`, `createLinkRequestSchema`,
`updateLinkRequestSchema` (each `satisfies z.ZodType<...>` of the type in `api-types.ts`).

### Error codes and statuses (`ERROR_CODES`, `ERROR_STATUS`)

| code                    | status | meaning                                                              |
| ----------------------- | ------ | -------------------------------------------------------------------- |
| `invalid_request`       | 400    | body fails schema validation                                         |
| `not_notion_url`        | 400    | URL is not a Notion page URL                                         |
| `not_public`            | 422    | page is not published / not reachable as a bot                       |
| `unsupported_workspace` | 422    | page is not under a `<ws>.notion.site` domain                        |
| `slug_taken`            | 409    |                                                                      |
| `slug_reserved`         | 422    |                                                                      |
| `slug_invalid`          | 422    | 1-64 chars, `a-z0-9` and single hyphens                              |
| `needs_verification`    | 403    | carries `action`: `claim` or `rotate`, the challenge to request next |
| `unauthorized`          | 401    | owner key missing or not the namespace's current key                 |
| `namespace_claimed`     | 409    | claim requested/finished for an already claimed namespace            |
| `namespace_not_claimed` | 409    | rotate requested for an unclaimed namespace                          |
| `challenge_expired`     | 410    | expired, already used, too many wrong tokens, or the rotation was overtaken by a newer rotation |
| `challenge_invalid`     | 403    | wrong claim token / wrong workspace / not a nonce                    |
| `nonce_not_found`       | 422    | page title does not contain the nonce yet (challenge is kept)        |
| `link_limit`            | 409    | namespace already holds `API_LIMITS.linksPerNamespace` links         |
| `rate_limited`          | 429    | carries `retryAfterSeconds` (also send as `Retry-After`)             |
| `not_found`             | 404    |                                                                      |
| `gone`                  | 410    |                                                                      |
| `upstream_error`        | 502    | Notion or the storage backend misbehaved                             |
| `not_implemented`       | 501    |                                                                      |
| `server_misconfigured`  | 500    | includes a corrupt stored record                                     |

`ApiError(code, message, { action?, retryAfterSeconds? })` has `.status` and `.toBody()`
(the envelope above); route handlers translate it without further interpretation.

### Limits (`API_LIMITS`)

`slugMaxLength` 64, `titleOverrideMaxLength` 200, `descriptionOverrideMaxLength` 500,
`linksPerNamespace` 200.

Rate limits (`RATE_LIMITS`, per hashed client IP, fixed window; `enforceRateLimit(store, action, ip, now?)`):
`preview` 30/60 s, `challenge` 10/600 s, `verify` 20/600 s, `links` 30/60 s, `sweep` 10/600 s.

### Types

```ts
type ChallengeAction = 'claim' | 'rotate';
type CanonicalMode = 'self' | 'notion';
interface TextOverrides { title?: string; description?: string }
interface CardData { title: string; description: string; imageUrl: string | null; language: string | null }

interface PreviewRequest { url: string }
interface PreviewResponse {
  workspace: string; pageId: string; canonicalUrl: string; card: CardData; proposedSlug: string;
  namespaceClaimed: boolean; needsVerification: boolean; suggestedAction: ChallengeAction | null;
}
interface ChallengeRequest { url: string; action: ChallengeAction }
interface ChallengeResponse { workspace: string; action: ChallengeAction; nonce: string; claimToken: string; expiresAt: string }
interface VerifyRequest { url: string; nonce: string; claimToken: string }
interface VerifyResponse { workspace: string; action: ChallengeAction; ownerKey: string; removedLinks: number; cleanupComplete: boolean }
interface CreateLinkRequest { url: string; slug?: string; fast?: boolean; overrides?: TextOverrides }
interface UpdateLinkRequest { slug?: string; overrides?: { title?: string | null; description?: string | null }; fast?: boolean; canonicalMode?: CanonicalMode }
interface LinkView {
  workspace: string; slug: string; pageId: string; canonicalUrl: string; card: CardData; overrides: TextOverrides;
  fast: boolean; canonicalMode: CanonicalMode; createdAt: string; redirectUrl: string; fastUrl: string | null;
}
interface CreateLinkResponse { link: LinkView }   // UpdateLinkResponse is identical. Without `slug`, a page that already has a
// link in the namespace returns that link with HTTP 200 (idempotent retry, also when it overlaps the original request; request `overrides`/`fast` are ignored).
// With an explicit `slug` a new link is created (201), so one page can carry several links.
interface DeleteLinkResponse { deleted: true }
interface ListLinksResponse { workspace: string; links: LinkView[] }   // sorted by createdAt
interface SweepLinksResponse { workspace: string; removedLinks: number; cleanupComplete: boolean }
```

Ownership flow (spec section 4): without a valid key, `createLink` throws `needs_verification`
with `action`; `preview` does not throw but succeeds with `needsVerification: true` and
`suggestedAction: 'claim' | 'rotate'` (which challenge to request). `issueChallenge` returns a
public `nonce` (`ntn-verify-` + 10 chars of `a-z0-9`, goes into any public page title of the
workspace) and a private `claimToken`,
valid 15 minutes. `verify` needs both and returns the `ownerKey` once (only its SHA-256 is stored).
A `rotate` challenge is bound to the key version it was issued against: once any rotation has
replaced the key, older rotate challenges fail with `challenge_expired`, and a rotation whose key
was replaced again while its sweep ran also fails with `challenge_expired` instead of returning a
dead key. If storage cannot confirm a rotation, `verify` fails closed with `upstream_error`
("request a new rotate challenge") and the challenge is consumed. Rotation sweeps links whose target is no longer public in that workspace
(`removedLinks`; `cleanupComplete: false` means call `POST /api/ns/<ws>/sweep` with the new key until it
reports `true`; the sweep is idempotent and owner-only). Every sweep call (including the one inside `verify`) is
time-bounded (20 s, at most 100 Notion fetches, 8 in flight); links already confirmed public for the current
key are not fetched again, so repeated calls converge (links whose fetch failed are retried after the untried ones; a call returns by its deadline even if storage or the cache purge is slow). The key replacement happens first and never rolls back.

## Service (`createService(deps): Service`)

```ts
interface ServiceDeps {
  store: Store; fetcher: PageFetcher;
  origin: string;                        // 'https://ntn.link', no trailing slash
  now?: () => Date;
  purge?: (workspace: string, slug: string) => Promise<void>;  // purge edge caches for both link forms
}
type Caller = { kind: 'owner'; ownerKey: string | null } | { kind: 'operator' };
type RedirectPageResult =
  | { kind: 'page'; html: string; needsRefresh: boolean }
  | { kind: 'gone'; html: string; needsRefresh: boolean }
  | { kind: 'not_found' };
type CardSource =
  | { kind: 'notion-image'; url: string; title: string; description: string }
  | { kind: 'generated'; title: string; description: string };

interface Service {
  preview(request, ownerKey: string | null): Promise<PreviewResponse>;
  issueChallenge(request: ChallengeRequest): Promise<ChallengeResponse>;
  verify(request: VerifyRequest): Promise<VerifyResponse>;
  createLink(request, ownerKey): Promise<CreateLinkOutcome>; // CreateLinkResponse + created: boolean (201 vs 200)
  updateLink(workspace, slug, request, ownerKey): Promise<UpdateLinkResponse>;
  deleteLink(workspace, slug, caller: Caller): Promise<void>;
  listLinks(workspace, ownerKey): Promise<ListLinksResponse>;
  redirectPage(workspace, slug): Promise<RedirectPageResult>;   // GET /<ws>/<slug>
  refreshLink(workspace, slug): Promise<void>;                  // failures swallowed; purges on success
  sweepLinks(workspace, ownerKey): Promise<SweepLinksResponse>; // POST /api/ns/<ws>/sweep
  cardSource(workspace, slug): Promise<CardSource | null>;      // GET /img/<ws>/<slug>
  getLink(workspace, slug): Promise<LinkRecord | null>;         // fast variant; null when missing or gone
  readonly store: Store; readonly origin: string;
}
```

- `redirectPage.needsRefresh` is true when the stored metadata is older than `REFRESH_AFTER_MS`
  (24 h); the route should call `refreshLink` after responding. A link whose page stopped being
  public turns `gone` and recovers on a later refresh once the page is public again.
- `cardSource` resolves the Notion image against Notion on demand (Notion image URLs are signed
  and expire, so they are never stored) and reuses the answer per service instance:
  for `CARD_CACHE_TTL_MS` (60 s; an older entry is never served, so a just-unpublished page
  stops serving its image within that time), concurrent requests share one fetch,
  `updateLink`/`deleteLink`/`refreshLink` drop the entry. `CARD_IMAGE_WIDTH` is 1200. The image bytes themselves come from `fetchCardImage(url)`.
- `getLink` returns the full `LinkRecord`; `LinkRecord` fields: `workspace, slug, pageId,
  canonicalUrl, title, description, imageUrl, language, fetchedAt, createdAt, overrides, fast,
  canonicalMode, goneAt`.

## Other exports

- URL and text: `parseNotionUrl(input): ParsedNotionUrl { pageId, workspaceHint }`,
  `canonicalNotionUrl(ws, pageId)`, `toDashedUuid`, `isAllowedNotionHost`, `workspaceFromHost`,
  `isUsableWorkspace`, `slugify(title)`, `checkSlug(slug): 'ok'|'invalid'|'reserved'`,
  `RESERVED_WORDS`, `extractMetadata(html): PageMetadata`, `withImageWidth(url, width)`,
  `ogLocale`, `detectLanguage`, `renderRedirectHtml`, `renderGoneHtml`, `escapeHtml`.
- Fetching: `createPageFetcher({ fetchImpl? }): PageFetcher` where
  `PageFetcher.fetchPage(ParsedNotionUrl): Promise<{ kind: 'public'; workspace; pageId; canonicalUrl; metadata } | { kind: 'not_public' }>`;
  `safeFetch(url, options)` with `allowNotionPageUrl` / `allowNotionImageUrl` allowlists and `BOT_USER_AGENT`.
- Storage: `Store` (`get`, `set(key, value, { ttlSeconds?, ifAbsent? })`, `compareAndSet`,
  `delete`, `increment(key, ttlSeconds)`, `createIndexed`, `deleteIndexed`, `moveIndexed`,
  `setMembers`), `MemoryStore(now?)`, `UpstashStore({ url, token, timeoutMs? })`,
  `PostgresStore({ executor, timeoutMs?, purgeIntervalMs? })` with `neonHttpExecutor(url)` (the
  `SqlExecutor` seam: `query` and `transaction`) and `databaseUrlFromEnv(env)` (reads `DATABASE_URL`),
  `upstashConfigFromEnv(env)` (reads `UPSTASH_REDIS_REST_URL`/`_TOKEN`, falling back to
  `KV_REST_API_URL`/`_TOKEN`; null when neither pair is set), `Repository`.
- Crypto: `sha256Hex`, `timingSafeEqual`.

## Storage keys (Repository owns every format)

`ns:<ws>` namespace record (`keyHash`, `claimedAt`, `rotatedAt`); `link:<ws>/<slug>` link record;
`nslinks:<ws>` set of slugs (kept in step with the records by `createIndexed`/`deleteIndexed`/`moveIndexed`);
`challenge:<ws>:<nonce>` (TTL 15 min; carries `namespaceKeyHash` for rotate challenges);
`challenge-attempts:<ws>:<nonce>` (counter, cap 5); `rl:<action>:<hash>:<window>` (rate limit counters).
`UpstashStore` implements every multi-step operation as one Lua script (`EVAL`), tested against a
real Redis with `bun run test:redis`.

## Store selection and backends

`apps/web` picks the store from the environment, in this order: `DATABASE_URL` (`PostgresStore` over
the Neon HTTP driver), then `UPSTASH_REDIS_REST_URL`/`_TOKEN` or `KV_REST_API_URL`/`_TOKEN`
(`UpstashStore`), then `MemoryStore` in development only; in production nothing configured is a
`500 server_misconfigured`. All three implement the same `Store` contract
(`packages/core/test/store-contract.ts`, run against each).

`PostgresStore` keeps values in `ntn_kv(key, value, expires_at)` and set members in
`ntn_set_members(set_key, member)`; `ensureSchema` runs lazily once per instance under an advisory
lock. Every operation is one SQL statement (`INSERT ... ON CONFLICT`, `UPDATE ... WHERE value = $expected`);
`createIndexed`/`deleteIndexed`/`moveIndexed` first take a transaction-scoped advisory lock on the set
key in a two-statement batch (one transaction), so the cap and the record/member pairing hold under
concurrent callers while unrelated sets never wait for each other. Expiry is lazy (`expires_at`
compared with the database's `clock_timestamp()`, never the app clock) plus a bounded purge (200 rows,
at most once a minute per instance) run by a TTL-carrying write. Failures map to `upstream_error`
with the same 3 s deadline and redacted one-line `storage_failure` log as `UpstashStore`.
Tests: `bun test` (PGlite and a PGlite-backed Neon HTTP stand-in), `bun run test:postgres` (real
Postgres in docker, true concurrency) and `DATABASE_URL=... bun run test:neon` (the real database,
keys under a unique prefix, removed afterwards).
