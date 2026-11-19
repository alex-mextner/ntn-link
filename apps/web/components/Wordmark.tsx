import {
  LOCKUP_LOGO_PATH,
  LOCKUP_STROKE,
  LOCKUP_VIEWBOX,
  LOCKUP_WORD_PATH,
} from '@ntn-link/core/lockup';

/**
 * The product identity: the logo and the hand-lettered "Fast Page" as one drawing (`currentColor`,
 * so it follows the theme). The accessible name is on the link, the drawing itself is decorative.
 */
export function Wordmark() {
  return (
    <a className="wordmark" href="/" aria-label="Fast Page, fastp.ge home" title="Fast Page">
      <svg
        className="wordmark-lockup"
        viewBox={LOCKUP_VIEWBOX}
        aria-hidden="true"
        focusable="false"
      >
        <path fill="currentColor" fillRule="evenodd" d={LOCKUP_LOGO_PATH} />
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth={LOCKUP_STROKE}
          strokeLinecap="round"
          strokeLinejoin="round"
          d={LOCKUP_WORD_PATH}
        />
      </svg>
    </a>
  );
}
