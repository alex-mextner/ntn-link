/**
 * Builds the Chrome and Firefox packages into extension/dist and zips them.
 *
 *   NTN_LINK_ORIGIN=https://example.com bun run build:extension
 *
 * The origin is baked into the bundles and into the manifest host permission from the same
 * variable, so the two cannot disagree. No source maps, no remote code.
 */
import { mkdir, readdir, readFile, rm, cp } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { zipSync } from 'fflate';

const root = resolve(import.meta.dir, '..');
const dist = join(root, 'dist');
export const DEFAULT_ORIGIN = 'https://ntn-link.vercel.app';

export const NOTION_MATCHES = [
  'https://*.notion.site/*',
  'https://www.notion.so/*',
  'https://www.notion.com/*',
  'https://app.notion.com/*',
] as const;

type Browser = 'chrome' | 'firefox';

interface Entry {
  source: string;
  out: string;
  format: 'iife' | 'esm';
  browsers: readonly Browser[];
}

/** Single source of truth for the scripts; the manifest below only names their outputs. */
const ENTRIES: readonly Entry[] = [
  { source: 'src/background-chrome.ts', out: 'background.js', format: 'esm', browsers: ['chrome'] },
  {
    source: 'src/background-firefox.ts',
    out: 'background.js',
    format: 'esm',
    browsers: ['firefox'],
  },
  {
    source: 'src/relay-entry.ts',
    out: 'relay.js',
    format: 'iife',
    browsers: ['chrome', 'firefox'],
  },
  {
    source: 'src/intercept-entry.ts',
    out: 'intercept.js',
    format: 'iife',
    browsers: ['chrome', 'firefox'],
  },
  { source: 'src/options.ts', out: 'options.js', format: 'iife', browsers: ['chrome', 'firefox'] },
  { source: 'src/offscreen.ts', out: 'offscreen.js', format: 'iife', browsers: ['chrome'] },
];

const STATIC_FILES: ReadonlyArray<{ file: string; browsers: readonly Browser[] }> = [
  { file: 'options.html', browsers: ['chrome', 'firefox'] },
  { file: 'offscreen.html', browsers: ['chrome'] },
];

/** `http://127.0.0.1:8787` -> `http://127.0.0.1/*`: match patterns carry no port. */
export function hostPermissionFor(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

export interface BaseManifest {
  [key: string]: unknown;
}

export function buildManifest(
  base: BaseManifest,
  browser: Browser,
  version: string,
  origin: string,
): BaseManifest {
  const common = {
    ...base,
    version,
    host_permissions: [...NOTION_MATCHES, hostPermissionFor(origin)],
    content_scripts: [
      { matches: [...NOTION_MATCHES], js: ['relay.js'], run_at: 'document_start' },
      {
        matches: [...NOTION_MATCHES],
        js: ['intercept.js'],
        run_at: 'document_start',
        world: 'MAIN',
      },
    ],
  };
  if (browser === 'chrome') {
    return {
      ...common,
      minimum_chrome_version: '116',
      // clipboardWrite: without it execCommand('copy') in the offscreen document returns false
      // (verified in Chromium, test/e2e/chrome.e2e.ts scenario f).
      permissions: ['storage', 'offscreen', 'clipboardWrite'],
      background: { service_worker: 'background.js', type: 'module' },
    };
  }
  return {
    ...common,
    // clipboardWrite: Firefox has no offscreen documents, so its background page writes the
    // clipboard itself.
    permissions: ['storage', 'clipboardWrite'],
    background: { scripts: ['background.js'], type: 'module' },
    browser_specific_settings: {
      // `world: "MAIN"` content scripts need Firefox 128.
      gecko: {
        id: 'ntn-link@ntn-link.vercel.app',
        strict_min_version: '128.0',
        // The URL of a page is sent to ntn-link only when the user presses the button or
        // shortcut (or switched automatic copying on for that workspace).
        data_collection_permissions: { required: ['browsingActivity'] },
      },
    },
  };
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(join(entry.parentPath, entry.name));
  }
  return out.toSorted();
}

async function buildBrowser(browser: Browser, version: string, origin: string): Promise<string> {
  const outdir = join(dist, browser);
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  for (const entry of ENTRIES.filter((e) => e.browsers.includes(browser))) {
    const result = await Bun.build({
      entrypoints: [join(root, entry.source)],
      outdir,
      naming: entry.out,
      target: 'browser',
      format: entry.format,
      define: {
        'process.env.NTN_LINK_ORIGIN': JSON.stringify(origin),
      },
      sourcemap: 'none',
      minify: false,
    });
    if (!result.success)
      throw new Error(`build failed: ${entry.source}\n${result.logs.join('\n')}`);
  }
  for (const item of STATIC_FILES.filter((s) => s.browsers.includes(browser))) {
    await cp(join(root, 'static', item.file), join(outdir, item.file));
  }
  await cp(join(root, 'static/icons'), join(outdir, 'icons'), { recursive: true });
  const base: BaseManifest = JSON.parse(await readFile(join(root, 'manifest.base.json'), 'utf8'));
  await Bun.write(
    join(outdir, 'manifest.json'),
    `${JSON.stringify(buildManifest(base, browser, version, origin), null, 2)}\n`,
  );
  return outdir;
}

async function zipDir(dir: string, zipPath: string): Promise<void> {
  const files: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const file of await listFiles(dir)) {
    // A fixed mtime keeps the zip byte-identical across rebuilds of the same sources.
    files[relative(dir, file)] = [
      new Uint8Array(await readFile(file)),
      { mtime: new Date('2026-01-01') },
    ];
  }
  await Bun.write(zipPath, zipSync(files));
}

if (import.meta.main) {
  const pkg: { version: string } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const origin = (process.env.NTN_LINK_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/+$/, '');
  for (const browser of ['chrome', 'firefox'] as const) {
    const dir = await buildBrowser(browser, pkg.version, origin);
    await zipDir(dir, join(dist, `ntn-link-${browser}-${pkg.version}.zip`));
  }
  console.log(`built extension ${pkg.version} for origin ${origin} into ${dist}`);
}
