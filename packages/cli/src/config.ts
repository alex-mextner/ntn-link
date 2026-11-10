/**
 * Deployment constants. Users can always override the origin with --origin or NTN_LINK_ORIGIN.
 */
export const DEFAULT_ORIGIN = 'https://fastp.ge';

/**
 * The origin the service launched on. It serves the same deployment as DEFAULT_ORIGIN, so owner keys
 * saved for it are still valid there and are adopted (see `adoptLegacyKeys`).
 */
export const LEGACY_ORIGIN = 'https://ntn-link.vercel.app';
