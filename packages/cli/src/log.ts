/**
 * Per-run log under /tmp (owner's script-logging policy). Every line passes through
 * redact(), and secrets known at runtime are registered so they can never be written
 * even if some code path forgets to leave them out.
 */
import { closeSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const MAX_LINE = 2000;
const SECRET_FIELD = /("(?:ownerKey|claimToken|key|authorization)"\s*:\s*)"[^"]*"/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const PREFIXED = /\bntn_[A-Za-z0-9_-]+/g;

export function redact(line: string): string {
  return line
    .replace(SECRET_FIELD, '$1"[redacted]"')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(PREFIXED, '[redacted]');
}

export interface RunLog {
  path: string;
  /** Redacts first and truncates after, so a secret cut in half by the limit cannot survive redaction. */
  write(line: string): void;
  /** Registers a value that must never appear in the log, whatever the call site. */
  secret(value: string): void;
  close(): void;
}

function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace(/[-:]/g, '');
}

export function openRunLog(now: Date, pid: number, tmp: string): RunLog {
  const base = `ntn-link-${stamp(now)}-${pid}`;
  let fd = -1;
  let path = '';
  // 'wx' refuses to follow or reuse an existing file, so a pre-planted symlink in /tmp cannot redirect the log.
  for (let n = 0; fd === -1; n++) {
    path = join(tmp, n === 0 ? `${base}.log` : `${base}-${n}.log`);
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST') || n > 50)
        throw error;
    }
  }
  const secrets = new Set<string>();
  let open = true;
  return {
    path,
    write(line) {
      if (!open) return;
      let clean = redact(line);
      for (const secret of secrets) clean = clean.split(secret).join('[redacted]');
      if (clean.length > MAX_LINE) clean = `${clean.slice(0, MAX_LINE)}...[truncated]`;
      try {
        writeSync(fd, `${new Date().toISOString()} ${clean}\n`);
      } catch {
        // A full /tmp must not turn a successful link creation into a failure.
        open = false;
      }
    },
    secret(value) {
      if (value.length >= 8) secrets.add(value);
    },
    close() {
      if (!open) return;
      open = false;
      closeSync(fd);
    },
  };
}
