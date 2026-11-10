/**
 * Build-time and policy constants shared by every extension context.
 */

/**
 * The ntn-link origin. One constant on purpose: it is rewritten at build time from
 * `NTN_LINK_ORIGIN` (also used for the manifest host permission), so changing the domain
 * after it is bought is a rebuild, not a code change.
 */
export const ORIGIN: string = process.env.NTN_LINK_ORIGIN ?? 'https://ntn-link.vercel.app';

/**
 * How long the automatic path may wait for the whole chain before Notion's own text wins.
 * The clipboard write happens after this wait, and Chrome and Firefox only allow it while the
 * click's transient user activation lasts (about 5 s, measured in Chrome: a write 4 s after
 * a click succeeded, 6.5 s after failed), so the budget stays well below that.
 */
export const INTERCEPT_TIMEOUT_MS = 3000;

/** The service worker stops this much before the page-side wait so the page never gives up first. */
export const RELAY_MARGIN_MS = 300;

/** Explicit actions (toolbar, shortcut) may be slower: nothing is racing a user gesture. */
export const EXPLICIT_TIMEOUT_MS = 8000;

/**
 * How long a "this page is public" (or "is not") answer is trusted. Short on the negative
 * side so a page the owner just published starts working soon.
 */
export const PROOF_TTL_MS = { positive: 3_600_000, negative: 300_000 } as const;

/** A link we created stays trusted this long before the API is asked again (deleted links). */
export const LINK_CACHE_TTL_MS = 3_600_000;
