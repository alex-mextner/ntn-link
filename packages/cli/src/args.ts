/**
 * Hand-written argument parser (the bundle must have zero runtime dependencies).
 * Pure: takes argv and env, returns a typed command or throws UsageError.
 */
import { DEFAULT_ORIGIN } from './config';

export type CanonicalMode = 'self' | 'notion';

export type Command =
  | { kind: 'create'; url: string; slug?: string; fast: boolean; copy: boolean }
  | { kind: 'ls'; ws: string }
  | { kind: 'rm'; target: string }
  | { kind: 'sweep'; ws: string }
  | {
      kind: 'set';
      target: string;
      title?: string;
      description?: string;
      slug?: string;
      fast?: boolean;
      canonicalMode?: CanonicalMode;
    }
  | { kind: 'help' }
  | { kind: 'version' };

export interface Parsed {
  command: Command;
  origin: string;
}

export class UsageError extends Error {}

type Env = Record<string, string | undefined>;

interface Flags {
  values: Map<string, string>;
  switches: Set<string>;
  positionals: string[];
}

const VALUE_FLAGS = new Set(['slug', 'origin', 'title', 'description', 'canonical']);
const SWITCH_FLAGS = new Set(['copy', 'help', 'version']);

/**
 * Handles one `--name[=value]` argument; returns how many following argv items it consumed.
 * `--fast` is a bare switch for create but takes on|off for set. The verb is only known after
 * all flags (including leading global ones) are read, so it is taken as a value only when the
 * next word is exactly on/off, and each command validates the form it expects.
 */
function readLongFlag(arg: string, next: string | undefined, flags: Flags): number {
  const eq = arg.indexOf('=');
  const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
  const inline = eq === -1 ? undefined : arg.slice(eq + 1);
  if (name === 'fast') return readFast(inline, next, flags);
  if (VALUE_FLAGS.has(name)) {
    const value = inline ?? next;
    // A following option token is a missing value, not the value (use --name=--literal if intended).
    if (value === undefined || (inline === undefined && value.startsWith('--'))) {
      throw new UsageError(`--${name} needs a value`);
    }
    flags.values.set(name, value);
    return inline === undefined ? 1 : 0;
  }
  if (SWITCH_FLAGS.has(name) && inline === undefined) {
    flags.switches.add(name);
    return 0;
  }
  throw new UsageError(`unknown option ${arg}`);
}

function readFast(inline: string | undefined, next: string | undefined, flags: Flags): number {
  if (inline !== undefined) {
    flags.values.set('fast', inline);
    return 0;
  }
  if (next === 'on' || next === 'off') {
    flags.values.set('fast', next);
    return 1;
  }
  flags.switches.add('fast');
  return 0;
}

function splitFlags(argv: string[]): Flags {
  const flags: Flags = { values: new Map(), switches: new Set(), positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '-h') flags.switches.add('help');
    else if (arg === '-v') flags.switches.add('version');
    else if (arg.startsWith('--')) i += readLongFlag(arg, argv[i + 1], flags);
    else flags.positionals.push(arg);
  }
  return flags;
}

function pickOrigin(flags: Flags, env: Env): string {
  const raw = flags.values.get('origin') ?? env['NTN_LINK_ORIGIN'] ?? DEFAULT_ORIGIN;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`invalid origin: ${raw}`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  // The owner key travels as a bearer token, so plain HTTP is only acceptable on loopback.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new UsageError(`origin must be https (http only for localhost): ${raw}`);
  }
  return url.origin;
}

function requireTarget(value: string | undefined, what: string): string {
  if (value === undefined || !/^[^/\s]+\/[^/\s]+$/.test(value)) {
    throw new UsageError(`${what} needs <workspace>/<slug>`);
  }
  return value;
}

function onOff(value: string, flag: string): boolean {
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new UsageError(`--${flag} takes on or off`);
}

function noExtra(
  flags: Flags,
  allowedValues: string[],
  cmd: string,
  positionals: number,
  allowedSwitches: string[] = [],
): void {
  const stray =
    [...flags.values.keys()].some((k) => k !== 'origin' && !allowedValues.includes(k)) ||
    [...flags.switches].some((k) => !allowedSwitches.includes(k));
  if (stray || flags.positionals.length > positionals) {
    throw new UsageError(`unexpected argument for ${cmd}`);
  }
}

function parseSet(flags: Flags): Command {
  const target = requireTarget(flags.positionals[1], 'set');
  const canonical = flags.values.get('canonical');
  if (canonical !== undefined && canonical !== 'self' && canonical !== 'notion') {
    throw new UsageError('--canonical takes self or notion');
  }
  if (flags.switches.has('fast')) throw new UsageError('--fast takes on or off for set');
  const fast = flags.values.get('fast');
  const command: Command = { kind: 'set', target };
  for (const key of ['title', 'description', 'slug'] as const) {
    const value = flags.values.get(key);
    if (value !== undefined) command[key] = value;
  }
  if (fast !== undefined) command.fast = onOff(fast, 'fast');
  if (canonical !== undefined) command.canonicalMode = canonical;
  const changes = ['title', 'description', 'slug', 'fast', 'canonical'];
  if (!changes.some((k) => flags.values.has(k))) {
    throw new UsageError(
      'set needs at least one of --title, --description, --slug, --fast, --canonical',
    );
  }
  noExtra(flags, changes, 'set', 2);
  return command;
}

function parseCommand(flags: Flags): Command {
  if (flags.switches.has('help')) return { kind: 'help' };
  if (flags.switches.has('version')) return { kind: 'version' };
  const [verb, arg] = flags.positionals;
  if (verb === 'ls') {
    if (arg === undefined || arg.includes('/')) throw new UsageError('ls needs <workspace>');
    noExtra(flags, [], 'ls', 2);
    return { kind: 'ls', ws: arg };
  }
  if (verb === 'rm') {
    const target = requireTarget(arg, 'rm');
    noExtra(flags, [], 'rm', 2);
    return { kind: 'rm', target };
  }
  if (verb === 'sweep') {
    if (arg === undefined || arg.includes('/')) throw new UsageError('sweep needs <workspace>');
    noExtra(flags, [], 'sweep', 2);
    return { kind: 'sweep', ws: arg };
  }
  if (verb === 'help') return { kind: 'help' };
  if (verb === undefined) throw new UsageError('missing Notion URL');
  noExtra(flags, ['slug'], 'create', 1, ['fast', 'copy']);
  const slug = flags.values.get('slug');
  return {
    kind: 'create',
    url: verb,
    ...(slug === undefined ? {} : { slug }),
    fast: flags.switches.has('fast'),
    copy: flags.switches.has('copy'),
  };
}

export function parseArgs(argv: string[], env: Env): Parsed {
  const flags = splitFlags(argv);
  const isSet = flags.positionals[0] === 'set' && !flags.switches.has('help');
  const command = isSet ? parseSet(flags) : parseCommand(flags);
  return { command, origin: pickOrigin(flags, env) };
}
