/**
 * The Redis test runner must stop its test process when it is interrupted, so a cancelled job
 * cannot go on issuing commands. Uses an endpoint that accepts connections and never answers,
 * which keeps the test process busy until the runner forwards the signal. No Docker involved.
 */
import { afterEach, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');
const stoppers: Array<() => void> = [];
afterEach(() => {
  for (const stop of stoppers.splice(0)) stop();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`${signal} reaches the test process and the runner exits with the signal's code`, async () => {
    const connected = Promise.withResolvers<void>();
    const clientGone = Promise.withResolvers<void>();
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        connected.resolve();
        request.signal.addEventListener('abort', () => clientGone.resolve());
        return new Promise<Response>(() => {});
      },
    });
    stoppers.push(() => void server.stop(true));

    const runner = Bun.spawn(['bun', 'packages/core/scripts/test-redis.ts'], {
      cwd: ROOT,
      env: {
        ...process.env,
        REDIS_REST_TEST_URL: `http://127.0.0.1:${server.port}`,
        REDIS_REST_TEST_TOKEN: 'unused',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    stoppers.push(() => runner.kill('SIGKILL'));

    await connected.promise;
    runner.kill(signal);
    expect(await runner.exited).toBe(signal === 'SIGINT' ? 130 : 143);
    // The test process held the open connection; it is gone only if the signal reached it.
    await clientGone.promise;
  }, 30_000);
}
