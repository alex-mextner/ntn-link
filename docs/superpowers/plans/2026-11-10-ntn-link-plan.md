# ntn-link Remaining Slices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take ntn-link from the Foundation commit (monorepo, core logic, API, redirect route) to a fully working, deployed service: fast variant, web UI, CLI, browser extension, live deployment on `*.vercel.app`, and verified integration.

**Architecture:** Six slices, each owned by one agent in its own worktree with a disjoint file list. Slices 1-4 run concurrently after Foundation lands; slice 5 (provisioning can start early, deploy after merge) and slice 6 (integration) follow. All clients talk only to the JSON API in `packages/core/src/api-types.ts`; the fast variant is a zero-JS route handler on ISR.

**Tech Stack:** Bun workspaces, TypeScript strict, Next.js 16 App Router (route handlers for `/read` and image proxy, React for `/`), `sharp` (image resize), `bun test`, Playwright + `@axe-core/playwright` (UI), Lighthouse (`bunx lighthouse`), MV3 WebExtension built with `bun build` + `fflate` zips, Vercel Hobby, Upstash Redis or Neon Postgres store.

**Spec:** `docs/superpowers/specs/2026-11-10-ntn-link-design.md` (authoritative; section numbers below refer to it).

## Prerequisite state (Foundation, built by FoundationBackend on `main`)

Present on disk when this plan was written: root `package.json` (scripts `test`=`bun test`, `lint`=`oxlint --deny-warnings && prettier --check .`, `typecheck`, `build`), packages `@ntn-link/core` (exports only `.` -> `src/index.ts`, dep `zod`), `@ntn-link/web` (Next 16, React 19, `@vercel/functions`), `packages/core/test/fixtures/{thsm-page.html,not-public-404.html,thsm-loadPageChunk.json}`. The `loadPageChunk` fixture confirms the nested record shape `recordMap.block[id].value.value = {id, type, properties, content, format, version, ...}`.

Foundation will also provide (names confirmed in Task 0, not guessed here): `packages/core/src/api-types.ts` (API contract), the `Store` interface with in-memory and Upstash REST implementations, allowlisted fetcher, URL parser, slugifier, OG renderer, ownership state machine, all `/api/*` routes, `GET /<ws>/<slug>`, `GET /img/<ws>/<slug>`, and a `501 not_implemented` placeholder at `GET /<ws>/<slug>/read`.

## Global Constraints

- Monorepo, Bun workspaces, TypeScript strict (`tsconfig.base.json`: `noUncheckedIndexedAccess`, `verbatimModuleSyntax`). Lint gate: `bun run lint` (oxlint `--deny-warnings` + prettier). Test runner: `bun test`.
- Fast link HTML <= 14 KB compressed (brotli), zero `<script>`, no third-party or off-origin requests (images included), total transfer excluding images <= 30 KB; inline critical CSS only, system font stack, no web fonts (5.3, 1).
- Acceptance on test page `thsm`: Lighthouse mobile performance >= 95; LCP <= 2.5 s, INP <= 200 ms, CLS <= 0.1; TTFB and transfer clearly below the Notion baseline (TTFB ~0.29 s, 22.7 KB HTML, 1,322,907 B brotli JS/CSS) (1).
- Slug `[a-z0-9-]` 1-64 chars; reserved words (`api`, `_next`, `og`, `img`, `new`, `about`, `read`, ...) rejected (3).
- Image hosts allowlist: `notion.site`, `*.notion.site`, `file.notion.so`, `img.notionusercontent.com`, `www.notion.so/images`, `images.unsplash.com`; anything else is not proxied and renders as a link. Signed Notion image URLs never appear in stored data or HTML (2, 5.3).
- Fetch allowlist for page metadata and data: `notion.so`, `www.notion.so`, `notion.site`, `*.notion.site`, `notion.com`, `www.notion.com`, `app.notion.com`; HTTPS, manual redirects re-checked per hop, max 5 hops, 5 s timeout, 1 MB cap (7).
- All Notion text is HTML-escaped; rich text never yields raw HTML (5.3, 7).
- Owner key: stored only as SHA-256 hash server-side; CLI keeps keys in `$XDG_CONFIG_HOME/ntn-link/keys.json` mode 0600; web and extension keep them in browser storage; `claimToken` stays in client memory (4).
- Errors are typed (`not_notion_url`, `not_public`, `slug_taken`, `slug_reserved`, `needs_verification`, `challenge_expired`, `challenge_invalid`, `rate_limited`, `unsupported_workspace`) and each carries a human `message` that every client prints as is (5.1).
- CLI: stdout = redirect link only (fast link with `--fast`); progress and prompts on stderr; non-zero exit on any error; per-run log in `/tmp` (6).
- Extension: Manifest V3, Chrome + Firefox, host permissions only Notion domains and the ntn-link origin, no remote code (6).
- No accounts, no analytics, no IP storage beyond rate-limit counters (7).
- Privacy: our server never receives a Notion page id unless the user explicitly created a link (web, CLI, toolbar button or shortcut, options page) or the extension proved the page public itself by a direct request to Notion. Automatic Copy-link interception is off by default and enabled per workspace by the user.
- Origin comes from one env variable `PUBLIC_ORIGIN`; development and previews use `*.vercel.app` (3).
- Worktrees: create with `rig worktree create <name> --from main` (raw `git worktree add` is blocked by the rig guard); they land in `<repo>/.worktrees/<name>`. Commit on the slice branch; never push or merge from a slice; the orchestrator merges (slice 6).
- Commits are conventional-commit style, one logical change each. Comments explain why, not what.

## Review Focus

Spec-implied inputs no spec test list names, most likely first. Each has a pinning test in the owning task.

1. A Notion block tree that is cyclic or very deep (block lists itself or an ancestor in `content`) must render finitely with a visible "open in Notion" link, not hang or overflow the stack. Pinned: Task 1.3.
2. Image proxy asked for a `blockId` that is not an image block of that link's page, or whose resolved URL is on a non-allowlisted host, must 404 and never fetch (otherwise the proxy is a generic Notion image fetcher/SSRF). Pinned: Task 1.5.
3. Link with `fast=false`, a deleted link, or a target that is no longer public: `/read` and its image proxy must not keep serving cached copies after revalidation (404 / 410). Pinned: Tasks 1.4, 1.5.
4. Double-click or double-press-Enter on Create and Verify in the web UI must issue exactly one request each; a pasted URL with surrounding whitespace, tracking params or trailing punctuation must still preview. Pinned: Task 2.2.
5. CLI with a corrupted, empty or too-permissive (`0644`) `keys.json`, or a missing `$HOME`: must not crash with a stack trace and must never print a key; a corrupted file is moved aside, not overwritten silently. Pinned: Task 3.2. Extension analogs: the clipboard wrapper must never throw or reject on API failure or timeout, and an ordinary Copy link on a private, unknown, workspace-less or non-enabled page must send nothing to our origin and keep the original clipboard text. Pinned: Task 4.3.

---

## Slice map, ownership and order

| Slice | Branch / worktree | Owns (exclusive) | Depends on | Wave |
|---|---|---|---|---|
| 0 Contract freeze | `main` (orchestrator, tiny) | `docs/superpowers/contract.md` | Foundation merged | start |
| 1 Fast variant | `fast` | `packages/core/src/notion/**`, `packages/core/src/render/**`, `packages/core/test/render/**`, `packages/core/test/fixtures/render/**`, `apps/web/app/[ws]/[slug]/read/**`, `apps/web/app/img/[ws]/[slug]/[blockId]/**`, `apps/web/lib/fast/**`, `scripts/perf/**`, `docs/instant-view/**` | 0 | A |
| 2 Web UI | `webui` | `apps/web/app/page.tsx`, `apps/web/app/layout.tsx`, `apps/web/app/globals.css`, `apps/web/app/_components/**`, `apps/web/lib/ui/**`, `apps/web/tests/**`, `apps/web/playwright.config.ts` | 0 | A |
| 3 CLI | `cli` | `packages/cli/**` | 0 | A |
| 4 Extension | `ext` | `extension/**` | 0 and spike verdict (known: (a), see Slice 4) | A |
| 5 Deploy | `deploy` | `vercel.json`, `packages/core/src/store/postgres.ts` (conditional), `packages/core/test/store/postgres.test.ts`, `scripts/deploy/**`, `docs/deploy/**` | 0 for provisioning; 1, 2, 3 merged for deploy | B (provisioning may start in wave A only if fewer than 4 agents run) |
| 6 Integration | `integrate` (orchestrator) | `README.md`, `CHANGELOG.md`, merge commits | all | C |

Shared files, edited only additively and only as stated: root `package.json` (new scripts, one line each), `bun.lock` (never hand-edit; regenerate), `packages/core/package.json` (slice 1 adds `exports["./render"]` and `exports["./notion"]`; nobody else touches it), `apps/web/package.json` (slice 1 adds `sharp`; slice 2 adds `@playwright/test`, `@axe-core/playwright`). Conflict policy in Task 6.1.

Concurrency: max 4 agents. Wave A is slices 1-4 exactly. Slice 5 starts when a slot frees (slice 3 usually finishes first). Slice 6 is the orchestrator.

---

## Task 0: Contract freeze (orchestrator, once Foundation is merged on `main`)

**Files:**
- Create: `docs/superpowers/contract.md`

**Interfaces:**
- Produces: the literal exported signatures of `packages/core/src/api-types.ts`, the `Store` interface, the link-record type, the ownership state machine entry points, and the env var names read by the web app. Every slice reads this file first and uses these names; where this plan says "`Store`" or "`LinkRecord`" it means the names in this file.

- [ ] **Step 1: Generate the contract file**

```bash
cd "$(git rev-parse --show-toplevel)"
{
  echo '# Foundation contract (generated from main at' "$(git rev-parse --short HEAD)"')'
  for f in packages/core/src/api-types.ts packages/core/src/index.ts; do echo; echo "## $f"; echo '```ts'; cat "$f"; echo '```'; done
  echo; echo '## Store interface'; echo '```ts'; cat packages/core/src/store*.ts packages/core/src/store/index.ts 2>/dev/null; echo '```'
  echo; echo '## Env vars read'; grep -rhoE 'process\.env\.[A-Z_]+' apps packages --include=*.ts --include=*.tsx | sort -u
  echo; echo '## Routes'; find apps/web/app -name 'route.ts' -o -name 'page.tsx' | sort
} > docs/superpowers/contract.md
wc -l docs/superpowers/contract.md
```
Expected: file written, > 50 lines, contains `needs_verification`, `PUBLIC_ORIGIN`, and `app/[ws]/[slug]/read/route.ts`.

- [ ] **Step 2: Verify Foundation is green**

Run: `bun install --frozen-lockfile && bun run lint && bun run typecheck && bun test`
Expected: exit 0 on all four. If not, Foundation is not done; stop and report to Main.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/contract.md && git commit -m "docs: freeze foundation contract for slice agents"
```

---

# Slice 1: Fast variant (spec 5.3)

Worktree: `rig worktree create fast --from main`.

### Task 1.1: Page-chunk types and loader

**Files:**
- Create: `packages/core/src/notion/records.ts`, `packages/core/src/notion/page-chunk.ts`, `packages/core/src/notion/index.ts`
- Modify: `packages/core/package.json` (add `"./notion": "./src/notion/index.ts"` and `"./render": "./src/render/index.ts"` to `exports`)
- Test: `packages/core/test/render/page-chunk.test.ts`

**Interfaces:**
- Consumes: the allowlisted fetcher from the Foundation (name in `contract.md`; reuse it, do not write a second allowlist). Fixture `packages/core/test/fixtures/thsm-loadPageChunk.json`.
- Produces:
  ```ts
  // records.ts
  export type RichTextSegment = [text: string, decorations?: Array<[string, ...string[]]>];
  export interface NotionBlock { id: string; type: string; version?: number; last_edited_time?: number; created_time?: number; properties?: Record<string, RichTextSegment[]>; content?: string[]; format?: Record<string, unknown>; parent_id?: string; }
  export interface RecordMap { blocks: Map<string, NotionBlock>; }   // unwrapped
  // page-chunk.ts
  export function unwrapRecordMap(raw: unknown): RecordMap;          // accepts value.value (new) and value (old) shapes, skips records with no type
  export function loadPageChunk(args: { workspace: string; pageId: string; fetch?: typeof fetch }): Promise<RecordMap>;
  ```
  `loadPageChunk` POSTs `https://<workspace>.notion.site/api/v3/loadPageChunk` with `{page:{id},limit:100,cursor:{stack:[]},chunkNumber:0,verticalColumns:false}` via the allowlisted fetcher; throws `NotionDataError` (exported) on non-200 or shape mismatch.

- [ ] **Step 1: Write the failing tests** in `page-chunk.test.ts`:
  - `unwrapRecordMap(fixture)` returns a map containing `413d447a-c4b1-8016-9985-c93eea7f02f9` with `type === "page"` and `properties.title[0][0] === "Наши с Леночкой Путешествия"`.
  - `unwrapRecordMap` drops typeless records: `blocks.size === 19` for the fixture (21 records minus 2 typeless; adjust to the fixture's real count the first time and keep it pinned).
  - `unwrapRecordMap({recordMap:{block:{a:{value:{id:"a",type:"text"}}}}})` (old flat shape) yields one block `a`.
  - `unwrapRecordMap({})` throws `NotionDataError`.
  - `loadPageChunk` with an injected `fetch` asserts the request URL is `https://thsm.notion.site/api/v3/loadPageChunk`, method POST, body equals the pinned JSON above; a fake 500 response throws `NotionDataError`.
- [ ] **Step 2:** Run `bun test packages/core/test/render/page-chunk.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `records.ts`, `page-chunk.ts`, `index.ts` per the interface. The shape check is a `zod` schema (zod already a core dependency) for the envelope only; block `properties` stay loosely typed and are validated by the renderer.
- [ ] **Step 4:** Rerun the test. Expected: PASS.
- [ ] **Step 5: Commit**
```bash
git add packages/core && git commit -m "feat(core): load and unwrap Notion loadPageChunk records"
```

### Task 1.2: Rich text renderer

**Files:**
- Create: `packages/core/src/render/escape.ts`, `packages/core/src/render/rich-text.ts`
- Test: `packages/core/test/render/rich-text.test.ts`

**Interfaces:**
- Consumes: `RichTextSegment` (Task 1.1).
- Produces:
  ```ts
  export function escapeHtml(s: string): string;                       // & < > " '
  export function safeHref(href: string, ctx: { workspace: string }): string | null; // http(s) only; "/<id>" -> https://<ws>.notion.site/<id>; javascript:/data: -> null
  export function renderRichText(segments: RichTextSegment[] | undefined, ctx: { workspace: string }): string;
  ```
  Decorations: `b`->`<strong>`, `i`->`<em>`, `s`->`<s>`, `c`->`<code>`, `_`->`<u>`, `a`->`<a href rel="noopener nofollow">` (external) , `h`->`<mark>`, `e`->`<span class="eq">` containing escaped TeX source, `p` (page mention) -> link to `https://<ws>.notion.site/<id-without-dashes>` with text `‣` replaced by the segment text. Nesting order is fixed: a, strong, em, s, u, code, mark.

- [ ] **Step 1: Failing tests:**
  - `renderRichText([["<script>alert(1)</script> & \"q\""]], ctx)` equals `&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;`.
  - `[["hi",[["b"],["i"]]]]` -> `<strong><em>hi</em></strong>` (fixed nesting order regardless of decoration order in the input).
  - `[["x",[["a","javascript:alert(1)"]]]]` -> `x` with no anchor; `[["x",[["a","https://e.com/?a=1&b=2"]]]]` -> `<a href="https://e.com/?a=1&amp;b=2" rel="noopener nofollow">x</a>`.
  - `[["‣",[["p","413d447a-c4b1-8016-9985-c93eea7f02f9"]]]]` -> anchor to `https://thsm.notion.site/413d447ac4b180169985c93eea7f02f9`.
  - `undefined` and `[]` -> `""`; emoji and RTL text pass through unchanged.
- [ ] **Step 2:** Run `bun test packages/core/test/render/rich-text.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement per interface. `safeHref` parses with `new URL`; relative values starting `/` are Notion-relative.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(core): render Notion rich text to escaped HTML"` (after `git add packages/core`).

### Task 1.3: Block renderer

**Files:**
- Create: `packages/core/src/render/blocks.ts`, `packages/core/test/fixtures/render/blocks-all-types-synthetic.json` (hand-built; the `-synthetic` suffix marks it as not recorded from Notion), `packages/core/test/fixtures/render/blocks-hostile.json`
- Test: `packages/core/test/render/blocks.test.ts`

**Interfaces:**
- Consumes: `RecordMap`, `NotionBlock`, `renderRichText`, `escapeHtml`, `safeHref`.
- Produces:
  ```ts
  export interface BlockRenderCtx {
    workspace: string;
    rootId: string;
    imageUrl(block: NotionBlock, width?: number): string | null; // our proxy URL for an image block, or null when the source is not proxiable
    openInNotionUrl(blockId: string): string;                    // https://<ws>.notion.site/<id-no-dashes>
  }
  export const MAX_DEPTH = 8;
  export function renderBlocks(map: RecordMap, ctx: BlockRenderCtx): { html: string; firstImageBlockId: string | null; text: string };
  ```
  `text` is the concatenated plain text (used for JSON-LD description fallback). Mapping: `text`->`<p>`; `header`/`sub_header`/`sub_sub_header` -> `h2`/`h3`/`h4` (the page title is the single `h1`); consecutive `bulleted_list`/`numbered_list` siblings grouped into one `<ul>`/`<ol>` (first numbered item's `start` from format when present), nested children inside `<li>`; `to_do` -> `<ul class="todo"><li>` with `<input type="checkbox" disabled [checked]>` (no script); `quote`->`<blockquote>`; `callout`->`<aside class="callout">` with icon text from `format.page_icon` if it is an emoji; `code`->`<pre><code>` with escaped text; `divider`->`<hr>`; `image`->`<figure><img ...><figcaption>`; `toggle`->`<details><summary>`; `bookmark`-> `<p class="bookmark"><a>` with title/description; `table`->`<table>` with `<thead>` when `format.table_block_row_header`; `column_list`->`<div class="cols">` with `<div>` per column and `style="flex:<ratio>"`; `page` -> `<p class="sub"><a href=openInNotionUrl>`; anything else (e.g. `collection_view`, `collection_view_page`, `embed`) -> `<p class="unsupported"><a href=openInNotionUrl>Open in Notion</a></p>` with the block title if any. Images: `<img src width height loading alt>`; first image `loading="eager" fetchpriority="high"`, later `loading="lazy"`; `width`/`height` from `format.block_width`/`block_height` else from `format.aspect_ratio` with width 720, else 720x480 default; if `ctx.imageUrl` returns null, render `<p class="unsupported"><a>` link instead of `<img>`.

- [ ] **Step 1: Failing tests** (`blocks.test.ts`):
  - golden: `renderBlocks(unwrapRecordMap(thsmFixture), ctx)` equals the checked-in `packages/core/test/fixtures/render/thsm-blocks.golden.html` (create by running once, then read it through and fix by hand any wrong output; the golden must contain exactly 4 headings, 3 paragraphs, 1 `<hr>`, and 1 `class="unsupported"` link for the `collection_view_page`/`collection_view`).
  - `blocks-all-types-synthetic.json` golden: one of each supported type, asserting `<details><summary>`, `<table>`, `<ol start="3">` and nested `<ul>` inside `<li>`, checkbox `checked`, `flex:` ratios, `<pre><code>` with `&lt;` escaping.
  - hostile (`blocks-hostile.json`): titles/text with `<script>`, quotes, `&`; assert output contains no `<script`, no `onerror`, and every attacker string appears only escaped.
  - cyclic: block `A.content = ["A"]` and `A.content=["B"], B.content=["A"]` both terminate; output contains one `class="unsupported"` link where the cycle or depth `MAX_DEPTH` is hit; no exception.
  - missing child id in `content` is skipped silently only when absent from the map AND typeless; a typed block missing from the map is impossible; assert no throw.
  - image: when `ctx.imageUrl` returns null the output has an anchor, no `<img`; first image has `fetchpriority="high"`, second has `loading="lazy"`; every `<img` has `width=` and `height=`.
- [ ] **Step 2:** Run `bun test packages/core/test/render/blocks.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `renderBlocks`: iterative-recursive walk with a `visited` set per path and depth cap `MAX_DEPTH`; list grouping done in the child-iteration loop.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): render Notion blocks to static semantic HTML`.

### Task 1.4: Full page document, CSS, JSON-LD, budgets

**Files:**
- Create: `packages/core/src/render/page.ts`, `packages/core/src/render/css.ts`, `packages/core/src/render/jsonld.ts`, `packages/core/src/render/index.ts`
- Test: `packages/core/test/render/page.test.ts`

**Interfaces:**
- Consumes: `renderBlocks`, `escapeHtml`, the Foundation OG/meta helper (reuse for tags where it exists; see `contract.md`).
- Produces:
  ```ts
  export const CRITICAL_CSS: string;  // <= 3072 bytes, system font stack, prefers-color-scheme, max-width 42rem, no @import/url()
  export interface FastPageInput {
    workspace: string; slug: string; origin: string;            // origin = PUBLIC_ORIGIN
    title: string; description: string; lang: string;
    canonicalMode: "self" | "notion"; notionUrl: string;
    ogImageUrl: string; editedAt?: string; createdAt?: string;
    body: { html: string; firstImageBlockId: string | null; text: string };
  }
  export function renderFastPage(input: FastPageInput): string;   // full "<!doctype html>" document
  export function articleJsonLd(input: FastPageInput): string;    // JSON, with "<" escaped as \u003c
  ```
  Document structure (Instant View contract, keep stable): `<html lang><head>` meta charset, viewport, `<title>`, description, canonical (`${origin}/${ws}/${slug}/read` for `self`, `notionUrl` for `notion`), OG (`og:title`, `og:description`, `og:image`, `og:url`, `og:type=article`, `twitter:card=summary_large_image`), `<script type="application/ld+json">` is the only script element and is allowed (data block, not executable); `<style>` inline; `<body><article><header><h1>`title`</h1></header>`body`<footer><a class="orig" href=notionUrl>Open the original in Notion</a></footer></article>`. The "no `<script>`" acceptance in spec 8 therefore reads: no executable script; the check in Task 1.7 counts scripts excluding `type="application/ld+json"`.

- [ ] **Step 1: Failing tests:**
  - `renderFastPage` for the thsm fixture: contains `<link rel="canonical" href="https://x.vercel.app/thsm/our-trips/read">`; with `canonicalMode:"notion"` contains the Notion URL instead; exactly one `<h1>`; `og:image` equals `ogImageUrl`.
  - Title `</title><script>x</script>` is escaped in `<title>`, `og:title`, `<h1>`, and JSON-LD contains `\u003c`; JSON.parse of the JSON-LD works and `@type === "Article"`, `headline === title`, `inLanguage === lang`.
  - Budget: `brotliCompressSync(Buffer.from(html)).length <= 14336` for the thsm page; `CRITICAL_CSS.length <= 3072`; html contains no `http://` or `https://` substrings other than `origin`, the Notion host, and schema.org in JSON-LD (test collects all URLs and asserts hosts subset).
  - Empty body (zero content blocks) still renders a valid document with title and footer link.
- [ ] **Step 2:** Run `bun test packages/core/test/render/page.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. CSS: hand-minified literal string in `css.ts` (header comment says why it is inline: first-RTT budget).
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): assemble fast page document with CSS, OG and JSON-LD`.

### Task 1.5: `/read` ISR route and image proxy route

**Files:**
- Create: `apps/web/lib/fast/load-fast-page.ts`, `apps/web/lib/fast/image-source.ts`, `apps/web/app/[ws]/[slug]/read/route.ts` (replaces the 501 placeholder), `apps/web/app/img/[ws]/[slug]/[blockId]/route.ts`
- Modify: `apps/web/package.json` (add `sharp`), and if Foundation's PATCH/DELETE handlers do not already call `revalidatePath` for `/${ws}/${slug}/read`, add that call there (one line each; record in the commit message).
- Test: `apps/web/tests/fast/read-route.test.ts`, `apps/web/tests/fast/image-route.test.ts` (bun test, in-memory `Store`, injected fake fetch)

**Interfaces:**
- Consumes: `Store` (get link by `ws`/`slug`), `loadPageChunk`, `renderBlocks`, `renderFastPage`, `PUBLIC_ORIGIN`, Foundation card-image URL builder for `ogImageUrl`.
- Produces:
  ```ts
  // load-fast-page.ts
  export async function loadFastPage(ws: string, slug: string): Promise<{ status: 200; html: string } | { status: 404 | 410 }>;
  // image-source.ts : the only place that turns a block into a fetchable URL
  export function imageSourceOf(block: NotionBlock): { kind: "attachment" | "external"; value: string } | null;
  export function isAllowedImageHost(url: URL): boolean;             // spec 5.3 allowlist
  export async function resolveFreshImage(args: { workspace: string; block: NotionBlock; width: number; fetch?: typeof fetch }): Promise<Response>; // follows <=3 redirects manually, re-checking isAllowedImageHost each hop
  ```
  Route behaviour: `read/route.ts` exports `dynamic = "force-static"`, `revalidate = 60`, `dynamicParams = true`, `generateStaticParams = () => []` and a `GET` returning `text/html; charset=utf-8` with the document, `Cache-Control` left to ISR. Missing link or `fast === false` -> 404; target not public (page chunk 404/403) -> 410 body "this page is no longer public" with no redirect. Failure of `loadPageChunk` when a cached render exists: the exception must propagate so ISR keeps serving the last good render (do not catch and render an error page with 200). Image URLs in HTML: `/img/<ws>/<slug>/<blockId>?v=<last_edited_time>&w=<640|1280>` with `srcset` of both widths and `sizes="(max-width:720px) 100vw,720px"`. Image route: verifies the link exists and `fast` is true, loads the page chunk (same cache), requires `blockId` to be a block of type `image` present in the map and reachable from the root (walk `content`), resolves a fresh URL, resizes with `sharp` to `w` in {640,1280} only (any other `w` -> 400), picks AVIF/WebP/JPEG from `Accept`, returns `Cache-Control: public, max-age=31536000, s-maxage=31536000, immutable` (cache key includes `v` because the URL does), `Vary: Accept`, `content-type`, and never a redirect to a Notion URL.

- [ ] **Step 1: Failing tests:**
  - read route: seeded link `thsm/our-trips` with fixture chunk -> 200, body contains `<h1>Наши с Леночкой Путешествия</h1>`, contains no `<script` except `application/ld+json`, contains no `notionusercontent`, `file.notion.so` or `secure.notion-static`.
  - `fast:false` -> 404; unknown slug -> 404; fake chunk fetch returning 404 -> 410 with text "no longer public".
  - image route: block not in map -> 404 and the fake fetch is never called; block exists but is type `text` -> 404; block not reachable from root -> 404; `w=999` -> 400; resolved redirect to `https://evil.example/x.png` -> 404 and evil host never fetched; happy path with fake fetch returning a 1x1 PNG and `Accept: image/webp` -> 200 `content-type: image/webp`, immutable cache header, `Vary: Accept`.
  - `isAllowedImageHost`: true for `thsm.notion.site`, `file.notion.so`, `img.notionusercontent.com`, `images.unsplash.com`; false for `notion.site.evil.com`, `evilnotion.site`, `http://` scheme.
- [ ] **Step 2:** Run `bun test apps/web/tests/fast`. Expected: FAIL.
- [ ] **Step 3:** Implement. `resolveFreshImage` for `attachment:` sources requests `https://<ws>.notion.site/image/<encodeURIComponent(value)>?table=block&id=<blockId>&width=1200` and follows the 302 manually; for external sources fetches the URL directly after `isAllowedImageHost`; 5 s timeout, 10 MB body cap. If `sharp` cannot decode, return 404, never the raw bytes.
- [ ] **Step 4:** Run `bun test apps/web/tests/fast && bun run typecheck`. Expected: PASS, typecheck exit 0.
- [ ] **Step 5:** Local ISR check: `bun run build && PUBLIC_ORIGIN=http://localhost:3000 bun run --cwd apps/web start &` then seed an in-memory link via the Foundation dev seed (see `contract.md`; if none exists, add `apps/web/lib/fast/dev-seed.ts` loading the fixture, used only when `NODE_ENV!=="production"`) and `curl -si localhost:3000/thsm/our-trips/read | head -20`. Expected: `HTTP/1.1 200`, `x-nextjs-cache: HIT` on the second request, `content-type: text/html`.
- [ ] **Step 6: Commit** `feat(web): serve fast page via ISR and proxy fresh Notion images`.

### Task 1.6: Live shape smoke and image-block fixture

**Files:**
- Create: `packages/core/scripts/smoke-page-chunk.ts`, `packages/core/test/render/live.test.ts` (skipped unless `LIVE=1`)
- Modify: root `package.json` (script `"smoke:page-chunk": "bun run packages/core/scripts/smoke-page-chunk.ts"`)

**Interfaces:**
- Produces: a script that POSTs `loadPageChunk` for `thsm` page `413d447ac4b180169985c93eea7f02f9`, runs `unwrapRecordMap`, and exits 1 with a clear message if the page block is missing, `content` is empty, or no block types from the supported set appear. Spec 9 risk 7: with no real image block on the test page, the script also accepts `--find-image <url>` to scan any public page and writes a recorded fixture to `packages/core/test/fixtures/render/<ws>-image-chunk.json` (strip `signedUrls`). Task 1.3's image path is trusted only on synthetic data until such a fixture is recorded; if no public page with an image is available, state that in the final report.

- [ ] **Step 1:** Failing test `live.test.ts`: `test.skipIf(!process.env.LIVE)("loadPageChunk shape still matches", ...)` asserts page block present, `blocks.size > 5`.
- [ ] **Step 2:** Run `bun test packages/core/test/render/live.test.ts`. Expected: 1 skipped.
- [ ] **Step 3:** Implement the script. Run `LIVE=1 bun test packages/core/test/render/live.test.ts && bun run smoke:page-chunk`. Expected: PASS and exit 0.
- [ ] **Step 4: Commit** `test(core): live smoke for loadPageChunk response shape`.

### Task 1.7: Performance acceptance script and Instant View template

**Files:**
- Create: `scripts/perf/fast-acceptance.ts`, `docs/instant-view/ntn-link-read.txt`, `docs/instant-view/README.md`
- Modify: root `package.json` (script `"perf:fast": "bun run scripts/perf/fast-acceptance.ts"`)

**Interfaces:**
- Produces: `bun run perf:fast <url> [--baseline]` that:
  1. fetches the URL with `Accept-Encoding: br` and checks: status 200, compressed body <= 14336 B, zero `<script` elements other than `application/ld+json`, one `<h1>`, and every `src`/`href`/`srcset` URL that is not an `<a>` is same-origin;
  2. runs Lighthouse (`CHROME_PATH=~/.local/bin/google-chrome bunx lighthouse <url> --chrome-flags="--headless=new --no-sandbox" --form-factor=mobile --output=json --output-path=<tmp>`), ignores the Lighthouse exit code (unreliable) and reads the JSON; asserts `categories.performance.score >= 0.95`, LCP <= 2500 ms, CLS <= 0.1, TBT <= 200 ms (lab proxy for INP; with zero JS INP is trivially in range, say so in the output), and sums `network-requests` transfer sizes excluding images <= 30720 B;
  3. prints a one-line table comparing TTFB (`server-response-time`) and HTML bytes with the baseline constants (0.29 s; 22.7 KB) and exits 1 on any failed check. Scratch output under `/tmp/ntn-link-perf-<random>`, removed at exit.
- Template: Telegram Instant View draft written against the Task 1.4 document structure (`article`, `h1`, `h2`-`h4`, `figure`, `details`, `table`), path rule matching `/<ws>/<slug>/read`. `docs/instant-view/README.md` states: the template is checked and submitted in the instantview.telegram.org editor with a Telegram login, which is a human-account step outside the autonomous run; fallback (page stays fast with OG) is the shipped behaviour until then.

- [ ] **Step 1:** Write a unit test `scripts/perf/fast-acceptance.test.ts` for the pure checks (`checkHtml(html: string, compressedBytes: number, origin: string): string[]` returns failure messages): returns `[]` for a good document, a failure for an injected `<script>alert(1)</script>`, for an off-origin `<img src="https://x.test/a.png">`, and for 14337 compressed bytes.
- [ ] **Step 2:** Run `bun test scripts/perf`. Expected: FAIL. Implement `checkHtml` and the Lighthouse wrapper. Rerun. Expected: PASS.
- [ ] **Step 3:** Run against the local production server from Task 1.5: `bun run perf:fast http://localhost:3000/thsm/our-trips/read`. Expected: exit 0 with all checks `ok`; if performance < 95, fix the page (not the threshold) and repeat.
- [ ] **Step 4:** `bun run lint && bun run typecheck && bun test`. Expected: all exit 0.
- [ ] **Step 5: Commit** `feat: add fast-page acceptance script and Instant View template`.

---

# Slice 2: Web UI at `/` (spec 6, Interfaces/Web)

Worktree: `rig worktree create webui --from main`. All API calls are typed with `@ntn-link/core/api-types` names from `contract.md`.

### Task 2.1: Flow state machine and client modules (pure, tested)

**Files:**
- Create: `apps/web/lib/ui/flow.ts`, `apps/web/lib/ui/api-client.ts`, `apps/web/lib/ui/storage.ts`, `apps/web/lib/ui/normalize-input.ts`
- Test: `apps/web/tests/ui/flow.test.ts`, `apps/web/tests/ui/storage.test.ts`, `apps/web/tests/ui/normalize-input.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // normalize-input.ts
  export function normalizePastedUrl(raw: string): string; // trim, strip wrapping <>/quotes, trailing .,;)]; keeps query
  // storage.ts (localStorage, injected Storage for tests)
  export interface StoredLink { ws: string; slug: string; redirectUrl: string; fastUrl: string; title: string; createdAt: string }
  export function createUiStorage(s: Storage): {
    getKey(ws: string): string | null; setKey(ws: string, key: string): void;
    listLinks(): StoredLink[]; addLink(l: StoredLink): void; removeLink(ws: string, slug: string): void;
  }; // keys under "ntn-link:keys" and "ntn-link:links"; corrupt JSON -> treated as empty, not thrown
  // flow.ts : reducer, no side effects
  export type Step = "input" | "preview" | "verify" | "done";
  export interface FlowState { step: Step; url: string; busy: boolean; preview?: PreviewResult; slug: string; fast: boolean; challenge?: { nonce: string; claimToken: string; expiresAt: string; action: "claim" | "rotate" }; result?: { redirectUrl: string; fastUrl: string }; error?: { code: string; message: string } }
  export type FlowEvent = { type: "pasted"; url: string } | { type: "previewed"; preview: PreviewResult } | { type: "slugEdited"; slug: string } | { type: "fastToggled"; fast: boolean } | { type: "submit" } | { type: "needsVerification"; challenge: NonNullable<FlowState["challenge"]> } | { type: "verifyPressed" } | { type: "created"; result: NonNullable<FlowState["result"]> } | { type: "failed"; error: { code: string; message: string } } | { type: "reset" };
  export function flowReducer(s: FlowState, e: FlowEvent): FlowState;
  ```
  `PreviewResult` and call shapes come from `api-types.ts`. Reducer rule: `submit` and `verifyPressed` while `busy` return the same state object (enforces single request); `claimToken` exists only in `FlowState.challenge` (never passed to storage).

- [ ] **Step 1: Failing tests:**
  - `normalizePastedUrl("  <https://app.notion.com/p/thsm/413d447ac4b180169985c93eea7f02f9?source=copy_link>.  ")` equals `https://app.notion.com/p/thsm/413d447ac4b180169985c93eea7f02f9?source=copy_link`.
  - reducer: `submit` when `busy` returns identical reference; `needsVerification` moves to step `verify` and stores challenge; `failed` with `challenge_expired` keeps `url` and clears `challenge`; `created` moves to `done`.
  - storage: `setKey("thsm","k")`/`getKey` roundtrip; `Storage` containing `"ntn-link:links"="{oops"` -> `listLinks()` is `[]` and does not throw; `claimToken` string is never found in the serialized storage after a full simulated flow.
- [ ] **Step 2:** `bun test apps/web/tests/ui` -> FAIL. **Step 3:** implement; `api-client.ts` exposes `preview(url)`, `createLink(body)`, `challenge(url, action)`, `verify(body)`, `listNamespace(ws, key)`, each returning `{ok:true,data}|{ok:false,error:{code,message}}`, with an `AbortSignal` param and a 15 s default timeout. **Step 4:** rerun -> PASS.
- [ ] **Step 5: Commit** `feat(web): add UI flow reducer, storage and API client`.

### Task 2.2: Page, components, accessibility

**Files:**
- Create: `apps/web/app/page.tsx`, `apps/web/app/_components/LinkForm.tsx` (client), `CardPreview.tsx`, `VerifyStep.tsx`, `ResultLinks.tsx`, `MyLinks.tsx`, `CopyButton.tsx`
- Modify: `apps/web/app/layout.tsx`, `apps/web/app/globals.css` (Foundation's files; this slice owns the edits)
- Test: `apps/web/tests/e2e/flow.spec.ts`, `apps/web/tests/e2e/a11y.spec.ts`, `apps/web/playwright.config.ts`
- Modify: `apps/web/package.json` (devDeps `@playwright/test`, `@axe-core/playwright`; script `"test:e2e": "playwright test"`)

**Interfaces:**
- Consumes: Task 2.1 modules.
- Produces: the page with these accessibility contract points that tests assert: one `<h1>`; the URL input has a visible `<label>` "Notion page link"; step changes move focus to the new step's heading (`tabIndex=-1`); status and errors in one `aria-live="polite"` region (`role="alert"` for errors); the busy button sets `aria-disabled` and text "Creating..."; Copy buttons announce "Copied" in the live region; every control reachable and operable by keyboard; colours meet WCAG AA in light and dark (`prefers-color-scheme`); `prefers-reduced-motion` disables transitions; no layout shift when the preview appears (the card has fixed `aspect-ratio: 1200/630`). `page.tsx` is a server component; only `LinkForm` and its children are client components; no UI or icon libraries, no web fonts.
  - CardPreview renders the exact unfurl card: image (the `imageUrl` from preview), title, description, domain `ntn.link` (from `PUBLIC_ORIGIN` host), all as text nodes.
  - Verify step: shows the `nonce` in a `<code>` with a Copy button, instructions "Put this text into the title of any public page in your Notion workspace, then press Verify", Verify button, expiry countdown computed from `expiresAt` (text only, updates every 1 s with `aria-live="off"`), and a "Start over" button. `challenge_expired` -> offers a fresh challenge button.
  - Result: both links in `<input readonly>` + Copy each, labelled "Pretty link" and "Fast link"; the fast toggle is a checkbox "Also publish a fast copy (/read)" default on, hidden from the result when off.
  - MyLinks: reads `listLinks()` from storage, and for each known workspace key calls `listNamespace` to merge; delete button calls `DELETE /api/links/<ws>/<slug>` with the key and removes locally on success.

- [ ] **Step 1: Failing e2e tests** (Playwright, API mocked with `page.route("**/api/**")` returning typed fixtures; `webServer` = `next dev`):
  - happy path: paste URL with surrounding spaces -> card preview visible with title text (no `| Notion`) -> slug input prefilled `nashi-s-lenochkoy-puteshestviya` -> Create -> both links shown; clipboard (granted permission) contains the pretty link after clicking Copy and live region says "Copied".
  - verification path: create returns `needs_verification` -> challenge called with `action: "claim"` -> nonce shown -> Verify -> verify request body contains `claimToken`; after success `localStorage["ntn-link:keys"]` contains the key and does NOT contain the `claimToken`; the create is retried with `ownerKey`.
  - double submit: `dblclick` on Create and pressing Enter twice quickly produce exactly 1 `POST /api/links`; same for Verify.
  - error: preview returns `not_public` -> the server's `message` appears in the `role="alert"` region.
  - a11y: `new AxeBuilder({page}).analyze()` has zero violations on each step (input, preview, verify, done) in light and dark (`colorScheme` emulation); Tab order test: Tab from the URL input reaches slug, fast toggle, Create in that order.
  - fast-off: toggle off -> create body has `fast: false` and the result shows only the pretty link.
- [ ] **Step 2:** Run `bun run --cwd apps/web test:e2e`. Expected: FAIL (no UI).
- [ ] **Step 3:** Implement the components. Preview is requested on paste or after 400 ms of input idle, with the previous request aborted (`AbortController`) so stale responses cannot overwrite newer ones.
- [ ] **Step 4:** Rerun e2e. Expected: all PASS.
- [ ] **Step 5: Commit** `feat(web): add paste-to-link web UI with verification flow`.

### Task 2.3: Performance budget and visual proof

**Files:**
- Create: `apps/web/tests/e2e/budget.spec.ts`, `docs/screenshots/webui-{input,preview,verify,done,mylinks}-{mobile,desktop}.png`
- Test: `budget.spec.ts`

**Interfaces:** none new.

- [ ] **Step 1: Failing test** `budget.spec.ts`: against `next start`, sum of JS transfer for `/` (`response.headers()["content-length"]` or encoded size via CDP `Network.loadingFinished.encodedDataLength`) <= 110 KB, zero third-party requests (all request hosts equal the page host), no request for font files, CLS from `PerformanceObserver` (`layout-shift`) <= 0.05 after pasting a URL.
- [ ] **Step 2:** Run it. Expected: FAIL or PASS; if the budget is exceeded, remove dependencies or code until it passes (never raise the number).
- [ ] **Step 3: Visual proof:** with API mocked, capture the five states at 390x844 and 1280x800 into `docs/screenshots/` using Playwright `page.screenshot`. Open every PNG with the image-capable `read` tool and review: card crops correctly, no overflow at 390 px, focus ring visible, Cyrillic title not clipped. Fix and re-capture until all ten are clean; state each reviewed finding in the final report.
- [ ] **Step 4:** `bun run lint && bun run typecheck && bun run build`. Expected: exit 0; the `/` route in the build output is static or ISR (no per-request dynamic rendering).
- [ ] **Step 5: Commit** `test(web): enforce UI payload budget and add reviewed screenshots`.

---

# Slice 3: CLI `ntn-link` (spec 6, Interfaces/CLI)

Worktree: `rig worktree create cli --from main`. The bundle must have zero runtime dependencies: only `import type` from `../../core/src/api-types` (erased at build) and Node built-ins.

### Task 3.1: Argument parsing, config paths, logging

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/src/args.ts`, `packages/cli/src/paths.ts`, `packages/cli/src/log.ts`
- Test: `packages/cli/test/args.test.ts`, `packages/cli/test/paths.test.ts`, `packages/cli/test/log.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // args.ts
  export type Command =
    | { kind: "create"; url: string; slug?: string; fast: boolean; copy: boolean }
    | { kind: "ls"; ws: string } | { kind: "rm"; target: string }
    | { kind: "set"; target: string; title?: string; description?: string; slug?: string; fast?: boolean; canonicalMode?: "self" | "notion" }
    | { kind: "help" } | { kind: "version" };
  export interface Parsed { command: Command; origin?: string }   // --origin or env NTN_LINK_ORIGIN, default "https://ntn.link"
  export class UsageError extends Error {}
  export function parseArgs(argv: string[], env: Record<string, string | undefined>): Parsed;
  // paths.ts
  export function keysFilePath(env: Record<string, string | undefined>, home: string | undefined): string; // $XDG_CONFIG_HOME/ntn-link/keys.json else $HOME/.config/ntn-link/keys.json; no home -> throws ConfigError
  // log.ts
  export function openRunLog(now: Date, pid: number, tmp: string): { path: string; write(line: string): void; close(): void }; // <tmp>/ntn-link-<YYYYMMDDTHHMMSS>-<pid>.log, mode 0600
  export function redact(line: string): string;   // replaces any ownerKey/claimToken/key values and "ntn_" prefixed secrets with [redacted]
  ```
  `ls`/`rm`/`set` targets: `ls <ws>`, `rm <ws>/<slug>`, `set <ws>/<slug> --title ... [--description ...] [--slug ...] [--fast on|off] [--canonical self|notion]`.

- [ ] **Step 1: Failing tests:** `parseArgs(["https://app.notion.com/p/thsm/413d...","--slug","our-trips","--fast","--copy"], {})` gives create with `fast:true, copy:true, slug:"our-trips"`; `["ls","thsm"]`; `["rm","thsm/our-trips"]`; `["set","thsm/our-trips","--title","Hi","--fast","off"]` gives `fast:false`; `[]` and unknown flags throw `UsageError`; `--origin http://x` beats env; `rm` without `/` throws; `keysFilePath({XDG_CONFIG_HOME:"/x"}, "/h")` = `/x/ntn-link/keys.json`, without XDG = `/h/.config/ntn-link/keys.json`; `openRunLog` creates a file with `stat.mode & 0o777 === 0o600`; `redact('{"ownerKey":"abc123"}')` contains no `abc123`.
- [ ] **Step 2:** `bun test packages/cli` -> FAIL. **Step 3:** implement (hand-written parser, no libraries). **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(cli): argument parsing, config paths and run log`.

### Task 3.2: Key store

**Files:**
- Create: `packages/cli/src/keys.ts`
- Test: `packages/cli/test/keys.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface KeyStore { get(ws: string): string | null; set(ws: string, key: string): void }
  export function openKeyStore(path: string): KeyStore;
  ```
  File format `{"<ws>":{"key":"...","savedAt":"ISO"}}`; directory created `0700`, file `0600`, written atomically (tmp file in same dir + `rename`). A file with mode wider than `0600` is chmod'ed to `0600` on read and a warning is returned via `store.warnings: string[]`. Corrupt/empty JSON: renamed to `keys.json.corrupt-<epochms>`, a fresh empty store is used, warning recorded; never throws from `get`.

- [ ] **Step 1: Failing tests** in a temp dir: set/get roundtrip with file mode `0600` and dir mode `0700`; pre-existing `0644` file is fixed to `0600` with a warning; file containing `{oops` is moved aside (the `.corrupt-` sibling exists, original path then holds valid JSON after the next `set`) and `get` returns `null`; two `set` calls for different workspaces preserve both; the key never appears in `warnings`.
- [ ] **Step 2:** FAIL. **Step 3:** implement with `node:fs`. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(cli): 0600 owner key store with corruption recovery`.

### Task 3.3: Commands and entry point

**Files:**
- Create: `packages/cli/src/run.ts`, `packages/cli/src/clipboard.ts`, `packages/cli/src/bin.ts`
- Test: `packages/cli/test/run.test.ts`

**Interfaces:**
- Consumes: Tasks 3.1-3.2; API shapes via `import type` from `../../core/src/api-types` (names in `contract.md`).
- Produces:
  ```ts
  export interface Io { fetch: typeof fetch; env: Record<string, string | undefined>; home: string | undefined; tmp: string; now(): Date; pid: number;
    stdout(s: string): void; stderr(s: string): void; isTTY: boolean; waitForEnter(prompt: string): Promise<void>; copy(text: string): Promise<boolean>; sleep(ms: number): Promise<void> }
  export async function run(argv: string[], io: Io): Promise<number>; // exit code
  ```
  Exit codes: 0 ok; 1 API or network error; 2 usage error; 3 verification needed but stdin is not a TTY; 4 config error (no home).
  Behaviour: `create` -> `POST /api/links {url, slug?, ownerKey?, fast}` with the stored key for the workspace (workspace parsed from the URL by the Foundation parser is not available without bundling; instead send without key first only when no key is stored for any workspace, else key lookup is deferred: on `needs_verification` or when the error payload names the workspace, look up the key and retry once). On `needs_verification`: `POST /api/challenge {url, action:"claim"}`, print on stderr the nonce and the instruction "Put this text into the title of any public page in your Notion workspace, then press Enter", `waitForEnter`, `POST /api/verify`, store the returned key, retry create with it. Non-TTY: print the same instruction, exit 3 (a challenge cannot survive across runs because the `claimToken` is deliberately not persisted). Stdout is exactly `<redirect link>\n` (or the fast link with `--fast`), nothing else. `--copy` copies via `clipboard.ts` (tries `wl-copy`, `xclip -selection clipboard`, `xsel -b`, `pbcopy`, `clip.exe` with `spawn`; failure -> stderr warning, exit code unaffected). `ls <ws>` prints one `slug<TAB>title<TAB>redirectUrl` per line on stdout; `rm`/`set` print nothing on stdout. Every API error prints its `message` on stderr verbatim and returns 1. A `/tmp` log path is printed on stderr only when the exit code is non-zero.

- [ ] **Step 1: Failing tests** (fake `Io` with scripted `fetch`): 
  - success path with stored key: stdout equals `https://x.vercel.app/thsm/our-trips\n`, stderr contains no URL on stdout lines, exit 0; with `--fast` stdout equals the fast link.
  - verification flow: scripted responses `needs_verification` -> challenge -> verify (assert request bodies contain the `claimToken` from the challenge response) -> create ok; the key file now holds the returned key; stdout is still the single link; stderr contains the nonce.
  - non-TTY with `needs_verification`: exit 3, no verify call made.
  - `slug_taken` error: stderr contains the server `message` exactly, exit 1, stdout empty; stderr ends with `log: /tmp/ntn-link-...log`.
  - `ls thsm` prints tab-separated lines; `rm thsm/our-trips` sends `DELETE /api/links/thsm/our-trips` with the key header or body per `contract.md`; `set ... --fast off` sends PATCH `{fast:false}`.
  - network failure (fetch rejects): exit 1, message on stderr, no stack trace.
  - `--copy` with failing clipboard: warning on stderr, exit 0.
  - the log file never contains the owner key (assert by scanning file content).
- [ ] **Step 2:** FAIL. **Step 3:** implement `run`; `bin.ts` builds the real `Io` and calls `process.exit(await run(...))`. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(cli): create, ls, rm and set commands`.

### Task 3.4: Single-file build and npm publish readiness

**Files:**
- Create: `packages/cli/scripts/build.ts`, `packages/cli/README.md`, `packages/cli/LICENSE` (MIT)
- Modify: `packages/cli/package.json`
- Test: `packages/cli/test/build.test.ts`

**Interfaces:**
- Produces: `bun run --cwd packages/cli build` writes `packages/cli/dist/ntn-link.js` (single ESM file, `#!/usr/bin/env node` shebang, `--target=node`, minify off for auditability, version injected from `package.json` via `--define`). `package.json`: `name: "ntn-link"`, `version: "0.1.0"`, `bin: {"ntn-link": "dist/ntn-link.js"}`, `files: ["dist/ntn-link.js","README.md","LICENSE"]`, `engines: {node: ">=20"}`, `type: "module"`, no `dependencies` key, `publishConfig: {access: "public"}`; `prepack` runs the build.

- [ ] **Step 1: Failing test** `build.test.ts` runs the build and asserts: `dist/ntn-link.js` exists and begins with the shebang; contains no `require("` of a non-builtin (regex over `from "..."`/`require("...")` specifiers: all start with `node:` or are in `node:module`'s builtin list); `node dist/ntn-link.js --version` prints `0.1.0`; `node dist/ntn-link.js` (no args) exits 2 with usage on stderr and empty stdout; `npm pack --dry-run --json` lists exactly `dist/ntn-link.js`, `README.md`, `LICENSE`, `package.json`.
- [ ] **Step 2:** FAIL. **Step 3:** implement script, README (usage, exit codes, key file path, verification explanation). **Step 4:** PASS. Run `cd packages/cli && npm publish --dry-run`; Expected: ends with `+ ntn-link@0.1.0` dry-run output and no network write. A real `npm publish` needs the owner's npm credentials and is NOT run (reported in slice 6).
- [ ] **Step 5:** `bun run lint && bun run typecheck`. Expected: exit 0.
- [ ] **Step 6: Commit** `feat(cli): single-file build and npm publish readiness`.

---

# Slice 4: Browser extension (spec 6, Interfaces/Extension)

Worktree: `rig worktree create ext --from main`. Spike verdict received from ClipboardSpike: **(a)** Notion's Copy link builds the URL (adds `?source=copy_link`) then awaits `navigator.clipboard.write([ClipboardItem{text/plain}])` (falls back to `writeText`), `.then(callback)` after; on rejection it opens a manual-copy modal. Sync `execCommand('copy')` is only the block Ctrl+C path. The verdict is from static analysis; Task 4.5 verifies dynamically. If Task 4.5 disproves it, branch (b) is: delete `src/intercept-main.ts`, `src/relay.ts` and the `content_scripts` entries, and ship only Tasks 4.1, 4.2, 4.4 (the build and tests keep working because the manifest builder takes the content-script list from one array). Branch (c) hybrid: if only the callback path is awaitable, `intercept-main.ts` lets the original write proceed and overwrites the clipboard with the pretty link after the API answers (same wrapper, flag `OVERWRITE_AFTER = true`).

### Task 4.1: Pure logic: URL classification, key store, link service

**Files:**
- Create: `extension/package.json`, `extension/tsconfig.json`, `extension/src/notion-url.ts`, `extension/src/keys.ts`, `extension/src/link-service.ts`, `extension/src/config.ts`
- Test: `extension/test/notion-url.test.ts`, `extension/test/link-service.test.ts`

**Interfaces:**
- Consumes: the Foundation Notion URL parser from `@ntn-link/core` (pure; bundled by `bun build`), API shapes from `api-types.ts`.
- Produces:
  ```ts
  // config.ts
  export const ORIGIN: string;           // injected at build from env NTN_LINK_ORIGIN (default "https://ntn.link"); used for the API and for host permissions
  // notion-url.ts
  export function classifyPageUrl(raw: string): { workspace: string | null; pageId: string; canonical: string } | null; // null = not a Notion page URL; workspace null when the URL form has none (www.notion.so/<id>): caller must resolve via API
  // keys.ts (chrome.storage.local-compatible async area, injected)
  export interface StorageArea { get(k: string): Promise<Record<string, unknown>>; set(o: Record<string, unknown>): Promise<void> }
  export function createKeyStore(a: StorageArea): { getKey(ws: string): Promise<string | null>; setKey(ws: string, key: string): Promise<void>; getLinkCache(pageId: string): Promise<{ redirectUrl: string; fastUrl: string } | null>; setLinkCache(pageId: string, v: { redirectUrl: string; fastUrl: string }): Promise<void> }
  // link-service.ts
  export type Kind = "pretty" | "fast";
  export async function resolveLink(args: { url: string; kind: Kind; keys: ReturnType<typeof createKeyStore>; fetch: typeof fetch; timeoutMs: number }): Promise<{ ok: true; link: string } | { ok: false; reason: "not_notion" | "no_key" | "api_error" | "timeout"; message: string }>;
  ```
  `resolveLink`: classify; if no workspace, call `POST /api/preview` to obtain it; no key for the workspace -> `no_key`; cache hit by `pageId` returns immediately; otherwise `GET /api/ns/<ws>/links` with the key, match `pageId`; otherwise `POST /api/links {url, ownerKey, fast:true}`; cache result; abort after `timeoutMs`.
  Added key-store methods for the interception policy (explicit toolbar/shortcut actions do not use them): `isAutoEnabled(ws: string): Promise<boolean>` (default `false`), `setAutoEnabled(ws: string, on: boolean): Promise<void>`, `getPublicProof(pageId: string, now: number): Promise<boolean | null>` (null = absent or expired), `setPublicProof(pageId: string, ok: boolean, now: number): Promise<void>`. `resolveLink` remains the path for explicit user actions only and may contact our API (including `/api/preview` for workspace-less URLs); the automatic path goes through `interceptionLink` (Task 4.3) and never reaches `resolveLink` before its gates pass.

- [ ] **Step 1: Failing tests:** `classifyPageUrl` over `https://app.notion.com/p/thsm/413d447ac4b180169985c93eea7f02f9?source=copy_link` -> `{workspace:"thsm", pageId:"413d447a-c4b1-8016-9985-c93eea7f02f9"}`; `https://thsm.notion.site/Our-Trips-413d447ac4b180169985c93eea7f02f9` -> workspace `thsm`; `https://example.com/x` -> `null`; `https://www.notion.so/413d447ac4b180169985c93eea7f02f9` -> workspace `null`. `resolveLink` with scripted fetch: no key -> `no_key` and zero fetch calls; key + list containing the page -> returns existing link without POST; key + empty list -> exactly one `POST /api/links` whose body has `ownerKey` and `fast:true`; second call hits the cache with zero fetches; `kind:"fast"` returns `fastUrl`; fetch that never resolves -> `timeout` within `timeoutMs + 50`.
- [ ] **Step 2:** `bun test extension` -> FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(ext): Notion URL classification, key store and link resolution`.

### Task 4.2: Background (commands, toolbar), options page, Chrome and Firefox clipboard

**Files:**
- Create: `extension/src/background.ts`, `extension/src/copy.ts`, `extension/src/offscreen.ts`, `extension/src/options.ts`, `extension/static/options.html`, `extension/static/offscreen.html`, `extension/static/icons/{16,48,128}.png`, `extension/manifest.base.json`
- Test: `extension/test/background.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // background.ts
  export async function handleCopy(kind: Kind, deps: { activeTabUrl(): Promise<string | undefined>; resolve: typeof resolveLink; copy(text: string): Promise<void>; notify(state: "ok" | "no_key" | "error", text: string): Promise<void>; openOptions(url: string): Promise<void> }): Promise<void>;
  ```
  Commands (manifest `commands`): `copy-pretty` (suggested `Ctrl+Shift+L`, `MacCtrl+Shift+L` on Mac), `copy-fast` (`Ctrl+Shift+F`); toolbar `action.onClicked` = `copy-pretty`. Feedback via the action badge ("OK" green / "!" red for 3 s), no notifications permission. `no_key` opens `options.html?url=<tab url>`. Options page: claim flow (calls `/api/challenge`, shows the public `nonce` with copy, keeps `claimToken` in page memory only, Verify -> `/api/verify`, stores key via key store) and a manual "paste an owner key" field for keys created in the CLI; labelled controls, keyboard operable. Copy: Chrome uses an offscreen document (`reasons: ["CLIPBOARD"]`, `document.execCommand("copy")` on a textarea, because a service worker has no clipboard); Firefox uses `navigator.clipboard.writeText` in the background script with `clipboardWrite` (Firefox only). `copy.ts` picks the implementation via `typeof chrome.offscreen`.

- [ ] **Step 1: Failing tests** (`handleCopy` with fakes): ok -> `copy` called once with the link and `notify("ok")`; `no_key` -> `openOptions` called with a URL ending `options.html?url=` + encoded tab url and no copy; `not_notion` -> `notify("error", "Open a public Notion page first")`; `timeout`/`api_error` -> `notify("error", message)` and no copy; undefined tab URL -> error notify, no throw.
  - Options page auto-interception toggle: per-workspace list with a checkbox "Replace Notion's Copy link for <ws>" (default off); toggling calls `keys.setAutoEnabled(ws, boolean)`; a workspace can be added only by typing its `<ws>` (a-z0-9-) or via the `?url=` prefill. Explanation text says what is sent where: "When on, copying a link on a public page of this workspace makes the extension check that the page is public (direct request to Notion) and then ask ntn-link for the short link. Private pages are never sent to ntn-link." Test (options logic as a pure function `setAutoWorkspace(keys, ws, on)`): default `isAutoEnabled` is false; invalid `<ws>` rejected; toggle persists.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(ext): copy commands, toolbar button and options page`.

### Task 4.3: Copy-link interception (verdict (a)), privacy-gated

**Files:**
- Create: `extension/src/intercept-main.ts` (MAIN world, `document_start`), `extension/src/relay.ts` (isolated world content script), `extension/src/intercept-policy.ts` (privacy gate), plus background handler addition in `extension/src/background.ts` for message `{type:"ntn-resolve", url}` that returns `interceptionLink(url, deps)`
- Test: `extension/test/intercept.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // intercept-main.ts
  export interface InterceptDeps { clipboard: Clipboard; ask(url: string, timeoutMs: number): Promise<string | null>; isNotionPageUrl(text: string): boolean }
  export function installInterceptor(deps: InterceptDeps, opts?: { timeoutMs?: number; overwriteAfter?: boolean }): void;
  ```
`installInterceptor` replaces `Clipboard.prototype.write` and `.writeText` (the originals are kept in closure). For `writeText(text)`: if `isNotionPageUrl(text)`, `ask(text, 1500)`; a string result is written instead, `null`/timeout/any exception falls back to the original `text`. For `write(items)`: only a single-item payload whose `types` includes `text/plain` is considered; read it with `getType("text/plain").text()`; on a pretty link build a new `ClipboardItem({"text/plain": new Blob([link], {type:"text/plain"})})`; on any failure (including reading the blob) call the original `write(items)` with the unchanged items. The wrapper must never throw synchronously and never reject for a reason other than the original method's own rejection. `ask` is `window.postMessage({source:"ntn-link", id, url})` to the isolated relay, which forwards to the background via `chrome.runtime.sendMessage` and answers with a `postMessage`; the relay only accepts messages whose `event.source === window` and `event.origin === location.origin`. The page-side code never contacts our origin and holds no key, no workspace list and no policy: all decisions are in the background (`interceptionLink`, below). No `clipboardWrite` permission is requested. Firefox: MAIN world content scripts are supported from 128; prototype patching of page objects from an extension needs no `exportFunction` when the script runs in the MAIN world; Task 4.5 verifies this.

  **Privacy policy (hard rules, enforced in `extension/src/intercept-policy.ts`, which the background message handler `{type:"ntn-resolve", url}` calls):**
  ```ts
  export interface PolicyDeps { keys: ReturnType<typeof createKeyStore>; fetch: typeof fetch; now(): number; timeoutMs: number; resolve: typeof resolveLink }
  export async function interceptionLink(url: string, d: PolicyDeps): Promise<string | null>; // null = leave the clipboard payload untouched
  export async function provePublic(ws: string, pageId: string, d: Pick<PolicyDeps, "keys" | "fetch" | "now" | "timeoutMs">): Promise<boolean>;
  export const PROOF_TTL_MS: { positive: 3_600_000; negative: 300_000 };
  ```
  `interceptionLink` returns `null` unless every step passes, in this order, each step stopping the chain with zero requests to `ORIGIN`: (1) `classifyPageUrl` gives a non-null `workspace` (workspace-less `notion.so/<id>` URLs are NEVER intercepted); (2) the workspace is in the user's auto-interception set (`keys.isAutoEnabled(ws)`; OFF by default, enabled per workspace on the options page); (3) an owner key exists for the workspace; (4) `provePublic`: the service worker itself fetches `https://<ws>.notion.site/<id-no-dashes>` (Notion only, `credentials: "omit"`, `redirect: "manual"` limited to the same host, timeout) and requires status 200 plus `og:title` in the HTML, result cached per page id with `PROOF_TTL_MS` (positive and negative); (5) only then `d.resolve(...)` (our API). Any failure, timeout, non-public page, unknown workspace or missing key yields `null`. Our server therefore never receives a page id unless the user explicitly created a link (toolbar, shortcut, options page, CLI, web) or the page was proven public by the extension itself.

- [ ] **Step 1: Failing tests** (fake `Clipboard` class with recorded calls; for the background policy, scripted `fetch` that records every URL, with `ORIGIN` = `https://x.example`):
  - **Privacy, zero requests to our origin and original text preserved** for each of: a private page (direct Notion fetch answers 404), an unknown workspace (direct fetch rejects / DNS failure), a workspace-less URL `https://www.notion.so/413d447ac4b180169985c93eea7f02f9` (zero fetches at all, not even to Notion), a workspace with auto-interception not enabled (zero fetches at all), an enabled workspace without an owner key (the public proof may run, but no request to `ORIGIN`), a direct fetch answering 200 without OG tags, a direct fetch that hangs past the timeout. In each case the clipboard receives exactly the original text, and `fetch` calls whose host equals the `ORIGIN` host number 0.
  - **Enabled + public + key:** workspace enabled, direct fetch to `https://thsm.notion.site/413d447ac4b180169985c93eea7f02f9` (assert `credentials: "omit"`) answers 200 with `og:title`, key present -> the API is called and the clipboard receives `https://x.example/thsm/our-trips` (pretty link).
  - Proof cache: a second copy of the same page makes zero direct fetches; a negative result is cached for its shorter TTL (use an injected clock to assert expiry of both).
  - Wrapper behaviour: non-Notion text -> original called with identical text, `ask` never called; `ask` rejects -> original called with the original text and the returned promise resolves; `ask` hangs -> falls back after `timeoutMs` (use `timeoutMs: 20`); `write()` with two items or `text/html` only -> passes through untouched; `write()` whose `getType` throws -> original items written; original `writeText` rejects -> wrapper rejects with the same error (no swallowing); the wrapper never throws synchronously (call it with `undefined`, a number, a frozen object); `overwriteAfter: true` (branch (c)) -> original called first with the original text, then again with the pretty link once `ask` resolves, and not at all when the policy declines.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(ext): intercept Notion Copy link with safe fallback`.

### Task 4.4: Manifest builder, packaging, static checks

**Files:**
- Create: `extension/scripts/build.ts`, `extension/test/manifest.test.ts`, `extension/README.md`
- Modify: root `package.json` (script `"build:ext": "bun run extension/scripts/build.ts"`)

**Interfaces:**
- Produces: `bun run build:ext` -> `extension/dist/chrome/`, `extension/dist/firefox/`, `extension/dist/ntn-link-chrome-<version>.zip`, `extension/dist/ntn-link-firefox-<version>.zip` (zipped with `fflate`, root-level manifest, no source maps). Manifest per browser derived from `manifest.base.json` with `manifest_version: 3`, `name: "ntn-link"`, `version` from `extension/package.json`, `permissions: ["storage"]` plus `"offscreen"` on Chrome only and `"clipboardWrite"` on Firefox only, `host_permissions: ["https://*.notion.site/*","https://www.notion.so/*","https://www.notion.com/*","https://app.notion.com/*", "<ORIGIN>/*"]`, `content_scripts` [relay (isolated, `document_start`), interceptor (`world: "MAIN"`, `document_start`)] both with `matches` the four Notion patterns, `all_frames: false`; Chrome `background: {service_worker}`, `minimum_chrome_version: "111"`; Firefox `background: {scripts}`, `browser_specific_settings.gecko: {id: "ntn-link@ntn.link", strict_min_version: "128.0"}`. No `activeTab`, `tabs`, `scripting`, `<all_urls>`, `notifications`. Reading the active tab URL uses `chrome.tabs.query` which returns `url` only for hosts in `host_permissions` (Notion pages), which is all that is needed.

- [ ] **Step 1: Failing tests** `manifest.test.ts` (after running the build): both manifests parse; `permissions` deep-equal `["storage","offscreen"]` (chrome) and `["storage","clipboardWrite"]` (firefox); every `host_permissions` entry is one of the allowed set or `ORIGIN/*`; no `unsafe-eval`/`unsafe-inline` in `content_security_policy`; scanning every built `.js` and `.html` finds no `eval(`, `new Function(`, no `<script src="http`, no `import("http`, and no `fetch(` to a host other than `ORIGIN`; both zips contain `manifest.json` at root and every file declared in the manifest.
- [ ] **Step 2:** FAIL. **Step 3:** implement with `Bun.build` (one entry per script, `format: "iife"` for content scripts, `esm` for the service worker). **Step 4:** `bun run build:ext && bun test extension` -> PASS.
- [ ] **Step 5: Commit** `feat(ext): build Chrome and Firefox packages with minimal permissions`.

### Task 4.5: Dynamic verification in real browsers (verdict assumptions made explicit)

**Files:**
- Create: `extension/test/e2e/chrome.e2e.ts`, `docs/spikes/extension-dynamic-check.md` (results)

**Interfaces:** none.

Unverified assumptions from the static spike, each one a checked step with the observed result written into `docs/spikes/extension-dynamic-check.md` (use `git add -f` if the docs path is ignored):

- [ ] **Step 1: Chrome load + activation window + CSP.** Launch Playwright Chromium (headed under `xvfb-run` if headless drops extensions) with `--disable-extensions-except=extension/dist/chrome --load-extension=extension/dist/chrome`, open `https://thsm.notion.site/413d447ac4b180169985c93eea7f02f9`, evaluate in the page: `typeof navigator.clipboard.writeText` is `function` and `Clipboard.prototype.writeText.toString()` does NOT contain `[native code]` (patched). Record the page's `content-security-policy` response header and whether a direct `fetch(ORIGIN)` is blocked (the relay path means this is informational).
- [ ] **Step 2: Activation window.** With auto-interception enabled for `thsm` on the options page (it is off by default), a key seeded into the extension storage (service-worker `evaluate`) and a stub API (`context.route(ORIGIN + "/**")`) that delays 0.2 s, 1 s, 1.8 s: click Notion's page menu "Copy link" (public notion.site pages expose "Copy link" in the share/page menu; if unauthenticated pages have no such control, perform the check on a page where the Notion web app is signed out and record that fact) and read the clipboard with `navigator.clipboard.readText()` after `focus`. Expected: pretty link for delays below the timeout; original URL for 1.8 s (timeout fallback). Record the observed maximum delay at which `write` still succeeds under user activation (the direct public-proof request to Notion is part of that budget; record its latency too).
- [ ] **Step 2b: Privacy, dynamic.** In the same browser session, count every request to `ORIGIN` (`context.route(ORIGIN + "/**")`). (i) Auto-interception NOT enabled for `thsm` (default) -> click "Copy link": clipboard holds Notion's original URL, counter 0, and the service worker issued no request to `thsm.notion.site` either. (ii) Enable `thsm`, key seeded, but copy a private page URL (a 404 on `https://thsm.notion.site/<random-32-hex>`) -> original text, counter 0. (iii) Enabled + public page -> pretty link, counter >= 1, and the direct Notion request carried no cookies (no `cookie` request header in the service-worker network log). Record all three in the results file; a counter > 0 in (i) or (ii) fails the task.
- [ ] **Step 3: Lazy modules.** Open the share modal (Share button), find a second "Copy link" button, click it, assert the same rewriting; record result.
- [ ] **Step 4: Firefox.** `bunx web-ext run --source-dir extension/dist/firefox --firefox <firefox path> --start-url <page>` is interactive; use `web-ext lint --source-dir extension/dist/firefox` as the automated check (expected: 0 errors) and run the interceptor unit tests in Firefox's `about:debugging` temporary add-on flow only if a Firefox binary is available (`command -v firefox`); otherwise record "Firefox runtime check not performed: no Firefox binary" in the results file and keep `web-ext lint` as evidence.
- [ ] **Step 5: Decide the verdict branch.** If Step 2 shows rewriting works: keep (a). If rewriting only works with `overwriteAfter`: set the flag in `extension/src/config.ts` and note (c). If neither works: remove the interceptor per the branch (b) instruction at the top of Slice 4, rebuild, rerun `bun test extension`.
- [ ] **Step 6: Commit** `test(ext): record dynamic copy-link verification results`.

---

# Slice 5: Deploy and live verification (spec 8 End to end)

Worktree: `rig worktree create deploy --from main`. Tasks 5.1-5.2 may run as soon as Foundation is merged; 5.3 onward after slices 1-3 are merged into `main` (the orchestrator tells the agent). Vercel facts from the readiness inventory: logged in as `a-x-`, Hobby scope `inventorems-projects`, CLI `bunx vercel@latest` (65.14.0), conventions from the tasks-app `vercel.json`. Secrets are never printed or committed; use `vercel env add NAME --environment production,preview --value <v> --sensitive` and the `keychain` skill for anything stored locally.

### Task 5.1: Project, config, and store provisioning decision

**Files:**
- Create: `vercel.json`, `docs/deploy/provisioning.md`

**Interfaces:**
- Produces `vercel.json` exactly:
  ```json
  {
    "bunVersion": "1.x",
    "installCommand": "bun install --frozen-lockfile",
    "buildCommand": "bun run build",
    "framework": "nextjs",
    "outputDirectory": "apps/web/.next",
    "regions": ["fra1"]
  }
  ```
  (confirm `outputDirectory`/root settings against a first `vercel build` and adjust only with evidence; if the Vercel project uses Root Directory `apps/web`, then `vercel.json` moves to `apps/web/` and `installCommand` runs from the repo root via `cd ../..`). Node 24.x is set in the project settings (`vercel project` or the API `nodeVersion: "24.x"`).

- [ ] **Step 1: Link the project:** `cd <worktree> && bunx vercel@latest link --yes --project ntn-link --scope inventorems-projects`. Expected: `.vercel/` created (git-ignored) and output `Linked to inventorems-projects/ntn-link`.
- [ ] **Step 2: Choose the store (autonomous path first).** Run `bunx vercel@latest integration add --help`. If it documents `neon` with `--yes` (or an equivalent non-interactive flag) run `bunx vercel@latest integration add neon --name ntn-link-db --yes` and then `bunx vercel@latest env ls`; Expected: a `DATABASE_URL` (or the names printed) available to production and preview. Do NOT accept Upstash terms on the owner's behalf (`vercel integration add upstash/upstash-kv` needs a human to accept terms). Outcomes:
  - **Neon works:** do Task 5.2 and set `STORE=postgres` (the env name that the Foundation store factory reads, per `contract.md`; if the factory has no selector add one in Task 5.2).
  - **Neon not possible non-interactively:** keep `UpstashStore`, write `docs/deploy/provisioning.md` with the single owner command `bunx vercel@latest integration add upstash/upstash-kv --name ntn-link-redis` (the owner accepts terms once; it injects the REST URL and token env vars that Foundation reads, names in `contract.md`), skip 5.2, and finish 5.3-5.6 against the in-memory-incompatible reality by deploying only after the owner runs that command. Report this as the sole blocker with the exact command.
- [ ] **Step 3: Set app env vars:** `ADMIN_TOKEN=$(openssl rand -hex 32)` stored with `bunx vercel@latest env add ADMIN_TOKEN --environment production,preview --value "$ADMIN_TOKEN" --sensitive` and in the local keychain entry `ntn-link/admin-token` via the keychain skill; `PUBLIC_ORIGIN` for production set after the first deploy reveals the stable alias (Task 5.4), expected `https://ntn-link.vercel.app`.
- [ ] **Step 4: Commit** `chore(deploy): add vercel.json and provisioning notes`.

### Task 5.2: PostgresStore (only if Task 5.1 chose Neon)

**Files:**
- Create: `packages/core/src/store/postgres.ts`, `packages/core/test/store/postgres.test.ts`
- Modify: the Foundation store factory (file named in `contract.md`) to select `postgres` when `STORE=postgres`; `packages/core/package.json` deps `@neondatabase/serverless`, devDeps `@electric-sql/pglite` (this is the only edit to that file from this slice; slice 1's export lines are additive)

**Interfaces:**
- Produces: `export function createPostgresStore(sql: SqlClient, now?: () => number): Store` where `SqlClient = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>`; the real client is `neon(process.env.DATABASE_URL)`, the test client wraps PGlite with the same call shape. Schema created by an idempotent `ensureSchema(sql)`: table `kv(key text primary key, value jsonb not null, expires_at timestamptz null)` plus helper operations implementing every `Store` method with: `setNX` = `INSERT ... ON CONFLICT (key) DO NOTHING RETURNING key` (true iff a row returned, treating an expired row as absent by deleting it first in the same statement via CTE); atomic delete returns true iff `DELETE ... RETURNING` yields a row; attempt counter = `UPDATE ... SET value = jsonb_set(value,'{attempts}', to_jsonb((value->>'attempts')::int + 1)) RETURNING value`; expiry honoured on every read with `expires_at > now()`.

- [ ] **Step 1: Failing tests:** run the shared Store conformance suite (the one Foundation applies to the in-memory and Upstash stores; if it lives in `packages/core/test/store-conformance.ts` import it, otherwise create it with the cases: `setNX` returns true then false; 20 concurrent `setNX` on one key yield exactly one `true`; atomic delete returns true exactly once under 20 concurrent calls; attempt increments are not lost under 20 concurrent increments; expired keys read as absent and can be re-`setNX`ed; counters for rate limits expire) against `createPostgresStore(pglite)`.
- [ ] **Step 2:** `bun test packages/core/test/store` -> FAIL. **Step 3:** implement. **Step 4:** PASS, then `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(core): PostgresStore on Neon with atomic SQL`.

### Task 5.3: Operator seed script

**Files:**
- Create: `scripts/deploy/seed-namespace.ts`, `scripts/deploy/seed-namespace.test.ts`

**Interfaces:**
- Produces: `bun run scripts/deploy/seed-namespace.ts --ws thsm` which, using the same store factory and env as production (pull with `vercel env pull .env.production.local --environment production`; file is git-ignored), claims namespace `thsm` directly in the store (operator authority) with a generated 256-bit owner key, stores only its SHA-256 hash, and writes the key into `$XDG_CONFIG_HOME/ntn-link/keys.json` (same format and 0600 mode as the CLI key store, atomic write) without printing it. Rationale: ownership of `thsm` by title challenge needs the Notion account owner to edit a page title, which cannot be done autonomously; the operator holds the store and the owner is the same human, so seeding gives the CLI a valid key for live testing, and the positive title-challenge path is covered by the unit tests plus a negative live check (Task 5.5). Refuses if the namespace is already claimed (exit 1).

- [ ] **Step 1: Failing test** with the in-memory store: seeding writes `ns:thsm` with `keyHash === sha256(key)`, file mode `0600`, key file entry for `thsm`, second run exits 1 without changing the hash, stdout contains no key.
- [ ] **Step 2-4:** FAIL, implement, PASS (`bun test scripts/deploy`).
- [ ] **Step 5: Commit** `feat(deploy): operator script to seed a namespace owner key`.

### Task 5.4: First production deploy

**Files:** none new.

- [ ] **Step 1: Pre-flight on the merged `main` build:** `bun install --frozen-lockfile && bun run lint && bun run typecheck && bun test && bun run build`. Expected: exit 0 each.
- [ ] **Step 2: Deploy:** `bunx vercel@latest deploy --prod --yes`. Expected: last line is `Production: https://ntn-link-<hash>-inventorems-projects.vercel.app` and an alias line `https://ntn-link.vercel.app` (if the alias differs, use whatever `vercel project inspect ntn-link` lists as the production domain; call it `$ORIGIN`).
- [ ] **Step 3: Set `PUBLIC_ORIGIN` to `$ORIGIN` and redeploy:** `printf %s "$ORIGIN" | bunx vercel@latest env add PUBLIC_ORIGIN production` then `bunx vercel@latest deploy --prod --yes`. Preview deployments use the system `VERCEL_URL`; if Foundation does not fall back to it, set `PUBLIC_ORIGIN` for the preview environment per deployment instead (record in `docs/deploy/provisioning.md`).
- [ ] **Step 4: Protection check:** `curl -s -o /dev/null -w '%{http_code}\n' $ORIGIN/`. Expected `200`. Unique deployment URLs may answer `401` due to Vercel Authentication; that is expected and why measurements use `$ORIGIN` (the production alias is public) instead of a protected preview URL. State this deviation from spec 1 ("on a Vercel preview") in the report.
- [ ] **Step 5:** Seed the namespace: `bunx vercel@latest env pull .env.production.local --environment production --yes && bun run scripts/deploy/seed-namespace.ts --ws thsm`. Expected: `claimed thsm` on stderr, exit 0.

### Task 5.5: Live verification

**Files:**
- Create: `scripts/deploy/live-verify.sh`, `docs/deploy/live-verification.md` (recorded results)

- [ ] **Step 1: Create link via the CLI against live** (needs slice 3 built): `NTN_LINK_ORIGIN=$ORIGIN node packages/cli/dist/ntn-link.js "https://app.notion.com/p/thsm/413d447ac4b180169985c93eea7f02f9?source=copy_link" --slug our-trips --fast`. Expected stdout (single line): `$ORIGIN/thsm/our-trips/read`; without `--fast` the redirect link; exit 0.
- [ ] **Step 2: Redirect link with every UA:** for `UA` in `curl/8`, `TelegramBot (like TwitterBot)`, `Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36`, `Slackbot-LinkExpanding 1.0`, `WhatsApp/2.23`: `curl -s -A "$UA" -o /tmp/ntn-body.html -w '%{http_code} %{redirect_url}\n' $ORIGIN/thsm/our-trips`. Expected each line `200 ` (empty redirect URL); the body contains `<meta property="og:title" content="Наши с Леночкой Путешествия">` (no `| Notion`), `og:image` ending `/og/thsm/our-trips.png`, `twitter:card`, and `http-equiv="refresh"` with `thsm.notion.site/413d447ac4b180169985c93eea7f02f9`.
- [ ] **Step 3: Card image:** `curl -sI $ORIGIN/og/thsm/our-trips.png` -> `200`, `content-type: image/png`; download and view the PNG with the image `read` tool; Expected: 1200x630, Cyrillic title legible or the page's own social image. Record the finding.
- [ ] **Step 4: Fast link:** `curl -s -H 'Accept-Encoding: br' -o /tmp/read.br -w '%{http_code} %{size_download} %{time_starttransfer}\n' $ORIGIN/thsm/our-trips/read`. Expected `200`, size_download <= 14336, no `<script` other than `application/ld+json` in the decompressed body (`brotli -dc`), second request header `x-vercel-cache: HIT`.
- [ ] **Step 5: Lighthouse acceptance:** `bun run perf:fast $ORIGIN/thsm/our-trips/read` (Slice 1 script; Lighthouse via `CHROME_PATH=~/.local/bin/google-chrome bunx lighthouse` headless as in the script). Expected exit 0: performance >= 95, LCP <= 2.5 s, CLS <= 0.1, TBT <= 200 ms, non-image transfer <= 30 KB, TTFB below 0.29 s baseline median or report the measured value. Also run mobile Lighthouse on `$ORIGIN/` and record the score (informational, no gate beyond the UI budget).
- [ ] **Step 6: CLI full cycle:** `ntn-link ls thsm` lists `our-trips`; `ntn-link set thsm/our-trips --title "Тест"` then re-run Step 2 (title changes after on-demand revalidation within seconds; poll up to 60 s) ; `ntn-link set thsm/our-trips --title "Наши с Леночкой Путешествия"` to restore (or `--title ""` if empty clears the override per `contract.md`); `ntn-link rm thsm/our-trips` then `curl -s -o /dev/null -w '%{http_code}' $ORIGIN/thsm/our-trips/read` -> `404`; recreate the link to leave the service in a usable state.
- [ ] **Step 7: Negative verification path:** `POST $ORIGIN/api/challenge {"url":"https://other.notion.site/413d447ac4b180169985c93eea7f02f9","action":"claim"}` expects either a challenge (if the page is public) or `not_public`; then `POST /api/verify` with a wrong `claimToken` expects `challenge_invalid`. Record. The positive path (owner edits a Notion title) is not run autonomously (needs Notion account); noted in the report.
- [ ] **Step 8: Image proxy live:** if a fixture with an image block was recorded in Task 1.6, create the link for that page and confirm `/img/<ws>/<slug>/<blockId>` returns an image and the HTML references no Notion image host; otherwise record "image proxy verified only against synthetic fixtures".
- [ ] **Step 9: Record and commit:** write results into `docs/deploy/live-verification.md` (commands, observed values, UTC timestamps). `git add scripts/deploy docs/deploy && git commit -m "docs(deploy): record live verification results"`.

### Task 5.6: Rollback plan and domain switch (owner action prepared)

**Files:**
- Create: `docs/deploy/rollback.md`, `docs/deploy/owner-domain-switch.md`

- [ ] **Step 1: `rollback.md`:** list the exact commands: `bunx vercel@latest ls ntn-link --prod` to find the previous good deployment, `bunx vercel@latest rollback <deployment-url>` (instant, restores the alias), `bunx vercel@latest promote <url>` to re-point after a fix, and the data note: store contents are untouched by rollback; a bad release that wrote malformed records is fixed forward, and a single link is disabled with `curl -X DELETE -H "x-admin-token: $ADMIN_TOKEN" $ORIGIN/api/links/<ws>/<slug>` (header name per `contract.md`). Verify the commands exist: `bunx vercel@latest rollback --help` and `promote --help` exit 0.
- [ ] **Step 2: `owner-domain-switch.md`** (the only owner-money item). Content, exact:
  1. Buy `ntn.link` at Porkbun (public price $7.72/yr; availability confirmed at checkout; Vercel's own registrar sells it at $258.50/yr, do not use it). Fallback `ntn.page` ($10.81).
  2. Attach the domain to the project: `bunx vercel@latest domains add ntn.link ntn-link` (domain, project). Vercel prints the DNS records it needs (apex: an `A` record, currently `76.76.21.21`; use the printed values, not this one if they differ); create them in Porkbun's DNS tab. No nameserver change is needed. If `domains add --help` shows a different argument order, follow the help text.
  3. `bunx vercel@latest domains inspect ntn.link` until `Configured`; then `printf %s https://ntn.link | bunx vercel@latest env rm PUBLIC_ORIGIN production --yes; printf %s https://ntn.link | bunx vercel@latest env add PUBLIC_ORIGIN production` and `bunx vercel@latest deploy --prod --yes`.
  4. Rebuild the extension with `NTN_LINK_ORIGIN=https://ntn.link bun run build:ext`, and re-run Task 5.5 Steps 1-4 with `ORIGIN=https://ntn.link`. Existing links keep working because OG URLs are built from the request-time `PUBLIC_ORIGIN`; records contain no origin (confirm against `contract.md`).
  5. Keep `ntn-link.vercel.app` alive as a redirect-free mirror; links shared before the switch still resolve.
- [ ] **Step 3: Commit** `docs(deploy): add rollback runbook and owner domain-switch steps`.

---

# Slice 6: Integration and verification wave (orchestrator)

### Task 6.1: Merge order and conflict policy

Merge from the main checkout, one branch at a time, running the gate after each merge: `bun install --frozen-lockfile && bun run lint && bun run typecheck && bun test`.

Order: `plan` (docs only) -> `fast` -> `cli` -> `webui` -> `ext` -> `deploy`. Rationale: `fast` and `cli` share nothing; `webui` and `fast` both touch `apps/web/package.json`; `ext` consumes the API shapes only; `deploy` last because it depends on the merged build.

- [ ] **Step 1: For each branch:** `git merge --no-ff <branch> -m "merge: <slice name>"`.
- [ ] **Step 2: Conflict policy:** file ownership is disjoint, so a conflict can only occur in shared files: `bun.lock` -> `git checkout --ours bun.lock && bun install` (regenerate, never hand-merge) and `git add bun.lock`; `package.json` files -> keep both sides' added lines (scripts/deps are additive); anything else -> stop, the owning slice agent resolves in its worktree by rebasing onto `main`, rerunning its tests, and re-merging. Never resolve by deleting a side.
- [ ] **Step 3: Gate after each merge.** Expected: exit 0 each time. A red gate after a merge means revert that merge (`git reset --hard HEAD~1` is forbidden by the git-workflow skill; use `git revert -m 1 HEAD`) and return the branch to its owner.

### Task 6.2: Final checks

- [ ] **Step 1:** `bun install --frozen-lockfile && bun run lint && bun run typecheck && bun test && bun run build && bun run build:ext && bun run --cwd packages/cli build`. Expected: all exit 0.
- [ ] **Step 2:** `bun run --cwd apps/web test:e2e`. Expected: all pass.
- [ ] **Step 3:** `LIVE=1 bun test packages/core/test/render/live.test.ts && bun run smoke:notion && bun run smoke:page-chunk`. Expected: pass (these are the alarm for Notion changes, spec 8 contract).
- [ ] **Step 4:** Re-run Task 5.5 Steps 1-6 against `$ORIGIN` for the merged `main` deployment. Expected: all as recorded.
- [ ] **Step 5:** Spec coverage walk: for each numbered success criterion in spec section 1 (1-6) write one line in `CHANGELOG.md` under "Verified" naming the check that proved it; criteria with only partial evidence (Telegram card rendering in a real client, Instant View approval, positive title-challenge on a real workspace, extension in Firefox runtime) are listed under "Not verified" with the reason.

### Task 6.3: README, CHANGELOG, release notes

**Files:**
- Create: `README.md`, `CHANGELOG.md`

- [ ] **Step 1:** `README.md`: what it is (one paragraph), the URL model, the three interfaces with a usage line each (web `/`, `npx ntn-link <url>`, extension load instructions from `extension/README.md`), the ownership explanation (public `nonce` + private `claimToken`), the env var table from `contract.md` (`PUBLIC_ORIGIN`, `ADMIN_TOKEN`, store vars), dev commands (`bun install`, `bun run dev`, `bun test`, `bun run perf:fast`, `bun run build:ext`), links to `docs/deploy/*` and the spec. No marketing language. Include a "Privacy" section (also copied into `extension/README.md`): our server never receives a Notion page id unless the user explicitly created a link (web, CLI, toolbar button or shortcut, options page) or the extension proved the page public itself by a direct request to Notion; automatic Copy-link interception is off by default, enabled per workspace on the options page, never applies to workspace-less `notion.so/<id>` URLs, and on any failure leaves the clipboard text untouched with no request to ntn-link; no analytics, no IP storage beyond rate-limit counters.
- [ ] **Step 2:** `CHANGELOG.md`: `## 0.1.0 - 2026-11-10` listing Foundation, fast variant, web UI, CLI, extension, deployment, plus the Verified / Not verified sections from Task 6.2.
- [ ] **Step 3:** `bun run lint` (prettier covers markdown). Expected exit 0.
- [ ] **Step 4: Commit** `docs: add README and 0.1.0 changelog`.
- [ ] **Step 5: Owner-only items list in the final report** (each with its exact command or action): buy `ntn.link` (Task 5.6), `npm publish` for the CLI (needs npm login; `cd packages/cli && npm publish`), Chrome Web Store / AMO submission of the two zips, Telegram Instant View submission, and the Upstash terms command if Task 5.1 took that branch.

---

## Self-review notes (resolved choices where the spec is silent)

- Fast route is a route handler, not a React page, so no Next runtime script can appear in the HTML. The only `<script>` allowed is the non-executable JSON-LD block; spec 8's "no `<script>`" is read as "no executable script" and this is stated in Task 1.4.
- Image resizing uses `sharp` in a Node function (Vercel supports it); allowed widths 640 and 1280 only, so the cache cannot be fragmented by arbitrary `w`.
- Slice 5 measures on the public production alias rather than a protected preview URL; stated in Task 5.4.
- The extension relays through the service worker rather than calling the API from the page, which avoids both Notion's CSP `connect-src` and any server CORS change; no Foundation file is touched.
- CLI verification requires an interactive terminal because the `claimToken` is intentionally never persisted (spec section 4).
- Live testing the real `thsm` namespace uses an operator-seeded key (Task 5.3) because the positive title challenge needs the owner's Notion account.
