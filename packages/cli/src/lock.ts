/**
 * Advisory file locks with safe reclamation after a crash.
 *
 * A lock is a file created with O_EXCL that holds `{pid, host, ts, start, token}`. A lock is
 * reclaimed only when its holder is provably gone: a holder that is merely slow (suspended, or
 * paused mid-update) keeps its exclusion, because taking over from a live writer would let its
 * stale snapshot overwrite the newer one.
 *
 * - Same host: stale when the pid no longer exists, or when it exists with a different process
 *   start time than the one recorded (pid reuse; /proc only, elsewhere a reused pid looks alive).
 * - Another host or unreadable content (a half-written file, or the empty directory the previous
 *   version made): nothing can be probed, so only age (`staleAfterMs`, generous) decides.
 * - Reclaiming and releasing both run under a `<lock>.reclaim` guard, itself a lock file with a
 *   holder record. The lock path can therefore only disappear while the guard is held, so a
 *   reclaimer that judged a lock stale removes exactly that lock: its holder cannot release in
 *   between and let a successor in. A stale guard is taken over by renaming it away and checking
 *   that what was moved is the file that was judged (a fresh guard that replaced it is put back).
 * - Acquisition verifies that the file at the path still carries our token after the record is
 *   written, so a creator that was suspended inside the empty-file window (and got reclaimed
 *   as unreadable) never enters.
 * - Release removes the file only while it still carries our token.
 * - Lock files are read with O_NONBLOCK and only when they are regular files, so a planted
 *   FIFO cannot stall the bounded wait.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

export interface LockOptions {
  /** A lock that cannot be probed (foreign host, unreadable) is reclaimed once older than this. */
  staleAfterMs: number;
  /** Test seams: run another actor inside a race window. */
  hooks?: LockHooks;
}

export interface LockHooks {
  /** Between creating the lock file and writing its holder record. */
  afterOpen?: () => void;
  /** Between judging a guard stale and taking it over. */
  beforeGuardTakeover?: () => void;
}

export interface Holder {
  pid: number;
  host: string;
  ts: number;
  /** Process start time as the OS reports it (Linux /proc), null where that is unavailable. */
  start: string | null;
  token: string;
}

/** Thrown when the wait for a lock ran out; the message names what to delete. */
export class LockTimeout extends Error {}

const GUARD_STALE_MS = 30_000;
const SYNC_POLL_MS = 25;
const GUARD_POLL_MS = 5;
const RELEASE_WAIT_MS = 5000;
export const ASYNC_POLL_MS = 200;

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isHolder(value: unknown): value is Holder {
  if (typeof value !== 'object' || value === null) return false;
  const holder = value as Partial<Holder>;
  return (
    typeof holder.pid === 'number' &&
    typeof holder.host === 'string' &&
    typeof holder.ts === 'number' &&
    (holder.start === null || typeof holder.start === 'string') &&
    typeof holder.token === 'string'
  );
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return !isCode(error, 'ESRCH');
  }
}

/** Start time of a process (field 22 of /proc/<pid>/stat), which tells a pid's reuse apart. */
function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name (field 2) is in parentheses and may contain spaces: count after the last ")".
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

/** Who holds the lock, or null when there is no lock or its content is unreadable. */
export function readHolder(path: string): Holder | null {
  let fd: number;
  try {
    // Never block on a FIFO or follow a link: only a plain file can be a lock record.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const parsed: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    return isHolder(parsed) ? parsed : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** True when the lock should be reclaimed. A missing lock is not stale (it can simply be acquired). */
function isStale(path: string, options: LockOptions): boolean {
  let modifiedMs: number;
  try {
    modifiedMs = lstatSync(path).mtimeMs;
  } catch (error) {
    if (isCode(error, 'ENOENT')) return false;
    throw error;
  }
  const holder = readHolder(path);
  if (holder === null) return Date.now() - modifiedMs > options.staleAfterMs;
  if (holder.host !== hostname()) return Date.now() - holder.ts > options.staleAfterMs;
  if (!pidExists(holder.pid)) return true;
  const now = processStart(holder.pid);
  return holder.start !== null && now !== null && now !== holder.start;
}

function removeQuietly(path: string): void {
  try {
    if (lstatSync(path).isDirectory()) rmdirSync(path);
    else unlinkSync(path);
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error;
  }
}

/** Identity of whatever is at `path` now: its token when it has a record, else inode and mtime. */
function fingerprint(path: string): string | null {
  try {
    const info = lstatSync(path);
    return readHolder(path)?.token ?? `${info.ino}:${info.mtimeMs}`;
  } catch {
    return null;
  }
}

/** Removes a stale guard without ever removing a fresh one that replaced it meanwhile. */
function takeOverStaleGuard(guard: string, hooks: LockHooks | undefined): void {
  const stale = { staleAfterMs: GUARD_STALE_MS };
  if (!isStale(guard, stale)) return;
  const judged = fingerprint(guard);
  hooks?.beforeGuardTakeover?.();
  const moved = `${guard}.dead-${randomBytes(6).toString('hex')}`;
  try {
    renameSync(guard, moved);
  } catch (error) {
    if (isCode(error, 'ENOENT')) return;
    throw error;
  }
  if (fingerprint(moved) !== judged) {
    // We moved a live guard that someone created after the stale one went away: put it back.
    try {
      linkSync(moved, guard);
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
    }
  }
  removeQuietly(moved);
}

interface Created {
  /** Removes the file if it still carries our token; no guard involved. */
  removeIfOurs(): void;
}

/** Creates the lock file with its record; null when the path is taken or was taken from us meanwhile. */
function create(path: string, hooks: LockHooks | undefined): Created | null {
  const token = randomBytes(8).toString('hex');
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (isCode(error, 'EEXIST')) return null;
    throw error;
  }
  try {
    hooks?.afterOpen?.();
    const holder: Holder = {
      pid: process.pid,
      host: hostname(),
      ts: Date.now(),
      start: processStart(process.pid),
      token,
    };
    writeSync(fd, JSON.stringify(holder));
  } finally {
    closeSync(fd);
  }
  const removeIfOurs = (): void => {
    if (readHolder(path)?.token === token) removeQuietly(path);
  };
  // While the file was still empty it could be reclaimed as unreadable and replaced: then it is not ours.
  return readHolder(path)?.token === token ? { removeIfOurs } : null;
}

/**
 * Runs `action` while holding the guard of `path`, waiting at most `waitMs` for it. Returns false
 * (and does not run) when the guard stayed busy.
 */
function underGuard(
  path: string,
  waitMs: number,
  hooks: LockHooks | undefined,
  action: () => void,
): boolean {
  const guard = `${path}.reclaim`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const held = create(guard, undefined);
    if (held) {
      try {
        action();
      } finally {
        held.removeIfOurs();
      }
      return true;
    }
    // A holder of the guard that died must not block everyone forever.
    takeOverStaleGuard(guard, hooks);
    if (Date.now() >= deadline) return false;
    sleepSync(GUARD_POLL_MS);
  }
}

function reclaimIfStale(path: string, options: LockOptions): void {
  underGuard(path, 0, options.hooks, () => {
    if (isStale(path, options)) removeQuietly(path);
  });
}

export interface LockHandle {
  release(): void;
}

function tryCreate(path: string, hooks: LockHooks | undefined): LockHandle | null {
  const created = create(path, hooks);
  if (!created) return null;
  return {
    release() {
      // If the guard stays busy for too long, release anyway: a lock must never outlive its holder.
      if (!underGuard(path, RELEASE_WAIT_MS, hooks, created.removeIfOurs)) created.removeIfOurs();
    },
  };
}

/** One acquisition attempt; a stale lock is reclaimed and the acquisition retried once. */
function attempt(path: string, options: LockOptions): LockHandle | null {
  const first = tryCreate(path, options.hooks);
  if (first) return first;
  reclaimIfStale(path, options);
  return tryCreate(path, options.hooks);
}

function timeoutMessage(path: string, what: string): string {
  return `${what}; if none is running, delete ${path}`;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Runs `action` under the lock, waiting at most `waitMs` for it. */
export function withLock<T>(
  path: string,
  waitMs: number,
  options: LockOptions,
  action: () => T,
): T {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const handle = attempt(path, options);
    if (handle) {
      try {
        return action();
      } finally {
        handle.release();
      }
    }
    if (Date.now() > deadline) {
      throw new LockTimeout(timeoutMessage(path, 'the key file is locked by another ntn-link run'));
    }
    sleepSync(SYNC_POLL_MS);
  }
}

/** Like withLock for a long, asynchronous critical section; `onWait` fires once when it has to wait. */
export async function withLockAsync<T>(
  path: string,
  waitMs: number,
  options: LockOptions,
  what: string,
  action: () => Promise<T>,
  onWait?: (holder: Holder | null) => void,
): Promise<T> {
  const deadline = Date.now() + waitMs;
  let announced = false;
  for (;;) {
    const handle = attempt(path, options);
    if (handle) {
      try {
        return await action();
      } finally {
        handle.release();
      }
    }
    if (!announced) {
      announced = true;
      onWait?.(readHolder(path));
    }
    if (Date.now() > deadline) throw new LockTimeout(timeoutMessage(path, what));
    // Executor-style Promise on purpose: the bundle must run on Node 20, which lacks Promise.withResolvers.
    await new Promise<void>((resolve) => setTimeout(resolve, ASYNC_POLL_MS));
  }
}
