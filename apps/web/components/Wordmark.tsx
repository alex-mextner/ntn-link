import { LOGO_PATH, LOGO_STROKE, LOGO_VIEWBOX } from '@ntn-link/core/brand';

/** The product identity: the logo (one path, `currentColor`, so it follows the theme), then the name set in two weights. */
export function Wordmark() {
  return (
    <a className="wordmark" href="/" aria-label="ntn.link home">
      <svg
        className="wordmark-logo"
        viewBox={LOGO_VIEWBOX}
        fill="currentColor"
        // The hand-drawn line is a hairline at 44 px: a little stroke keeps it crisp.
        stroke="currentColor"
        strokeWidth={LOGO_STROKE}
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path fillRule="evenodd" d={LOGO_PATH} />
      </svg>
      <span className="wordmark-text" aria-hidden="true">
        ntn<span className="wordmark-dot">.link</span>
      </span>
    </a>
  );
}
