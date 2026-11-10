/** Builds the real bundle and checks what would be published: a self-contained Node file. */
import { beforeAll, expect, test } from 'bun:test';
import { builtinModules } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const bundle = join(root, 'dist', 'ntn-link.js');

beforeAll(async () => {
  const build = Bun.spawn(['bun', 'run', 'scripts/build.ts'], {
    cwd: root,
    stdout: 'ignore',
    stderr: 'inherit',
  });
  expect(await build.exited).toBe(0);
}, 60_000);

async function node(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['node', bundle, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

test('bundle starts with a single node shebang', () => {
  const text = readFileSync(bundle, 'utf8');
  expect(text.startsWith('#!/usr/bin/env node\n')).toBe(true);
  expect(text.indexOf('#!', 2)).toBe(-1);
});

test('bundle imports only node built-ins', () => {
  const text = readFileSync(bundle, 'utf8');
  const specifiers = [...text.matchAll(/(?:from\s+|require\(|import\()\s*["']([^"']+)["']/g)].map(
    (m) => m[1] ?? '',
  );
  expect(specifiers.length).toBeGreaterThan(0);
  const builtins = new Set(builtinModules);
  for (const spec of specifiers) {
    expect(builtins.has(spec.replace(/^node:/, ''))).toBe(true);
  }
});

test('node dist/ntn-link.js --version prints the package version only', async () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
  expect(await node('--version')).toEqual({ code: 0, out: `${pkg.version}\n`, err: '' });
});

test('no arguments: usage on stderr, empty stdout, exit 2', async () => {
  const result = await node();
  expect(result.code).toBe(2);
  expect(result.out).toBe('');
  expect(result.err).toContain('Usage:');
});

test('npm pack lists exactly the intended files', async () => {
  const proc = Bun.spawn(['npm', 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const parsed = JSON.parse(await new Response(proc.stdout).text()) as Array<{
    files: Array<{ path: string }>;
  }>;
  const files = (parsed[0]?.files ?? []).map((f) => f.path).toSorted();
  expect(files).toEqual(['LICENSE', 'README.md', 'dist/ntn-link.js', 'package.json']);
});

test('package.json has no runtime dependencies and the right publish fields', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  expect(pkg['dependencies']).toBeUndefined();
  expect(pkg['bin']).toEqual({ 'ntn-link': 'dist/ntn-link.js' });
  expect(pkg['engines']).toEqual({ node: '>=20' });
  expect(pkg['publishConfig']).toEqual({ access: 'public' });
});
