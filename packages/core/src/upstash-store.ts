/**
 * `Store` over the Upstash Redis REST API (production). Plain fetch, no SDK, so it runs
 * on any runtime. Commands are sent as JSON arrays; the counter uses MULTI/EXEC so the
 * TTL can never be lost between INCR and EXPIRE.
 *
 * Credentials come from UPSTASH_REDIS_REST_URL/_TOKEN or the names the Vercel
 * Marketplace integration injects (KV_REST_API_URL/_TOKEN).
 */
import { z } from 'zod';
import { ApiError } from './errors';
import type { IndexedMove, SetOptions, Store } from './store';

type Command = ReadonlyArray<string | number>;

const replySchema = z.object({
  result: z.union([z.string(), z.number(), z.null(), z.array(z.string())]).optional(),
  error: z.string().optional(),
});
const repliesSchema = z.union([z.array(replySchema), replySchema.transform((r) => [r])]);

type UpstashReply = z.infer<typeof replySchema>;

/** Atomic on the Redis side: KEEPTTL so a replaced record keeps its expiry, if any. */
const COMPARE_AND_SET_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
  return 1
end
return 0`;

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

export class UpstashStore implements Store {
  readonly #config: UpstashConfig;
  readonly #fetch: typeof fetch;

  constructor(config: UpstashConfig, fetchImpl: typeof fetch = fetch) {
    this.#config = config;
    this.#fetch = fetchImpl;
  }

  async #send(path: string, body: Command | readonly Command[]): Promise<UpstashReply[]> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#config.url}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    } catch {
      throw new ApiError('upstream_error', 'The storage backend is unreachable.');
    }
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError('upstream_error', `The storage backend answered HTTP ${response.status}.`);
    }
    const parsed = repliesSchema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError('upstream_error', 'The storage backend sent an unexpected reply.');
    }
    for (const reply of parsed.data) {
      if (reply.error)
        throw new ApiError('upstream_error', 'The storage backend rejected a command.');
    }
    return parsed.data;
  }

  async #command(command: Command): Promise<UpstashReply['result']> {
    const [reply] = await this.#send('', command);
    return reply?.result ?? null;
  }

  async get(key: string): Promise<string | null> {
    const result = await this.#command(['GET', key]);
    return typeof result === 'string' ? result : null;
  }

  async set(key: string, value: string, options: SetOptions = {}): Promise<boolean> {
    const command: Array<string | number> = ['SET', key, value];
    if (options.ttlSeconds !== undefined) command.push('EX', options.ttlSeconds);
    if (options.ifAbsent) command.push('NX');
    return (await this.#command(command)) === 'OK';
  }

  async compareAndSet(key: string, expected: string, value: string): Promise<boolean> {
    const result = await this.#command(['EVAL', COMPARE_AND_SET_SCRIPT, 1, key, expected, value]);
    return result === 1;
  }

  async delete(key: string): Promise<boolean> {
    return (await this.#command(['DEL', key])) === 1;
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const replies = await this.#send('/multi-exec', [
      ['INCR', key],
      ['EXPIRE', key, ttlSeconds, 'NX'],
    ]);
    const value = replies[0]?.result;
    if (typeof value !== 'number') {
      throw new ApiError(
        'upstream_error',
        'The storage backend returned an unexpected counter value.',
      );
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
    const result = await this.#command([
      'EVAL',
      CREATE_INDEXED_SCRIPT,
      2,
      key,
      setKey,
      value,
      member,
      maxMembers,
    ]);
    if (result === 1) return 'created';
    return result === 2 ? 'full' : 'exists';
  }

  async deleteIndexed(
    key: string,
    setKey: string,
    member: string,
    expected?: string,
  ): Promise<boolean> {
    const guard = expected === undefined ? ['0', ''] : ['1', expected];
    const result = await this.#command([
      'EVAL',
      DELETE_INDEXED_SCRIPT,
      2,
      key,
      setKey,
      member,
      ...guard,
    ]);
    return result === 1;
  }

  async moveIndexed(move: IndexedMove): Promise<'moved' | 'missing' | 'taken'> {
    const result = await this.#command([
      'EVAL',
      MOVE_INDEXED_SCRIPT,
      3,
      move.from,
      move.to,
      move.setKey,
      move.fromMember,
      move.toMember,
      move.expectedFrom,
      move.value,
    ]);
    if (result === 1) return 'moved';
    return result === 2 ? 'taken' : 'missing';
  }

  async setMembers(key: string): Promise<string[]> {
    const result = await this.#command(['SMEMBERS', key]);
    return Array.isArray(result) ? [...result] : [];
  }
}
