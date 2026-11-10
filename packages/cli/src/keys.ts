/**
 * Owner keys per service origin and workspace in $XDG_CONFIG_HOME/ntn-link/keys.json:
 * `{"<origin>": {"<ws>": {"key": "...", "savedAt": "ISO"}}}`.
 *
 * - Keyed by origin so pointing --origin at another server can never send it a key that
 *   was issued by (and only means something to) the production service.
 * - Dir 0700, file 0600, atomic replace, and a directory lock around every mutation (save and
 *   corruption quarantine) so concurrent runs cannot drop or move each other's key.
 * - The lock is never reclaimed automatically: guessing that a holder died cannot be made safe
 *   without OS-level locks, and the critical section is a few synchronous file operations. If a
 *   run is killed inside it, saving fails after a bounded wait and names the directory to delete.
 * - A damaged file is moved aside rather than overwritten: it may hold the only copy of a key
 *   the user can recover by hand.
 */
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

export interface KeyStore {
  get(origin: string, ws: string): string | null;
  /**
   * Saves a key. With `ifCurrentIs`, only when the stored key still equals it (null = none), so a
   * slow run cannot overwrite a newer key another run saved meanwhile. Returns whether it saved.
   */
  set(origin: string, ws: string, key: string, ifCurrentIs?: string | null): boolean;
  warnings: string[];
}

interface Entry {
  key: string;
  savedAt: string;
}

type Entries = Record<string, Record<string, Entry>>;

const CORRUPT = Symbol('corrupt');
const LOCK_WAIT_MS = 5000;

function isEntry(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && typeof (value as Entry).key === 'string';
}

function isEntries(value: unknown): value is Entries {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (perOrigin) =>
      typeof perOrigin === 'object' &&
      perOrigin !== null &&
      !Array.isArray(perOrigin) &&
      Object.values(perOrigin).every(isEntry),
  );
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** mkdir is atomic, so its success means "I hold the lock". The wait is always bounded. */
function withLock<T>(lockDir: string, waitMs: number, action: () => T): T {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      break;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      if (Date.now() > deadline) {
        throw new Error(
          `the key file is locked by another ntn-link run; if none is running, delete ${lockDir}`,
          { cause: error },
        );
      }
      sleepSync(25);
    }
  }
  try {
    return action();
  } finally {
    rmdirSync(lockDir);
  }
}

/** The key directory must be a real directory owned by the current user (never a link or someone else's). */
function assertOwnDir(dir: string): number {
  const info = lstatSync(dir);
  if (!info.isDirectory())
    throw new Error(`${dir} is not a plain directory; refusing to use it for keys`);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error(`${dir} is owned by another user; refusing to use it for keys`);
  }
  return info.mode;
}

/**
 * The directory may already exist (for example XDG_CONFIG_HOME=/tmp with a pre-created
 * ntn-link): it is validated and forced to 0700 before any file goes in.
 */
function securePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((assertOwnDir(dir) & 0o077) !== 0) chmodSync(dir, 0o700);
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export function openKeyStore(path: string, lockWaitMs = LOCK_WAIT_MS): KeyStore {
  const warnings: string[] = [];
  const dir = dirname(path);
  const lockDir = join(dir, 'keys.lock');

  /**
   * Reads without side effects other than tightening the file's own permissions. The file is opened
   * with O_NOFOLLOW and inspected through the descriptor, so a planted link can neither be read nor
   * have its target chmod'ed.
   */
  function read(): Entries | typeof CORRUPT {
    try {
      assertOwnDir(dir);
    } catch (error) {
      if (isCode(error, 'ENOENT')) return {};
      throw error;
    }
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isCode(error, 'ENOENT')) return {};
      throw error;
    }
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) throw new Error(`${path} is not a regular file`);
      if ((info.mode & 0o077) !== 0) {
        fchmodSync(fd, 0o600);
        warnings.push(`${path} was readable by other users; permissions fixed to 0600`);
      }
      const parsed: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      if (isEntries(parsed)) return parsed;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    } finally {
      closeSync(fd);
    }
    return CORRUPT;
  }

  /** Must run under the lock, and re-reads first: another run may have repaired the file meanwhile. */
  function recover(): Entries {
    const current = read();
    if (current !== CORRUPT) return current;
    const aside = `${path}.corrupt-${Date.now()}`;
    renameSync(path, aside);
    warnings.push(`${path} was not valid; moved to ${aside}`);
    return {};
  }

  return {
    warnings,
    get(origin, ws) {
      try {
        const first = read();
        const entries = first === CORRUPT ? withLock(lockDir, lockWaitMs, recover) : first;
        return entries[origin]?.[ws]?.key ?? null;
      } catch (error) {
        warnings.push(
          `cannot read key file: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    },
    set(origin, ws, key, ifCurrentIs) {
      securePrivateDir(dir);
      return withLock(lockDir, lockWaitMs, () => {
        const entries = recover();
        const current = entries[origin]?.[ws]?.key ?? null;
        if (ifCurrentIs !== undefined && current !== ifCurrentIs) return false;
        entries[origin] = { ...entries[origin], [ws]: { key, savedAt: new Date().toISOString() } };
        // 'wx' (O_EXCL) never follows a pre-planted link and a random name is not guessable.
        const tmp = join(dir, `keys.json.tmp-${randomBytes(8).toString('hex')}`);
        writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        renameSync(tmp, path);
        return true;
      });
    },
  };
}
