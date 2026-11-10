/**
 * Everything that comes from Notion (titles, descriptions, image URLs) is attacker-controlled.
 * React escapes text nodes; these helpers cover what escaping does not: invisible bidi and
 * control characters that can disguise text, and URLs that are not plain https.
 */

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
