/**
 * Live shape check against Notion (spec section 9: the fast variant depends on an
 * unofficial response shape). Skipped unless LIVE=1, so CI and offline runs stay hermetic.
 */
import { expect, test } from 'bun:test';
import { loadPageChunk, renderBlocks } from '../../src/render';
import { THSM_ID, testCtx } from './helpers';

test.skipIf(process.env.LIVE !== '1')(
  'loadPageChunk response shape still matches (thsm)',
  async () => {
    const map = await loadPageChunk({ workspace: 'thsm', pageId: THSM_ID });
    const root = map.blocks.get(THSM_ID);
    expect(root?.type).toBe('page');
    expect(map.blocks.size).toBeGreaterThan(5);
    expect(root?.content.length).toBeGreaterThan(0);
    const { html } = renderBlocks(map, testCtx({ rootId: THSM_ID }));
    expect(html).toContain('<h2 ');
  },
);
