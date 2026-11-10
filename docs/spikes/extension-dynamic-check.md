# Extension: dynamic verification (2026-11-10)

Scripts: `extension/test/e2e/chrome.e2e.ts`, `extension/test/e2e/firefox.e2e.ts`.
Browsers: Playwright Chromium 153 (new headless mode, unpacked extension, temporary profile),
Firefox 159.0.1 (headless, WebDriver BiDi, temporary add-on). Branded Chrome 156
(`~/.local/bin/google-chrome`) ignores `--load-extension` even with
`--disable-features=DisableLoadExtensionCommandLineSwitch`, so it was not used.

## Verdict on the clipboard hook

(a) holds: replacing `Clipboard.prototype.write` and `writeText` from a MAIN-world content
script at `document_start` works in Chromium and in Firefox (no `exportFunction` needed:
a Firefox `world: "MAIN"` script runs in the page's own world and the patched method was
observed in the page). `overwriteAfter` (branch c) was not needed and is not implemented.

## What could not be tested, and why

- **Notion's own Copy link button and the lazy share-modal button.** Notion fronts its pages
  with a Cloudflare managed challenge for automated browsers: the document is HTTP 429
  "Just a moment..." with `cf-mitigated: challenge` and a Permissions-Policy that blocks the
  clipboard, and with a headed Chrome the `/_assets/*.js` bundles came back as `text/html`
  ("Resource Sentinel noted a failed resource load"). The app never boots, so no
  "More actions" or "Copy link" control exists to click. No attempt was made to defeat the
  challenge. "Copy link" was exercised through the page's real `navigator.clipboard.writeText`
  with a Notion URL, which is the call the static spike found Notion making.
- **Toolbar click and keyboard shortcut** cannot be driven by Playwright or BiDi. Covered by
  unit tests of `handleCopy`/`resolveLink`; Chrome's offscreen clipboard path was exercised
  with the same calls (scenario f).
- **Firefox**: the enabled paths, the options page, clipboard contents and the toolbar. BiDi
  cannot open `moz-extension://` pages to seed an owner key, and Firefox cannot read the
  clipboard without a user gesture.

## Observations (Chromium, hermetic run: fake ntn-link origin and a fake HTTPS Notion)

`thsm.notion.site` was mapped to a local HTTPS server (`--host-resolver-rules`, self-signed
certificate) so the run does not depend on Cloudflare; it answers like the real service
(block record for the public page id, `{role:"none"}` otherwise). Every scenario below passed.

| Scenario | Clipboard | Requests to ntn-link | Requests to Notion from the extension |
| --- | --- | --- | --- |
| interceptor installed | `Clipboard.prototype.writeText.toString()` is not `[native code]` | | |
| (a) default OFF, key stored | original URL | 0 | 0 |
| (b) workspace on + key + public page | `<origin>/thsm/our-trips` | `GET /api/ns/thsm/links`, `POST /api/links`, both with `Authorization` | 1 POST, no `Cookie` header, sent before the first ntn-link request |
| (c) workspace on + key, private page id | original URL | 0 | 1 POST |
| (c2) workspace on + key, `www.notion.so/<id>` | original URL | 0 | 0 |
| (c3) workspace on, no key, public page | original URL | 0 | not asserted |
| (f) Chrome offscreen `execCommand("copy")` | copied text read back | n/a | n/a |

- **Activation window (Chrome, no clipboard permission granted).** `writeText` called from a
  click handler succeeded 0 ms, 1500 ms and 4000 ms after the click and failed with
  `NotAllowedError` at 6500 ms: transient activation of about 5 s. With the clipboard
  permission granted (scenarios a-c) no gesture is needed at all. The automatic path's whole
  budget is therefore 3 s (service worker 2.7 s), well inside the window.
- **Latency budget (fake ntn-link delays every call; a first copy makes two calls, list then
  create).** 200 ms per call: pretty link after 408 ms. 1000 ms per call: pretty link after
  2007 ms. 1800 ms and 3500 ms per call: fell back to the original text at 2702 ms.
- **CSP and CORS.** In the one run where Notion's real document was served, its
  `connect-src` listed `'self'`, Notion and vendor hosts only, none of ours, and a
  page-context `fetch` to the ntn-link origin failed ("Failed to fetch"). The relay path
  (page `postMessage`, isolated content script, service worker) is not subject to either.
- **`chrome.storage.local` seeding through the service worker** is used by the e2e script only.
- **`clipboardWrite` on Chrome is needed:** before adding it, scenario (f) returned `false`
  (offscreen `execCommand("copy")`); after adding it, the text reached the clipboard.
- **Bug found by the browser run and fixed**: a bare `fetch` stored in a dependency object
  throws "Illegal invocation" when called as `deps.fetch(...)` in a service worker, which made
  every proof fail closed. Unit tests with fake fetches cannot see this.

## Observations about the real Notion service (static probes from this machine)

- `GET https://thsm.notion.site/<id>` with a browser User-Agent: HTTP 200, 22.7 KB app shell,
  `og:title` "Notion | Where teams and agents work together", **for the public page and for
  an all-zero id alike**. With a Slackbot User-Agent: real title for the public page, HTTP 404
  for the zero id. A service worker's `fetch` with a `User-Agent` header went out with the
  browser's own User-Agent. So an extension cannot prove publicness from the page HTML.
- `POST https://thsm.notion.site/api/v3/syncRecordValuesMain` (no cookies): public page id
  returned the block record (2.5 KB); zero id returned `{"value":{"role":"none"}}`. From a
  service worker the call returned HTTP 200 with the record once. Later the same calls (curl,
  and a service worker in an automated Chromium) got HTTP 429 `cf-mitigated: challenge` from
  Cloudflare; that is the last observation in the run (`realNotionRecordApi` in the script's
  output). When it happens the proof fails closed and Notion's text is kept.

## Firefox

- `web-ext lint --source-dir extension/dist/firefox`: 0 errors, 2 warnings
  (`data_collection_permissions` needs `strict_min_version` 140, older versions ignore the key).
- BiDi: the add-on installs, the page's `Clipboard.prototype.writeText` is patched, and a copy
  with nothing enabled sends 0 requests to the ntn-link origin (the page's own call rejected
  with `NotAllowedError`, the original method's rejection passed through unchanged).

## Later behaviour changes (after review rounds; unit-tested, e2e re-run)

- Public proof, explicit lookups and creation are keyed by the page identity the API's
  preview resolves for non-`notion.site` URLs; `notion.site` URLs are trusted as is (known
  follow-up: redirect resolution for those).
- The automatic path's 3 s deadline covers clipboard-item decoding; the page's remaining
  budget travels in the relay message and the worker uses the smaller of it and its own.
  A late replacement never writes after a newer wrapped write or a native `copy`/`cut`.
- Creation for one resolved page runs one at a time; link lists that are not a well-formed
  array fail instead of reading as empty.
- Known server dependency: retries after a timeout can create `slug-2` until the backend
  returns the existing link for a (workspace, page) without an explicit slug.
