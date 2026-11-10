/**
 * Guard for the suites that run against a REAL, shared Postgres (`bun run test:neon`).
 *
 * A run once wrote 219 rows into the production database because the suite took whatever
 * `DATABASE_URL` held, and a pulled production `.env` puts exactly that variable into every
 * `bun test`. So the suite no longer reads `DATABASE_URL` at all. It runs only against a URL
 * given in `NTN_TEST_DATABASE_URL`, only with the explicit opt-in `NTN_ALLOW_LIVE_DB_TESTS=1`,
 * and never against a database the application itself is configured for (same host as any
 * of the app's connection variables, pooled or direct) or inside a production environment.
 * Nothing here prints the URL: refusals name the variable, never its value.
 */

export const LIVE_DB_URL_VAR = 'NTN_TEST_DATABASE_URL';
export const LIVE_DB_OPT_IN_VAR = 'NTN_ALLOW_LIVE_DB_TESTS';

/** Connection strings the app or the Vercel/Neon integration puts into its environment. */
const APP_URL_VARS = [
  'DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
  'POSTGRES_URL',
  'POSTGRES_URL_NON_POOLING',
  'POSTGRES_URL_NO_SSL',
  'POSTGRES_PRISMA_URL',
] as const;

/** Bare host names of the same integration. */
const APP_HOST_VARS = ['PGHOST', 'PGHOST_UNPOOLED', 'POSTGRES_HOST'] as const;

export type LiveDbEnv = Readonly<Record<string, string | undefined>>;

export type LiveDbTarget =
  /** Nothing asked for a live run: the suite is skipped. */
  { readonly kind: 'skip' } | { readonly kind: 'run'; readonly url: string };

export class LiveDbRefusedError extends Error {
  override name = 'LiveDbRefusedError';
}

/**
 * Host of a Neon endpoint without its pooler marker: `ep-x-pooler.r.neon.tech` and
 * `ep-x.r.neon.tech` are the same database.
 */
function endpointOf(host: string): string {
  // A trailing dot (`host.`) is the same host in DNS.
  const lower = host.trim().toLowerCase().replace(/\.$/, '');
  const [first = '', ...rest] = lower.split('.');
  return [first.replace(/-pooler$/, ''), ...rest].join('.');
}

function hostOfUrl(raw: string): string | null {
  try {
    const { hostname } = new URL(raw);
    return hostname === '' ? null : hostname;
  } catch {
    return null;
  }
}

function appEndpoints(env: LiveDbEnv): Set<string> {
  const endpoints = new Set<string>();
  for (const name of APP_URL_VARS) {
    const value = env[name]?.trim();
    const host = value ? hostOfUrl(value) : null;
    if (host !== null) endpoints.add(endpointOf(host));
  }
  for (const name of APP_HOST_VARS) {
    const value = env[name]?.trim();
    if (value) endpoints.add(endpointOf(value));
  }
  return endpoints;
}

/**
 * Decides whether the live-database suite may run. Throws `LiveDbRefusedError` when a live
 * URL is given but the run is not explicitly allowed or would hit the app's own database.
 */
export function liveDbTarget(env: LiveDbEnv): LiveDbTarget {
  const url = env[LIVE_DB_URL_VAR]?.trim();
  if (!url) return { kind: 'skip' };
  if (env[LIVE_DB_OPT_IN_VAR] !== '1') {
    throw new LiveDbRefusedError(
      `Refusing to run against a live database: set ${LIVE_DB_OPT_IN_VAR}=1 to confirm that ${LIVE_DB_URL_VAR} is a disposable test database or branch.`,
    );
  }
  if (env['VERCEL_ENV'] === 'production' || env['NODE_ENV'] === 'production') {
    throw new LiveDbRefusedError(
      'Refusing to run live-database tests in a production environment.',
    );
  }
  const host = hostOfUrl(url);
  if (host === null) {
    throw new LiveDbRefusedError(`${LIVE_DB_URL_VAR} is not a valid connection URL.`);
  }
  if (appEndpoints(env).has(endpointOf(host))) {
    throw new LiveDbRefusedError(
      `Refusing to run against the application's own database: ${LIVE_DB_URL_VAR} points at the same host as DATABASE_URL or another app connection variable. Use a separate Neon branch.`,
    );
  }
  return { kind: 'run', url };
}
