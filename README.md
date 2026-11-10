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
bun run test:redis    # opt-in: store contract on a real Redis (docker)
bun run test:postgres # opt-in: store contract on a real Postgres (docker), true concurrency
NTN_TEST_DATABASE_URL=... NTN_ALLOW_LIVE_DB_TESTS=1 bun run test:neon  # opt-in: store contract on a separate Neon branch, never DATABASE_URL (see below)
```

`test:neon` writes to a real database, so it is guarded (`packages/core/test/support/live-db-guard.ts`):
it ignores `DATABASE_URL` completely, runs only against `NTN_TEST_DATABASE_URL` (use a separate Neon
branch, never the production one), and only with `NTN_ALLOW_LIVE_DB_TESTS=1`. It refuses a URL whose
host equals the host of `DATABASE_URL`, `POSTGRES_URL*` or `PGHOST*` in the same environment, and any
run with `NODE_ENV` or `VERCEL_ENV` set to `production`. The guard cannot recognise the production
database when no app variable is set next to the test URL: do not point the test URL at it. Rows
of a run (`ntnlinktest:<random>:`) are removed in `afterAll`, which also runs after failures (both
deletes run at once, each retried with a pause; a failure names the prefix to clean by hand).
Plain `bun test` loads the same file: keep `NTN_TEST_DATABASE_URL` out of `.env` files, since with
the URL but without the opt-in the suite fails to load (on purpose), and with both it writes to
that database.

Next is run with `--webpack` because Turbopack 16.4 cannot resolve `react/jsx-runtime` through
Bun's isolated install layout in this workspace.

## Environment

| Variable                                             | Meaning                                                                                                                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PUBLIC_ORIGIN`                                      | Origin used in links and `og:image`, e.g. `https://ntn.link`. Required in production; falls back to `https://$VERCEL_URL`, in development to `http://localhost:$PORT`.                                                         |
| `DATABASE_URL`                                       | Storage: the **pooled** Neon Postgres connection string (the Vercel Neon integration injects it). Wins over the Redis variables below.                                                                                         |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Storage (Upstash Redis REST), used when `DATABASE_URL` is not set. `KV_REST_API_URL` / `KV_REST_API_TOKEN` are accepted too.                                                                                                   |
| `ADMIN_TOKEN`                                        | Operator credential for `DELETE /api/links/<ws>/<slug>` via `X-Admin-Token`. Unset disables operator delete.                                                                                                                   |
| `NTN_TRUST_PROXY`                                    | `1` makes rate limiting trust `X-Forwarded-For` (set it only behind a proxy that overwrites the header). Always trusted on Vercel. Otherwise all callers share one rate-limit bucket, because the header is client-controlled. |
| `NTN_TEST_FETCHER`                                   | `1` enables the test fetcher, see below. Ignored with an error in production.                                                                                                                                                  |
| `NTN_TEST_FETCHER_NO_IMAGE`                          | With the test fetcher: `1` drops the page's social image so the generated title card is served.                                                                                                                                |

Store precedence: `DATABASE_URL` (Postgres) before the Upstash/KV pair (Redis) before memory. Without
any store configuration the app uses an **in-memory store in development only** (data is lost
on restart and not shared between instances). In production a missing store or `PUBLIC_ORIGIN`
makes every route answer `500 server_misconfigured` with a message naming the missing variable,
and logs it; it never silently falls back to memory.

## HTTP API

Errors are always `{"error":{"code","message"}}` with the status from `ERROR_STATUS` in
`packages/core/src/api-types.ts`, which is also the authoritative request/response contract. The
owner key travels as `Authorization: Bearer <ownerKey>`; client IPs (for rate limits, stored only
as a hash inside expiring counters) come from `X-Forwarded-For` where that header is trustworthy (see `NTN_TRUST_PROXY`).

| Endpoint                                                 | Purpose                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `POST /api/preview` `{url}`                              | Card data, proposed slug, whether verification is needed                                                     |
| `POST /api/challenge` `{url, action: "claim"\|"rotate"}` | `nonce` (public) and `claimToken` (private)                                                                  |
| `POST /api/verify` `{url, nonce, claimToken}`            | After the nonce is in a public page title: issues the owner key, shown once                                  |
| `POST /api/links` `{url, slug?, fast?, overrides?}`      | Create a link (Bearer key), `201`; a retry for the same page without `slug` returns the existing link, `200` |
| `PATCH /api/links/<ws>/<slug>`                           | Change slug, overrides, `fast`, `canonicalMode` (Bearer key)                                                 |
| `DELETE /api/links/<ws>/<slug>`                          | Delete (Bearer key or `X-Admin-Token`)                                                                       |
| `GET /api/ns/<ws>/links`                                 | List the namespace's links (Bearer key)                                                                      |
| `POST /api/ns/<ws>/sweep`                                | Remove links whose Notion page is gone; time-bounded, repeat until `cleanupComplete: true` (Bearer key)      |

Public routes:

| Route                   | Response                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /<ws>/<slug>`      | `200` HTML with OG tags and refresh to Notion (`410` once the Notion page is no longer public, `404` unknown). `Cache-Control: public, max-age=0, s-maxage=3600, stale-while-revalidate=86400`, tagged `ntn-<ws>-<slug>` via `Vercel-Cache-Tag`; stale cards are refreshed in the background after 24 h                                                                                                                                                                                                                                                       |
| `GET /<ws>/<slug>/read` | Fast copy of the page (static HTML)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /img/<ws>/<slug>`  | Card image: the page's own cover (PNG or JPEG, passed through unchanged, 1200 px wide requested) fetched fresh from Notion at request time (signed URLs expire, so only the bytes are CDN-cached). Notion's generic banners (the white "Notion" logo, the "Made with Notion" card) are never served: a page without a cover gets a generated 1200x630 card with the page's icon (an emoji drawn as a Twemoji picture, or the icon picture as a rounded square), its title and the beginning of its text in large type (bundled Noto Sans, Cyrillic supported) |

Emoji on the generated card are [Twemoji](https://github.com/jdecked/twemoji) graphics (Copyright 2020 Twitter, Inc and other contributors, [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/), shipped unmodified via `@twemoji/svg`; licence text in `apps/web/assets/emoji/`). They are not Apple's emoji: that artwork is proprietary and may not be redistributed in a PNG, so the card cannot have the iOS look (see the design spec, section 5.2). HTML surfaces (`/read`, the web preview) use the emoji as text, which Apple devices draw in Apple's own style.

Link changes purge the CDN by cache tag on Vercel (`dangerouslyDeleteByTag`) and revalidate the
`/read` path; elsewhere the purge is a no-op.

### Cards that change, and preview caches of messengers

The `og:image` of a link (and of its `/read` copy) is `/img/<ws>/<slug>?v=<version>`. The version
is a short digest of the card render version (`CARD_RENDER_VERSION` in
`packages/core/src/card-version.ts`, bumped whenever the look of the card changes), the effective
title and description, the cover, and, for a page without a cover, a digest of the opening text
and the icon drawn on its card (stored on create and on every refresh). A changed card therefore gets a new
image URL: crawlers that read the page again fetch the new image instead of reusing one cached
under the old URL, and the CDN keeps one entry per version. `?v=` is ignored by the route itself.

Telegram, Slack, Facebook and others keep their own preview of an already shared URL. That
cache cannot be cleared from this service: a link shared before a card change keeps its old
preview until the messenger decides to read the page again. For Telegram, send the link to
[@WebpageBot](https://t.me/WebpageBot) to make it re-read the page; messages posted afterwards
show the refreshed preview, messages already posted keep what they showed. Creating a second
link (another slug) to the same page always starts with a clean preview.

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

## Deploying to Vercel

Project settings (`apps/web/vercel.json` carries the framework, install/build commands and region):

| Setting         | Value                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------ |
| Root Directory  | `apps/web`, with "Include source files outside of the Root Directory" on (`packages/core`) |
| Node.js version | `24.x`                                                                                     |
| Install command | `bun install --frozen-lockfile`                                                            |
| Build command   | `bun run build`                                                                            |
| Function region | `fra1`                                                                                     |

Environment variables (Production and Preview; see [Environment](#environment)):

- `PUBLIC_ORIGIN`: the public origin, e.g. `https://ntn.link`.
- `ADMIN_TOKEN`: optional, enables operator delete; mark it sensitive.
- The store, one of (precedence in this order):
  1. `DATABASE_URL`: the pooled Neon Postgres URL (Neon HTTP driver, one stateless HTTPS request
     per storage call, nothing to pool or close in a serverless function). The tables `ntn_kv` and
     `ntn_set_members` are created on first use (idempotent `CREATE ... IF NOT EXISTS`); the role
     in the URL needs the right to create them once. Expiry uses the database clock.
     Neon's free plan scales the database to zero after about 5 minutes idle, and the first query
     then takes several seconds. Before an instance's first statement, and again after 4 minutes
     without an answer, the store sends an idempotent `SELECT 1` with a 10 s deadline (shared by
     concurrent callers, a failure is `502 upstream_error`, logged as `WARMUP`/`warmup-timeout`);
     real statements keep their 3 s deadline and are never retried. Routes that touch storage set
     `maxDuration = 60` (the 10 s warm-up plus the request's own Notion calls) to leave room for it; the
     extension's explicit actions wait up to 20 s for the same reason.
  2. `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, or `KV_REST_API_URL` +
     `KV_REST_API_TOKEN`. Each field is resolved on its own and the `UPSTASH_*` value wins, so a
     pair from two different stores is possible; set one pair only.

  Without a store, production routes answer `500 server_misconfigured`. Set one backend only:
  when `DATABASE_URL` is present the Redis variables are ignored.

Create the Postgres store through the Neon integration of the Vercel Marketplace (or the Upstash
Redis integration for the Redis option); the project owner has to accept the provider's terms in
that step, which an agent cannot do for them. Do not set `NTN_TEST_FETCHER` on Vercel (see the
caveat above).

Ownership flow: `POST /api/challenge` returns a public `nonce` and a private `claimToken`; the owner
puts the nonce into the title of a public page of the workspace, then `POST /api/verify` with the
`claimToken` issues the owner key (shown once). The `claimToken` is never put on a page.

Operations:

- Every storage request has a 3 s deadline; a backend that does not answer ends as `502
upstream_error`.
- Storage failures log one JSON line to stderr, `{"event":"storage_failure","command","errorClass","kind","message"}`,
  without keys, values or URLs; identical lines are limited to one per 10 s.
- `POST /api/ns/<ws>/sweep` (or `ntn-link sweep <workspace>`) removes links whose Notion page is
  gone. It is time-bounded; repeat until `cleanupComplete: true`.

Limits: at most 200 links per namespace. Rate limits are per client IP (fixed windows):

| Action      | Limit      |
| ----------- | ---------- |
| `preview`   | 30 / 60 s  |
| `links`     | 30 / 60 s  |
| `challenge` | 10 / 600 s |
| `verify`    | 20 / 600 s |
| `sweep`     | 10 / 600 s |

Run `bun run smoke:notion` after changing anything that parses Notion output.

License: MIT (see [LICENSE](LICENSE)).
