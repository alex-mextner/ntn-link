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
}

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

export class UpstashStore implements Store {
  readonly #redis: Redis;

  /**
   * The official client keeps Upstash's read-your-writes sync token itself (default on), so a
   * read never returns an older value than this instance's own earlier write, even when the
   * database has read replicas. Values are plain strings: automatic JSON deserialization is
   * off. Retries are off: a replayed INCR or compare-and-set after a lost reply could apply
   * twice. Auto-pipelining is off: every operation is its own request.
   */
  constructor(config: UpstashConfig) {
    this.#redis = new Redis({
      url: config.url,
      token: config.token,
      automaticDeserialization: false,
      retry: { retries: 0 },
      enableTelemetry: false,
      enableAutoPipelining: false,
    });
  }

  async #run<T>(operation: (redis: Redis) => Promise<T>): Promise<T> {
    try {
      return await operation(this.#redis);
    } catch {
      throw new ApiError('upstream_error', 'The storage backend failed to answer a command.');
    }
  }

  async get(key: string): Promise<string | null> {
    const result: unknown = await this.#run((redis) => redis.get(key));
    if (result === null) return null;
    if (typeof result !== 'string') throw unexpectedReply();
    return result;
  }

  async set(key: string, value: string, options: SetOptions = {}): Promise<boolean> {
    const result = await this.#run((redis) =>
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
    const result = await this.#run((redis) =>
      redis.eval(COMPARE_AND_SET_SCRIPT, [key], [expected, value]),
    );
    return oneOf(result, 0, 1) === 1;
  }

  async delete(key: string): Promise<boolean> {
    return oneOf(await this.#run((redis) => redis.del(key)), 0, 1) === 1;
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const value = await this.#run((redis) => redis.eval(INCREMENT_SCRIPT, [key], [ttlSeconds]));
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
    const result = await this.#run((redis) =>
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
    const result = await this.#run((redis) =>
      redis.eval(DELETE_INDEXED_SCRIPT, [key, setKey], [member, ...guard]),
    );
    return oneOf(result, 0, 1) === 1;
  }

  async moveIndexed(move: IndexedMove): Promise<'moved' | 'missing' | 'taken'> {
    const result = await this.#run((redis) =>
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
    const result: unknown = await this.#run((redis) => redis.smembers(key));
    if (!Array.isArray(result) || !result.every((member) => typeof member === 'string')) {
      throw unexpectedReply();
    }
    return result;
  }
}
