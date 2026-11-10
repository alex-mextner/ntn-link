import path from 'node:path';
import type { NextConfig } from 'next';

const workspaceRoot = path.join(import.meta.dirname, '..', '..');

/** Twemoji SVGs the title card reads at request time (about 3,700 small files). */
const EMOJI_SVGS = './node_modules/@twemoji/svg/*.svg';

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
  agentRules: false,
};

export default config;
