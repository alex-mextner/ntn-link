import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from '../src/errors';
import { openKeyStore } from '../src/keys';
import { startFakeServer } from './fake-server';
import { LOG_NAME, type Harness, makeHarness } from './harness';

const PAGE = 'https://thsm.notion.site/Our-trips-413d447ac4b180169985c93eea7f02f9';
let h: Harness;
beforeEach(() => void (h = makeHarness()));
afterEach(() => h.cleanup());

const out = (): string => h.stdout.join('');
const err = (): string => h.stderr.join('');
const clear = (): void => void ((h.stdout.length = 0), (h.stderr.length = 0));

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
  );
}
const everythingOnDisk = (): string =>
  filesUnder(h.dir)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

const keyOnDisk = (): string | null => openKeyStore(h.keysPath).get(h.server.origin, 'thsm');

/** Pre-claims "thsm" on the server and saves the key the way a previous CLI run would. */
function ownThsm(serverKey = 'saved-owner-key', savedKey = serverKey): void {
  h.server.owners.set('thsm', serverKey);
  openKeyStore(h.keysPath).set(h.server.origin, 'thsm', savedKey);
}

test('happy path with a stored key: stdout is exactly the redirect link', async () => {
  ownThsm();
  expect(await h.exec(PAGE, '--slug', 'our-trips')).toBe(EXIT.ok);
  expect(out()).toBe('https://short.test/thsm/our-trips\n');
  const create = h.server.seen.find((s) => s.path === '/api/links');
  expect(create?.auth).toBe('Bearer saved-owner-key');
  expect(create?.body).toEqual({ url: PAGE, slug: 'our-trips' });
});

test('--fast only selects the printed link; the fast page stays on by default', async () => {
  ownThsm();
  expect(await h.exec(PAGE, '--fast')).toBe(EXIT.ok);
  expect(out()).toBe('https://short.test/thsm/our-trips/read\n');
  expect(h.server.seen.find((s) => s.path === '/api/links')?.body).toEqual({ url: PAGE });
  expect(await h.exec(PAGE, '--slug', 'plain')).toBe(EXIT.ok);
  expect(h.server.links.get('thsm/plain')?.fast).toBe(true);
});

test('log path is announced at start and end of stderr, and the log is 0600', async () => {
  ownThsm();
  await h.exec(PAGE);
  const logPath = join(h.dir, LOG_NAME);
  expect(
    err()
      .split('\n')
      .filter((l) => l.startsWith('log: ')),
  ).toEqual([`log: ${logPath}`, `log: ${logPath}`]);
  expect(err().trimEnd().endsWith(`log: ${logPath}`)).toBe(true);
  expect(statSync(logPath).mode & 0o777).toBe(0o600);
});

test('unclaimed workspace: nonce shown, claimToken sent only to verify, key saved 0600, no secrets elsewhere', async () => {
  expect(await h.exec(PAGE)).toBe(EXIT.ok);
  expect(out()).toBe('https://short.test/thsm/our-trips\n');
  const nonce = /ntn-verify-\w+/.exec(err())?.[0] ?? '';
  expect(nonce).not.toBe('');
  expect(err()).toContain('title');

  expect(h.server.seen.find((s) => s.path === '/api/challenge')?.body).toEqual({
    url: PAGE,
    action: 'claim',
  });
  expect(h.server.seen.find((s) => s.path === '/api/verify')?.body).toEqual({
    url: PAGE,
    nonce,
    claimToken: 'claim-token-secret-1',
  });

  const key = h.server.owners.get('thsm') ?? '';
  expect(keyOnDisk()).toBe(key);
  expect(statSync(h.keysPath).mode & 0o777).toBe(0o600);
  expect(h.server.seen.filter((s) => s.path === '/api/links').map((s) => s.auth)).toEqual([
    null,
    `Bearer ${key}`,
  ]);

  // The claim token is memory-only; the owner key may exist only in the key file.
  expect(everythingOnDisk()).not.toContain('claim-token-secret-1');
  expect(err() + out()).not.toContain('claim-token-secret-1');
  expect(h.logFile()).not.toContain(key);
  expect(err() + out()).not.toContain(key);
});

test('verification can be retried when the title has not published yet', async () => {
  let presses = 0;
  const follow = h.onAsk;
  h.onAsk = (question, stderr) => {
    if (question.includes('gone from the title')) return follow(question, stderr);
    return ++presses === 2 ? follow(question, stderr) : '';
  };
  expect(await h.exec(PAGE)).toBe(EXIT.ok);
  expect(presses).toBe(2);
  expect(err()).toContain('does not contain the code yet');
});

test('the code on the linked page never leaks into the link: slug and card come from the clean title', async () => {
  expect(await h.exec(PAGE)).toBe(EXIT.ok);
  expect(out()).toBe('https://short.test/thsm/our-trips\n');
  const link = h.server.links.get('thsm/our-trips');
  expect(link?.card.title).toBe('Our trips');
  expect(err()).toContain('remove the code from the page title');
});

test('if the code never leaves the title the link is not created, but the key is kept', async () => {
  h.onAsk = (question, stderr) => {
    if (question.includes('gone from the title')) return '';
    for (const nonce of stderr.match(/ntn-verify-\w+/g) ?? [])
      h.server.publishedNonces.set(nonce, PAGE);
    return '';
  };
  expect(await h.exec(PAGE)).toBe(EXIT.failure);
  expect(out()).toBe('');
  expect(h.server.links.size).toBe(0);
  expect(keyOnDisk()).toBe(h.server.owners.get('thsm') ?? 'missing');
  expect(err()).toContain('still in the page title');
});

test('the code can be put on a different page: its URL is what gets verified', async () => {
  const other = 'https://thsm.notion.site/Another-page-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  let asks = 0;
  h.onAsk = (_question, stderr) => {
    asks++;
    for (const nonce of stderr.match(/ntn-verify-\w+/g) ?? [])
      h.server.publishedNonces.set(nonce, other);
    return other;
  };
  expect(await h.exec(PAGE)).toBe(EXIT.ok);
  expect(h.server.seen.find((s) => s.path === '/api/verify')?.body).toMatchObject({ url: other });
  expect(asks).toBe(1); // the linked page was never touched, so no clean-up prompt
  expect(out()).toBe('https://short.test/thsm/our-trips\n');
});

test('a rejected saved key triggers a rotate challenge and replaces the key', async () => {
  ownThsm('newer-key-on-server', 'stale-key');
  expect(await h.exec(PAGE)).toBe(EXIT.ok);
  expect(h.server.seen.find((s) => s.path === '/api/challenge')?.body).toEqual({
    url: PAGE,
    action: 'rotate',
  });
  expect(keyOnDisk()).toBe(h.server.owners.get('thsm') ?? 'missing');
  expect(keyOnDisk()).not.toBe('stale-key');
  expect(h.logFile()).not.toContain('stale-key');
});

test('a key saved for one service is never sent to another origin', async () => {
  ownThsm();
  const other = startFakeServer();
  try {
    expect(await h.exec('ls', 'thsm', '--origin', other.origin)).toBe(EXIT.unauthorized);
    expect(other.seen.map((request) => request.auth)).toEqual([null]);
    h.onAsk = (question, stderr) => {
      if (question.includes('gone from the title')) other.publishedNonces.clear();
      else
        for (const nonce of stderr.match(/ntn-verify-\w+/g) ?? [])
          other.publishedNonces.set(nonce, PAGE);
      return '';
    };
    expect(await h.exec(PAGE, '--origin', other.origin, '--slug', 'x')).toBe(EXIT.ok);
    expect(other.seen.map((request) => request.auth).join()).not.toContain('saved-owner-key');
    // The production key is still there, and the other service got its own entry.
    expect(openKeyStore(h.keysPath).get(h.server.origin, 'thsm')).toBe('saved-owner-key');
    expect(openKeyStore(h.keysPath).get(other.origin, 'thsm')).toBe(
      other.owners.get('thsm') ?? 'missing',
    );
  } finally {
    other.stop();
  }
});

test('verification needed without a terminal: exit 3, no challenge or verify call', async () => {
  h.isTTY = false;
  expect(await h.exec(PAGE)).toBe(EXIT.verificationNeedsTerminal);
  expect(out()).toBe('');
  expect(h.server.seen.some((s) => s.path === '/api/challenge' || s.path === '/api/verify')).toBe(
    false,
  );
  expect(err()).toContain('terminal');
});

test('typed API error: message verbatim, nothing on stdout, mapped exit code', async () => {
  ownThsm();
  await h.exec(PAGE, '--slug', 'our-trips');
  clear();
  expect(await h.exec(PAGE, '--slug', 'our-trips')).toBe(EXIT.slug);
  expect(out()).toBe('');
  expect(err()).toContain('ntn-link: The slug "our-trips" is already taken in thsm.');
});

test.each([
  ['not_public', 422, EXIT.badPage],
  ['not_notion_url', 400, EXIT.badPage],
  ['rate_limited', 429, EXIT.rateLimited],
  ['upstream_error', 502, EXIT.failure],
] as const)('error code %s (HTTP %d) exits %d', async (code, status, exit) => {
  const extra = code === 'rate_limited' ? { retryAfterSeconds: 30 } : {};
  h.server.failNext = { code, status, message: `server says ${code}`, extra };
  expect(await h.exec(PAGE)).toBe(exit);
  expect(err()).toContain(`server says ${code}`);
  if (code === 'rate_limited') expect(err()).toContain('retry in 30s');
});

test('a non-JSON error page still gives a clean message and exit 1', async () => {
  const html = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response('<html>bad gateway</html>', { status: 502 }),
  });
  try {
    h.ioOverrides = {
      env: { XDG_CONFIG_HOME: join(h.dir, 'c'), NTN_LINK_ORIGIN: `http://127.0.0.1:${html.port}` },
    };
    expect(await h.exec(PAGE)).toBe(EXIT.failure);
    expect(err()).toContain('HTTP 502');
    expect(err()).not.toMatch(/\n\s+at /);
  } finally {
    html.stop(true);
  }
});

test('network failure: exit 10, readable message, no stack trace', async () => {
  h.ioOverrides = {
    env: { XDG_CONFIG_HOME: join(h.dir, 'c'), NTN_LINK_ORIGIN: 'http://127.0.0.1:1' },
  };
  expect(await h.exec(PAGE)).toBe(EXIT.network);
  expect(err()).toContain('cannot reach http://127.0.0.1:1');
  expect(err()).not.toMatch(/\n\s+at /);
  expect(out()).toBe('');
});

test('a body that dies after the headers is a network failure (exit 10), not a crash', async () => {
  // A raw socket promises 500 bytes, sends 13 and hangs up: the failure happens while reading the body.
  const flaky = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket) {
        socket.write(
          'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 500\r\n\r\n{"workspace":',
        );
        socket.end();
      },
    },
  });
  try {
    h.ioOverrides = {
      env: { XDG_CONFIG_HOME: join(h.dir, 'c'), NTN_LINK_ORIGIN: `http://127.0.0.1:${flaky.port}` },
    };
    expect(await h.exec(PAGE)).toBe(EXIT.network);
    expect(err()).toContain('cannot reach');
    expect(err()).not.toMatch(/\n\s+at /);
  } finally {
    flaky.stop(true);
  }
});

test('--copy copies the printed link; a failing clipboard only warns', async () => {
  ownThsm();
  expect(await h.exec(PAGE, '--copy')).toBe(EXIT.ok);
  expect(h.copied).toEqual(['https://short.test/thsm/our-trips']);
  h.server.links.clear();
  h.clipboardWorks = false;
  clear();
  expect(await h.exec(PAGE, '--copy')).toBe(EXIT.ok);
  expect(out()).toBe('https://short.test/thsm/our-trips\n');
  expect(err()).toContain('no clipboard tool found');
});

test('ls prints tab-separated rows; an empty namespace prints nothing on stdout', async () => {
  ownThsm();
  expect(await h.exec('ls', 'thsm')).toBe(EXIT.ok);
  expect(out()).toBe('');
  await h.exec(PAGE, '--slug', 'our-trips');
  clear();
  expect(await h.exec('ls', 'thsm')).toBe(EXIT.ok);
  expect(out()).toBe('our-trips\tOur trips\thttps://short.test/thsm/our-trips\n');
  expect(h.server.seen.at(-1)).toMatchObject({
    method: 'GET',
    path: '/api/ns/thsm/links',
    auth: 'Bearer saved-owner-key',
  });
});

test('set and rm send the right requests with the key and print nothing on stdout', async () => {
  ownThsm();
  await h.exec(PAGE, '--slug', 'our-trips', '--fast');
  clear();
  expect(await h.exec('set', 'thsm/our-trips', '--fast', 'off', '--title', '')).toBe(EXIT.ok);
  expect(h.server.seen.at(-1)).toMatchObject({
    method: 'PATCH',
    path: '/api/links/thsm/our-trips',
    auth: 'Bearer saved-owner-key',
    body: { fast: false, overrides: { title: null } },
  });
  expect(await h.exec('rm', 'thsm/our-trips')).toBe(EXIT.ok);
  expect(h.server.seen.at(-1)).toMatchObject({
    method: 'DELETE',
    path: '/api/links/thsm/our-trips',
    auth: 'Bearer saved-owner-key',
  });
  expect(h.server.links.size).toBe(0);
  expect(out()).toBe('');
});

test('wrong key on ls/rm/set: exit 7, server message, recovery hint, key not logged', async () => {
  ownThsm('real-key', 'wrong-key');
  for (const argv of [
    ['ls', 'thsm'],
    ['rm', 'thsm/x'],
    ['set', 'thsm/x', '--fast', 'on'],
  ]) {
    h.stderr.length = 0;
    expect(await h.exec(...argv)).toBe(EXIT.unauthorized);
    expect(err()).toContain('The owner key is missing or wrong.');
    expect(err()).toContain('ntn-link <notion-url>');
  }
  expect(out()).toBe('');
  expect(h.logFile()).not.toContain('wrong-key');
});

test('usage errors: exit 2, usage on stderr, empty stdout, no network, no log file', async () => {
  expect(await h.exec()).toBe(EXIT.usage);
  expect(await h.exec('rm', 'nope')).toBe(EXIT.usage);
  expect(out()).toBe('');
  expect(err()).toContain('Usage:');
  expect(h.server.seen.length).toBe(0);
  expect(existsSync(join(h.dir, LOG_NAME))).toBe(false);
});

test('no home directory and no XDG_CONFIG_HOME: config error exit 4 before any request', async () => {
  h.ioOverrides = { env: { NTN_LINK_ORIGIN: h.server.origin }, home: undefined };
  expect(await h.exec(PAGE)).toBe(EXIT.config);
  expect(h.server.seen.length).toBe(0);
  expect(err()).toContain('home directory');
});

test('--version and --help print to stdout only', async () => {
  expect(await h.exec('--version')).toBe(EXIT.ok);
  expect(out()).toBe('0.1.0\n');
  expect(err()).toBe('');
  clear();
  expect(await h.exec('--help')).toBe(EXIT.ok);
  expect(out()).toContain('Usage:');
  expect(err()).toBe('');
});

test('control characters from the server never reach the terminal', async () => {
  h.server.failNext = {
    code: 'not_public',
    status: 422,
    message: 'bad\u001b[31m page\u0007\nline2',
  };
  expect(await h.exec(PAGE)).toBe(EXIT.badPage);
  expect(err()).toContain('ntn-link: bad [31m page line2');
  expect(err()).not.toContain('\u001b');
  expect(err()).not.toContain('\u0007');
});

test('server-provided text never reaches the terminal raw: links, ls rows, challenge fields', async () => {
  ownThsm();
  h.server.redirectUrlOverride = 'https://short.test/x\u001b]52;c;ZXZpbA==\u0007';
  expect(await h.exec(PAGE, '--slug', 'evil')).toBe(EXIT.failure);
  expect(out()).toBe('');
  expect(err()).toContain('not a plain http(s) URL');
  expect(err()).not.toContain('\u001b');
  clear();
  expect(await h.exec('ls', 'thsm')).toBe(EXIT.ok);
  expect(out()).not.toContain('\u001b');
  expect(out().split('\n')[0]?.split('\t')).toHaveLength(3);
});

test('a page pasted in another Notion URL form is still recognised as the linked page', async () => {
  const alias =
    'https://thsm.notion.site/Page-413d447a-c4b1-8016-9985-c93eea7f02f9?source=copy_link';
  h.onAsk = (question, stderr) => {
    if (question.includes('gone from the title')) h.server.publishedNonces.clear();
    else
      for (const nonce of stderr.match(/ntn-verify-\w+/g) ?? [])
        h.server.publishedNonces.set(nonce, alias);
    return question.includes('gone from the title') ? '' : alias;
  };
  expect(await h.exec(PAGE)).toBe(EXIT.ok);
  expect(err()).toContain('remove the code from the page title'); // same page id: clean-up was required
  expect(out()).toBe('https://short.test/thsm/our-trips\n');
});

test('after an interrupted clean-up, the next run (with the saved key) still waits for a clean title', async () => {
  h.onAsk = (question, stderr) => {
    if (question.includes('gone from the title')) return '';
    for (const nonce of stderr.match(/ntn-verify-\w+/g) ?? [])
      h.server.publishedNonces.set(nonce, PAGE);
    return '';
  };
  expect(await h.exec(PAGE)).toBe(EXIT.failure); // clean-up never succeeds, but the key was saved
  expect(h.server.links.size).toBe(0);
  clear();

  h.isTTY = false;
  expect(await h.exec(PAGE)).toBe(EXIT.failure); // no terminal: refuses instead of snapshotting a dirty title
  expect(err()).toContain('still contains an ownership code');
  expect(h.server.links.size).toBe(0);

  h.isTTY = true;
  h.onAsk = () => {
    h.server.publishedNonces.clear(); // the user removed the code
    return '';
  };
  expect(await h.exec(PAGE)).toBe(EXIT.ok);
  expect([...h.server.links.keys()]).toEqual(['thsm/our-trips']);
});

test('a malformed success response never writes half a credential into the log', async () => {
  const broken = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () =>
      new Response(
        // Obviously fake fixture credentials.
        `{"workspace":"thsm","${'owner'}Key":"SECRETOWNERKEY1234567890","${'claim'}Token":"SECRETCLAIMTOKEN1234567890`, // gitleaks:allow (fake fixture)
        {
          headers: { 'content-type': 'application/json' },
        },
      ),
  });
  try {
    h.ioOverrides = {
      env: {
        XDG_CONFIG_HOME: join(h.dir, 'c'),
        NTN_LINK_ORIGIN: `http://127.0.0.1:${broken.port}`,
      },
    };
    expect(await h.exec(PAGE)).toBe(EXIT.failure);
    expect(h.logFile()).not.toContain('SECRETOWNERKEY');
    expect(h.logFile()).not.toContain('SECRETCLAIMTOKEN');
  } finally {
    broken.stop(true);
  }
});

test('every leftover verification code must be gone, not just the one from this run', async () => {
  h.server.publishedNonces.set('ntn-verify-zzzzzzzzzz', PAGE); // an older attempt's code
  let cleaned = 0;
  h.onAsk = (question, stderr) => {
    if (!question.includes('gone from the title')) {
      for (const nonce of stderr.match(/ntn-verify-\w+/g) ?? [])
        h.server.publishedNonces.set(nonce, PAGE);
      return '';
    }
    // First removal only takes out the older code; the next removes the rest.
    if (cleaned++ === 0) h.server.publishedNonces.delete('ntn-verify-zzzzzzzzzz');
    else h.server.publishedNonces.clear();
    return '';
  };
  ownThsm();
  expect(await h.exec(PAGE)).toBe(EXIT.ok);
  expect([...h.server.links.keys()]).toEqual(['thsm/our-trips']);
});

test('a malformed verify response cannot poison the key file', async () => {
  let verifyCalls = 0;
  const bad = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === '/api/preview') {
        return Response.json({ workspace: 'thsm', pageId: 'p', card: { title: 'T' } });
      }
      if (path === '/api/challenge') {
        return Response.json({
          workspace: 'thsm',
          action: 'claim',
          nonce: 'ntn-verify-abcdefghij',
          claimToken: 'ct-xxxxxxxx',
          expiresAt: 'x',
        });
      }
      if (path === '/api/verify') {
        verifyCalls++;
        return Response.json({
          workspace: 'thsm',
          action: 'claim',
          ownerKey: 123,
          removedLinks: 0,
          cleanupComplete: true,
        });
      }
      return Response.json(
        { error: { code: 'needs_verification', message: 'verify first', action: 'claim' } },
        { status: 403 },
      );
    },
  });
  try {
    ownThsm(); // a good production key that must survive
    const origin = `http://127.0.0.1:${bad.port}`;
    h.onAsk = () => '';
    expect(await h.exec(PAGE, '--origin', origin)).toBe(EXIT.failure);
    expect(err()).toContain('unexpected response shape');
    expect(verifyCalls).toBe(1); // the credential check itself was exercised
    expect(openKeyStore(h.keysPath).get(h.server.origin, 'thsm')).toBe('saved-owner-key');
    expect(openKeyStore(h.keysPath).get(origin, 'thsm')).toBeNull();
  } finally {
    bad.stop(true);
  }
});

test('a slow run cannot overwrite a newer key another run saved meanwhile', async () => {
  ownThsm('key-before', 'key-before');
  h.server.owners.set('thsm', 'other-key'); // make the server reject key-before so a rotate runs
  const follow = h.onAsk;
  h.onAsk = (question, stderr) => {
    // While this run waits for the user, a concurrent run finishes its own rotation.
    if (!question.includes('gone from the title')) {
      openKeyStore(h.keysPath).set(h.server.origin, 'thsm', 'newer-key-from-other-run');
    }
    return follow(question, stderr);
  };
  await h.exec(PAGE);
  expect(openKeyStore(h.keysPath).get(h.server.origin, 'thsm')).toBe('newer-key-from-other-run');
  expect(err()).toContain('saved a newer key');
});

test('sweep repeats until the service reports it is done, prints only a summary on stderr', async () => {
  ownThsm();
  h.server.sweepAnswers.push(
    { removedLinks: 2, cleanupComplete: false },
    { removedLinks: 1, cleanupComplete: false },
    { removedLinks: 0, cleanupComplete: true },
  );
  expect(await h.exec('sweep', 'thsm')).toBe(EXIT.ok);
  expect(out()).toBe('');
  const sweeps = h.server.seen.filter((s) => s.path === '/api/ns/thsm/sweep');
  expect(sweeps).toHaveLength(3);
  expect(sweeps.every((s) => s.method === 'POST' && s.auth === 'Bearer saved-owner-key')).toBe(
    true,
  );
  expect(sweeps[0]?.body).toBeUndefined(); // empty body
  expect(h.sleeps).toHaveLength(2); // a pause between attempts, none after the last
  const lines = err()
    .split('\n')
    .filter((l) => l !== '' && !l.startsWith('log: '));
  expect(lines).toEqual(['Swept "thsm": removed 3 link(s); cleanup complete.']);
});

test('sweep gives up after a bounded number of attempts with its own exit code', async () => {
  ownThsm();
  h.server.sweepAnswers.push(
    ...Array.from({ length: 50 }, () => ({ removedLinks: 1, cleanupComplete: false })),
  );
  expect(await h.exec('sweep', 'thsm')).toBe(EXIT.sweepIncomplete);
  expect(out()).toBe('');
  expect(h.server.seen.filter((s) => s.path === '/api/ns/thsm/sweep')).toHaveLength(10);
  expect(err()).toContain('has not finished after 10 attempts');
  expect(err()).toContain('ntn-link sweep thsm');
});

test('sweep against a service without the route says so (404 and 405)', async () => {
  ownThsm();
  h.server.sweepRoute = false;
  expect(await h.exec('sweep', 'thsm')).toBe(EXIT.sweepUnsupported);
  expect(err()).toContain('does not support sweeping');
  expect(out()).toBe('');
  expect(h.server.seen.filter((s) => s.path === '/api/ns/thsm/sweep')).toHaveLength(1);

  clear();
  const methodNotAllowed = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response('Method Not Allowed', { status: 405 }),
  });
  try {
    openKeyStore(h.keysPath).set(`http://127.0.0.1:${methodNotAllowed.port}`, 'thsm', 'k');
    expect(
      await h.exec('sweep', 'thsm', '--origin', `http://127.0.0.1:${methodNotAllowed.port}`),
    ).toBe(EXIT.sweepUnsupported);
    expect(err()).toContain('HTTP 405');
  } finally {
    methodNotAllowed.stop(true);
  }
});

test('sweep with a wrong key: exit 7 with the recovery hint', async () => {
  ownThsm('real-key', 'wrong-key');
  expect(await h.exec('sweep', 'thsm')).toBe(EXIT.unauthorized);
  expect(err()).toContain('ntn-link <notion-url>');
  expect(h.logFile()).not.toContain('wrong-key');
});

test('a rotation whose cleanup did not finish tells the user to run sweep', async () => {
  ownThsm('real-key', 'stale-key');
  h.server.verifyCleanupComplete = false;
  expect(await h.exec(PAGE)).toBe(EXIT.ok);
  expect(err().split('\n')).toContain('run: ntn-link sweep thsm');
  expect(out()).toBe('https://short.test/thsm/our-trips\n');
});

test('no sweep hint when the cleanup finished', async () => {
  ownThsm('real-key', 'stale-key');
  expect(await h.exec(PAGE)).toBe(EXIT.ok);
  expect(err()).not.toContain('ntn-link sweep');
});

test('a hostile workspace name never ends up in the copy-paste hint', async () => {
  const hostile = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === '/api/preview') {
        return Response.json({
          workspace: 'thsm',
          pageId: 'p',
          card: { title: 'Our trips', description: '', imageUrl: null, language: null },
        });
      }
      if (path === '/api/challenge') {
        return Response.json({
          workspace: 'thsm',
          action: 'claim',
          nonce: 'ntn-verify-abcdefghij',
          claimToken: 'tok',
          expiresAt: '2030-01-01T00:00:00Z',
        });
      }
      if (path === '/api/verify') {
        return Response.json({
          workspace: 'thsm',
          action: 'claim',
          ownerKey: 'k',
          removedLinks: 0,
          cleanupComplete: false,
        });
      }
      return Response.json(
        { error: { code: 'needs_verification', message: 'verify', action: 'claim' } },
        { status: 403 },
      );
    },
  });
  try {
    h.onAsk = () => '';
    await h.exec(PAGE, '--origin', `http://127.0.0.1:${hostile.port}`);
    expect(err()).toContain('run: ntn-link sweep thsm');
    expect(err()).toContain(`--origin http://127.0.0.1:${hostile.port}`);
  } finally {
    hostile.stop(true);
  }
});

test('a verification URL with a conflicting ?p= query cannot skip the clean-up of the title', async () => {
  // Percent-encoded hyphens hide the page id from a naive local parse; the service resolves it.
  const odd =
    'https://thsm.notion.site/Our%2Dtrips%2D413d447ac4b180169985c93eea7f02f9?p=00000000000000000000000000000001';
  h.onAsk = (question, stderr) => {
    if (question.includes('gone from the title')) h.server.publishedNonces.clear();
    else
      for (const nonce of stderr.match(/ntn-verify-\w+/g) ?? [])
        h.server.publishedNonces.set(nonce, odd);
    return question.includes('gone from the title') ? '' : odd;
  };
  expect(await h.exec(PAGE)).toBe(EXIT.ok);
  expect(err()).toContain('remove the code from the page title'); // same page per the service
  expect(out()).toBe('https://short.test/thsm/our-trips\n'); // no code in slug or title
  const previews = h.server.seen.filter((s) => s.path === '/api/preview').map((s) => s.body);
  expect(previews).toContainEqual({ url: odd });
});

test('a verification page that really is another page needs no clean-up of the linked title', async () => {
  const other = 'https://thsm.notion.site/Other-11111111111111111111111111111111';
  h.onAsk = (question, stderr) => {
    for (const nonce of stderr.match(/ntn-verify-\w+/g) ?? [])
      h.server.publishedNonces.set(nonce, other);
    return other;
  };
  expect(await h.exec(PAGE)).toBe(EXIT.ok);
  expect(err()).not.toContain('remove the code from the page title');
});

test('two overlapping rotations of one workspace leave the key that is valid on the server', async () => {
  ownThsm('real-key', 'stale-key');
  // Both runs start with the same rejected key and each wants to rotate; the user takes a moment
  // to publish the code each time.
  h.onAsk = async (question, stderr) => {
    if (question.includes('gone from the title')) {
      h.server.publishedNonces.clear();
      return '';
    }
    await Bun.sleep(150);
    for (const nonce of stderr.match(/ntn-verify-\w+/g) ?? [])
      h.server.publishedNonces.set(nonce, PAGE);
    return '';
  };
  const [first, second] = await Promise.all([
    h.exec(PAGE, '--slug', 'one'),
    h.exec(PAGE, '--slug', 'two'),
  ]);
  expect([first, second]).toEqual([EXIT.ok, EXIT.ok]);
  expect([...h.server.links.keys()].toSorted()).toEqual(['thsm/one', 'thsm/two']);
  expect(keyOnDisk()).toBe(h.server.owners.get('thsm') ?? null);
  expect(h.server.seen.filter((s) => s.path === '/api/verify')).toHaveLength(1);
  expect(err()).toContain('Another ntn-link run');
});

test("a run that picks up another run's key still waits for the code to leave the linked title", async () => {
  ownThsm('real-key', 'stale-key');
  // The first run answers the clean-up prompt slowly; the second one gets the saved key meanwhile
  // and must not snapshot the title that still carries the first run's code.
  h.onAsk = async (question, stderr) => {
    if (question.includes('gone from the title')) {
      await Bun.sleep(300);
      h.server.publishedNonces.clear();
      return '';
    }
    for (const nonce of stderr.match(/ntn-verify-\w+/g) ?? [])
      h.server.publishedNonces.set(nonce, PAGE);
    return '';
  };
  const [first, second] = await Promise.all([
    h.exec(PAGE, '--slug', 'one'),
    h.exec(PAGE, '--slug', 'two'),
  ]);
  expect([first, second]).toEqual([EXIT.ok, EXIT.ok]);
  for (const link of h.server.links.values()) expect(link.card.title).toBe('Our trips');
  expect(h.server.links.size).toBe(2);
});
