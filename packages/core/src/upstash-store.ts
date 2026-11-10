/**
 * `Store` over Upstash Redis through the official `@upstash/redis` client (production).
 * Every multi-step operation (counter, compare-and-set, indexed create/delete/move) is one
 * Lua script run with EVAL, so it is atomic on the server and works through proxies that
 * share one Redis connection (a MULTI/EXEC sent through such a front can interleave with
 * another caller's and fail as "nested").
 *
 * Use a regional Upstash database in production. The client's read-your-writes sync token
 * keeps reads consistent with this instance's own writes even on a global database with
 * read replicas, but a regional one has no replicas to lag behind at all.
 *
 * Credentials come from UPSTASH_REDIS_REST_URL/_TOKEN or the names the Vercel
 * Marketplace integration injects (KV_REST_API_URL/_TOKEN).
 */
import { Redis } from '@upstash/redis';
import { ApiError } from './errors';
import type { IndexedMove, SetOptions, Store } from './store';

/** Atomic on the Redis side: KEEPTTL so a replaced record keeps its expiry, if any. */
const COMPARE_AND_SET_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
  return 1
end
return 0`;

/** The TTL is set whenever the counter has none, so a counter can never outlive its window. */
const INCREMENT_SCRIPT = `local value = redis.call('INCR', KEYS[1])
if redis.call('TTL', KEYS[1]) == -1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return value`;

const CREATE_INDEXED_SCRIPT = `if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
if redis.call('SCARD', KEYS[2]) >= tonumber(ARGV[3]) then
  return 2
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SADD', KEYS[2], ARGV[2])
return 1`;

const DELETE_INDEXED_SCRIPT = `if ARGV[2] == '1' and redis.call('GET', KEYS[1]) ~= ARGV[3] then
  return 0
end
redis.call('SREM', KEYS[2], ARGV[1])
return redis.call('DEL', KEYS[1])`;

const MOVE_INDEXED_SCRIPT = `if redis.call('GET', KEYS[1]) ~= ARGV[3] then
  return 0
end
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 2
end
redis.call('SET', KEYS[2], ARGV[4])
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[3], ARGV[1])
redis.call('SADD', KEYS[3], ARGV[2])
return 1`;

export interface UpstashConfig {
  url: string;
  token: string;
  /** Per-request deadline in ms (default 3000); every command and EVAL script gets its own. */
  timeoutMs?: number;
}

/**
 * One request must not hold a serverless function hostage: a backend that accepts the
 * connection and never answers would otherwise hang every storage-touching route. Kept well
 * below the 20 s sweep budget, where a timed-out call is just a failed attempt.
 */
const DEFAULT_TIMEOUT_MS = 3000;
/** At most one identical failure line per this window, so an outage cannot flood the logs. */
const LOG_WINDOW_MS = 10_000;
const LOG_MEMORY_LIMIT = 64;

/** Reads credentials from an env-like object; null when none are configured. */
export function upstashConfigFromEnv(env: {
  readonly [name: string]: string | undefined;
}): UpstashConfig | null {
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

function unexpectedReply(): ApiError {
  return new ApiError('upstream_error', 'The storage backend sent an unexpected reply.');
}

/** A script/command result that must be one of the documented numbers; anything else is a fault. */
function oneOf<T extends number>(result: unknown, ...allowed: readonly T[]): T {
  const match = allowed.find((value) => value === result);
  if (match === undefined) throw unexpectedReply();
  return match;
}

/**
 * What gets logged is fixed text per failure kind, never the error's own message: the client's
 * messages embed the command (keys, values) and, for an unparseable reply, the response body.
 */
const FAILURE_MESSAGES = {
  timeout: 'The request ran into its deadline.',
  'backend-error': 'The backend rejected the command.',
  'bad-reply': 'The backend sent a reply that could not be parsed.',
  network: 'The request failed in transport.',
} as const;
type FailureKind = keyof typeof FAILURE_MESSAGES;

function failureKind(error: unknown): FailureKind {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (name === 'UpstashError') return 'backend-error';
  return name === 'UpstashJSONParseError' ? 'bad-reply' : 'network';
}

/** Class names only; anything else an unusual throw could carry is not logged. */
function errorClassOf(error: unknown): string {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error.name)
    ? error.name
    : 'Error';
}

export class UpstashStore implements Store {
  readonly #lastLogged = new Map<string, number>();
  readonly #redis: Redis;

  /**
   * The official client keeps Upstash's read-your-writes sync token itself (default on), so a
   * read never returns an older value than this instance's own earlier write, even when the
   * database has read replicas. Values are plain strings: automatic JSON deserialization is
   * off. Retries are off: a replayed INCR or compare-and-set after a lost reply could apply
   * twice. Auto-pipelining is off: every operation is its own request. The signal is a
   * factory, so each request gets a fresh deadline (a shared signal would stay aborted).
   */
  constructor(config: UpstashConfig) {
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#redis = new Redis({
      url: config.url,
      token: config.token,
      automaticDeserialization: false,
      retry: { retries: 0 },
      enableTelemetry: false,
      enableAutoPipelining: false,
      signal: () => AbortSignal.timeout(timeoutMs),
    });
  }

  async #run<T>(command: string, operation: (redis: Redis) => Promise<T>): Promise<T> {
    try {
      return await operation(this.#redis);
    } catch (error) {
      this.#logFailure(command, error);
      throw new ApiError('upstream_error', 'The storage backend failed to answer a command.');
    }
  }

  /** One structured stderr line: class, reason and command name only, never keys or values. */
  #logFailure(command: string, error: unknown): void {
    const errorClass = errorClassOf(error);
    const kind = failureKind(error);
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

  async get(key: string): Promise<string | null> {
    const result: unknown = await this.#run('GET', (redis) => redis.get(key));
    if (result === null) return null;
    if (typeof result !== 'string') throw unexpectedReply();
    return result;
  }

  async set(key: string, value: string, options: SetOptions = {}): Promise<boolean> {
    const result = await this.#run('SET', (redis) =>
      options.ifAbsent
        ? options.ttlSeconds === undefined
          ? redis.set(key, value, { nx: true })
          : redis.set(key, value, { nx: true, ex: options.ttlSeconds })
        : options.ttlSeconds === undefined
          ? redis.set(key, value)
          : redis.set(key, value, { ex: options.ttlSeconds }),
    );
    if (result !== 'OK' && result !== null) throw unexpectedReply();
    return result === 'OK';
  }

  async compareAndSet(key: string, expected: string, value: string): Promise<boolean> {
    const result = await this.#run('EVAL', (redis) =>
      redis.eval(COMPARE_AND_SET_SCRIPT, [key], [expected, value]),
    );
    return oneOf(result, 0, 1) === 1;
  }

  async delete(key: string): Promise<boolean> {
    return oneOf(await this.#run('DEL', (redis) => redis.del(key)), 0, 1) === 1;
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const value = await this.#run('EVAL', (redis) =>
      redis.eval(INCREMENT_SCRIPT, [key], [ttlSeconds]),
    );
    if (typeof value !== 'number') {
      throw unexpectedReply();
    }
    return value;
  }

  async createIndexed(
    key: string,
    value: string,
    setKey: string,
    member: string,
    maxMembers: number,
  ): Promise<'created' | 'exists' | 'full'> {
    const result = await this.#run('EVAL', (redis) =>
      redis.eval(CREATE_INDEXED_SCRIPT, [key, setKey], [value, member, maxMembers]),
    );
    const outcome = oneOf(result, 0, 1, 2);
    if (outcome === 1) return 'created';
    return outcome === 2 ? 'full' : 'exists';
  }

  async deleteIndexed(
    key: string,
    setKey: string,
    member: string,
    expected?: string,
  ): Promise<boolean> {
    const guard = expected === undefined ? ['0', ''] : ['1', expected];
    const result = await this.#run('EVAL', (redis) =>
      redis.eval(DELETE_INDEXED_SCRIPT, [key, setKey], [member, ...guard]),
    );
    return oneOf(result, 0, 1) === 1;
  }

  async moveIndexed(move: IndexedMove): Promise<'moved' | 'missing' | 'taken'> {
    const result = await this.#run('EVAL', (redis) =>
      redis.eval(
        MOVE_INDEXED_SCRIPT,
        [move.from, move.to, move.setKey],
        [move.fromMember, move.toMember, move.expectedFrom, move.value],
      ),
    );
    const outcome = oneOf(result, 0, 1, 2);
    if (outcome === 1) return 'moved';
    return outcome === 2 ? 'taken' : 'missing';
  }

  async setMembers(key: string): Promise<string[]> {
    const result: unknown = await this.#run('SMEMBERS', (redis) => redis.smembers(key));
    if (!Array.isArray(result) || !result.every((member) => typeof member === 'string')) {
      throw unexpectedReply();
    }
    return result;
  }
}
