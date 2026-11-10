/** Where the owner keys live. Pure so tests need no real home directory. */
import { join } from 'node:path';

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

export function keysFilePath(env: Env, home: string | undefined): string {
  const xdg = env['XDG_CONFIG_HOME'];
  // The XDG spec says a relative XDG_CONFIG_HOME must be ignored.
  if (xdg !== undefined && xdg.startsWith('/')) return join(xdg, 'ntn-link', 'keys.json');
  if (home === undefined || home === '') {
    throw new ConfigError(
      'cannot find a home directory for the key file (set HOME or XDG_CONFIG_HOME)',
    );
  }
  return join(home, '.config', 'ntn-link', 'keys.json');
}
