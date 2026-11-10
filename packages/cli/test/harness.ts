/** Test wiring: a real Io whose side effects are captured and redirected into a temp dir. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Io } from '../src/ctx';
import { run } from '../src/run';
import { type FakeServer, startFakeServer } from './fake-server';

export const LOG_NAME = 'ntn-link-20261110T120000-4242.log';

export interface Harness {
  server: FakeServer;
  dir: string;
  keysPath: string;
  stdout: string[];
  stderr: string[];
  copied: string[];
  /** Delays the CLI asked to sleep (the harness never actually waits). */
  sleeps: number[];
  /**
   * Answers a CLI prompt. Default behaviour mimics a user who follows the instructions: puts every
   * nonce shown so far into the title of `codePage` (default: the linked page), and removes them
   * again when asked to clean the title.
   */
  onAsk: (question: string, stderrSoFar: string) => string | Promise<string>;
  /** Page the user puts the code on; defaults to the first argument of exec(). */
  codePage: string | undefined;
  clipboardWorks: boolean;
  isTTY: boolean;
  /** Overrides applied on top of the harness Io (for home/env/origin experiments). */
  ioOverrides: Partial<Io>;
  exec(...argv: string[]): Promise<number>;
  logFile(): string;
  cleanup(): void;
}

export function makeHarness(): Harness {
  let currentPage = '';
  const server = startFakeServer();
  const dir = mkdtempSync(join(tmpdir(), 'ntn-link-cli-test-'));
  const h: Harness = {
    server,
    dir,
    keysPath: join(dir, 'config', 'ntn-link', 'keys.json'),
    stdout: [],
    stderr: [],
    copied: [],
    sleeps: [],
    clipboardWorks: true,
    isTTY: true,
    ioOverrides: {},
    codePage: undefined,
    onAsk: (question, stderr) => {
      if (question.includes('gone from the title')) server.publishedNonces.clear();
      else
        for (const nonce of stderr.match(/ntn-verify-\w+/g) ?? [])
          server.publishedNonces.set(nonce, h.codePage ?? currentPage);
      return '';
    },
    async exec(...argv) {
      currentPage = argv[0] ?? '';
      const io: Io = {
        fetch: (url, init) => fetch(url, init),
        env: { XDG_CONFIG_HOME: join(dir, 'config'), NTN_LINK_ORIGIN: server.origin },
        home: dir,
        tmp: dir,
        now: () => new Date('2026-11-10T12:00:00Z'),
        pid: 4242,
        stdout: (s) => void h.stdout.push(s),
        stderr: (s) => void h.stderr.push(s),
        isTTY: h.isTTY,
        ask: async (question) => h.onAsk(question, h.stderr.join('')),
        copy: async (text) => {
          if (h.clipboardWorks) h.copied.push(text);
          return h.clipboardWorks;
        },
        sleep: async (ms) => void h.sleeps.push(ms),
        ...h.ioOverrides,
      };
      return run(argv, io);
    },
    logFile: () => readFileSync(join(dir, LOG_NAME), 'utf8'),
    cleanup() {
      server.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}
