/**
 * Public routes take `<workspace>/<slug>` straight from the URL. Anything that cannot be a
 * stored link is rejected before it reaches headers (the cache tag) or the store.
 */
import { checkSlug } from '@ntn-link/core';

const WORKSPACE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isPlausibleLinkPath(workspace: string, slug: string): boolean {
  return WORKSPACE_PATTERN.test(workspace) && checkSlug(slug) === 'ok';
}
