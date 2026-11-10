/**
 * Client-side slug validation, mirroring `checkSlug` in packages/core/src/slug.ts so the
 * form can say "invalid" or "reserved" before a round trip. The client deliberately does not
 * import core at runtime (it would drag zod and server code into the bundle); a parity test
 * in test/ui/slug.test.ts fails if the two rule sets drift apart. The server stays authoritative.
 */
import { API_LIMITS } from './limits';

const SLUG_MAX_LENGTH = API_LIMITS.slugMaxLength;

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'api',
  '_next',
  'og',
  'img',
  'new',
  'about',
  'read',
  'admin',
  'static',
  'assets',
  'favicon',
  'robots',
  'sitemap',
  'www',
  'app',
  'help',
  'terms',
  'privacy',
  'login',
  'logout',
  'signup',
  'settings',
]);

export type SlugCheck = 'ok' | 'empty' | 'invalid' | 'reserved';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function checkSlug(slug: string): SlugCheck {
  if (slug.length === 0) return 'empty';
  if (slug.length > SLUG_MAX_LENGTH || !SLUG_PATTERN.test(slug)) return 'invalid';
  if (RESERVED_SLUGS.has(slug)) return 'reserved';
  return 'ok';
}
