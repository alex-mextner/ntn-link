/** The live-database guard: what may and may not reach a real, shared Postgres. */
import { describe, expect, test } from 'bun:test';
import {
  LIVE_DB_OPT_IN_VAR,
  LIVE_DB_URL_VAR,
  LiveDbRefusedError,
  liveDbTarget,
} from './support/live-db-guard';

const FAKE_CREDENTIAL = 'not-a-real-password';
const APP_HOST = 'ep-app-1234-pooler.eu-central-1.aws.neon.tech';
const APP = `postgres://owner:${FAKE_CREDENTIAL}@${APP_HOST}/neondb?sslmode=require`;
const BRANCH = `postgres://owner:${FAKE_CREDENTIAL}@ep-branch-5678.eu-central-1.aws.neon.tech/neondb`;
const OPT_IN = { [LIVE_DB_OPT_IN_VAR]: '1' };

function refusal(env: Record<string, string>): LiveDbRefusedError {
  try {
    liveDbTarget(env);
  } catch (error) {
    if (error instanceof LiveDbRefusedError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('liveDbTarget', () => {
  test('without a test URL the suite is skipped, whatever else is in the environment', () => {
    const envs = [
      {},
      { DATABASE_URL: APP },
      { DATABASE_URL: APP, ...OPT_IN },
      { [LIVE_DB_URL_VAR]: '  ' },
    ];
    for (const env of envs) expect(liveDbTarget(env)).toEqual({ kind: 'skip' });
  });

  test('a production DATABASE_URL alone never starts a run', () => {
    const env = { DATABASE_URL: APP, POSTGRES_URL: APP, PGHOST: APP_HOST };
    expect(liveDbTarget(env).kind).toBe('skip');
  });

  test('a test URL without the explicit opt-in is refused', () => {
    expect(() => liveDbTarget({ [LIVE_DB_URL_VAR]: BRANCH })).toThrow(LiveDbRefusedError);
    for (const value of ['', '0', 'true', 'yes', ' 1']) {
      expect(() =>
        liveDbTarget({ [LIVE_DB_URL_VAR]: BRANCH, [LIVE_DB_OPT_IN_VAR]: value }),
      ).toThrow(LiveDbRefusedError);
    }
  });

  test('a separate database with the opt-in runs, with the URL trimmed', () => {
    const env = { [LIVE_DB_URL_VAR]: ` ${BRANCH} `, ...OPT_IN, DATABASE_URL: APP };
    expect(liveDbTarget(env)).toEqual({ kind: 'run', url: BRANCH });
  });

  test('the same database as any app variable is refused, pooled or direct, in any case', () => {
    const direct = APP.replace('-pooler', '');
    const upper = APP.replace(APP_HOST, APP_HOST.toUpperCase().replace('-POOLER', ''));
    const cases: Record<string, string>[] = [
      { [LIVE_DB_URL_VAR]: APP, DATABASE_URL: APP },
      { [LIVE_DB_URL_VAR]: direct, DATABASE_URL: APP },
      { [LIVE_DB_URL_VAR]: APP, DATABASE_URL: direct },
      { [LIVE_DB_URL_VAR]: upper, DATABASE_URL: APP },
      { [LIVE_DB_URL_VAR]: APP.replace(APP_HOST, `${APP_HOST}.`), DATABASE_URL: APP },
      { [LIVE_DB_URL_VAR]: APP, PGHOST: `${APP_HOST}.` },
      { [LIVE_DB_URL_VAR]: APP, DATABASE_URL_UNPOOLED: direct },
      { [LIVE_DB_URL_VAR]: APP, POSTGRES_URL: APP },
      { [LIVE_DB_URL_VAR]: APP, POSTGRES_PRISMA_URL: APP },
      { [LIVE_DB_URL_VAR]: APP, PGHOST: APP_HOST },
      { [LIVE_DB_URL_VAR]: APP, PGHOST_UNPOOLED: APP_HOST.replace('-pooler', '') },
    ];
    for (const env of cases) {
      expect(refusal({ ...env, ...OPT_IN }).message).toContain("application's own database");
    }
  });

  test('a production environment is refused even with the opt-in', () => {
    for (const marker of [{ VERCEL_ENV: 'production' }, { NODE_ENV: 'production' }]) {
      expect(() => liveDbTarget({ [LIVE_DB_URL_VAR]: BRANCH, ...OPT_IN, ...marker })).toThrow(
        LiveDbRefusedError,
      );
    }
  });

  test('an unparseable URL is refused', () => {
    expect(refusal({ [LIVE_DB_URL_VAR]: 'not a url', ...OPT_IN }).message).toContain('not a valid');
  });

  test('a refusal never contains the URL or its credentials', () => {
    const errors = [
      refusal({ [LIVE_DB_URL_VAR]: APP }),
      refusal({ [LIVE_DB_URL_VAR]: APP, DATABASE_URL: APP, ...OPT_IN }),
      refusal({ [LIVE_DB_URL_VAR]: BRANCH, NODE_ENV: 'production', ...OPT_IN }),
    ];
    for (const error of errors) {
      for (const leaked of [FAKE_CREDENTIAL, 'ep-app-1234', 'ep-branch-5678', 'postgres://']) {
        expect(error.message).not.toContain(leaked);
      }
    }
  });
});
