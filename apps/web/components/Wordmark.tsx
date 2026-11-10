import { LinkIcon } from './icons';

/** The ntn.link identity: a gradient tile carrying the link glyph, then the name set in two weights. */
export function Wordmark() {
  return (
    <a className="wordmark" href="/" aria-label="ntn.link home">
      <span className="wordmark-glyph" aria-hidden="true">
        <LinkIcon size={18} />
      </span>
      <span className="wordmark-text" aria-hidden="true">
        ntn<span className="wordmark-dot">.link</span>
      </span>
    </a>
  );
}
