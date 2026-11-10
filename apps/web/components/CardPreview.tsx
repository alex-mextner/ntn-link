'use client';

import type { CardData } from '../../../packages/core/src/api-types';
import { plainText, safeImageUrl } from '@/lib/client/text';
import { ru } from '@/lib/client/strings';

/** The card an unfurler would show. All fields are Notion-controlled: rendered as text nodes only. */
export function CardPreview({ card, host }: { card: CardData; host: string }) {
  const image = safeImageUrl(card.imageUrl);
  const title = plainText(card.title);
  const description = plainText(card.description);
  return (
    <figure className="card" aria-label={ru.previewHeading}>
      <div className="card-image">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" referrerPolicy="no-referrer" decoding="async" />
        ) : (
          <span className="card-noimage">{ru.noImage}</span>
        )}
      </div>
      <figcaption className="card-body">
        <span className="card-host">{host}</span>
        <strong className="card-title">{title}</strong>
        {description ? <span className="card-description">{description}</span> : null}
      </figcaption>
    </figure>
  );
}
