/**
 * What every storage backend shares when a request fails: the typed error callers see, the
 * redacted log line and its rate limit. What gets logged is fixed text per failure kind,
 * never the error's own message: client messages embed the command (keys, values, SQL) and,
 * for an unparseable reply, the response body or the connection string.
 */
import { ApiError } from './errors';

export const FAILURE_MESSAGES = {
  timeout: 'The request ran into its deadline.',
  'backend-error': 'The backend rejected the command.',
  'bad-reply': 'The backend sent a reply that could not be parsed.',
  network: 'The request failed in transport.',
  'warmup-timeout': 'The database did not wake up within the warm-up deadline.',
} as const;
export type FailureKind = keyof typeof FAILURE_MESSAGES;

/** At most one identical failure line per this window, so an outage cannot flood the logs. */
const LOG_WINDOW_MS = 10_000;
const LOG_MEMORY_LIMIT = 64;

/**
 * One request must not hold a serverless function hostage: a backend that accepts the
 * connection and never answers would otherwise hang every storage-touching route. Kept well
 * below the 20 s sweep budget, where a timed-out call is just a failed attempt.
 */
export const DEFAULT_TIMEOUT_MS = 3000;

export function unexpectedReply(): ApiError {
  return new ApiError('upstream_error', 'The storage backend sent an unexpected reply.');
}

export function storageFailed(): ApiError {
  return new ApiError('upstream_error', 'The storage backend failed to answer a command.');
}

/** Class names only; anything else an unusual throw could carry is not logged. */
export function errorClassOf(error: unknown): string {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error.name)
    ? error.name
    : 'Error';
}

/** One structured stderr line per failure: class, reason and command name only. */
export class StorageFailureLog {
  readonly #lastLogged = new Map<string, number>();

  record(command: string, error: unknown, kind: FailureKind): void {
    const errorClass = errorClassOf(error);
    const id = `${command}|${errorClass}|${kind}`;
    const now = Date.now();
    const last = this.#lastLogged.get(id);
    if (last !== undefined && now - last < LOG_WINDOW_MS) return;
    if (this.#lastLogged.size >= LOG_MEMORY_LIMIT) this.#lastLogged.clear();
    this.#lastLogged.set(id, now);
    console.error(
      JSON.stringify({
        event: 'storage_failure',
        command,
        errorClass,
        kind,
        message: FAILURE_MESSAGES[kind],
      }),
    );
  }
}
