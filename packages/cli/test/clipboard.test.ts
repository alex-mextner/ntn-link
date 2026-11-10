import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyToClipboard } from '../src/clipboard';

let dir = '';
let savedPath: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ntn-link-clip-test-'));
  savedPath = process.env['PATH'];
  process.env['PATH'] = dir; // only the fake tools exist
});
afterEach(() => {
  process.env['PATH'] = savedPath;
  rmSync(dir, { recursive: true, force: true });
});

function fakeTool(name: string, script: string): void {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
}

test('feeds the link to the first working tool on stdin', async () => {
  fakeTool('wl-copy', `/bin/cat > ${dir}/copied`);
  expect(await copyToClipboard('https://x/y')).toBe(true);
  expect(readFileSync(join(dir, 'copied'), 'utf8')).toBe('https://x/y');
});

test('falls through a failing tool to the next one', async () => {
  fakeTool('wl-copy', 'exit 1');
  fakeTool('xclip', `/bin/cat > ${dir}/copied`);
  expect(await copyToClipboard('t')).toBe(true);
  expect(readFileSync(join(dir, 'copied'), 'utf8')).toBe('t');
});

test('no clipboard tool installed: reports false instead of throwing', async () => {
  expect(await copyToClipboard('t')).toBe(false);
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function exited(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (!pidAlive(pid)) return true;
    await Bun.sleep(25);
  }
  return false;
}

test('a helper that ignores SIGTERM and never exits is stopped after the timeout', async () => {
  fakeTool('wl-copy', `trap '' TERM\necho $$ > ${dir}/pid\nexec /bin/sleep 30`);
  expect(await copyToClipboard('t', 300)).toBe(false);
  expect(await exited(Number(readFileSync(join(dir, 'pid'), 'utf8')))).toBe(true);
});

test('a helper that closes stdin but keeps running is stopped too', async () => {
  fakeTool('wl-copy', `echo $$ > ${dir}/pid\nexec 0<&-\nexec /bin/sleep 30`);
  expect(await copyToClipboard('t'.repeat(200_000), 300)).toBe(false);
  expect(await exited(Number(readFileSync(join(dir, 'pid'), 'utf8')))).toBe(true);
});
