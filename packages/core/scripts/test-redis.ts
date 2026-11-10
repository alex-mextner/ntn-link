/**
 * Runs the opt-in UpstashStore integration test against a REAL Redis behind an
 * Upstash-REST-compatible HTTP front. Nothing in the production code path changes: this
 * script only starts throwaway containers, points the test at them and removes them again.
 *
 *   bun run test:redis                 start redis + serverless-redis-http via docker
 *   REDIS_REST_TEST_URL=... REDIS_REST_TEST_TOKEN=... bun run test:redis
 *                                      use an existing Upstash-compatible endpoint instead
 *
 * Images are overridable (REDIS_TEST_IMAGE, SRH_TEST_IMAGE) so Valkey or a pinned Redis
 * version can be exercised the same way. The token is random per run and never printed.
 */
import { randomBytes } from 'node:crypto';
import { $ } from 'bun';

const REDIS_IMAGE = process.env.REDIS_TEST_IMAGE ?? 'redis:7-alpine';
const SRH_IMAGE = process.env.SRH_TEST_IMAGE ?? 'hiett/serverless-redis-http:latest';
const TEST_FILE = 'packages/core/test/upstash-redis.integration.test.ts';
/** Each probe is bounded, and so is the whole wait: a front that accepts but never replies must not hang us. */
const READY_REQUEST_TIMEOUT_MS = 2_000;
const READY_DEADLINE_MS = 30_000;

/** The running test process, so an interrupt can stop it before the containers go away. */
let testProcess: Bun.Subprocess | null = null;
/** Set by SIGINT/SIGTERM; the startup steps check it so an interrupt unwinds into `finally`. */
let stopSignal: NodeJS.Signals | null = null;

/**
 * SIGINT/SIGTERM are recorded and forwarded to the test process in every mode, instead of
 * ending this runner while the test keeps issuing commands. In docker mode the cleanup runs in
 * `finally` after the startup step in flight has settled, so it cannot race a container the
 * daemon is still creating (`--rm` only removes a container once it has stopped).
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopSignal = signal;
    testProcess?.kill(signal);
  });
}

function throwIfInterrupted(): void {
  if (stopSignal !== null) throw new Error(`Interrupted by ${stopSignal}.`);
}

async function runTest(url: string, token: string): Promise<number> {
  // No await between this check and `testProcess` below, so a signal cannot slip in unnoticed.
  throwIfInterrupted();
  const proc = Bun.spawn(['bun', 'test', TEST_FILE], {
    env: { ...process.env, REDIS_REST_TEST_URL: url, REDIS_REST_TEST_TOKEN: token },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  testProcess = proc;
  return proc.exited;
}

async function waitForRest(url: string, token: string): Promise<void> {
  const deadline = Date.now() + READY_DEADLINE_MS;
  while (Date.now() < deadline) {
    throwIfInterrupted();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(['PING']),
        signal: AbortSignal.timeout(READY_REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return;
    } catch {
      // The proxy is still starting, or did not answer within the probe timeout.
    }
    await Bun.sleep(500);
  }
  throw new Error('The Redis REST front did not become ready.');
}

async function withDocker(): Promise<number> {
  const suffix = randomBytes(4).toString('hex');
  const network = `ntn-redis-test-${suffix}`;
  const redis = `ntn-redis-${suffix}`;
  const srh = `ntn-srh-${suffix}`;
  const token = randomBytes(16).toString('hex');
  const cleanup = async (): Promise<void> => {
    await $`docker rm -f ${srh} ${redis}`.quiet().nothrow();
    await $`docker network rm ${network}`.quiet().nothrow();
  };
  try {
    await $`docker network create ${network}`.quiet();
    throwIfInterrupted();
    await $`docker run -d --rm --name ${redis} --network ${network} ${REDIS_IMAGE}`.quiet();
    throwIfInterrupted();
    await $`docker run -d --rm --name ${srh} --network ${network} -p 127.0.0.1::80 -e SRH_MODE=env -e SRH_TOKEN=${token} -e SRH_CONNECTION_STRING=redis://${redis}:6379 ${SRH_IMAGE}`.quiet();
    throwIfInterrupted();
    const mapping = (await $`docker port ${srh} 80/tcp`.text()).trim().split('\n')[0] ?? '';
    const port = mapping.slice(mapping.lastIndexOf(':') + 1);
    if (!/^\d+$/.test(port)) throw new Error(`Unexpected docker port mapping "${mapping}".`);
    const url = `http://127.0.0.1:${port}`;
    await waitForRest(url, token);
    throwIfInterrupted();
    return await runTest(url, token);
  } finally {
    await cleanup();
  }
}

const url = process.env.REDIS_REST_TEST_URL;
const token = process.env.REDIS_REST_TEST_TOKEN;
const exitCodeFor = (code: number): number =>
  stopSignal === null ? code : 128 + (stopSignal === 'SIGINT' ? 2 : 15);
try {
  process.exit(exitCodeFor(url && token ? await runTest(url, token) : await withDocker()));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(exitCodeFor(1));
}
