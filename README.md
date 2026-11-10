# ntn-link

Short, readable links for **public Notion pages** that unfurl in messengers with the page's real
title, description and image, then send readers on to Notion.

`https://<origin>/<workspace>/<slug>` answers `200` HTML (never a `302`) with Open Graph tags and an
immediate redirect to `https://<workspace>.notion.site/<page-id>`. No accounts: the owner of a
Notion workspace proves control once by putting a one-time nonce into the title of a public page of
that workspace and then holds an owner key for the namespace `<workspace>`.

Design: `docs/superpowers/specs/2026-11-10-ntn-link-design.md`.

## Layout

| Path            | What                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `packages/core` | Framework-free logic: Notion fetching, ownership, link service, stores, API contract (`src/api-types.ts`) |
| `apps/web`      | Next.js App Router app: API routes, public link routes, card images                                       |
| `vercel.json`   | Bun runtime, region `fra1`, install/build commands                                                        |

## Development

```bash
bun install
bun run dev          # next dev --webpack on http://localhost:3000, in-memory store
bun test             # core tests (offline)
bun run typecheck    # whole workspace
bun run lint
bun run build        # next build --webpack
bun run smoke:notion # opt-in live check of Notion's page shape (network)
```

Next is run with `--webpack` because Turbopack 16.4 cannot resolve `react/jsx-runtime` through
Bun's isolated install layout in this workspace.

## Environment

| Variable                                             | Meaning                                                                                                                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PUBLIC_ORIGIN`                                      | Origin used in links and `og:image`, e.g. `https://ntn.link`. Required in production; falls back to `https://$VERCEL_URL`, in development to `http://localhost:$PORT`.                                                         |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Storage (Upstash Redis REST). `KV_REST_API_URL` / `KV_REST_API_TOKEN` are accepted too.                                                                                                                                        |
| `ADMIN_TOKEN`                                        | Operator credential for `DELETE /api/links/<ws>/<slug>` via `X-Admin-Token`. Unset disables operator delete.                                                                                                                   |
| `NTN_TRUST_PROXY`                                    | `1` makes rate limiting trust `X-Forwarded-For` (set it only behind a proxy that overwrites the header). Always trusted on Vercel. Otherwise all callers share one rate-limit bucket, because the header is client-controlled. |
| `NTN_TEST_FETCHER`                                   | `1` enables the test fetcher, see below. Ignored with an error in production.                                                                                                                                                  |
| `NTN_TEST_FETCHER_NO_IMAGE`                          | With the test fetcher: `1` drops the page's social image so the generated title card is served.                                                                                                                                |

Without a store configuration the app uses an **in-memory store in development only** (data is lost
on restart and not shared between instances). In production a missing store or `PUBLIC_ORIGIN`
makes every route answer `500 server_misconfigured` with a message naming the missing variable,
and logs it; it never silently falls back to memory.

## HTTP API

Errors are always `{"error":{"code","message"}}` with the status from `ERROR_STATUS` in
`packages/core/src/api-types.ts`, which is also the authoritative request/response contract. The
owner key travels as `Authorization: Bearer <ownerKey>`; client IPs (for rate limits, stored only
as a hash inside expiring counters) come from `X-Forwarded-For` where that header is trustworthy (see `NTN_TRUST_PROXY`).

| Endpoint                                                 | Purpose                                                                     |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| `POST /api/preview` `{url}`                              | Card data, proposed slug, whether verification is needed                    |
| `POST /api/challenge` `{url, action: "claim"\|"rotate"}` | `nonce` (public) and `claimToken` (private)                                 |
| `POST /api/verify` `{url, nonce, claimToken}`            | After the nonce is in a public page title: issues the owner key, shown once |
| `POST /api/links` `{url, slug?, fast?, overrides?}`      | Create a link (Bearer key), `201`                                           |
| `PATCH /api/links/<ws>/<slug>`                           | Change slug, overrides, `fast`, `canonicalMode` (Bearer key)                |
| `DELETE /api/links/<ws>/<slug>`                          | Delete (Bearer key or `X-Admin-Token`)                                      |
| `GET /api/ns/<ws>/links`                                 | List the namespace's links (Bearer key)                                     |

Public routes:

| Route                   | Response                                                                                                                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /<ws>/<slug>`      | `200` HTML with OG tags and refresh to Notion (`410` once the Notion page is no longer public, `404` unknown). `Cache-Control: public, max-age=0, s-maxage=3600, stale-while-revalidate=86400`, tagged `ntn-<ws>-<slug>` via `Vercel-Cache-Tag`; stale cards are refreshed in the background after 24 h |
| `GET /<ws>/<slug>/read` | Fast copy of the page; `501 not_implemented` until that variant is merged                                                                                                                                                                                                                               |
| `GET /img/<ws>/<slug>`  | 1200x630 image: the page's Notion social image fetched fresh from Notion at request time (signed URLs expire, so only the bytes are CDN-cached), otherwise a generated title card (bundled Noto Sans, Cyrillic supported)                                                                               |

Link changes purge the CDN by cache tag on Vercel (`dangerouslyDeleteByTag`) and revalidate the
`/read` path; elsewhere the purge is a no-op.

## The `NTN_TEST_FETCHER` caveat

Verification demands that a public Notion page of the workspace shows the nonce in its title. To
exercise the whole claim flow without editing a real owner's page, `NTN_TEST_FETCHER=1` wraps the
real Notion fetcher: pages are still loaded from Notion for real, but their title gets the nonces
that this process itself issued via `/api/challenge` appended. Consequences, stated plainly:

- With it on, **anyone who can call the API can claim any workspace without owning it.** It is a
  development/testing switch only.
- It is refused in production: when `NODE_ENV=production` (which includes `next start` and every
  Vercel deployment, because Next inlines it at build time) any request fails with
  `500 server_misconfigured`. Run it with `bun run dev` (or another non-production `NODE_ENV`).
- State lives in process memory only.

## Deploying

Vercel project settings are in `apps/web/vercel.json` (Bun `1.x`, `fra1`); set the project's Root Directory to `apps/web` (Next is installed there; "include files outside the root directory" must stay on for `packages/core`). This layout has not been deployed yet. Set `PUBLIC_ORIGIN` and the
Upstash variables (plus optionally `ADMIN_TOKEN`) for the Production and Preview environments.
Run `bun run smoke:notion` after changing anything that parses Notion output.
