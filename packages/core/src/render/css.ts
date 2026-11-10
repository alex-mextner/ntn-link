/**
 * Critical CSS for the fast page, inlined into the document (no extra request, which is
 * what lets the whole first response fit the first round trip, spec section 5.3).
 * System font stack, no web fonts, no `url()` and no `@import`, so the page can never
 * trigger a request this CSS did not name. Dark first (the ntn.link look: ink background, violet glow, violet-to-sky accent), with a
 * light theme behind `prefers-color-scheme`. Hard cap: 3 KB (asserted in test/render/page.test.ts).
 */
export const CRITICAL_CSS = [
  ':root{color-scheme:dark light;--bg:#0a0a12;--fg:#ececf3;--mut:#a3a3b8;--ln:#2a2a3a;--ac:#a99bff;--sf:#15151f;--gl:rgba(124,92,255,.22)}',
  '@media(prefers-color-scheme:light){:root{--bg:#fafafd;--fg:#1a1a26;--mut:#54546c;--ln:#dddde8;--ac:#4338ca;--sf:#f0f0f8;--gl:rgba(124,92,255,.12)}}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:radial-gradient(40rem 22rem at 15% -8%,var(--gl),transparent 65%),var(--bg);color:var(--fg);font:1.0625rem/1.7 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Helvetica Neue",Arial,sans-serif;overflow-wrap:break-word;-webkit-font-smoothing:antialiased}',
  'article{max-width:43rem;margin:0 auto;padding:2rem 1.25rem 4rem}',
  'h1{font-size:clamp(1.9rem,6vw,2.6rem);line-height:1.1;letter-spacing:-.035em;margin:.5rem 0 .4rem}',
  'h2,h3,h4{line-height:1.25;letter-spacing:-.02em;margin:2em 0 .5em}',
  'h2{font-size:1.6rem}h3{font-size:1.3rem}h4{font-size:1.0625rem}',
  'p{margin:.7em 0}',
  'a{color:var(--ac);text-underline-offset:.2em}',
  'header time{color:var(--mut);font-size:.875rem}',
  'ul,ol{padding-left:1.5em;margin:.7em 0}',
  'ul.todo{list-style:none;padding-left:.25em}ul.todo input{margin-right:.5em}',
  'blockquote{margin:1.2em 0;padding:.1em 1.1em;border-left:3px solid var(--ac);color:var(--mut)}',
  '.callout{display:flex;gap:.75rem;margin:1.2em 0;padding:1rem 1.1rem;background:var(--sf);border:1px solid var(--ln);border-radius:14px}',
  '.callout p{margin:0}.ico{font-size:1.25rem}',
  'pre{overflow-x:auto;padding:1rem 1.1rem;background:var(--sf);border:1px solid var(--ln);border-radius:14px;font-size:.9rem;line-height:1.55}',
  'code{font:.88em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--sf);padding:.12em .35em;border-radius:6px}',
  'pre code{padding:0;background:none}',
  'mark{background:#fff3a3;color:#1a1a26}',
  'hr{border:0;border-top:1px solid var(--ln);margin:2.2em 0}',
  'figure{margin:1.4em 0}img{display:block;max-width:100%;height:auto;border-radius:12px}',
  'figcaption{color:var(--mut);font-size:.875rem;margin-top:.45rem}',
  'details{margin:.7em 0}summary{cursor:pointer}summary>*{display:inline}',
  '.tw{overflow-x:auto;margin:1.2em 0}table{border-collapse:collapse;min-width:100%}',
  'th,td{border:1px solid var(--ln);padding:.45rem .7rem;text-align:left;vertical-align:top}th{background:var(--sf)}',
  '.cols{display:flex;gap:1.5rem}.cols>div{min-width:0}',
  '@media(max-width:600px){.cols{flex-direction:column;gap:0}.cols>div{flex:none!important}}',
  '.bookmark small{display:block;color:var(--mut)}',
  '.unsupported,.sub{margin:.7em 0}.unsupported a::before{content:"\\2197\\00a0"}',
  'footer{margin-top:3.5rem;padding-top:1.25rem;border-top:1px solid var(--ln);font-size:.9rem}',
  'a.orig{display:inline-block;padding:.5rem 1rem;border:1px solid var(--ln);border-radius:999px;background:var(--sf);font-weight:600;text-decoration:none}',
  'a.orig:hover{border-color:var(--ac)}a:focus-visible{outline:2px solid var(--ac);outline-offset:2px}',
].join('');
