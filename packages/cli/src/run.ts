/**
 * Entry logic with all side effects behind `Io` so tests can drive it against a fake
 * server. stdout carries only the result (the link, or `ls` rows); everything else
 * (progress, prompts, errors, the log path) goes to stderr.
 */
import pkg from '../package.json';
import { ApiFailure, NetworkFailure, createApi } from './api';
import { type Command, UsageError, parseArgs } from './args';
import { create, list, remove, update } from './commands';
import { type Ctx, type Io, say } from './ctx';
import { EXIT, Fail, exitCodeFor, plainText } from './errors';
import { openKeyStore } from './keys';
import { type RunLog, openRunLog } from './log';
import { ConfigError, keysFilePath } from './paths';

export type { Io } from './ctx';

const USAGE = `ntn-link ${pkg.version} - short links for public Notion pages

Usage:
  ntn-link <notion-url> [--slug name] [--fast] [--copy] [--origin URL]
  ntn-link ls <workspace>
  ntn-link rm <workspace>/<slug>
  ntn-link set <workspace>/<slug> [--title T] [--description D] [--slug S]
                                  [--fast on|off] [--canonical self|notion]

Prints only the short link on stdout (the fast /read link with --fast).
An empty --title or --description removes that override.
Environment: NTN_LINK_ORIGIN (service origin), XDG_CONFIG_HOME (key file location).
`;

const UNAUTHORIZED_HINT =
  '\nThe saved owner key for this workspace is missing or wrong. To get a new one run `ntn-link <notion-url>` for a page of that workspace.';

function describeFailure(error: unknown): { message: string; exit: number } {
  if (error instanceof Fail) return { message: error.message, exit: error.exit };
  if (error instanceof ApiFailure) {
    const wait =
      error.retryAfterSeconds === undefined ? '' : ` (retry in ${error.retryAfterSeconds}s)`;
    const hint = error.code === 'unauthorized' ? UNAUTHORIZED_HINT : '';
    return { message: `${error.message}${wait}${hint}`, exit: exitCodeFor(error.code) };
  }
  if (error instanceof NetworkFailure) return { message: error.message, exit: EXIT.network };
  if (error instanceof ConfigError) return { message: error.message, exit: EXIT.config };
  const detail = error instanceof Error ? error.message : String(error);
  return { message: `unexpected error: ${detail}`, exit: EXIT.failure };
}

const EXPECTED_FAILURES = [Fail, ApiFailure, NetworkFailure, ConfigError];

async function dispatch(ctx: Ctx, command: Command): Promise<void> {
  if (command.kind === 'create') await create(ctx, command);
  else if (command.kind === 'ls') await list(ctx, command.ws);
  else if (command.kind === 'rm') await remove(ctx, command.target);
  else if (command.kind === 'set') await update(ctx, command);
}

async function execute(io: Io, command: Command, origin: string, log: RunLog): Promise<number> {
  try {
    const keys = openKeyStore(keysFilePath(io.env, io.home));
    const ctx: Ctx = { io, origin, log, api: createApi(origin, io.fetch, log, pkg.version), keys };
    await dispatch(ctx, command);
    for (const warning of keys.warnings) say(ctx, `Warning: ${warning}`);
    return EXIT.ok;
  } catch (error) {
    const failure = describeFailure(error);
    io.stderr(`ntn-link: ${plainText(failure.message)}\n`);
    log.write(`failed exit=${failure.exit}: ${failure.message}`);
    // A bug (not a user or server error) is worth a stack in the log, never on the terminal.
    if (error instanceof Error && !EXPECTED_FAILURES.some((type) => error instanceof type)) {
      log.write(`stack: ${error.stack ?? ''}`);
    }
    return failure.exit;
  }
}

export async function run(argv: string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv, io.env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`ntn-link: ${error.message}\n\n${USAGE}`);
    return EXIT.usage;
  }
  const { command, origin } = parsed;
  if (command.kind === 'help' || command.kind === 'version') {
    io.stdout(command.kind === 'help' ? USAGE : `${pkg.version}\n`);
    return EXIT.ok;
  }

  const log = openRunLog(io.now(), io.pid, io.tmp);
  io.stderr(`log: ${log.path}\n`);
  log.write(`ntn-link ${pkg.version} command=${command.kind} origin=${origin}`);
  const exit = await execute(io, command, origin, log);
  log.write(`exit ${exit}`);
  io.stderr(`log: ${log.path}\n`);
  log.close();
  return exit;
}
