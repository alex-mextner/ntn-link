/**
 * Runs the opt-in PostgresStore integration test against a REAL Postgres, many connections
 * wide. Only starts a throwaway container, points the test at it and removes it again.
 *
 *   bun run test:postgres                       start postgres via docker
 *   POSTGRES_TEST_URL=postgres://... bun run test:postgres
 *                                               use an existing server instead (it must be
 *                                               disposable: the store creates its two tables)
 *
 * The image is overridable (POSTGRES_TEST_IMAGE). The password is random per run and never printed.
 */
import { randomBytes } from 'node:crypto';
import { $ } from 'bun';

const IMAGE = process.env.POSTGRES_TEST_IMAGE ?? 'postgres:16-alpine';
const TEST_FILE = 'packages/core/test/postgres.integration.test.ts';
const READY_DEADLINE_MS = 60_000;

let testProcess: Bun.Subprocess | null = null;
/** Set by SIGINT/SIGTERM; the startup steps check it so an interrupt unwinds into `finally`. */
let stopSignal: NodeJS.Signals | null = null;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopSignal = signal;
    testProcess?.kill(signal);
  });
}

function throwIfInterrupted(): void {
  if (stopSignal !== null) throw new Error(`Interrupted by ${stopSignal}.`);
}

async function runTest(url: string): Promise<number> {
  throwIfInterrupted();
  const proc = Bun.spawn(['bun', 'test', TEST_FILE], {
    env: { ...process.env, POSTGRES_TEST_URL: url },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  testProcess = proc;
  return proc.exited;
}

async function withDocker(): Promise<number> {
  const suffix = randomBytes(4).toString('hex');
  const name = `ntn-postgres-${suffix}`;
  const password = randomBytes(16).toString('hex');
  try {
    await $`docker run -d --rm --name ${name} -p 127.0.0.1::5432 -e POSTGRES_PASSWORD=${password} ${IMAGE}`.quiet();
    throwIfInterrupted();
    const mapping = (await $`docker port ${name} 5432/tcp`.text()).trim().split('\n')[0] ?? '';
    const port = mapping.slice(mapping.lastIndexOf(':') + 1);
    if (!/^\d+$/.test(port)) throw new Error(`Unexpected docker port mapping "${mapping}".`);
    const deadline = Date.now() + READY_DEADLINE_MS;
    // Over TCP with the password, like the tests: without -h psql uses the unix socket, which
    // the image's temporary initialization server answers while TCP is still closed.
    while (
      (
        await $`docker exec -e PGPASSWORD=${password} ${name} psql -h 127.0.0.1 -U postgres -tAc "select 1"`
          .quiet()
          .nothrow()
      ).exitCode !== 0
    ) {
      throwIfInterrupted();
      if (Date.now() > deadline) throw new Error('Postgres did not become ready.');
      await Bun.sleep(500);
    }
    return await runTest(`postgres://postgres:${password}@127.0.0.1:${port}/postgres`);
  } finally {
    await $`docker rm -f ${name}`.quiet().nothrow();
  }
}

const existing = process.env.POSTGRES_TEST_URL;
const exitCodeFor = (code: number): number =>
  stopSignal === null ? code : 128 + (stopSignal === 'SIGINT' ? 2 : 15);
try {
  process.exit(exitCodeFor(existing ? await runTest(existing) : await withDocker()));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(exitCodeFor(1));
}
