import path from 'node:path';
import type { NextConfig } from 'next';

const workspaceRoot = path.join(import.meta.dirname, '..', '..');

const config: NextConfig = {
  // Core is shipped as TypeScript source.
  transpilePackages: ['@ntn-link/core'],
  // The workspace root is the tracing root so packages/core lands in the serverless bundle.
  outputFileTracingRoot: workspaceRoot,
  // The title card reads its fonts from disk at request time; tracing cannot see that.
  outputFileTracingIncludes: { '/img/[workspace]/[slug]': ['./assets/fonts/**'] },
  poweredByHeader: false,
  agentRules: false,
};

export default config;
