# ntn.link: pretty links for public Notion pages

Status: draft for owner review. Date: 2026-11-10.

## 1. Goal

Turn a public Notion URL into a short readable link with a clean preview card, with no registration:

`https://app.notion.com/p/thsm/413d447ac4b180169985c93eea7f02f9?source=copy_link` -> `https://ntn.link/thsm/our-trips`

Success criteria:

1. A message containing the pretty link shows a clean card in Telegram, Slack, WhatsApp, Discord, X and iMessage: page title without the "| Notion" suffix, page description, a 1200x630 image (the page's own social image, or a generated title card).
2. A human opening the link lands on the real Notion page in one hop (HTTP 302).
3. Three interfaces, all without an account: web page, CLI, browser extension.
4. Nobody can take over another workspace's namespace by guessing it.
5. Hosted on Vercel, running cost close to the domain price.

Non-goals: private pages, analytics, click counts, custom domains for the user, password protection, an official Notion OAuth integration.

## 2. Evidence this design rests on (probed 2026-11-10 against the owner's `thsm` page)

- Notion serves complete OpenGraph tags to a bot user agent: `og:title` ("Наши с Леночкой Путешествия | Notion"), `og:description`, `og:image` (`...?width=2000`, a custom `SocialMediaPreviewImage.png`), `og:site_name` ("thsm on Notion"), `og:locale` = `en_US`. The problem is Notion branding and the 2000 px image, not missing data.
- Every URL form redirects to the canonical `https://<workspace>.notion.site/<32-hex-id>`: `app.notion.com/p/thsm/<id>`, `www.notion.so/thsm/<id>`, `www.notion.so/<id>`, and slug-prefixed `.../Our-Trips-<id>`. The workspace domain is therefore recoverable from the final URL after redirects.
- A page that is not public (or does not exist) answers 404 with no OG tags. This is the "is it public" test.
- `notion.site/<id>` without a workspace subdomain redirects to the Notion homepage. Workspaces without a domain are not supported (see risks).

## 3. URL model

`https://ntn.link/<workspace>/<slug>`

- `<workspace>` is the Notion workspace domain, read from the canonical URL. It is never typed by the user.
- `<slug>`: `[a-z0-9-]`, 1-64 chars, unique inside the workspace. Default is a transliteration of the page title ("Наши с Леночкой Путешествия" -> `nashi-s-lenochkoy-puteshestviya`); the user can edit it. Reserved words (`api`, `_next`, `og`, `new`, `about`, ...) are rejected as slugs and as workspaces.
- Domain: `ntn.link` ($7.72 per year registration and renewal per Porkbun's public price list; no RDAP record and no DNS delegation found). `ntn.page` ($10.81) is the fallback. This is a registry-level observation, not a purchase check: availability and final price are confirmed at registrar checkout, which needs the owner (money). The origin is one env variable, `PUBLIC_ORIGIN`, so development and previews use `*.vercel.app`.

## 4. Ownership without accounts

Namespaces are claimed by proving control of the Notion workspace, not by being first.

1. First link in an unclaimed namespace: the API answers `needs_verification` with a one-time code `ntn-verify-<10 chars>`.
2. The user temporarily puts the code into the title of any public page of that workspace (the page being linked works) and presses Verify. The service fetches the page as a bot and looks for the code in `og:title`.
3. On success the namespace is claimed atomically (Redis `SET NX`), and a random 256-bit owner key is returned once. Only its SHA-256 hash is stored. The CLI keeps the key in `$XDG_CONFIG_HOME/ntn-link/keys.json` (mode 0600), the web page and the extension keep it in browser storage.
4. Later create/update/delete calls in that namespace send the key; no re-verification.
5. Lost key: repeat steps 1-2; success rotates the key. On rotation every existing link in the namespace is re-fetched and deleted if its target no longer resolves publicly (covers a workspace domain that changed hands).

Why: anyone who sees `thsm.notion.site/...` can otherwise create `ntn.link/thsm/anything` first. The title challenge proves edit access to a published page of that workspace, which is the same authority that can publish pages.

## 5. Components

Monorepo, Bun workspaces, TypeScript strict.

- `apps/web` (Next.js App Router on Vercel): web UI, JSON API, redirect and card routes, generated image route.
- `packages/core`: pure logic shared by all three clients and the server: Notion URL parser, slugifier with Cyrillic transliteration, bot user agent classifier, OG HTML renderer, metadata normalizer, ownership state machine.
- `packages/cli`: `ntn-link`, one file, no runtime dependencies, run as `npx ntn-link <url>`.
- `extension/`: Manifest V3 for Chrome and Firefox.
- Storage: Upstash Redis through the Vercel Marketplace. Keys: `ns:<ws>` -> `{keyHash, claimedAt}`; `link:<ws>/<slug>` -> `{pageId, canonical, title, description, imageUrl, fetchedAt, overrides}`; `challenge:<ws>:<code>` with a 15 minute TTL; rate limit counters.

### 5.1 API

| Call | Purpose |
|---|---|
| `POST /api/preview {url}` | Parse and fetch; returns normalized card data, the proposed slug and whether verification is needed. Stores nothing. |
| `POST /api/links {url, slug?, ownerKey?, overrides?}` | Create. Without a valid key in an unclaimed or foreign namespace returns `needs_verification {code}`. |
| `POST /api/verify {url, code}` | Checks the challenge; on success claims or rotates and returns the owner key. |
| `PATCH` / `DELETE /api/links/<ws>/<slug>` | Update slug, text overrides or delete; owner key required. |
| `GET /api/ns/<ws>/links` | List links of a namespace; owner key required. |

Errors are typed (`not_notion_url`, `not_public`, `slug_taken`, `slug_reserved`, `needs_verification`, `rate_limited`, `unsupported_workspace`) and each carries a human message that the web UI, CLI and extension print as is.

### 5.2 Serving a link: `GET /<ws>/<slug>`

- User agent matches a known unfurler (Telegram, WhatsApp, Slack, Discord, Twitter/X, facebookexternalhit/Facebot, LinkedIn, Viber, VK, Skype, Apple link preview): 200 HTML with `og:title`, `og:description`, `og:image`, `og:url`, `twitter:card=summary_large_image`, and a `<meta http-equiv=refresh>` to the target.
- Everything else: 302 to the stored canonical Notion URL (302, not 301, so edits take effect). Unknown unfurlers degrade to Notion's own card, which is the current behaviour, not a regression.
- Metadata comes from the stored record and is refreshed lazily in the background when older than 24 hours, so renamed pages follow. Overrides win over fetched values.
- Title: `og:title` with a trailing ` | Notion` removed. Image: `/og/<ws>/<slug>.png`, which proxies the page's social image requested with `width=1200` and caches it at the Vercel CDN, or renders a title card with `next/og` using a bundled font with Cyrillic coverage when the page has no image. `og:site_name` is omitted so the platform shows our domain; `og:locale` follows the detected page language.
- If the target stops answering 200: humans get a small "this page is no longer public" page (410), bots get the same, and no redirect happens.

## 6. Interfaces

- **Web (`/`)**: one input. Paste -> live card preview (the exact card an unfurler would see) -> editable slug -> Create. If verification is needed, a second step shows the code with a copy button and a Verify button. Result shows the link with Copy. "My links" is read from browser storage plus the list call.
- **CLI**: `ntn-link <url> [--slug s] [--copy]` prints only the short URL on stdout, progress and the verification prompt go to stderr, exit code is non-zero on any error. Subcommands: `ls <ws>`, `rm <ws>/<slug>`, `set <ws>/<slug> --title ...`. Each run also writes a log to `/tmp` per the owner's script-logging policy.
- **Browser extension** (the "Notion integration"): host permissions only for Notion domains and `ntn.link`.
  1. Toolbar button and keyboard shortcut "Copy pretty link": reliable path, works on any public Notion page.
  2. Optional "replace Notion's Copy link": a MAIN-world content script wraps `navigator.clipboard.writeText` and the `copy` event, rewrites the text only when it is a Notion page URL of the current workspace and an owner key exists for that workspace, awaiting our API before the real write. Feasibility depends on how Notion performs the copy (async Clipboard API vs `document.execCommand`, which cannot be awaited) and must be proven first in a spike before the rest of the extension is built. If it cannot be done reliably, item 1 ships alone.

## 7. Security

- Only these hosts are ever fetched, over HTTPS: `notion.so`, `www.notion.so`, `notion.site`, `*.notion.site`, `notion.com`, `www.notion.com`, `app.notion.com`. Redirects are followed manually, each hop re-checked against the allowlist, max 5 hops, 5 s timeout, 1 MB body cap. This blocks SSRF.
- The redirect target is always the canonical `https://<ws>.notion.site/<id>` rebuilt by the server, never a user-supplied string, so the service is not an open redirector.
- Notion titles and descriptions are attacker-controlled text: HTML-escaped in OG output and rendered as text in the web UI.
- Rate limits per IP on create/verify/preview; per-namespace link cap.
- Phishing laundering through public Notion pages is a real abuse path for any short-link service. Mitigation in v1: operator delete via an `ADMIN_TOKEN` header on the delete route; no automated moderation.
- No accounts, no analytics, no IP storage beyond rate-limit counters.

## 8. Testing

- Unit: URL parser over all forms in section 2, transliteration and slug rules, user agent classifier (positive and negative lists), OG renderer escaping, ownership state machine against a fake Notion fetcher (claim race, wrong code, expired code, key rotation).
- Contract: recorded HTML of the `thsm` page and of a 404 page as fixtures for the metadata normalizer, plus one live smoke that fails loudly if Notion changes its SSR meta tags (verification depends on them).
- End to end on a Vercel preview: create a link for the `thsm` page; `curl` with a Telegram bot user agent (e.g. `TelegramBot (like TwitterBot)`) returns HTTP 200 with the OG HTML (clean title, 1200 px image) and NOT a 302; `curl` with a normal browser user agent returns HTTP 302 to `thsm.notion.site/<id>`; CLI create + `ls` + `rm`; the generated card checked visually.
- Extension: spike result recorded; manual run in Chrome and Firefox on a real Notion page.

## 9. Risks and open points

1. Workspaces without a workspace domain are unsupported; I have only seen domain-bearing workspaces and nonexistent ids. Needs one real example to confirm what such a page redirects to.
2. Verification depends on Notion's server-rendered `og:title`; an unofficial but stable-for-years behaviour. The live smoke test is the alarm.
3. Copy interception in the extension may be impossible (section 6).
4. The unfurler user agent list drifts; unknown agents degrade gracefully.
5. A workspace domain that is renamed and later reused by someone else is handled only at key rotation (section 4.5), not continuously.
6. Domain purchase needs the owner; development proceeds on `*.vercel.app` meanwhile.
