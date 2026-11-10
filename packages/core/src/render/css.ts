/**
 * Critical CSS for the fast page, inlined into the document (no extra request, which is
 * what lets the whole first response fit the first round trip, spec section 5.3).
 * System font stack, no web fonts, no `url()` and no `@import`, so the page can never
 * trigger a request this CSS did not name. Dark mode follows `prefers-color-scheme`.
 */
export const CRITICAL_CSS = [
  ':root{color-scheme:light dark;--bg:#fff;--fg:#1f1f1f;--mut:#6b6b6b;--ln:#e3e3e3;--ac:#0b63c4;--sf:#f5f5f4}',
  '@media(prefers-color-scheme:dark){:root{--bg:#191919;--fg:#ebebeb;--mut:#a0a0a0;--ln:#363636;--ac:#6cb0ff;--sf:#242424}}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:var(--bg);color:var(--fg);font:1.0625rem/1.65 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Helvetica Neue",Arial,sans-serif;overflow-wrap:break-word}',
  'article{max-width:42rem;margin:0 auto;padding:1.5rem 1rem 3rem}',
  'h1{font-size:2rem;line-height:1.2;margin:.5rem 0 .25rem}',
  'h2,h3,h4{line-height:1.3;margin:1.8em 0 .5em}',
  'h2{font-size:1.5rem}h3{font-size:1.25rem}h4{font-size:1.0625rem}',
  'p{margin:.6em 0}',
  'a{color:var(--ac);text-underline-offset:.15em}',
  'header time{color:var(--mut);font-size:.875rem}',
  'ul,ol{padding-left:1.5em;margin:.6em 0}',
  'ul.todo{list-style:none;padding-left:.25em}ul.todo input{margin-right:.5em}',
  'blockquote{margin:1em 0;padding:.1em 1em;border-left:3px solid var(--fg)}',
  '.callout{display:flex;gap:.75rem;margin:1em 0;padding:1rem;background:var(--sf);border-radius:.5rem}',
  '.callout p{margin:0}.ico{font-size:1.25rem}',
  'pre{overflow-x:auto;padding:1rem;background:var(--sf);border-radius:.5rem;font-size:.9rem;line-height:1.5}',
  'code{font:.9em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--sf);padding:.1em .3em;border-radius:.25rem}',
  'pre code{padding:0;background:none}',
  'mark{background:#fff3a3;color:#1f1f1f}',
  'hr{border:0;border-top:1px solid var(--ln);margin:2em 0}',
  'figure{margin:1.2em 0}img{display:block;max-width:100%;height:auto;border-radius:.375rem}',
  'figcaption{color:var(--mut);font-size:.875rem;margin-top:.4rem}',
  'details{margin:.6em 0}summary{cursor:pointer}summary>*{display:inline}',
  '.tw{overflow-x:auto;margin:1em 0}table{border-collapse:collapse;min-width:100%}',
  'th,td{border:1px solid var(--ln);padding:.4rem .6rem;text-align:left;vertical-align:top}th{background:var(--sf)}',
  '.cols{display:flex;gap:1.5rem}.cols>div{min-width:0}',
  '@media(max-width:600px){.cols{flex-direction:column;gap:0}.cols>div{flex:none!important}}',
  '.bookmark small{display:block;color:var(--mut)}',
  '.unsupported,.sub{margin:.6em 0}.unsupported a::before{content:"\\2197\\00a0"}',
  'footer{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--ln);font-size:.875rem}',
].join('');
