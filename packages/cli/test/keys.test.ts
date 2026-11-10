import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { openKeyStore } from '../src/keys';
import { LockTimeout, withLock, withLockAsync } from '../src/lock';

const O = 'https://svc.test';
let dir = '';
let cfg = '';
let path = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ntn-link-keys-test-'));
  cfg = join(dir, 'cfg', 'ntn-link');
  path = join(cfg, 'keys.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('set/get roundtrip with 0600 file and 0700 directory', () => {
  const store = openKeyStore(path);
  expect(store.get(O, 'thsm')).toBeNull();
  store.set(O, 'thsm', 'k1');
  expect(openKeyStore(path).get(O, 'thsm')).toBe('k1');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(cfg).mode & 0o777).toBe(0o700);
});

test('different workspaces coexist and leave no temp files behind', () => {
  const store = openKeyStore(path);
  store.set(O, 'a', 'ka');
  store.set(O, 'b', 'kb');
  store.set(O, 'a', 'ka2');
  expect(store.get(O, 'a')).toBe('ka2');
  expect(store.get(O, 'b')).toBe('kb');
  expect(readdirSync(cfg)).toEqual(['keys.json']); // no temp file, no stale lock
});

test('a world-readable file is tightened and a warning is recorded without the key', () => {
  openKeyStore(path).set(O, 'thsm', 'super-secret-key');
  chmodSync(path, 0o644);
  const reopened = openKeyStore(path);
  expect(reopened.get(O, 'thsm')).toBe('super-secret-key');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(reopened.warnings.length).toBe(1);
  expect(reopened.warnings.join('')).not.toContain('super-secret-key');
});

test('a corrupt file is moved aside, not lost, and the store keeps working', () => {
  mkdirSync(cfg, { recursive: true });
  writeFileSync(path, '{oops', { mode: 0o600 });
  const store = openKeyStore(path);
  expect(store.get(O, 'thsm')).toBeNull();
  const aside = readdirSync(cfg).filter((f) => f.startsWith('keys.json.corrupt-'));
  expect(aside.length).toBe(1);
  expect(readFileSync(join(cfg, aside[0] ?? ''), 'utf8')).toBe('{oops');
  store.set(O, 'thsm', 'k');
  expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveProperty(
    ['https://svc.test', 'thsm', 'key'],
    'k',
  );
  expect(store.warnings.length).toBe(1);
});

test('valid JSON of the wrong shape counts as corrupt', () => {
  mkdirSync(cfg, { recursive: true });
  writeFileSync(path, '["x"]', { mode: 0o600 });
  expect(openKeyStore(path).get(O, 'x')).toBeNull();
});

test('keys are kept per origin: the same workspace on another service is a different entry', () => {
  const store = openKeyStore(path);
  store.set('https://one.test', 'thsm', 'k-one');
  store.set('https://two.test', 'thsm', 'k-two');
  expect(store.get('https://one.test', 'thsm')).toBe('k-one');
  expect(store.get('https://two.test', 'thsm')).toBe('k-two');
  expect(store.get('https://three.test', 'thsm')).toBeNull();
});

test('concurrent processes saving different workspaces do not lose each other', async () => {
  const writer = join(import.meta.dir, 'key-writer.ts');
  const workspaces = Array.from({ length: 8 }, (_, i) => `ws${i}`);
  const procs = workspaces.map((ws) =>
    Bun.spawn(['bun', writer, path, O, ws, `key-${ws}`], { stdout: 'ignore', stderr: 'inherit' }),
  );
  expect(await Promise.all(procs.map((proc) => proc.exited))).toEqual(workspaces.map(() => 0));
  const store = openKeyStore(path);
  for (const ws of workspaces) expect(store.get(O, ws)).toBe(`key-${ws}`);
  expect(readdirSync(cfg).toSorted()).toEqual(['keys.json']);
});

const lockFile = (): string => join(cfg, 'keys.lock');

/** A pid that certainly belongs to no running process. */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn(['true']);
  await proc.exited;
  return proc.pid;
}

function plantLock(holder: { pid: number; host?: string; ts?: number; start?: string }): void {
  mkdirSync(cfg, { recursive: true });
  writeFileSync(
    lockFile(),
    JSON.stringify({ host: hostname(), ts: Date.now(), start: null, token: 'planted', ...holder }),
  );
}

test('a lock held by a live run fails after the bounded wait and names what to delete', () => {
  plantLock({ pid: process.pid });
  const started = Date.now();
  expect(() => openKeyStore(path, { lockWaitMs: 200 }).set(O, 'a', 'k')).toThrow(
    /delete .*keys\.lock/,
  );
  expect(Date.now() - started).toBeLessThan(2000);
  expect(existsSync(lockFile())).toBe(true); // a live holder is never taken over
});

test('a lock left by a killed run (its pid is gone) is reclaimed at once', async () => {
  plantLock({ pid: await deadPid() });
  const store = openKeyStore(path, { lockWaitMs: 200 });
  expect(store.set(O, 'a', 'k')).toBe(true);
  expect(store.get(O, 'a')).toBe('k');
  expect(readdirSync(cfg)).toEqual(['keys.json']); // lock and reclaim guard are gone
});

test('a lock from another host is only reclaimed once it is older than the bound', () => {
  plantLock({ pid: process.pid, host: 'some-other-host', ts: Date.now() - 1000 });
  expect(() =>
    openKeyStore(path, { lockWaitMs: 100, lockStaleMs: 60_000 }).set(O, 'a', 'k'),
  ).toThrow(/delete/);
  plantLock({ pid: process.pid, host: 'some-other-host', ts: Date.now() - 120_000 });
  expect(openKeyStore(path, { lockWaitMs: 100, lockStaleMs: 60_000 }).set(O, 'a', 'k')).toBe(true);
});

test('a live holder is never taken over, however old its lock (a paused writer keeps exclusion)', () => {
  const stale = { staleAfterMs: 1 };
  mkdirSync(cfg, { recursive: true });
  withLock(lockFile(), 100, stale, () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); // far older than the bound
    expect(() => withLock(lockFile(), 60, stale, () => undefined)).toThrow(LockTimeout);
  });
  plantLock({ pid: process.pid, ts: Date.now() - 3_600_000 });
  expect(() =>
    openKeyStore(path, { lockWaitMs: 100, lockStaleMs: 60_000 }).set(O, 'a', 'k'),
  ).toThrow(/delete/);
  expect(readFileSync(lockFile(), 'utf8')).toContain('planted');
});

test.skipIf(process.platform !== 'linux')(
  'a lock whose pid was reused by another process (different start time) is reclaimed',
  () => {
    plantLock({ pid: process.pid, start: 'not-the-real-start-time' });
    expect(openKeyStore(path, { lockWaitMs: 100 }).set(O, 'a', 'k')).toBe(true);
    expect(readdirSync(cfg)).toEqual(['keys.json']);
  },
);

test('a lock without readable content (the old empty directory) is judged by its age only', () => {
  mkdirSync(lockFile(), { recursive: true });
  expect(() =>
    openKeyStore(path, { lockWaitMs: 100, lockStaleMs: 60_000 }).set(O, 'a', 'k'),
  ).toThrow(/delete/);
  const longAgo = new Date(Date.now() - 120_000);
  utimesSync(lockFile(), longAgo, longAgo);
  expect(openKeyStore(path, { lockWaitMs: 100, lockStaleMs: 60_000 }).set(O, 'a', 'k')).toBe(true);
  expect(readdirSync(cfg)).toEqual(['keys.json']);
});

test('a holder that was reclaimed meanwhile does not delete its successor lock on release', () => {
  mkdirSync(cfg, { recursive: true });
  withLock(lockFile(), 100, { staleAfterMs: 60_000 }, () => {
    // Someone judged us abandoned, reclaimed the lock and now holds it themselves.
    rmSync(lockFile());
    plantLock({ pid: process.pid });
  });
  expect(readFileSync(lockFile(), 'utf8')).toContain('planted');
});

test('a FIFO planted as the lock cannot stall the bounded wait', async () => {
  mkdirSync(cfg, { recursive: true });
  expect(Bun.spawnSync(['mkfifo', lockFile()]).exitCode).toBe(0);
  const probe = Bun.spawn(['bun', join(import.meta.dir, 'lock-probe.ts'), path, '100'], {
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const killer = setTimeout(() => probe.kill(), 4000);
  const out = await new Response(probe.stdout).text();
  clearTimeout(killer);
  expect(probe.killed).toBe(false); // finished on its own
  expect(out).toMatch(/delete .*keys\.lock/);
});

test('releasing waits for an in-flight reclaimer instead of racing it', async () => {
  mkdirSync(cfg, { recursive: true });
  const guard = `${lockFile()}.reclaim`;
  const started = Date.now();
  let helper: ReturnType<typeof Bun.spawn> | undefined;
  await withLockAsync(lockFile(), 100, { staleAfterMs: 60_000 }, 'x', async () => {
    writeFileSync(guard, ''); // a reclaimer is working on this lock path right now
    // release() blocks this thread, so another process frees the guard after a moment.
    helper = Bun.spawn(['sh', '-c', `sleep 0.3; rm -f '${guard}'`]);
  });
  expect(Date.now() - started).toBeGreaterThanOrEqual(250); // release was held back by the guard
  expect(existsSync(lockFile())).toBe(false);
  await helper?.exited;
  expect(existsSync(guard)).toBe(false);
});

test('a reclaimer leaves the lock alone while another reclaimer or releaser holds the guard', async () => {
  plantLock({ pid: await deadPid() });
  writeFileSync(`${lockFile()}.reclaim`, ''); // fresh guard: someone else is acting on the lock
  expect(() => openKeyStore(path, { lockWaitMs: 100 }).set(O, 'a', 'k')).toThrow(/delete/);
  expect(readFileSync(lockFile(), 'utf8')).toContain('planted');
});

test('a creator suspended inside the empty-file window never enters a lock reclaimed meanwhile', () => {
  mkdirSync(cfg, { recursive: true });
  let entered = false;
  let interfered = false;
  const hooks = {
    afterOpen: () => {
      if (interfered) return;
      interfered = true;
      // While we are paused: the empty file is judged unreadable, reclaimed, and someone else holds the lock.
      rmSync(lockFile());
      plantLock({ pid: process.pid });
    },
  };
  expect(() =>
    withLock(lockFile(), 80, { staleAfterMs: 60_000, hooks }, () => void (entered = true)),
  ).toThrow(LockTimeout);
  expect(entered).toBe(false);
  expect(readFileSync(lockFile(), 'utf8')).toContain('planted'); // the successor's lock is untouched
});

test('two reclaimers of one abandoned guard cannot delete the fresh guard that replaced it', async () => {
  plantLock({ pid: await deadPid() }); // a lock to reclaim
  const guard = `${lockFile()}.reclaim`;
  writeFileSync(guard, ''); // abandoned guard of a dead reclaimer
  const old = new Date(Date.now() - 60_000);
  utimesSync(guard, old, old);
  let swapped = false;
  const hooks = {
    beforeGuardTakeover: () => {
      if (swapped) return;
      swapped = true;
      // The other reclaimer finishes first and a new live guard exists when we move ours away.
      rmSync(guard);
      writeFileSync(
        guard,
        JSON.stringify({
          pid: process.pid,
          host: hostname(),
          ts: Date.now(),
          start: null,
          token: 'fresh-guard',
        }),
      );
    },
  };
  expect(() => withLock(lockFile(), 0, { staleAfterMs: 60_000, hooks }, () => undefined)).toThrow(
    LockTimeout,
  );
  expect(readFileSync(guard, 'utf8')).toContain('fresh-guard'); // put back, not deleted
  expect(readFileSync(lockFile(), 'utf8')).toContain('planted'); // nobody reclaimed under a guard they did not hold
  expect(readdirSync(cfg).filter((f) => f.includes('.dead-'))).toEqual([]);
});

test('a stale reclaim guard left by a dead reclaimer does not block forever', async () => {
  plantLock({ pid: await deadPid() });
  writeFileSync(`${lockFile()}.reclaim`, '');
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${lockFile()}.reclaim`, old, old);
  expect(openKeyStore(path, { lockWaitMs: 1000, lockStaleMs: 60_000 }).set(O, 'a', 'k')).toBe(true);
  expect(readdirSync(cfg)).toEqual(['keys.json']);
});

test('workspace names that are Object.prototype keys roundtrip like any other', () => {
  const store = openKeyStore(path);
  for (const ws of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    expect(store.get(O, ws)).toBeNull();
    store.set(O, ws, `key-${ws}`);
    expect(openKeyStore(path).get(O, ws)).toBe(`key-${ws}`);
  }
});

test('flows of one workspace run one at a time, across store instances', async () => {
  const order: string[] = [];
  const first = openKeyStore(path);
  const second = openKeyStore(path);
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const running = first.withFlow(O, 'ws', async () => {
    order.push('first-start');
    await gate;
    order.push('first-end');
  });
  await Bun.sleep(30);
  let waited = 0;
  const queued = second.withFlow(
    O,
    'ws',
    async () => void order.push('second'),
    () => void waited++,
  );
  await Bun.sleep(400);
  expect(order).toEqual(['first-start']); // the second flow is held back
  release();
  await Promise.all([running, queued]);
  expect(order).toEqual(['first-start', 'first-end', 'second']);
  expect(waited).toBe(1);
  expect(readdirSync(cfg)).toEqual([]); // flow locks removed
});

test('flows of different workspaces or origins do not block each other', async () => {
  const store = openKeyStore(path);
  const inside: string[] = [];
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const one = store.withFlow(O, 'a', async () => {
    inside.push('a');
    await gate;
  });
  await store.withFlow(O, 'b', async () => void inside.push('b'));
  await store.withFlow('https://other.test', 'a', async () => void inside.push('other'));
  expect(inside).toEqual(['a', 'b', 'other']);
  release();
  await one;
});

test('a flow lock left by a killed run is reclaimed', async () => {
  const store = openKeyStore(path, { flowWaitMs: 300 });
  let flowPath = '';
  await store.withFlow(O, 'ws', async () => {
    flowPath = readdirSync(cfg).find((f) => f.startsWith('keys.flow-')) ?? '';
  });
  expect(flowPath).not.toBe('');
  writeFileSync(
    join(cfg, flowPath),
    JSON.stringify({
      pid: await deadPid(),
      host: hostname(),
      ts: Date.now(),
      start: null,
      token: 't',
    }),
  );
  let ran = false;
  await store.withFlow(O, 'ws', async () => void (ran = true));
  expect(ran).toBe(true);
});

test('a flow that waits too long fails with a message naming the lock file', async () => {
  const store = openKeyStore(path, { flowWaitMs: 300 });
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const holder = store.withFlow(O, 'ws', () => gate);
  await Bun.sleep(30);
  await expect(store.withFlow(O, 'ws', async () => undefined)).rejects.toThrow(
    /delete .*keys\.flow-/,
  );
  release();
  await holder;
});

test('a pre-existing group/world-writable key directory is locked down before use', () => {
  mkdirSync(cfg, { recursive: true });
  chmodSync(cfg, 0o777);
  openKeyStore(path).set(O, 'thsm', 'k');
  expect(statSync(cfg).mode & 0o777).toBe(0o700);
});

test('a symlink where the key directory should be is refused, and nothing is written through it', () => {
  const target = join(dir, 'elsewhere');
  mkdirSync(target);
  mkdirSync(join(dir, 'cfg'), { recursive: true });
  symlinkSync(target, cfg);
  expect(() => openKeyStore(path).set(O, 'thsm', 'secret-key')).toThrow(/not a plain directory/);
  expect(readdirSync(target)).toEqual([]);
});

test('planted links at guessable temp names cannot capture the key file', () => {
  const loot = join(dir, 'loot');
  mkdirSync(cfg, { recursive: true });
  for (let i = 0; i < 3; i++)
    symlinkSync(loot, join(cfg, `keys.json.tmp-${process.pid}-${Date.now() + i}`));
  openKeyStore(path).set(O, 'thsm', 'secret-key');
  expect(existsSync(loot)).toBe(false);
  expect(openKeyStore(path).get(O, 'thsm')).toBe('secret-key');
});

test('reading never follows a planted link: no chmod of its target, no key read through it', () => {
  const victim = join(dir, 'victim');
  mkdirSync(victim, { mode: 0o755 });
  chmodSync(victim, 0o755);
  mkdirSync(cfg, { recursive: true });
  symlinkSync(victim, path);
  const store = openKeyStore(path);
  expect(store.get(O, 'thsm')).toBeNull();
  expect(statSync(victim).mode & 0o777).toBe(0o755);
  expect(store.warnings.join(' ')).toContain('cannot read key file');
});
