/**
 * Slug rules (spec section 3): `[a-z0-9-]`, 1-64 chars, Russian transliteration for the
 * default, and a reserved list shared with workspace validation because workspaces and
 * slugs both live in our top-level URL space.
 */
import { API_LIMITS } from './api-types';

/**
 * Words that collide with our own routes or would look official. Applied to slugs and
 * to workspaces (`/<ws>/<slug>` shares the namespace with `/api`, `/img`, ...).
 */
export const RESERVED_WORDS: ReadonlySet<string> = new Set([
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

// GOST 7.79 System B-like, without diacritics, matching Yandex/Telegram habits.
const CYRILLIC_TO_LATIN: ReadonlyMap<string, string> = new Map([
  ['а', 'a'],
  ['б', 'b'],
  ['в', 'v'],
  ['г', 'g'],
  ['д', 'd'],
  ['е', 'e'],
  ['ё', 'e'],
  ['ж', 'zh'],
  ['з', 'z'],
  ['и', 'i'],
  ['й', 'y'],
  ['к', 'k'],
  ['л', 'l'],
  ['м', 'm'],
  ['н', 'n'],
  ['о', 'o'],
  ['п', 'p'],
  ['р', 'r'],
  ['с', 's'],
  ['т', 't'],
  ['у', 'u'],
  ['ф', 'f'],
  ['х', 'h'],
  ['ц', 'ts'],
  ['ч', 'ch'],
  ['ш', 'sh'],
  ['щ', 'sch'],
  ['ъ', ''],
  ['ы', 'y'],
  ['ь', ''],
  ['э', 'e'],
  ['ю', 'yu'],
  ['я', 'ya'],
  // Ukrainian and Belarusian letters
  ['і', 'i'],
  ['ї', 'yi'],
  ['є', 'ye'],
  ['ґ', 'g'],
  ['ў', 'u'],
]);

const FALLBACK_SLUG = 'page';

/** Lowercase, transliterate, collapse everything else to single hyphens, cut at 64 chars. */
export function slugify(title: string): string {
  let out = '';
  for (const ch of title.normalize('NFKC').toLowerCase()) {
    out += CYRILLIC_TO_LATIN.get(ch) ?? ch;
  }
  // Strip combining marks left after decomposing accented Latin (café -> cafe).
  out = out
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (out.length > API_LIMITS.slugMaxLength) {
    out = out.slice(0, API_LIMITS.slugMaxLength).replace(/-+$/g, '');
  }
  if (out === '' || RESERVED_WORDS.has(out)) return out === '' ? FALLBACK_SLUG : `${out}-page`;
  return out;
}

export type SlugCheck = 'ok' | 'invalid' | 'reserved';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Validates a user-typed slug; the server never silently rewrites explicit slugs. */
export function checkSlug(slug: string): SlugCheck {
  if (slug.length < 1 || slug.length > API_LIMITS.slugMaxLength) return 'invalid';
  if (!SLUG_PATTERN.test(slug)) return 'invalid';
  if (RESERVED_WORDS.has(slug)) return 'reserved';
  return 'ok';
}

/** `base`, `base-2`, `base-3`, ... never exceeding the length limit. */
export function slugCandidate(base: string, attempt: number): string {
  if (attempt <= 1) return base;
  const suffix = `-${attempt}`;
  const trimmed = base.slice(0, API_LIMITS.slugMaxLength - suffix.length).replace(/-+$/g, '');
  return `${trimmed}${suffix}`;
}
