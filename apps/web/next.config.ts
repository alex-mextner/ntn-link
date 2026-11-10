import path from 'node:path';
import type { NextConfig } from 'next';

const workspaceRoot = path.join(import.meta.dirname, '..', '..');

/** Twemoji SVGs the title card reads at request time (about 3,700 small files). */
const EMOJI_SVGS = './node_modules/@twemoji/svg/*.svg';

/** The favicon set (file conventions in app/): the links carry a content hash, bare requests do not. */
const FAVICON_PATHS = [
  '/favicon.ico',
  '/icon.svg',
  '/icon1.png',
  '/icon2.png',
  '/icon3.png',
  '/apple-icon.png',
] as const;

const config: NextConfig = {
  // Core is shipped as TypeScript source.
  transpilePackages: ['@ntn-link/core'],
  // The workspace root is the tracing root so packages/core lands in the serverless bundle.
  outputFileTracingRoot: workspaceRoot,
  // The title card reads its fonts and emoji pictures from disk at request time; tracing cannot see that.
  outputFileTracingIncludes: {
    '/img/[workspace]/[slug]': [EMOJI_SVGS, './assets/fonts/**'],
  },
  poweredByHeader: false,
  // A day fresh, a week stale-while-revalidate: a changed logo shows within a day, and the many
  // tab and bookmark lookups do not each revalidate.
  headers: async () =>
    FAVICON_PATHS.map((source) => ({
      source,
      headers: [
        { key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' },
      ],
    })),
  agentRules: false,
};

export default config;
