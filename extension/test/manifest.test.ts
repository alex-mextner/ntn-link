import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { NOTION_MATCHES, buildManifest, hostPermissionFor } from '../scripts/build';

const root = resolve(import.meta.dir, '..');
const dist = join(root, 'dist');
const ORIGIN = 'https://x.example';
const version: string = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

type Manifest = {
  permissions: string[];
  host_permissions: string[];
  content_scripts: Array<{ js: string[]; world?: string; run_at: string; matches: string[] }>;
  content_security_policy?: unknown;
  background: { service_worker?: string; scripts?: string[] };
  options_ui: { page: string };
  icons: Record<string, string>;
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

beforeAll(async () => {
  // Build against a throwaway origin so the test also proves the origin is a build input.
  const proc = Bun.spawn(['bun', 'run', 'scripts/build.ts'], {
    cwd: root,
    env: { ...process.env, NTN_LINK_ORIGIN: ORIGIN },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  expect(await proc.exited).toBe(0);
}, 60_000);

const manifest = (b: 'chrome' | 'firefox'): Manifest =>
  JSON.parse(readFileSync(join(dist, b, 'manifest.json'), 'utf8'));

describe('manifests', () => {
  test('permissions are minimal and per browser', () => {
    expect(manifest('chrome').permissions).toEqual(['storage', 'offscreen', 'clipboardWrite']);
    expect(manifest('firefox').permissions).toEqual(['storage', 'clipboardWrite']);
  });

  test('host permissions: only Notion and our origin', () => {
    for (const b of ['chrome', 'firefox'] as const) {
      expect(manifest(b).host_permissions).toEqual([...NOTION_MATCHES, `${ORIGIN}/*`]);
    }
  });

  test('origin match pattern carries no port', () => {
    expect(hostPermissionFor('http://127.0.0.1:8787')).toBe('http://127.0.0.1/*');
  });

  test('no relaxed CSP, scripts: relay isolated + interceptor MAIN at document_start', () => {
    for (const b of ['chrome', 'firefox'] as const) {
      const m = manifest(b);
      expect(JSON.stringify(m.content_security_policy ?? '')).not.toMatch(/unsafe-/);
      const [relay, main] = m.content_scripts;
      expect(relay).toMatchObject({ js: ['relay.js'], run_at: 'document_start' });
      expect(relay?.world).toBeUndefined();
      expect(main).toMatchObject({ js: ['intercept.js'], run_at: 'document_start', world: 'MAIN' });
    }
  });

  test('buildManifest is a pure function of its inputs', () => {
    const a = buildManifest({ name: 'x' }, 'chrome', '1.2.3', ORIGIN);
    expect(a).toEqual(buildManifest({ name: 'x' }, 'chrome', '1.2.3', ORIGIN));
    expect(a.version).toBe('1.2.3');
  });
});

describe('built files', () => {
  test.each(['chrome', 'firefox'] as const)('%s: no eval, remote code or foreign fetch', (b) => {
    for (const file of walk(join(dist, b)).filter((f) => /\.(js|html)$/.test(f))) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(/\beval\(/);
      expect(text).not.toMatch(/new Function\(/);
      expect(text).not.toMatch(/<script[^>]+src=["']https?:/);
      expect(text).not.toMatch(/import\(\s*["']https?:/);
      // Every literal fetch target must be our origin or Notion (the proof request).
      for (const m of text.matchAll(/fetch\(\s*[`"']([^`"']+)/g)) {
        expect(m[1]).toMatch(/^(https:\/\/\$\{ws\}\.notion\.site|\$\{)/);
      }
    }
  });

  test.each(['chrome', 'firefox'] as const)('%s: baked origin is the build input', (b) => {
    const bg = readFileSync(join(dist, b, 'background.js'), 'utf8');
    expect(bg).toContain(ORIGIN);
    expect(bg).not.toContain('ntn-link.vercel.app');
  });

  test.each(['chrome', 'firefox'] as const)(
    '%s: zip has manifest at root and every declared file',
    (b) => {
      const zip = unzipSync(
        new Uint8Array(readFileSync(join(dist, `ntn-link-${b}-${version}.zip`))),
      );
      expect(Object.keys(zip)).toContain('manifest.json');
      const m = manifest(b);
      const declared = [
        ...m.content_scripts.flatMap((c) => c.js),
        m.options_ui.page,
        ...Object.values(m.icons),
        ...(m.background.service_worker ? [m.background.service_worker] : []),
        ...(m.background.scripts ?? []),
      ];
      for (const f of declared) expect(Object.keys(zip)).toContain(f);
      expect(Object.keys(zip).some((n) => n.endsWith('.map'))).toBe(false);
      if (b === 'chrome') expect(Object.keys(zip)).toContain('offscreen.html');
    },
  );
});
