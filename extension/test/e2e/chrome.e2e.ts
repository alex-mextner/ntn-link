/**
 * Real-browser check of the extension (Chromium with the unpacked build, new headless mode).
 *
 *   bun run test/e2e/chrome.e2e.ts          (from extension/, needs Playwright's Chromium and openssl)
 *
 * Not part of `bun test`: it needs a browser. It builds the extension against a throwaway
 * local "ntn-link" server and counts exactly what reaches it.
 *
 * Notion is replaced by a local HTTPS server too: `--host-resolver-rules` maps
 * thsm.notion.site to it (self-signed certificate, accepted for this run only). That keeps
 * the run hermetic, and it has to: Notion fronts its pages with a Cloudflare managed
 * challenge for automated browsers (HTTP 429 "Just a moment...", a Permissions-Policy that
 * blocks the clipboard), so its real app never boots here and Playwright cannot route
 * service-worker requests. "Copy link" is therefore exercised through the page's real
 * `navigator.clipboard`, which is the call Notion makes. The fake answers with the shapes
 * observed from the real service (`syncRecordValuesMain`: block record for a public page,
 * `{role:"none"}` otherwise); a separate step asks the real service once, informationally.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright-core';

const PUBLIC_ID = '413d447ac4b180169985c93eea7f02f9';
const DASHED_PUBLIC_ID = '413d447a-c4b1-8016-9985-c93eea7f02f9';
const PRETTY_PATH = '/thsm/our-trips';
const FIXTURE_OWNER = 'fixture-owner-0000-0000-0000';
const root = join(import.meta.dir, '../..');
const scratch = mkdtempSync('/tmp/ntn-link-ext-e2e-');
const chromePath =
  process.env.NTN_E2E_CHROMIUM ??
  `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
const report: Record<string, unknown> = {};

// ---- fake ntn-link origin: records every request that reaches it ----
interface Hit {
  method: string;
  path: string;
  hasAuth: boolean;
}
let hits: Hit[] = [];
let apiDelayMs = 0;
let ORIGIN = '';
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const path = new URL(req.url).pathname;
    hits.push({ method: req.method, path, hasAuth: req.headers.has('authorization') });
    await Bun.sleep(apiDelayMs);
    if (req.method === 'GET' && path === '/api/ns/thsm/links') {
      return Response.json({ workspace: 'thsm', links: [] });
    }
    if (req.method === 'POST' && path === '/api/links') {
      const body: { url: string } = await req.json();
      const pageId = /[0-9a-f]{32}$/.exec(body.url)?.[0] ?? '';
      return Response.json(
        {
          link: {
            workspace: 'thsm',
            slug: 'our-trips',
            pageId,
            redirectUrl: `${ORIGIN}${PRETTY_PATH}`,
            fastUrl: `${ORIGIN}${PRETTY_PATH}/read`,
          },
        },
        { status: 201 },
      );
    }
    return Response.json({ error: { code: 'not_found', message: 'nope' } }, { status: 404 });
  },
});
ORIGIN = `http://127.0.0.1:${fake.port}`;
const PRETTY = `${ORIGIN}${PRETTY_PATH}`;

// ---- fake Notion (HTTPS, answers for thsm.notion.site) ----
interface NotionHit {
  method: string;
  path: string;
  hasCookie: boolean;
  body: string;
}
let notionHits: NotionHit[] = [];
const certDir = join(scratch, 'cert');
Bun.spawnSync(['mkdir', '-p', certDir]);
const openssl = Bun.spawnSync([
  'openssl',
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-days',
  '1',
  '-keyout',
  join(certDir, 'key.pem'),
  '-out',
  join(certDir, 'cert.pem'),
  '-subj',
  '/CN=thsm.notion.site',
  '-addext',
  'subjectAltName=DNS:thsm.notion.site',
]);
if (openssl.exitCode !== 0) throw new Error(`openssl failed: ${openssl.stderr.toString()}`);
const fakeNotion = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  tls: {
    key: readFileSync(join(certDir, 'key.pem'), 'utf8'),
    cert: readFileSync(join(certDir, 'cert.pem'), 'utf8'),
  },
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === 'POST' ? await req.text() : '';
    notionHits.push({
      method: req.method,
      path: url.pathname,
      hasCookie: req.headers.has('cookie'),
      body,
    });
    if (req.method === 'POST' && url.pathname === '/api/v3/syncRecordValuesMain') {
      const parsed: { requests: Array<{ pointer: { id: string } }> } = JSON.parse(body);
      const id = parsed.requests[0]?.pointer.id ?? '';
      const block =
        id === DASHED_PUBLIC_ID
          ? { value: { id, type: 'page' }, role: 'reader' }
          : { role: 'none' };
      return Response.json({ recordMap: { block: { [id]: { value: block } } } });
    }
    return new Response('<!doctype html><title>stand-in for a Notion page</title>', {
      headers: { 'content-type': 'text/html' },
    });
  },
});

// ---- build against the fake origin ----
const build = Bun.spawnSync(['bun', 'run', 'scripts/build.ts'], {
  cwd: root,
  env: { ...process.env, NTN_LINK_ORIGIN: ORIGIN },
});
if (build.exitCode !== 0) throw new Error(`build failed: ${build.stderr.toString()}`);
const extDir = join(root, 'dist/chrome');

// ---- helpers ----
// Chromium also runs component-extension workers; ours is the one serving background.js.
const isOurs = (w: Worker): boolean =>
  w.url().startsWith('chrome-extension://') && w.url().endsWith('/background.js');

async function launch(hermetic: boolean): Promise<{ ctx: BrowserContext; sw: Worker }> {
  const args = [
    '--headless=new',
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
  ];
  if (hermetic) {
    args.push(
      `--host-resolver-rules=MAP thsm.notion.site 127.0.0.1:${fakeNotion.port}`,
      '--ignore-certificate-errors',
    );
  }
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(scratch, 'profile-')), {
    executablePath: chromePath,
    // Extensions need the new headless mode; Playwright's default headless shell has none.
    headless: false,
    args,
  });
  const sw =
    ctx.serviceWorkers().find(isOurs) ??
    (await ctx.waitForEvent('serviceworker', { predicate: isOurs }));
  return { ctx, sw };
}

async function resetState(sw: Worker, state: { key: boolean; auto: boolean }): Promise<void> {
  hits = [];
  notionHits = [];
  apiDelayMs = 0;
  await sw.evaluate(
    async ({ key, auto, owner }) => {
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
      const items: Record<string, unknown> = {};
      if (key) items['key:thsm'] = owner;
      if (auto) items['auto:thsm'] = true;
      await chrome.storage.local.set(items);
    },
    { ...state, owner: FIXTURE_OWNER },
  );
}

async function copyAndRead(page: Page, text: string): Promise<string> {
  await page.bringToFront();
  return page.evaluate(async (t) => {
    await navigator.clipboard.writeText(t);
    return navigator.clipboard.readText();
  }, text);
}

const settle = (): Promise<void> => Bun.sleep(300);
let failures = 0;
function check(name: string, ok: boolean, detail: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`);
  if (!ok) failures++;
}

try {
  const { ctx, sw } = await launch(true);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'https://thsm.notion.site',
  });
  const page = await ctx.newPage();
  await page.goto(`https://thsm.notion.site/${PUBLIC_ID}`, { waitUntil: 'domcontentloaded' });
  const patched = await page.evaluate(
    () => !Clipboard.prototype.writeText.toString().includes('[native code]'),
  );
  check('interceptor installed in MAIN world', patched, patched);
  notionHits = [];
  report.pageFetchToOrigin = await page.evaluate(
    (o) =>
      fetch(o).then(
        () => 'allowed',
        (e: Error) => `blocked: ${e.message}`,
      ),
    ORIGIN,
  );

  const original = `https://thsm.notion.site/Our-Trips-${PUBLIC_ID}?source=copy_link`;

  // (a) default OFF: key present but interception never enabled
  await resetState(sw, { key: true, auto: false });
  let text = await copyAndRead(page, original);
  await settle();
  check('(a) default OFF keeps the original text', text === original, text);
  check('(a) zero requests to our origin', hits.length === 0, hits);
  check('(a) zero requests to Notion from the extension', notionHits.length === 0, notionHits);

  // (b) enabled + key + public page
  await resetState(sw, { key: true, auto: true });
  text = await copyAndRead(page, original);
  await settle();
  check('(b) enabled+public+key writes the pretty link', text === PRETTY, text);
  check(
    '(b) our origin was called with the key',
    hits.some((h) => h.path === '/api/links' && h.hasAuth),
    hits,
  );
  check(
    '(b) public proof is one credential-less POST to Notion',
    notionHits.length === 1 && !notionHits[0]?.hasCookie,
    notionHits,
  );
  check('(b) Notion was asked before our origin was', notionHits.length >= 1 && hits.length >= 1, {
    notion: notionHits.length,
    ours: hits.length,
  });

  // (c) private/unknown page id
  await resetState(sw, { key: true, auto: true });
  const privateUrl = `https://thsm.notion.site/${'a'.repeat(32)}?source=copy_link`;
  text = await copyAndRead(page, privateUrl);
  await settle();
  check('(c) private page keeps the original text', text === privateUrl, text);
  check('(c) zero requests to our origin', hits.length === 0, hits);
  check('(c) the extension did check Notion', notionHits.length === 1, notionHits);

  // (c2) workspace-less URL in an enabled workspace
  await resetState(sw, { key: true, auto: true });
  const bare = `https://www.notion.so/${PUBLIC_ID}?source=copy_link`;
  text = await copyAndRead(page, bare);
  await settle();
  check(
    '(c2) workspace-less URL kept; zero requests to Notion and to our origin',
    text === bare && hits.length === 0 && notionHits.length === 0,
    { text, hits, notionHits },
  );

  // (c3) enabled but no owner key
  await resetState(sw, { key: false, auto: true });
  text = await copyAndRead(page, original);
  await settle();
  check(
    '(c3) no owner key keeps the original, zero requests to our origin',
    text === original && hits.length === 0,
    { text, hits },
  );

  // (d) timeout budget with a slow API (proof cached by a warm-up copy)
  const timings: Record<string, string> = {};
  for (const delay of [200, 1000, 1800, 3500]) {
    await resetState(sw, { key: true, auto: true });
    await copyAndRead(page, original); // warms the public-proof cache
    await sw.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('link:')));
    });
    hits = [];
    apiDelayMs = delay;
    const t0 = Date.now();
    const out = await copyAndRead(page, original);
    const label = out === PRETTY ? 'pretty link' : out === original ? 'original (fell back)' : out;
    timings[`api delay ${delay} ms per call`] = `${label} after ${Date.now() - t0} ms`;
  }
  report.delayBudget = timings;

  // (f) Chrome's explicit-action clipboard path: offscreen document + execCommand("copy"),
  // the same calls clipboard-chrome.ts makes (the toolbar click itself cannot be automated).
  await resetState(sw, { key: false, auto: false });
  const answer = await sw.evaluate(async () => {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.CLIPBOARD],
        justification: 'e2e',
      });
    }
    return chrome.runtime.sendMessage({ type: 'ntn-offscreen-copy', text: 'offscreen probe' });
  });
  await page.bringToFront();
  const afterOffscreen = await page
    .evaluate(() => navigator.clipboard.readText())
    .catch(() => 'unreadable');
  check(
    '(f) offscreen execCommand copy reaches the clipboard',
    afterOffscreen === 'offscreen probe',
    { answer, clipboard: afterOffscreen },
  );
  await ctx.close();

  // (e) user-activation window of the async clipboard WITHOUT the clipboard permission
  const { ctx: noPerm } = await launch(true);
  const p2 = await noPerm.newPage();
  await p2.goto(`https://thsm.notion.site/${PUBLIC_ID}`, { waitUntil: 'domcontentloaded' });
  const activation: Record<string, string> = {};
  for (const wait of [0, 1500, 4000, 6500]) {
    await p2.evaluate((w) => {
      document.getElementById('act')?.remove();
      const b = document.createElement('button');
      b.id = 'act';
      b.textContent = 'x';
      b.style.cssText = 'position:fixed;top:0;left:0;width:200px;height:100px;z-index:99999';
      b.addEventListener('click', async () => {
        await new Promise((r) => setTimeout(r, w));
        const w2 = window as unknown as Record<string, string>;
        try {
          await navigator.clipboard.writeText('activation probe');
          w2.actResult = 'written';
        } catch (e) {
          w2.actResult = (e as Error).name;
        }
      });
      document.body.append(b);
    }, wait);
    await p2.mouse.click(50, 50);
    await p2.waitForFunction(
      () => (window as unknown as Record<string, string>).actResult !== undefined,
      null,
      { timeout: 15000 },
    );
    activation[`write ${wait} ms after click`] = await p2.evaluate(() => {
      const w = window as unknown as Record<string, string | undefined>;
      const r = w.actResult;
      delete w.actResult;
      return r ?? 'none';
    });
  }
  report.activationWithoutPermission = activation;
  await noPerm.close();

  // (g) informational: the REAL Notion record API, asked once from a service worker. Not
  // an assertion, because Cloudflare answers some automated clients with a challenge.
  const { ctx: live, sw: liveSw } = await launch(false);
  report.realNotionRecordApi = await liveSw.evaluate(async () => {
    const out: Record<string, string> = {};
    const ids = {
      public: '413d447a-c4b1-8016-9985-c93eea7f02f9',
      unknown: '00000000-0000-0000-0000-000000000000',
    };
    for (const [label, id] of Object.entries(ids)) {
      try {
        const res = await fetch('https://thsm.notion.site/api/v3/syncRecordValuesMain', {
          method: 'POST',
          credentials: 'omit',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requests: [{ pointer: { table: 'block', id }, version: -1 }] }),
        });
        const body = await res.text();
        const record = body.includes(`"id":"${id}"`) && body.includes('"type"');
        out[label] = `HTTP ${res.status}, page record ${record ? 'present' : 'absent'}`;
      } catch (e) {
        out[label] = `error ${(e as Error).message}`;
      }
    }
    return out;
  });
  await live.close();
} finally {
  fake.stop(true);
  fakeNotion.stop(true);
  rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
process.exit(failures === 0 ? 0 : 1);
