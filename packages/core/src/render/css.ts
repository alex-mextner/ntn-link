/**
 * Critical CSS for the fast page, inlined into the document (no extra request, which is
 * what lets the whole first response fit the first round trip, spec section 5.3).
 *
 * The page is meant to look like Notion's own public page, so sizes, spacing and colours are
 * Notion's, measured from a rendered page (720 px column with 8 px block inset, 40/30/24/20 px
 * headings, 24 px line height, 10 px callout radius, its light and dark palettes). System font
 * stack, no web fonts, no `url()` and no `@import`, so the page can never trigger a request this
 * CSS did not name; the light theme is the default and dark follows `prefers-color-scheme`.
 *
 * Budget: 10 KB (asserted in test/render/page.test.ts), up from 3 KB for the plain layout. The
 * Notion look needs the block spacing, the 9 colours in two themes and the list/toggle/callout/
 * code/table/bookmark rules; the repeated names compress about 4:1 (the test also holds the whole
 * first response to 14 KB brotli, the first TCP flight).
 */
const COLOURS: readonly (readonly [
  name: string,
  text: string,
  mark: string,
  light: string,
  dark: string,
])[] = [
  ['gray', '#7d7a75', '#2a1c0012', '#f0efed', '#383836'],
  ['brown', '#9f765a', '#8b2e0016', '#f5ede9', '#45362d'],
  ['orange', '#d27b2d', '#e0650121', '#fbebde', '#53361f'],
  ['yellow', '#cb9434', '#d3a80023', '#f9f3dc', '#504425'],
  ['teal', '#50946e', '#00642d17', '#e8f1ec', '#263d30'],
  ['blue', '#387dc9', '#007cd718', '#e5f2fc', '#233850'],
  ['purple', '#9a6bb4', '#6600b214', '#f3ebf9', '#3c2d47'],
  ['pink', '#c14c8a', '#c5005d16', '#fae9f1', '#4e2b3c'],
  ['red', '#cf5148', '#df160018', '#fce9e7', '#502c29'],
];

const colourRules = (theme: 'light' | 'dark'): string =>
  COLOURS.map(
    ([name, text, mark, light, dark]) =>
      `.${name}{--c:${text};--m:${mark};--b:${theme === 'light' ? light : dark}}`,
  ).join('');

const MONO = 'SFMono-Regular,Menlo,Consolas,"PT Mono","Liberation Mono",Courier,monospace';

export const CRITICAL_CSS = [
  ':root{color-scheme:light dark;--bg:#fff;--fg:#2c2c2b;--mut:#7d7a75;--ln:#e9e9e7;--sf:#f9f8f7;--ic:rgba(55,53,47,.06);--ul:rgba(55,53,47,.4);--ul2:rgba(55,53,47,.16);--s:16px;--f:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI Variable Display","Segoe UI",Helvetica,"Apple Color Emoji",Arial,sans-serif,"Segoe UI Emoji","Segoe UI Symbol"}',
  colourRules('light'),
  `@media(prefers-color-scheme:dark){:root{--bg:#191919;--fg:#f0efed;--mut:#9b9a97;--ln:#2f2f2f;--sf:#202020;--ic:rgba(255,255,255,.08);--ul:rgba(255,255,255,.28);--ul2:rgba(255,255,255,.16)}${colourRules('dark')}}`,
  'body.serif{--f:Lyon-Text,Georgia,YuMincho,"Yu Mincho","Songti SC",serif}',
  `body.mono{--f:iawriter-mono,Nitti,${MONO}}body.sm{--s:14px}`,
  '*{box-sizing:border-box}',
  'body{margin:0;background:var(--bg);color:var(--fg);font:var(--s)/1.5 var(--f);overflow-wrap:break-word;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}',
  // Page column: 704 px of text (Notion's 720 px column with 8 px inset); full width pages keep 96 px margins.
  'article{width:min(704px,100% - 36px);margin:0 auto;padding-bottom:8vh}',
  'body.fw article{width:calc(100% - clamp(36px,15vw,192px));max-width:none}',
  '.cv{height:200px;overflow:hidden}.cv img{width:100%;height:100%;object-fit:cover;border-radius:0}',
  '.pi{display:block;width:78px;height:78px;margin:96px 0 0;font-size:78px;line-height:78px;font-family:"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif}',
  '.pi.im{object-fit:cover;border-radius:4px;width:124px;height:124px}',
  '.pi.up{margin-top:-39px}.pi.im.up{margin-top:-62px}',
  'h1{margin:12px 0 0;padding:3px 0;font-size:40px;line-height:48px;font-weight:700;letter-spacing:normal}',
  'header time{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}',
  'header{margin-bottom:21px}',
  'h2,h3,h4{margin:36px 0 4px;padding:3px 0;font-weight:600;line-height:1.3}',
  'h2{font-size:30px}h3{font-size:24px;margin-top:32px}h4{font-size:20px;margin-top:28px}',
  'h1+*>:first-child,header+h2,header+h3,header+h4{margin-top:0}',
  'p{margin:0;padding:8px 0;font-size:var(--s)}p.e::before{content:"\\200b"}',
  'a{color:inherit;opacity:.7;text-decoration:underline .8px var(--ul);text-underline-offset:2px}',
  'a:focus-visible{outline:2px solid #2383e2;outline-offset:2px;opacity:1}',
  'strong{font-weight:600}',
  '.tx{color:var(--c)}.bg{background:var(--b)}mark{background:var(--m);color:inherit;border-radius:3px}',
  'ul,ol{margin:0;padding:0 0 0 30px}li{padding:3px 0;font-size:var(--s)}li::marker{color:var(--fg)}',
  'li>.in{margin:3px 0 -3px 2px}li>.in>p{padding:3px 0}ol ol{list-style-type:lower-alpha}ol ol ol{list-style-type:lower-roman}',
  'ul.todo{padding-left:0;list-style:none}ul.todo input{appearance:none;position:relative;display:inline-block;width:16px;height:16px;margin:0 8px 0 2px;vertical-align:-3px;border:1.5px solid var(--fg);border-radius:3px;opacity:1}ul.todo input:checked{background:#2383e2;border-color:#2383e2}ul.todo input:checked::after{content:"";position:absolute;left:3.5px;top:.5px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}li.done{color:var(--mut)}li.done::first-line{text-decoration:line-through}',
  'blockquote{margin:4px 0;padding:3px 14px;border-left:3px solid currentColor}blockquote p{padding:0 8px}',
  `code{font:85% ${MONO};padding:.2em .4em;border-radius:4px;background:var(--ic);color:#cf5148}`,
  `pre{margin:8px 0;padding:34px 22px 32px;overflow-x:auto;background:var(--sf);border-radius:4px;font:85%/1.5 ${MONO};tab-size:2;position:relative}`,
  'pre code{padding:0;background:none;color:inherit;font:inherit;border-radius:0}',
  '.cb{margin:8px 0}.cb pre{margin:0}.cb figcaption{padding-top:6px}',
  'hr{border:0;border-top:1px solid var(--ln);margin:6px 0}',
  '.callout{display:flex;margin:8px 0;padding:12px;border-radius:10px;background:var(--sf)}.callout.bg{background:var(--b)}.callout>div{flex:1;min-width:0}',
  '.callout .ico{flex:none;width:24px;height:24px;margin:8px 9px 0 0;font-size:20px;line-height:24px;text-align:center}',
  'figure{margin:8px 0;text-align:center}figure.l{text-align:left}figure.r{text-align:right}img{max-width:100%;height:auto}',
  'figcaption{padding:6px 0 0;font-size:14px;line-height:1.4;color:var(--mut);text-align:left}',
  'details{padding:0}summary{padding:3px 0;cursor:pointer;list-style:none;font-size:var(--s)}summary::-webkit-details-marker{display:none}',
  'summary::before{content:"\\25B6";display:inline-block;width:24px;text-align:center;font-size:10px;vertical-align:middle;color:var(--fg)}details[open]>summary::before{transform:rotate(90deg)}',
  'details.th:has(>summary>h2){margin-top:36px}details.th:has(>summary>h3){margin-top:32px}details.th:has(>summary>h4){margin-top:28px}',
  'summary>*{display:inline;margin:0;padding:0}details>:not(summary){margin-left:24px}details.th>summary>*{vertical-align:baseline}',
  '.tw{overflow-x:auto;margin:8px 0}table{border-collapse:collapse;min-width:100%;font-size:14px}',
  'th,td{border:1px solid var(--ln);padding:7px 9px;text-align:left;vertical-align:top;line-height:1.5}th{background:var(--sf);font-weight:600}',
  '.cols{display:flex;gap:46px;margin:13px 0 4px}.cols>div{min-width:0}.cols>div>:is(h2,h3,h4):first-child{margin-top:0}',
  '@media(max-width:600px){.cols{flex-direction:column;gap:0}.cols>div{flex:none!important}h1{font-size:28px;line-height:1.2}.pi{margin-top:48px}}',
  '.bm{margin:8px 0;padding:0}.bm a{display:block;padding:12px 14px;border:1px solid var(--ln);border-radius:4px;text-decoration:none;opacity:1}.bm a:hover{background:var(--sf)}',
  '.bm span{display:block;overflow:hidden}.bm .t{font-size:14px;line-height:20px;white-space:nowrap;text-overflow:ellipsis}.bm .d{max-height:32px;margin-top:2px;font-size:12px;line-height:16px;color:var(--mut)}',
  '.bm .u{margin-top:6px;font-size:12px;line-height:16px;white-space:nowrap;text-overflow:ellipsis}',
  '.pg{margin:1px 0;padding:0}.pg a{display:flex;align-items:center;padding:3px 2px;opacity:1;text-decoration:none}.pg a>.t{text-decoration:underline .8px var(--ul2);text-underline-offset:3px}.pg .ico{flex:none;width:22px;margin-right:4px;font-size:18px;line-height:24px;text-align:center}',
  '.toc{margin:4px 0}.toc a{display:block;padding:3px 2px;color:var(--mut);opacity:1;font-size:14px;text-decoration:underline .8px var(--ul2)}.toc .l2{padding-left:24px}.toc .l3{padding-left:48px}',
  '.unsupported{padding:3px 0;color:var(--mut)}.unsupported a::before{content:"\\2197\\00a0"}',
  'footer{margin-top:56px;padding-top:12px;border-top:1px solid var(--ln);font-size:14px;color:var(--mut)}',
].join('');
