/**
 * Public HTTP contract of ntn-link (spec section 5.1).
 *
 * This file is the single source of truth for every client (web UI, CLI, browser
 * extension). It is type-only on purpose (apart from the error-code list) so a
 * client can `import type` from it without pulling in any runtime dependency.
 * Request validation lives in `api-schemas.ts` and is checked against these types.
 *
 * Conventions
 * - All bodies are JSON. Success responses are the documented `*Response` type with
 *   HTTP 200 (201 for `POST /api/links`).
 * - Errors are always `{ error: { code, message } }` with the HTTP status from
 *   `ERROR_STATUS`. `message` is human-readable and meant to be printed as is.
 * - The owner key travels as `Authorization: Bearer <ownerKey>`, never in a body or URL.
 * - Operator delete uses the `X-Admin-Token` header on `DELETE /api/links/<ws>/<slug>`.
 *
 * Endpoints
 *   POST   /api/preview               PreviewRequest   -> PreviewResponse
 *   POST   /api/challenge             ChallengeRequest -> ChallengeResponse
 *   POST   /api/verify                VerifyRequest    -> VerifyResponse
 *   POST   /api/links                 CreateLinkRequest-> CreateLinkResponse   (Bearer key)
 *   PATCH  /api/links/<ws>/<slug>     UpdateLinkRequest-> UpdateLinkResponse   (Bearer key)
 *   DELETE /api/links/<ws>/<slug>                      -> DeleteLinkResponse   (Bearer key or admin token)
 *   GET    /api/ns/<ws>/links                          -> ListLinksResponse    (Bearer key)
 *
 * Public routes (not JSON API)
 *   GET /<ws>/<slug>        200 HTML with OG tags and an immediate redirect to Notion
 *   GET /<ws>/<slug>/read   fast static copy of the page
 *   GET /img/<ws>/<slug>    1200x630 card image (proxied Notion image or generated card)
 */

export const ERROR_CODES = [
  'invalid_request',
  'not_notion_url',
  'not_public',
  'unsupported_workspace',
  'slug_taken',
  'slug_reserved',
  'slug_invalid',
  'needs_verification',
  'unauthorized',
  'namespace_claimed',
  'namespace_not_claimed',
  'challenge_expired',
  'challenge_invalid',
  'nonce_not_found',
  'link_limit',
  'rate_limited',
  'not_found',
  'gone',
  'upstream_error',
  'not_implemented',
  'server_misconfigured',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** HTTP status used for each error code; clients may rely on the code, not the status. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  invalid_request: 400,
  not_notion_url: 400,
  not_public: 422,
  unsupported_workspace: 422,
  slug_taken: 409,
  slug_reserved: 422,
  slug_invalid: 422,
  needs_verification: 403,
  unauthorized: 401,
  namespace_claimed: 409,
  namespace_not_claimed: 409,
  challenge_expired: 410,
  challenge_invalid: 403,
  nonce_not_found: 422,
  link_limit: 409,
  rate_limited: 429,
  not_found: 404,
  gone: 410,
  upstream_error: 502,
  not_implemented: 501,
  server_misconfigured: 500,
};

export type ChallengeAction = 'claim' | 'rotate';

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Only on `needs_verification`: which challenge action the client should request next. */
    action?: ChallengeAction;
    /** Only on `rate_limited`: seconds until the caller may retry (also sent as `Retry-After`). */
    retryAfterSeconds?: number;
  };
}

export type CanonicalMode = 'self' | 'notion';

export interface TextOverrides {
  title?: string;
  description?: string;
}

/** Card data exactly as an unfurler would see it. */
export interface CardData {
  /** Title without the trailing " | Notion". */
  title: string;
  description: string;
  /** Page social image requested at width=1200, or null when the generated title card is used. */
  imageUrl: string | null;
  /** BCP 47 primary subtag (`ru`, `en`, ...) detected from the text, or null if unknown. */
  language: string | null;
}

export interface PreviewRequest {
  url: string;
}

export interface PreviewResponse {
  workspace: string;
  pageId: string;
  /** Canonical `https://<ws>.notion.site/<32-hex-id>` the redirect link will lead to. */
  canonicalUrl: string;
  card: CardData;
  /** Free slug proposed from the title. */
  proposedSlug: string;
  /** True when the namespace is unclaimed. */
  namespaceClaimed: boolean;
  /**
   * True when the caller (no key, or a key that does not match) cannot create links yet.
   * `suggestedAction` then says which challenge to request.
   */
  needsVerification: boolean;
  suggestedAction: ChallengeAction | null;
}

export interface ChallengeRequest {
  url: string;
  action: ChallengeAction;
}

export interface ChallengeResponse {
  workspace: string;
  action: ChallengeAction;
  /** Public. Put it in the title of any public page of the workspace. */
  nonce: string;
  /** Private to the caller. Keep in memory/storage, never publish. Sent back to /api/verify. */
  claimToken: string;
  /** ISO 8601, 15 minutes after issue. */
  expiresAt: string;
}

export interface VerifyRequest {
  url: string;
  nonce: string;
  claimToken: string;
}

export interface VerifyResponse {
  workspace: string;
  action: ChallengeAction;
  /** Shown exactly once. Only its SHA-256 is stored. */
  ownerKey: string;
  /** Rotation only: number of links removed because their target is no longer public. */
  removedLinks: number;
  /**
   * False when the post-rotation sweep stopped early (storage trouble). The new key is valid
   * regardless; the sweep is idempotent and can be re-run with that key.
   */
  cleanupComplete: boolean;
}

export interface CreateLinkRequest {
  url: string;
  /** Defaults to a transliteration of the page title. */
  slug?: string;
  /** Defaults to true. */
  fast?: boolean;
  overrides?: TextOverrides;
}

export interface LinkView {
  workspace: string;
  slug: string;
  pageId: string;
  canonicalUrl: string;
  /** Effective values after overrides. */
  card: CardData;
  overrides: TextOverrides;
  fast: boolean;
  canonicalMode: CanonicalMode;
  createdAt: string;
  /** Redirect link `https://<origin>/<ws>/<slug>`. */
  redirectUrl: string;
  /** Fast link `https://<origin>/<ws>/<slug>/read`, null when `fast` is off. */
  fastUrl: string | null;
}

export interface CreateLinkResponse {
  link: LinkView;
}

export interface UpdateLinkRequest {
  slug?: string;
  /** A `null` value removes that override. */
  overrides?: { title?: string | null; description?: string | null };
  fast?: boolean;
  canonicalMode?: CanonicalMode;
}

export interface UpdateLinkResponse {
  link: LinkView;
}

export interface DeleteLinkResponse {
  deleted: true;
}

export interface ListLinksResponse {
  workspace: string;
  links: LinkView[];
}

/** Limits that clients may want to pre-validate against. */
export const API_LIMITS = {
  slugMaxLength: 64,
  titleOverrideMaxLength: 200,
  descriptionOverrideMaxLength: 500,
  linksPerNamespace: 200,
} as const;
