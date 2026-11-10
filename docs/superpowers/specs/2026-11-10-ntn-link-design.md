# ntn.link: pretty links for public Notion pages

Status: draft for owner review. Date: 2026-11-10.

## 1. Goal

Turn a public Notion URL into a short readable link with a clean preview card, with no registration:

`https://app.notion.com/p/thsm/413d447ac4b180169985c93eea7f02f9?source=copy_link` -> `https://ntn.link/thsm/our-trips`

Every link has two forms:

- **Redirect link** `https://ntn.link/<ws>/<slug>`: clean preview card, then the real Notion page.
- **Fast link** `https://ntn.link/<ws>/<slug>/read`: an instantly loading, static, zero-JavaScript copy of the page, built to the existing fast-page standards (section 5.3).

Success criteria:

1. A message containing the pretty link shows a clean card in Telegram, Slack, WhatsApp, Discord, X and iMessage: page title without the "| Notion" suffix, page description, a 1200x630 image (the page's own social image, or a generated title card).
2. A human opening the redirect link lands on the real Notion page after one HTML hop (a 200 document that redirects immediately; section 5.2).
3. Three interfaces, all without an account: web page, CLI, browser extension.
4. Nobody can take over another workspace's namespace by guessing it or by reading a public challenge.
5. Hosted on Vercel, running cost close to the domain price.
6. The fast link loads instantly everywhere. Measurable acceptance on the owner's test page (`thsm`, "Наши с Леночкой Путешествия") on a Vercel preview: Lighthouse mobile performance >= 95; LCP, INP and CLS all in Google's "good" range (LCP <= 2.5 s, INP <= 200 ms, CLS <= 0.1); TTFB and total transfer clearly below the Notion baseline measured on 2026-11-10: TTFB about 0.29 s (median of 5 runs 0.28-0.70 s), HTML 22.7 KB, 16 first-party JS/CSS files referenced by that HTML totalling 1,322,907 bytes on the wire (brotli; 6,076,505 bytes decoded), plus the 15 KB (brotli; 50.7 KB raw) page-data call. Targets: fast link HTML <= 14 KB compressed (fits the first TCP congestion window), no JavaScript, total transfer excluding images <= 30 KB (about 2% of the baseline), TTFB from the edge cache below the 0.29 s baseline when measured the same way from the same machine.

Non-goals: private pages, analytics, click counts, custom domains for the user, password protection, an official Notion OAuth integration, Google AMP and Yandex Turbo pages (section 5.3 gives the reasons).

## 2. Evidence this design rests on (probed 2026-11-10 against the owner's `thsm` page)

- Notion serves complete OpenGraph tags to a bot user agent: `og:title` ("Наши с Леночкой Путешествия | Notion"), `og:description`, `og:image` (`...?width=2000`, a custom `SocialMediaPreviewImage.png`), `og:site_name` ("thsm on Notion"), `og:locale` = `en_US`. The problem is Notion branding and the 2000 px image, not missing data. A plain `curl` without a bot user agent gets the generic Notion `og:image` (`app.notion.com/images/meta/default.png`), so metadata fetches must send a bot user agent.
- Every URL form redirects to the canonical `https://<workspace>.notion.site/<32-hex-id>`: `app.notion.com/p/thsm/<id>`, `www.notion.so/thsm/<id>`, `www.notion.so/<id>`, and slug-prefixed `.../Our-Trips-<id>`. The workspace domain is therefore recoverable from the final URL after redirects.
- A page that is not public (or does not exist) answers 404 with no OG tags. This is the "is it public" test.
- `notion.site/<id>` without a workspace subdomain redirects to the Notion homepage. Workspaces without a domain are not supported (see risks).
- The page body is not in Notion's server-rendered HTML; the Notion client loads it from an unofficial API. `POST https://thsm.notion.site/api/v3/loadPageChunk` with the request shape used by `notion-client` (`{"page":{"id":"<uuid>"},"limit":100,"cursor":{"stack":[]},"chunkNumber":0,"verticalColumns":false}`) answered HTTP 200 without cookies or any token, three times (0.30-0.38 s each). Payload: 50.7 KB raw, 15.1 KB brotli, 21 block records on the test page: `page` 9 (root plus sub-pages), `header` 4, `text` 3, `divider` 1, `collection_view_page` 1, `collection_view` 1, plus two records without a type; the root page lists 18 child blocks. `loadCachedPageChunkV2` also answered 200 (51.7 KB). The test page has no `image` blocks, so image blocks inside content are unverified; only the cover and the social preview image were probed. Database contents (`collection_view`) need a further `queryCollection` call that was not probed.
- Images: the cover is a relative Notion asset (`/images/page-cover/webb2.jpg`, 200, 151,664 bytes under `thsm.notion.site`). The social preview is stored as `attachment:<uuid>:SocialMediaPreviewImage.png`. It resolves two ways: `GET https://thsm.notion.site/image/<urlencoded attachment>?table=block&id=<blockId>&width=1200` answers 302 to `img.notionusercontent.com/s3/...?tok=<JWT>` (the JWT's `exp` is about 24 hours ahead), and `POST /api/v3/getSignedFileUrls` returns a `file.notion.so/f/f/...&expirationTimestamp=...&signature=...` URL (expiring, about 6 hours ahead in the probe). Either way image URLs are signed and expire, so they must never be copied into stored data or served pages as is.
- `notion-client` and `react-notion-x` (NotionX, repo `NotionX/react-notion-x`) are both licensed MIT (`npm view` and the repo `license` file; copyright Travis Fischer); both at version 8.0.8 on 2026-11-10. They are unofficial and unaffiliated with Notion.

## 3. URL model

`https://ntn.link/<workspace>/<slug>` (redirect) and `https://ntn.link/<workspace>/<slug>/read` (fast).

- `<workspace>` is the Notion workspace domain, read from the canonical URL. It is never typed by the user.
- `<slug>`: `[a-z0-9-]`, 1-64 chars, unique inside the workspace. Default is a transliteration of the page title ("Наши с Леночкой Путешествия" -> `nashi-s-lenochkoy-puteshestviya`); the user can edit it. Reserved words (`api`, `_next`, `og`, `img`, `new`, `about`, `read`, ...) are rejected as slugs and as workspaces.
- Domain: `ntn.link` ($7.72 per year registration and renewal per Porkbun's public price list; no RDAP record and no DNS delegation found). `ntn.page` ($10.81) is the fallback. This is a registry-level observation, not a purchase check: availability and final price are confirmed at registrar checkout, which needs the owner (money). The origin is one env variable, `PUBLIC_ORIGIN`, so development and previews use `*.vercel.app`.

## 4. Ownership without accounts

Namespaces are claimed by proving control of the Notion workspace, not by being first. The challenge has two halves so that publishing it on a public page does not hand it to anyone who reads that page.

1. The client calls `POST /api/challenge {url, action}` with `action` = `claim` (namespace unclaimed) or `rotate` (key lost or replacing it). The server returns two values: a public `nonce` (`ntn-verify-<10 chars>`) and a private `claimToken` (random, 256 bit). The `claimToken` is never written to any page; it stays in the requesting client's memory or storage. The server stores only its SHA-256 hash.
2. The user temporarily puts the `nonce` into the title of any public page of that workspace (the page being linked works) and presses Verify.
3. `POST /api/verify {url, nonce, claimToken}`. The server requires both: it checks that the challenge exists, is not expired, is bound to this exact namespace and to the requested action, and that the hash of `claimToken` matches (constant-time compare). Then it fetches the page under that exact `<ws>.notion.site` as a bot and looks for the `nonce` in `og:title`. Finally it deletes the challenge atomically; only the request whose delete succeeds proceeds, so a concurrent duplicate cannot succeed twice.
4. On success: `claim` sets the namespace atomically (Redis `SET NX`), `rotate` replaces the key hash; a random 256-bit owner key is returned once. Only its SHA-256 hash is stored. The CLI keeps the key in `$XDG_CONFIG_HOME/ntn-link/keys.json` (mode 0600), the web page and the extension keep it in browser storage.
5. Later create/update/delete calls in that namespace send the key; no re-verification.
6. A challenge is single use with a 15 minute TTL. Someone who reads the public `nonce` still cannot claim without the `claimToken`. A wrong `claimToken` does not consume the challenge (otherwise a reader of the nonce could burn it) but counts toward a cap of 5 attempts, after which the challenge is deleted.
7. Recovery of a lost key is a brand new challenge with `action=rotate`; no earlier nonce, token or key is ever reused or accepted. On rotation every existing link in the namespace is re-fetched and deleted if its target no longer resolves publicly (covers a workspace domain that changed hands).

Why: anyone who sees `thsm.notion.site/...` can otherwise create `ntn.link/thsm/anything` first. The title challenge proves edit access to a published page of that workspace, which is the same authority that can publish pages. The private `claimToken` ties the proof to the party that started the flow.

All links, and therefore all fast pages, exist only inside a namespace claimed this way.

## 5. Components

Monorepo, Bun workspaces, TypeScript strict.

- `apps/web` (Next.js App Router on Vercel): web UI, JSON API, the redirect route, the fast-page ISR route, the image proxy route, the generated card image route.
- `packages/core`: pure logic shared by all three clients and the server: Notion URL parser, slugifier with Cyrillic transliteration, OG HTML renderer, metadata normalizer, ownership state machine, and the Notion block renderer (blocks to static HTML, section 5.3).
- `packages/cli`: `ntn-link`, one file, no runtime dependencies, run as `npx ntn-link <url>`.
- `extension/`: Manifest V3 for Chrome and Firefox.
- Storage: Upstash Redis through the Vercel Marketplace. Keys: `ns:<ws>` -> `{keyHash, claimedAt}`; `link:<ws>/<slug>` -> `{pageId, canonical, title, description, imageUrl, fetchedAt, overrides, fast, canonicalMode}`; `challenge:<ws>:<nonce>` -> `{action, claimTokenHash, attempts}` with a 15 minute TTL and deleted on success; rate limit counters.

### 5.1 API

| Call | Purpose |
|---|---|
| `POST /api/preview {url}` | Parse and fetch; returns normalized card data, the proposed slug and whether verification is needed. Stores nothing. |
| `POST /api/links {url, slug?, ownerKey?, fast?, overrides?}` | Create. Without a valid key in an unclaimed or foreign namespace returns `needs_verification`; the client then calls `/api/challenge`. Returns both the redirect link and the fast link. |
| `POST /api/challenge {url, action}` | `action` is `claim` or `rotate`. Returns `{nonce, claimToken, expiresAt}`; the `nonce` is public, the `claimToken` is private to the caller. |
| `POST /api/verify {url, nonce, claimToken}` | Checks and consumes the challenge; on success claims or rotates and returns the owner key. |
| `PATCH` / `DELETE /api/links/<ws>/<slug>` | Update slug, text overrides, the `fast` switch, `canonicalMode`, or delete; owner key required. Each triggers on-demand revalidation of both link forms. |
| `GET /api/ns/<ws>/links` | List links of a namespace; owner key required. |

Errors are typed (`not_notion_url`, `not_public`, `slug_taken`, `slug_reserved`, `needs_verification`, `challenge_expired`, `challenge_invalid`, `rate_limited`, `unsupported_workspace`) and each carries a human message that the web UI, CLI and extension print as is.

### 5.2 Serving the redirect link: `GET /<ws>/<slug>`

One behaviour for every client, with no user agent detection:

- HTTP 200 with a tiny HTML document: `og:title`, `og:description`, `og:image`, `og:url`, `twitter:card=summary_large_image`, no schema.org markup. Humans are sent on by `<meta http-equiv="refresh" content="0;url=<canonical Notion URL>">` plus an inline `location.replace()`, with a visible link in `<noscript>` as fallback.
- Tradeoff, accepted: a redirect page costs one HTML hop instead of a 302, a few tens of milliseconds slower with a brief blank flash. In return, a 302 cannot carry OG metadata at all, and any user agent allowlist silently breaks for every new crawler. One behaviour for every client means no classifier to maintain and no unfurler gets a worse card than another.
- `Cache-Control: public, max-age=0, s-maxage=3600, stale-while-revalidate=86400` so the Vercel edge serves it instantly and refreshes in the background. Updates and deletes purge it on demand.
- Metadata comes from the stored record and is refreshed lazily in the background when older than 24 hours, so renamed pages follow. Overrides win over fetched values.
- Title: `og:title` with a trailing ` | Notion` removed. Image: `/og/<ws>/<slug>.png`, which proxies the page's social image requested with `width=1200` and caches it at the Vercel CDN, or renders a title card with `next/og` using a bundled font with Cyrillic coverage when the page has no image. `og:site_name` is omitted so the platform shows our domain; `og:locale` follows the detected page language.
- If the target stops answering 200: every client gets a small "this page is no longer public" page (410) with no redirect.

### 5.3 Fast variant: `GET /<ws>/<slug>/read`

Purpose: a link that itself serves an instantly loading copy of the page, following the standards that exist today rather than a single vendor format.

**Rendering.** The server renders the Notion page into static, semantic, zero-JavaScript HTML. Data comes from `notion-client` (MIT) or its request shape (`loadPageChunk`, section 2), and rendering is our own lightweight renderer in `packages/core`. We do not use react-notion-x's renderer: its JavaScript and CSS weight defeats the purpose. Supported blocks, at least: paragraph (`text`), headings (`header`, `sub_header`, `sub_sub_header`), bulleted and numbered lists, `to_do`, `quote`, `callout`, `code`, `divider`, `image`, `toggle` (rendered as `<details>`), `bookmark`, `table`, `column_list`, and sub-pages (`page`) as links. Any other block, including `collection_view` databases, becomes a visible "open in Notion" link to that block; no block is ever silently dropped.

**Delivery.** Next.js ISR (or equivalent static generation) cached at the Vercel edge. Revalidate about 60 s with stale-while-revalidate, plus on-demand revalidation when the owner updates or deletes the link. Per page:

- Critical CSS inlined (a few KB), system font stack, no web fonts, no JavaScript, no third-party requests. Compressed first HTML response <= 14 KB where the content allows, so it fits the first round trip.
- Images go through our own resizing proxy route (`/img/<ws>/<slug>/<blockId>`), which resolves a fresh signed Notion URL server-side (section 2: signed URLs expire, so they never appear in the HTML), resizes, serves AVIF/WebP/JPEG by `Accept`, and caches long at the edge keyed by the block's edit version. Every `<img>` has explicit `width` and `height` (from the block's recorded dimensions, otherwise read from the image header at render time); below-the-fold images use `loading="lazy"`, the first image is eagerly loaded and prioritised as the likely LCP element.
- `rel=canonical` points to the fast page itself by default; the owner can switch it (`canonicalMode`) to the Notion URL.

**Standards satisfied, and why:**

| Standard | Why |
|---|---|
| Core Web Vitals (LCP, INP, CLS) | Google's page experience standard; the only speed metric Google ranks on. Static HTML, no JS and explicit image dimensions make all three trivial. |
| Open Graph and Twitter cards | The same tags as the redirect link, so previews of the fast link are equally clean. |
| schema.org `Article` JSON-LD | Machine-readable title, description, image and dates for search engines. |
| Semantic HTML (`article`, `h1`-`h3`, `figure`, `details`, `table`) | Readability-style extractors and Telegram Instant View parse it reliably. |
| `rel=canonical`, default self | Gives the fast page its own identity; the owner can point it at Notion instead. |
| Telegram Instant View template for `ntn.link/*/*/read` | Telegram's own fast-page standard. Because the HTML is uniform, one template at instantview.telegram.org covers every page. Submission and approval are outside our control, so this is a spike with a defined fallback: without it the page is still fast and has OG. |

**Not built, and why:**

- Yandex Turbo pages: shut down in April 2025 (announced by Yandex Webmaster on 2025-02-07).
- Google AMP: since June 2021 it is not required for Top Stories and gives no ranking boost; Core Web Vitals are the standard. AMP is restrictive and costly to maintain.
- Telegraph mirroring: Telegraph pages get Instant View automatically but support only a small tag set; an Instant View template over our own HTML is cleaner and keeps one source of truth.

**Security and abuse.**

- The fast variant exists only for links created by a verified namespace owner (section 4).
- All Notion text is HTML-escaped; rich text never produces raw HTML.
- Images come only from allowlisted Notion image hosts (`notion.site`, `*.notion.site`, `file.notion.so`, `img.notionusercontent.com`, `www.notion.so/images`, and `images.unsplash.com` for Notion's stock covers). An image from any other host is not proxied and renders as a link.
- Per-link `fast` switch (default on): turning it off makes `/read` return 404 and purges the cache.
- Copyright and phishing laundering: a mirror hosts copied content on our domain, which makes laundering and takedown claims our problem. Operator delete (`ADMIN_TOKEN`, section 7) removes the link and disables the mirror at the same time.

## 6. Interfaces

- **Web (`/`)**: one input. Paste -> live card preview (the exact card an unfurler would see) -> editable slug -> `fast` toggle (default on) -> Create. If verification is needed, a second step shows the public `nonce` with a copy button and a Verify button; the `claimToken` stays in the page's memory. The result shows both links, the short redirect link and the fast link, each with Copy. "My links" is read from browser storage plus the list call.
- **CLI**: `ntn-link <url> [--slug s] [--fast] [--copy]` prints only the redirect link on stdout; with `--fast` it prints the fast link instead. Progress and the verification prompt go to stderr, exit code is non-zero on any error. Subcommands: `ls <ws>`, `rm <ws>/<slug>`, `set <ws>/<slug> --title ...`. Each run also writes a log to `/tmp` per the owner's script-logging policy.
- **Browser extension** (the "Notion integration"): host permissions only for Notion domains and `ntn.link`.
  1. Toolbar button and keyboard shortcut "Copy pretty link": reliable path, works on any public Notion page. A second command, "Copy fast link", copies the `/read` form.
  2. Optional "replace Notion's Copy link": a MAIN-world content script wraps `navigator.clipboard.writeText` and the `copy` event, rewrites the text only when it is a Notion page URL of the current workspace and an owner key exists for that workspace, awaiting our API before the real write. Feasibility depends on how Notion performs the copy (async Clipboard API vs `document.execCommand`, which cannot be awaited) and must be proven first in a spike before the rest of the extension is built. If it cannot be done reliably, item 1 ships alone.

## 7. Security

- Only these hosts are ever fetched for page metadata and page data, over HTTPS: `notion.so`, `www.notion.so`, `notion.site`, `*.notion.site`, `notion.com`, `www.notion.com`, `app.notion.com`. Redirects are followed manually, each hop re-checked against the allowlist, max 5 hops, 5 s timeout, 1 MB body cap. This blocks SSRF. Image fetching by the proxy follows the narrower image host list in section 5.3.
- The redirect target is always the canonical `https://<ws>.notion.site/<id>` rebuilt by the server, never a user-supplied string, so the service is not an open redirector.
- Notion titles, descriptions and page text are attacker-controlled: HTML-escaped in OG output and in the fast page, rendered as text in the web UI.
- Rate limits per IP on create/challenge/verify/preview; per-namespace link cap.
- Phishing laundering through public Notion pages is a real abuse path for any short-link service, and the fast mirror adds copied content (section 5.3). Mitigation in v1: operator delete via an `ADMIN_TOKEN` header on the delete route, which also disables the mirror; no automated moderation.
- No accounts, no analytics, no IP storage beyond rate-limit counters.

## 8. Testing

- Unit: URL parser over all forms in section 2, transliteration and slug rules, OG renderer escaping, ownership state machine against a fake Notion fetcher: claim race, wrong nonce, replayed nonce without `claimToken`, expired challenge, challenge reused after success, wrong namespace, wrong action (`claim` challenge used for `rotate` and the reverse), attempt cap, key rotation.
- Renderer golden tests: fixtures of recorded `loadPageChunk` payloads (the `thsm` page is the base), expected HTML checked in. Includes an unsupported-block case (a `collection_view` becomes an "open in Notion" link, not a drop) and an escaping case (titles and text containing `<script>`, quotes and `&`).
- Contract: recorded HTML of the `thsm` page and of a 404 page as fixtures for the metadata normalizer, plus one live smoke that fails loudly if Notion changes its SSR meta tags (verification depends on them) or the `loadPageChunk` response shape (the fast variant depends on it).
- End to end on a Vercel preview: create a link for the `thsm` page. `curl` the redirect link with any user agent, including `TelegramBot (like TwitterBot)` and a normal browser: every one returns HTTP 200 with the OG HTML (clean title, 1200 px image) and no 302. Human navigation ends at the Notion page, checked without a headless browser: the response body contains the `http-equiv=refresh` target `thsm.notion.site/<id>`. CLI create + `ls` + `rm`; the generated card checked visually.
- Fast variant on the preview: Lighthouse mobile and a Core Web Vitals run on `/<ws>/<slug>/read` against the acceptance in section 1, with TTFB and total transfer compared with the baseline there; check that the HTML contains no `<script>` and that no request leaves our origin (images included, since they come through our proxy).
- Telegram Instant View: template check once submitted, in the instantview.telegram.org editor.
- Extension: spike result recorded; manual run in Chrome and Firefox on a real Notion page.

## 9. Risks and open points

1. Workspaces without a workspace domain are unsupported; I have only seen domain-bearing workspaces and nonexistent ids. Needs one real example to confirm what such a page redirects to.
2. Verification depends on Notion's server-rendered `og:title`; an unofficial but stable-for-years behaviour. The live smoke test is the alarm.
3. Copy interception in the extension may be impossible (section 6).
4. A workspace domain that is renamed and later reused by someone else is handled only at key rotation (section 4.7), not continuously.
5. Domain purchase needs the owner; development proceeds on `*.vercel.app` meanwhile.
6. The unofficial page-load API (`loadPageChunk`) may change or be rate limited without notice; the fast variant has no official alternative without an integration token. The same live smoke test is the alarm; on failure fast pages keep serving the last cached render and the redirect link is unaffected.
7. Block coverage gaps: databases (`collection_view`) and other block types render as "open in Notion" links; image blocks are unverified on the test page and need a fixture before the image path is trusted.
8. Telegram Instant View approval is outside our control; the fallback is the fast page with OG tags.
9. Mirror content liability: copied page text and images served from our domain (section 5.3 security).
