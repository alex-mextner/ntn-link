import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openKeyStore } from '../src/keys';

const O = 'https://svc.test';
let dir = '';
let cfg = '';
let path = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ntn-link-keys-test-'));
  cfg = join(dir, 'cfg', 'ntn-link');
  path = join(cfg, 'keys.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('set/get roundtrip with 0600 file and 0700 directory', () => {
  const store = openKeyStore(path);
  expect(store.get(O, 'thsm')).toBeNull();
  store.set(O, 'thsm', 'k1');
  expect(openKeyStore(path).get(O, 'thsm')).toBe('k1');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(cfg).mode & 0o777).toBe(0o700);
});

test('different workspaces coexist and leave no temp files behind', () => {
  const store = openKeyStore(path);
  store.set(O, 'a', 'ka');
  store.set(O, 'b', 'kb');
  store.set(O, 'a', 'ka2');
  expect(store.get(O, 'a')).toBe('ka2');
  expect(store.get(O, 'b')).toBe('kb');
  expect(readdirSync(cfg)).toEqual(['keys.json']); // no temp file, no stale lock
});

test('a world-readable file is tightened and a warning is recorded without the key', () => {
  openKeyStore(path).set(O, 'thsm', 'super-secret-key');
  chmodSync(path, 0o644);
  const reopened = openKeyStore(path);
  expect(reopened.get(O, 'thsm')).toBe('super-secret-key');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(reopened.warnings.length).toBe(1);
  expect(reopened.warnings.join('')).not.toContain('super-secret-key');
});

test('a corrupt file is moved aside, not lost, and the store keeps working', () => {
  mkdirSync(cfg, { recursive: true });
  writeFileSync(path, '{oops', { mode: 0o600 });
  const store = openKeyStore(path);
  expect(store.get(O, 'thsm')).toBeNull();
  const aside = readdirSync(cfg).filter((f) => f.startsWith('keys.json.corrupt-'));
  expect(aside.length).toBe(1);
  expect(readFileSync(join(cfg, aside[0] ?? ''), 'utf8')).toBe('{oops');
  store.set(O, 'thsm', 'k');
  expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveProperty(
    ['https://svc.test', 'thsm', 'key'],
    'k',
  );
  expect(store.warnings.length).toBe(1);
});

test('valid JSON of the wrong shape counts as corrupt', () => {
  mkdirSync(cfg, { recursive: true });
  writeFileSync(path, '["x"]', { mode: 0o600 });
  expect(openKeyStore(path).get(O, 'x')).toBeNull();
});

test('keys are kept per origin: the same workspace on another service is a different entry', () => {
  const store = openKeyStore(path);
  store.set('https://one.test', 'thsm', 'k-one');
  store.set('https://two.test', 'thsm', 'k-two');
  expect(store.get('https://one.test', 'thsm')).toBe('k-one');
  expect(store.get('https://two.test', 'thsm')).toBe('k-two');
  expect(store.get('https://three.test', 'thsm')).toBeNull();
});

test('concurrent processes saving different workspaces do not lose each other', async () => {
  const writer = join(import.meta.dir, 'key-writer.ts');
  const workspaces = Array.from({ length: 8 }, (_, i) => `ws${i}`);
  const procs = workspaces.map((ws) =>
    Bun.spawn(['bun', writer, path, O, ws, `key-${ws}`], { stdout: 'ignore', stderr: 'inherit' }),
  );
  expect(await Promise.all(procs.map((proc) => proc.exited))).toEqual(workspaces.map(() => 0));
  const store = openKeyStore(path);
  for (const ws of workspaces) expect(store.get(O, ws)).toBe(`key-${ws}`);
  expect(readdirSync(cfg).toSorted()).toEqual(['keys.json']);
});

test('a lock held by another run fails after the bounded wait and names what to delete', () => {
  mkdirSync(join(cfg, 'keys.lock'), { recursive: true });
  const started = Date.now();
  expect(() => openKeyStore(path, 200).set(O, 'a', 'k')).toThrow(/delete .*keys\.lock/);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(existsSync(join(cfg, 'keys.lock'))).toBe(true); // never reclaimed behind the holder's back
});

test('a pre-existing group/world-writable key directory is locked down before use', () => {
  mkdirSync(cfg, { recursive: true });
  chmodSync(cfg, 0o777);
  openKeyStore(path).set(O, 'thsm', 'k');
  expect(statSync(cfg).mode & 0o777).toBe(0o700);
});

test('a symlink where the key directory should be is refused, and nothing is written through it', () => {
  const target = join(dir, 'elsewhere');
  mkdirSync(target);
  mkdirSync(join(dir, 'cfg'), { recursive: true });
  symlinkSync(target, cfg);
  expect(() => openKeyStore(path).set(O, 'thsm', 'secret-key')).toThrow(/not a plain directory/);
  expect(readdirSync(target)).toEqual([]);
});

test('planted links at guessable temp names cannot capture the key file', () => {
  const loot = join(dir, 'loot');
  mkdirSync(cfg, { recursive: true });
  for (let i = 0; i < 3; i++)
    symlinkSync(loot, join(cfg, `keys.json.tmp-${process.pid}-${Date.now() + i}`));
  openKeyStore(path).set(O, 'thsm', 'secret-key');
  expect(existsSync(loot)).toBe(false);
  expect(openKeyStore(path).get(O, 'thsm')).toBe('secret-key');
});

test('reading never follows a planted link: no chmod of its target, no key read through it', () => {
  const victim = join(dir, 'victim');
  mkdirSync(victim, { mode: 0o755 });
  chmodSync(victim, 0o755);
  mkdirSync(cfg, { recursive: true });
  symlinkSync(victim, path);
  const store = openKeyStore(path);
  expect(store.get(O, 'thsm')).toBeNull();
  expect(statSync(victim).mode & 0o777).toBe(0o755);
  expect(store.warnings.join(' ')).toContain('cannot read key file');
});
