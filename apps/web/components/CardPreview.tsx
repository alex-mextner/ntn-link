'use client';

import { useId, useState } from 'react';
import type { CardData } from '../../../packages/core/src/api-types';
import { plainText, safeImageUrl } from '@/lib/client/text';
import { en } from '@/lib/client/strings';

type Platform = keyof typeof en.platforms;
const PLATFORMS = Object.keys(en.platforms) as Platform[];

export type UnfurlMode = 'empty' | 'loading' | 'ready';

/** Shown before there is a page: the shape of the result, clearly not real data. */
const SAMPLE: CardData = {
  title: 'Your page title appears here',
  description: 'The description from your Notion page, exactly as a messenger shows it.',
  imageUrl: null,
  language: null,
};

/**
 * A live "unfurl": the card a messenger builds from the link, in the layout of Telegram, Slack
 * or X. All fields are Notion-controlled, so they are rendered as text nodes only.
 */
export function CardPreview({
  card,
  excerpt,
  host,
  sourceHost,
  mode,
}: {
  card: CardData | null;
  /** Leading lines of the page's text, shown on the generated card of a cover-less page. */
  excerpt: readonly string[];
  host: string;
  /** The Notion domain the generated card names, `<workspace>.notion.site`. */
  sourceHost: string;
  mode: UnfurlMode;
}) {
  const id = useId();
  const [platform, setPlatform] = useState<Platform>('telegram');
  const shown = card ?? SAMPLE;
  const image = mode === 'ready' ? safeImageUrl(shown.imageUrl) : null;
  const title = plainText(shown.title);
  const description = plainText(shown.description);
  // The same choice the generated /img card makes: the page text, the description when empty.
  const bodyLines = (excerpt.length > 0 ? excerpt : [description])
    .map(plainText)
    .filter((line) => line !== '')
    .slice(0, 6);

  return (
    <div className="unfurl-block">
      <div className="unfurl-head">
        <h3 className="subheading" id={`${id}-heading`}>
          {en.previewHeading}
        </h3>
        <div role="radiogroup" aria-label={en.previewPlatformsLabel} className="segmented">
          {PLATFORMS.map((name) => (
            <label key={name} className="segment">
              <input
                type="radio"
                name={`${id}-platform`}
                value={name}
                checked={platform === name}
                onChange={() => setPlatform(name)}
              />
              <span>{en.platforms[name]}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="unfurl-stage" data-platform={platform}>
        <figure
          className="unfurl"
          data-mode={mode}
          aria-labelledby={`${id}-heading`}
          aria-hidden={mode === 'ready' ? undefined : true}
        >
          <div className="unfurl-media">
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={image} alt="" referrerPolicy="no-referrer" decoding="async" />
            ) : mode === 'loading' ? null : (
              <span className="unfurl-fallback">
                <span className="unfurl-fallback-host">{sourceHost}</span>
                <span className="unfurl-fallback-copy">
                  <span className="unfurl-fallback-title">{title}</span>
                  {bodyLines.map((line, index) => (
                    <span key={index} className="unfurl-fallback-line">
                      {line}
                    </span>
                  ))}
                </span>
              </span>
            )}
          </div>
          <figcaption className="unfurl-text">
            {mode === 'loading' ? (
              <>
                <span className="skeleton-line short" />
                <span className="skeleton-line" />
                <span className="skeleton-line" />
              </>
            ) : (
              <>
                <span className="unfurl-site">{host}</span>
                <strong className="unfurl-title">{title}</strong>
                {description ? <span className="unfurl-desc">{description}</span> : null}
              </>
            )}
          </figcaption>
        </figure>
      </div>
      {mode === 'ready' && !image ? <p className="hint">{en.noImage}</p> : null}
    </div>
  );
}
