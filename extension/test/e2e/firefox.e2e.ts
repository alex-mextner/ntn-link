/**
 * Firefox runtime check over WebDriver BiDi (no Playwright/geckodriver needed):
 *
 *   bun run test/e2e/firefox.e2e.ts      (from extension/, needs a Firefox >= 128 binary)
 *
 * Verifies what can be observed without Notion's app: the temporary add-on installs, the
 * MAIN-world interceptor patches the page's real Clipboard prototype, and the default (off)
 * state sends NOTHING to the ntn-link origin. Not covered: seeding an owner key / opting a
 * workspace in (BiDi cannot open moz-extension:// pages) and reading the clipboard (needs a
 * user gesture in Firefox), so the enabled paths are untested in Firefox.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '../..');
const scratch = mkdtempSync('/tmp/ntn-link-ext-e2e-ff-');
const firefox = process.env.NTN_E2E_FIREFOX ?? '/usr/bin/firefox';
const PAGE_ID = '413d447ac4b180169985c93eea7f02f9';

let hits: string[] = [];
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    hits.push(`${req.method} ${new URL(req.url).pathname}`);
    return Response.json({ error: { code: 'not_found', message: 'nope' } }, { status: 404 });
  },
});
const ORIGIN = `http://127.0.0.1:${fake.port}`;
const build = Bun.spawnSync(['bun', 'run', 'scripts/build.ts'], {
  cwd: root,
  env: { ...process.env, NTN_LINK_ORIGIN: ORIGIN },
});
if (build.exitCode !== 0) throw new Error(build.stderr.toString());

const proc = Bun.spawn(
  [
    firefox,
    '--headless',
    '--no-remote',
    '--profile',
    scratch,
    '--remote-debugging-port',
    '9445',
    'about:blank',
  ],
  { stdout: 'ignore', stderr: 'ignore' },
);

let nextId = 1;
async function connect(): Promise<WebSocket> {
  for (let i = 0; i < 60; i++) {
    try {
      const ws = new WebSocket('ws://127.0.0.1:9445/session');
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve(), { once: true });
        ws.addEventListener('error', () => reject(new Error('ws')), { once: true });
      });
      return ws;
    } catch {
      await Bun.sleep(500);
    }
  }
  throw new Error('Firefox BiDi endpoint did not come up');
}
const ws = await connect();
const pending = new Map<
  number,
  (m: { result?: unknown; error?: string; message?: string }) => void
>();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data));
  pending.get(m.id)?.(m);
});
function send<T>(method: string, params: object): Promise<T> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (m) =>
      m.error ? reject(new Error(`${method}: ${m.error} ${m.message}`)) : resolve(m.result as T),
    );
    ws.send(JSON.stringify({ id, method, params }));
  });
}

let failures = 0;
function check(name: string, ok: boolean, detail: unknown): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`);
  if (!ok) failures++;
}
async function evaluate(context: string, expression: string): Promise<string> {
  const res = await send<{
    type: string;
    result?: { value?: unknown };
    exceptionDetails?: { text: string };
  }>('script.evaluate', {
    expression,
    target: { context },
    awaitPromise: true,
    resultOwnership: 'none',
  });
  return res.type === 'success' ? String(res.result?.value) : `EXC ${res.exceptionDetails?.text}`;
}

try {
  await send('session.new', { capabilities: {} });
  const installed = await send<{ extension: string }>('webExtension.install', {
    extensionData: { type: 'path', path: join(root, 'dist/firefox') },
  });
  check('temporary add-on installs in Firefox', typeof installed.extension === 'string', installed);

  const tree = await send<{ contexts: Array<{ context: string }> }>('browsingContext.getTree', {});
  const first = tree.contexts[0]?.context ?? '';

  await send('browsingContext.navigate', {
    context: first,
    url: `https://thsm.notion.site/${PAGE_ID}`,
    wait: 'interactive',
  });
  const patched = await evaluate(
    first,
    "String(!Clipboard.prototype.writeText.toString().includes('[native code]'))",
  );
  check('MAIN-world interceptor patched the real Clipboard prototype', patched === 'true', patched);

  const copy = (url: string): Promise<string> =>
    evaluate(
      first,
      `navigator.clipboard.writeText(${JSON.stringify(url)}).then(() => 'resolved', (e) => 'rejected:' + e.name)`,
    );
  const notionUrl = `https://thsm.notion.site/Our-Trips-${PAGE_ID}?source=copy_link`;

  hits = [];
  const off = await copy(notionUrl);
  await Bun.sleep(500);
  check('default OFF: zero requests to the ntn-link origin', hits.length === 0, {
    hits,
    copyResult: off,
  });

  console.log(
    JSON.stringify({
      firefoxVersion: (await Bun.$`${firefox} --version`.quiet().text()).trim(),
    }),
  );
} finally {
  ws.close();
  proc.kill();
  fake.stop(true);
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
