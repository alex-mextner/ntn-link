/** Deadlines: ordinary calls are bounded tightly, but verify must outlive a slow key rotation. */
import { expect, test } from 'bun:test';
import { NetworkFailure, createApi } from '../src/api';
import { openRunLog } from '../src/log';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ntn-link-api-test-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const slow = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    await Bun.sleep(400);
    const path = new URL(req.url).pathname;
    if (path === '/api/verify') {
      return Response.json({
        workspace: 'w',
        action: 'rotate',
        ownerKey: 'k'.repeat(20),
        removedLinks: 0,
        cleanupComplete: true,
      });
    }
    if (path === '/api/ns/w/sweep') {
      return Response.json({ workspace: 'w', removedLinks: 1, cleanupComplete: true });
    }
    return Response.json({ error: { code: 'not_found', message: 'nope' } }, { status: 404 });
  },
});

test('verify and sweep outlive the ordinary deadline (namespace-wide work); other calls time out', async () => {
  const log = openRunLog(new Date(), 99, dir);
  const api = createApi(
    `http://127.0.0.1:${slow.port}`,
    (url, init) => fetch(url, init),
    log,
    'test',
    {
      default: 100,
      verify: 3000,
      sweep: 3000,
    },
  );
  const verified = await api.verify('https://w.notion.site/x', 'ntn-verify-aaaaaaaaaa', 'token');
  expect(verified.ownerKey).toHaveLength(20);
  expect(await api.sweepLinks('w', 'key')).toEqual({
    workspace: 'w',
    removedLinks: 1,
    cleanupComplete: true,
  });
  await expect(api.listLinks('w', 'key')).rejects.toBeInstanceOf(NetworkFailure);
  await expect(api.preview('https://w.notion.site/x')).rejects.toBeInstanceOf(NetworkFailure);
  log.close();
  slow.stop(true);
});
