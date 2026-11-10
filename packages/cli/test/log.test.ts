import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRunLog, redact } from '../src/log';

let dir = '';
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'ntn-link-log-test-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('log file is unique per run, named by time and pid, mode 0600', () => {
  const now = new Date('2026-11-10T12:34:56.789Z');
  const a = openRunLog(now, 7, dir);
  const b = openRunLog(now, 7, dir);
  expect(a.path).toBe(join(dir, 'ntn-link-20261110T123456-7.log'));
  expect(b.path).not.toBe(a.path);
  expect(statSync(a.path).mode & 0o777).toBe(0o600);
  a.close();
  b.close();
});

test('secret fields, bearer tokens and registered secrets never reach the file', () => {
  const log = openRunLog(new Date(), 1, dir);
  log.secret('registered-secret-value');
  log.write('{"ownerKey":"abc123xyz","claimToken":"tok456","url":"u"}');
  log.write('Authorization: Bearer sekrit.value');
  log.write('oops registered-secret-value leaked');
  log.close();
  const text = readFileSync(log.path, 'utf8');
  for (const bad of ['abc123xyz', 'tok456', 'sekrit.value', 'registered-secret-value']) {
    expect(text).not.toContain(bad);
  }
  expect(text).toContain('"url":"u"');
});

test('redact keeps harmless text', () => {
  expect(redact('POST /api/links 201')).toBe('POST /api/links 201');
});

test('a secret cut in half by the line limit is still redacted (redact before truncating)', () => {
  const log = openRunLog(new Date(), 2, dir);
  const head = '< 200 {"claimToken":"' + 'T'.repeat(43);
  // Pad so the 2000-character limit lands right after the token's last character.
  log.write(`${'p'.repeat(2000 - head.length)}${head}","pad":"${'x'.repeat(50)}"}`);
  log.close();
  expect(readFileSync(log.path, 'utf8')).not.toContain('TTTTTTTT');
});
