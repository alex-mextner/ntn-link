/**
 * Test-only page fetcher (enabled by NTN_TEST_FETCHER=1 outside production).
 *
 * Ownership verification needs the nonce in the title of a public Notion page, which would
 * mean editing the owner's real page. In test mode the real fetcher still loads the real
 * page, but the title of the workspace's pages is extended with the nonces our own
 * /api/challenge issued in this process. Everything else (metadata, images, redirects) is
 * real. It never runs in production: `lib/service.ts` refuses the flag there.
 */
import type { PageFetcher } from '@ntn-link/core';

export interface TestFetcher extends PageFetcher {
  /** Pretends the workspace owner pasted `nonce` into a page title. */
  expectNonce(workspace: string, nonce: string): void;
  /** Forgets the pretended edits once verification is done, so later titles are the real ones. */
  clearNonces(workspace: string): void;
}

export function createTestFetcher(real: PageFetcher, options: { dropImage: boolean }): TestFetcher {
  const nonces = new Map<string, string[]>();
  return {
    expectNonce(workspace, nonce) {
      nonces.set(workspace, [...(nonces.get(workspace) ?? []), nonce]);
    },
    clearNonces(workspace) {
      nonces.delete(workspace);
    },
    async fetchPage(page) {
      const result = await real.fetchPage(page);
      if (result.kind !== 'public') return result;
      const extra = nonces.get(result.workspace) ?? [];
      return {
        ...result,
        metadata: {
          ...result.metadata,
          title: [result.metadata.title, ...extra].join(' '),
          imageUrl: options.dropImage ? null : result.metadata.imageUrl,
        },
      };
    },
  };
}
