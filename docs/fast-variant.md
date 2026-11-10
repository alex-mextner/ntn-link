# Fast variant: `GET /<workspace>/<slug>/read`

A link that serves its own lightweight copy of a public Notion page: static, semantic,
zero-JavaScript HTML with inline CSS. Design: `docs/superpowers/specs/2026-11-10-ntn-link-design.md`
section 5.3. This file records how it is built, what was measured, and the Telegram Instant
View template draft.

## How a request is served

1. `app/[workspace]/[slug]/read/route.ts` looks the link up (`service.getLink`). Missing link,
   or `fast` switched off: 404. A link whose Notion page stopped being public: 410 with the
   same "no longer public" page as the redirect link, no redirect.
2. `buildFastPage` (`packages/core/src/render/fast-page.ts`) loads the page's blocks, learns the
   size of images that do not record one, renders, and returns the document.
3. The response is `Cache-Control: public, max-age=0, s-maxage=60, stale-while-revalidate=86400,
   stale-if-error=86400` with the link's `vercel-cache-tag`. Updates and deletes purge it through the
   service's `purge` callback (`revalidatePath` + tag purge in `apps/web/lib/service.ts`).
   A transient Notion failure throws (502) instead of rendering an error page, so the edge keeps
   serving the last good copy.

This is edge caching with explicit headers (the same mechanism as the redirect link), not Next
ISR: one purge path covers both link forms.

## Loading Notion data (unofficial API)

`packages/core/src/render/page-chunk.ts`, all traffic through `safeFetch` (SSRF allowlist):

- `POST https://<ws>.notion.site/api/v3/loadPageChunk` with the shape from the spec; the returned
  `cursor` is echoed back with `chunkNumber + 1` until its `stack` is empty (at most 40 chunks).
  Probed on the Oman sub-page of `thsm`: 3 chunks, 129 blocks.
- Children that are referenced but not delivered (nested inside toggles, callouts, columns) are
  fetched with `POST /api/v3/syncRecordValuesMain` (works without cookies, probed 2026-11-10; the
  older `syncRecordValues` is behind a Cloudflare challenge and is not used). Records Notion will
  not give out are typeless; they never arrive, so the loop stops when a round adds nothing.
- 404/401/403 mean "not public" (`NotionDataError.notPublic`); everything else is transient.

## Rendering contract

Block mapping: `text` to `<p>`; `header`, `sub_header`, `sub_sub_header` to `h2`, `h3`, `h4` (the
page title is the single `h1`; a heading with children becomes `<details>`); bulleted and numbered
lists grouped into `ul`/`ol` with nesting; `to_do` to a disabled checkbox list; `quote`;
`callout` (`aside`); `code`; `divider`; `image` (`figure`); `toggle` (`details`); `bookmark`;
`table` (header row/column honoured); `column_list` (flex ratios); `page` as a link to the
sub-page on Notion. Everything else (`collection_view`, `embed`, `video`, unknown future types, a
missing child, a cycle, nesting deeper than 8) becomes a visible
`<p class="unsupported"><a>Open in Notion: ...</a></p>`. Nothing is silently dropped.

Safety: all text is escaped; links only `http`, `https`, `mailto`; text colours are not carried
over (only background highlights become `<mark>`); the only `<script>` is the JSON-LD data block;
the CSS has no `url()` or `@import`.

Images: the page never contains a Notion URL. It points to
`/img/content/<ws>/<slug>/<blockId>?v=<edit time>&w=<640|1280>`, which
(`app/img/content/[workspace]/[slug]/[blockId]/route.ts`)

- serves only image blocks that are on the link's own page (not any block of the workspace),
- resolves a fresh signed URL per request (`/image/<attachment>?table=block&id=<block>&width=<w>`
  on the workspace host, redirects re-checked against the image host allowlist),
- forwards a fixed `Accept` (AVIF/WebP/PNG+JPEG variants) so Notion's own resizer answers in a
  modern format, and answers `Vary: Accept`,
- refuses anything that is not a raster image (an SVG from our origin could run script),
- is cached `s-maxage=30 days, immutable`; `v` makes an edited image a new URL.

Resizing is done by Notion's image endpoint (`width=`), not by `sharp`: it removes a native
dependency and the second decode/encode. Hosts outside the spec allowlist (for example imgur) are
not proxied and render as a link.

Image dimensions: `format.block_width/height` when present; otherwise read from the header of a
640 px rendition at render time (PNG, JPEG, WebP, GIF; at most 12 probes per render, in
parallel); otherwise 16:9. The first image has `fetchpriority="high"`, later ones
`loading="lazy" decoding="async"`.

Page chrome (the structure the Instant View template below depends on):
`<article><header><h1>title</h1><time datetime></header> ...blocks... <footer><a class="orig">
Open the original in Notion</a></footer></article>`, plus canonical (self by default), description,
Open Graph and Twitter tags identical in kind to the redirect card, `article:modified_time`, and a
schema.org `Article` JSON-LD block (`<`, `>`, `&`, U+2028/9 escaped).

## Notion look

The page is styled to match Notion's own public page, measured from rendered pages: the 720 px
column (704 px of text), 40 px title with the page icon (78 px emoji, 124 px picture) over an
optional 200 px cover, 30/24/20 px headings, 24 px lines, Notion's block spacing, callouts
(10 px radius, icon column), quotes, toggles (`<details>`, toggle headings), bulleted, numbered
(decimal, letters, roman by depth) and to-do lists, code blocks and inline code, tables, columns
(46 px gap, stacked under 600 px), bookmark cards, page links with their icon, a table of
contents, image captions and alignment. Text colours and highlights, block colours and the
callout background use Notion's nine colours in its light palette, and its dark palette under
`prefers-color-scheme: dark`. Per-page options are honoured: full width, small text, serif/mono.
Covers and uploaded icons go through the same image proxy as image blocks
(`/img/content/<ws>/<slug>/<pageId>?k=cover|icon`, only for the link's own root page). The CSS
budget is 10 KB (it was 3 KB for the plain layout), asserted in `test/render/page.test.ts`.

Not rendered like Notion (they stay "Open in Notion" links or plain text): syntax highlighting in
code blocks, equations, embeds and video, files and PDFs, synced blocks, inline databases
(`collection_view`), external object mentions, bookmark thumbnails, the top bar.

## Measured (2026-11-10, local production build, no CDN, real Notion)

Page `thsm` (`/thsm/our-trips/read`), the owner's test page, 18 blocks:

| | ours | Notion public page (baseline) |
|---|---|---|
| HTML, uncompressed | 6,684 B | 22.7 KB |
| HTML on the wire (gzip) | 2,586 B (brotli 2,029 B) | about 7,060 B |
| First-party JS/CSS | 0 B (CSS is 6.9 KB raw, 2.1 KB brotli, inline; measured before the Notion restyle: 2.9 KB) | 1,322,907 B brotli |
| Requests | 1 (+ favicon from the browser) | many |
| TTFB, uncached render (3 runs) | 0.24 to 0.28 s | 0.39 to 0.43 s (curl, this host) |

Lighthouse 13 mobile, headless Chrome, simulated throttling (`lh-our-trips.json`): performance
**100**, FCP 0.8 s, LCP 0.8 s, CLS 0, TBT 11 ms, 3.4 KB transferred. The server-response audit says
250 ms: that is this local server fetching Notion on every request, since there is no CDN here.
On Vercel the page is served from the edge cache and the Notion fetch happens in the background.

Page `thsm/oman`, a long page with 10 images (`lh-oman.json`): performance **97**, LCP 1.8 s,
CLS 0, TBT 0 ms; the server-response audit is 1.87 s because the cold render makes 3 chunk calls
plus 10 image-size probes; HTML 44 KB uncompressed, 13.4 KB gzip; only the first image loads
eagerly (417 KB total with it, 13.7 KB without images).

INP: no JavaScript runs, so TBT and INP are trivially in range.

## Known limits

- Pages beyond 5,000 blocks, or 40 chunks, end with a visible "this page continues" link to Notion.
- Soft line breaks inside a paragraph become `<br>`.
- A cold render of an image-heavy page takes seconds (above). The edge cache hides it after the
  first visitor; the next visitor within a day gets the stale copy while one request refreshes.
  Not done: caching sniffed image sizes in the store.
- The data API is unofficial; `packages/core/test/render/live.test.ts` (run with `LIVE=1`) fails
  loudly if its shape changes.
- `collection_view` databases are links, not rendered.
- No image test page with an `image` block exists in the owner's pages except the Oman sub-page,
  whose recorded chunks (trimmed to the fields the loader reads, signed URLs and
  attribution stripped) are the fixture `render/oman-chunks.json`.

## Telegram Instant View template (DRAFT, NOT SUBMITTED)

Status: **unsubmitted and unverified.** It was written from the structure above and the template
language as documented at instantview.telegram.org; it has not been pasted into the editor, run
against a live URL, or reviewed by Telegram. Submitting needs a Telegram login in the
instantview.telegram.org editor, which is a human step. Until then Telegram shows the normal
Open Graph preview and the page itself is fast; nothing depends on the template.

```
~version: "2.1"

# Matches https://ntn.link/<workspace>/<slug>/read (and the preview origins while testing).
?path: /[a-z0-9-]+/[a-z0-9-]+/read

site_name: "ntn.link"

body:      //article
title:     $body//header/h1
published_date: $body//header/time/@datetime

# Our own page chrome is not article content.
@remove: $body//header
@remove: $body//footer
@remove: $body//script

# Telegram articles have two heading levels in the body: h3 and h4.
@replace_tag(<h3>): $body//h2
@replace_tag(<h4>): $body//h3
@replace_tag(<h4>): $body//h4

# "Open in Notion" blocks keep working as ordinary links.
# Task lists: drop the disabled checkbox, keep the text.
@remove: $body//input[@type="checkbox"]

# Images come from our own proxy, same origin as the page.
@set_attr(src, ./@src): $body//img

# Cover: the Open Graph card image.
image_url: //meta[@property="og:image"]/@content
```

Checks to do in the editor once the account step is available: the `?path` regex flavour, that
`<details>` and `<aside class="callout">` survive (otherwise `@replace_tag(<aside>)` or
`@replace_tag(<blockquote>)`), and the preview for `thsm/our-trips` and `thsm/oman`.
