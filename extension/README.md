# ntn-link browser extension

Manifest V3 extension for Chrome (116+) and Firefox (128+). It copies the short
`ntn-link` link of the Notion page you are looking at, and can optionally replace
Notion's own "Copy link".

## Use

- Toolbar button or `Ctrl+Shift+L` (`MacCtrl+Shift+L` on macOS): **Copy pretty link**
  (`<origin>/<workspace>/<slug>`). `Ctrl+Shift+F`: **Copy fast link** (`.../read`).
  The badge shows `OK` (green) or `!` (red) for 3 seconds. With no owner key for the
  page's workspace the options page opens.
- Options page: owner keys per workspace (claim a workspace with the challenge flow, or
  paste a key the CLI created), and the per-workspace checkbox
  **Replace Notion's Copy link** (off by default).

## Build

```sh
bun run build:extension                              # from the repo root
NTN_LINK_ORIGIN=https://example.com bun run build:extension
```

Writes `extension/dist/chrome/`, `extension/dist/firefox/` and
`ntn-link-chrome-<version>.zip` / `ntn-link-firefox-<version>.zip`. The origin
(default `https://ntn-link.vercel.app`) is baked into the scripts and into the manifest
host permission from the same variable. Load `dist/chrome` as an unpacked extension, or
`dist/firefox/manifest.json` as a temporary add-on.

Permissions: `storage`; `offscreen` and `clipboardWrite` on Chrome (the offscreen
document is the only place Chrome lets an extension copy, and its `execCommand("copy")`
returns `false` without `clipboardWrite`: verified); `clipboardWrite` on Firefox. Host
permissions: `*.notion.site`, `www.notion.so`, `www.notion.com`, `app.notion.com` and the
ntn-link origin. No remote code, no `eval`, no analytics.

## Privacy

What is implemented (every point has a unit test in `test/`, and the numbered ones were
re-checked in a real Chromium, see `docs/spikes/extension-dynamic-check.md`):

1. **Nothing is sent anywhere until you act.** The toolbar button and the two shortcuts
   are explicit actions: they send the URL of the current tab (query string removed) and
   your owner key to the ntn-link origin to create or look up the link. The `Authorization`
   header carries the key; it is never put in a URL or body, and requests are made without
   cookies.
2. **Automatic interception is off by default.** It exists only per workspace, after you
   tick the checkbox on the options page. Adding a workspace or saving a key does not
   switch it on.
3. **Even when on, a copy reaches ntn-link only if every gate passes, in this order, and
   the first failure leaves Notion's original clipboard text untouched with zero requests
   to ntn-link:**
   1. the copied text is a single Notion page URL that names a workspace (workspace-less
      `www.notion.so/<id>` URLs are never intercepted and trigger no request at all);
   2. that workspace is switched on;
   3. an owner key for it is stored;
   4. the extension proves the page public itself: a direct POST from the service worker to
      `https://<workspace>.notion.site/api/v3/syncRecordValuesMain` with credentials omitted.
      A public page returns its block record, anything else returns `{role: "none"}`, an
      error, or a challenge page, which all count as "not public". The result is cached per
      workspace and page: 1 hour when public, 5 minutes when not; a timeout or network
      failure is not cached. The cache lives in `storage.session`, so it is gone when the
      browser closes;
   5. only then ntn-link is asked, with the query-free canonical URL, within the remaining
      part of one 3 second deadline for the whole chain.
4. **The page wrapper never throws or rejects for its own reasons.** Any error, timeout or
   odd answer writes the original payload. Only a lone `text/plain` item or a plain string
   is considered; multi-format items pass through. The replacement must be an `http(s)` URL.
5. The page (including Notion's own scripts) can send the relay the same messages the
   interceptor does, so nothing in the page is trusted: every gate runs in the service
   worker.

Why the proof is not a page fetch: Notion answers a browser-like client (the only kind an
extension can be; Chrome ignores a `User-Agent` override on `fetch`) with its app shell and
HTTP 200 for **any** page id, so status or `og:title` prove nothing. This was observed
live. The record endpoint above is undocumented; if Notion changes it, the proof fails
closed (the original text is kept) and the feature stops working until the extension is
updated.

What is not covered: with the checkbox on, ntn-link learns the page id of a page the
extension proved public, when you copy its link; creating the link is the point. If
Notion's Cloudflare answers the proof request with a challenge or HTTP 429 (seen in
automated browsers), the copy falls back to Notion's own text.

## Architecture

| File                                                                                       | Role                                                                                   |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `src/intercept-main.ts`, `intercept-entry.ts`                                              | MAIN-world script (`document_start`): replaces `Clipboard.prototype.write`/`writeText` |
| `src/relay.ts`, `relay-entry.ts`                                                           | isolated-world relay: page `postMessage` to service worker                             |
| `src/intercept-policy.ts`                                                                  | privacy gates and public proof                                                         |
| `src/link-service.ts`, `api.ts`                                                            | API client (list, create, patch), explicit-action path                                 |
| `src/keys.ts`                                                                              | `chrome.storage` stores: keys, opt-in, caches                                          |
| `src/background.ts`, `background-main.ts`, `background-chrome.ts`, `background-firefox.ts` | commands, toolbar, message handler; per-browser clipboard                              |
| `src/options.ts`, `options-logic.ts`, `static/options.html`                                | options page and claim flow (the claim token stays in page memory)                     |
| `scripts/build.ts`                                                                         | per-browser manifests, bundles, zips                                                   |

The page-to-extension hop is `window.postMessage` to the isolated relay to the service
worker, so Notion's CSP (`connect-src` lists only Notion and vendor hosts) and CORS never
apply to our requests.

## Tests

```sh
bun test extension          # unit and manifest tests (no browser)
cd extension
bun run test/e2e/chrome.e2e.ts     # Playwright Chromium, hermetic; needs openssl
bun run test/e2e/firefox.e2e.ts    # Firefox over WebDriver BiDi; needs Firefox >= 128
bunx web-ext lint --source-dir dist/firefox
```
