/** Shared command context: the injected side effects plus the helpers every command uses. */
import type { Api, FetchFn } from './api';
import { plainText } from './errors';
import type { KeyStore } from './keys';
import type { RunLog } from './log';

export interface Io {
  fetch: FetchFn;
  env: Record<string, string | undefined>;
  home: string | undefined;
  tmp: string;
  now(): Date;
  pid: number;
  stdout(s: string): void;
  stderr(s: string): void;
  isTTY: boolean;
  /** Shows the question on stderr and resolves with the line the user typed (empty for a bare Enter). */
  ask(question: string): Promise<string>;
  copy(text: string): Promise<boolean>;
}

export interface Ctx {
  io: Io;
  /** Service origin; saved keys are looked up and stored per origin. */
  origin: string;
  log: RunLog;
  api: Api;
  keys: KeyStore;
}

/** Progress and messages for humans: stderr, mirrored into the log. */
export function say(ctx: Ctx, line: string): void {
  // Some lines embed server-provided text (challenge fields, messages): never let it carry escapes.
  const safe = plainText(line);
  ctx.io.stderr(`${safe}\n`);
  ctx.log.write(`stderr: ${safe}`);
}

/** Looks up the saved key and registers it with the log so it can never be written. */
export function keyFor(ctx: Ctx, ws: string): string | null {
  const key = ctx.keys.get(ctx.origin, ws);
  if (key) ctx.log.secret(key);
  return key;
}
