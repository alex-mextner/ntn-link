/**
 * Everything that comes from Notion (titles, descriptions, image URLs) is attacker-controlled.
 * React escapes text nodes; these helpers cover what escaping does not: invisible bidi and
 * control characters that can disguise text, and URLs that are not plain https.
 */
import type { CardIcon } from '../../../../packages/core/src/api-types';

// Control characters, zero-width space/marks, bidi embeddings/overrides/isolates, word joiner, BOM.
// ZWJ/ZWNJ (U+200C/D) stay: emoji and Indic scripts need them.
const INVISIBLE = /[\p{Cc}\u200B\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/gu;

export function plainText(value: string): string {
  return value.replace(/\s+/gu, ' ').replace(INVISIBLE, '').trim();
}

/** Returns the URL only if it is an absolute https URL without credentials, else null. */
export function safeImageUrl(value: string | null): string | null {
  if (value === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return null;
  return parsed.href;
}

const ICON_DATA_URI = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
/** The server embeds at most 192 KB; the same bound here keeps a hostile response from being rendered. */
const ICON_DATA_URI_MAX = 270_000;
const ICON_EMOJI_MAX = 40;

/** What the preview draws for the page icon. */
export type PreviewIcon = { kind: 'emoji'; text: string } | { kind: 'image'; src: string };

/**
 * The preview's page icon: an emoji as plain text (so Apple devices draw Apple's own glyph, which
 * we may not redistribute as a picture), or the embedded picture when it is a plain PNG/JPEG
 * data URI. Anything else (an SVG or a script-bearing URI in a manipulated response) is not drawn.
 */
export function safeIcon(icon: CardIcon | null): PreviewIcon | null {
  if (icon === null) return null;
  if (icon.kind === 'emoji') {
    const text = plainText(icon.emoji);
    return text === '' || text.length > ICON_EMOJI_MAX ? null : { kind: 'emoji', text };
  }
  const { dataUri } = icon;
  const valid = dataUri.length <= ICON_DATA_URI_MAX && ICON_DATA_URI.test(dataUri);
  return valid ? { kind: 'image', src: dataUri } : null;
}

/** Workspace of a `<ws>.notion.site` URL typed by the user, or null when it cannot be told. */
export function workspaceHint(input: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const match = /^([a-z0-9-]+)\.notion\.site$/i.exec(parsed.hostname);
  return match?.[1] ? match[1].toLowerCase() : null;
}
