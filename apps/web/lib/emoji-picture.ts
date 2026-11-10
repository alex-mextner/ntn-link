/**
 * Emoji pictures for the generated card.
 *
 * The bundled card fonts have no emoji, and satori would otherwise fetch every emoji picture
 * from a CDN at render time. The pictures are Twemoji 15 from the `@twemoji/svg` package (one SVG
 * per emoji, named by code points: `1f93f.svg`, `1f468-200d-1f469-200d-1f466.svg`); only the one
 * file of the emoji being drawn is read, on demand.
 *
 * Licence: graphics CC-BY 4.0 (Twitter, Inc and other contributors), code MIT; text and
 * attribution in assets/emoji. Apple's emoji artwork is proprietary and is deliberately not used.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const SKIN_TONES = /^1f3f[b-f]$/;
const ZWJ = '200d';
/** Variation selectors: presentation hints that the file names include only for some emoji. */
const VARIATION_SELECTORS: ReadonlySet<string> = new Set(['fe0e', 'fe0f']);
/** Longest emoji string looked up; the longest real sequences (tag flags) are 7 code points, 14 UTF-16 units. */
export const MAX_EMOJI_UTF16_UNITS = 40;

export interface EmojiIndex {
  /** File names as they exist on disk. */
  names: ReadonlySet<string>;
  /** Name by its code points without variation selectors, so `2764` finds `2764-fe0f.svg`. */
  byBase: ReadonlyMap<string, string>;
}

const baseOf = (hexes: readonly string[]): string =>
  hexes.filter((hex) => !VARIATION_SELECTORS.has(hex)).join('-');

export function createEmojiIndex(fileNames: Iterable<string>): EmojiIndex {
  const names = new Set<string>();
  const byBase = new Map<string, string>();
  for (const name of fileNames) {
    if (!name.endsWith('.svg')) continue;
    names.add(name);
    const stem = name.slice(0, -'.svg'.length);
    const base = baseOf(stem.split('-'));
    const known = byBase.get(base);
    // The fully qualified spelling (with its selectors) is the longer one.
    if (known === undefined || name.length > known.length) byBase.set(base, name);
  }
  return { names, byBase };
}

function findByHexes(index: EmojiIndex, hexes: readonly string[]): string | null {
  if (hexes.length === 0) return null;
  const exact = `${hexes.join('-')}.svg`;
  if (index.names.has(exact)) return exact;
  return index.byBase.get(baseOf(hexes)) ?? null;
}

const withoutTones = (hexes: readonly string[]): string[] =>
  hexes.filter((hex) => !SKIN_TONES.test(hex));

/**
 * File of the picture for `emoji`, or null when there is none. Handles fully qualified and
 * bare spellings (`❤` and `❤️`), flags (regional indicator pairs and tag sequences), keycaps,
 * skin tones and ZWJ sequences. A sequence the set does not draw as one picture falls back to
 * the same without skin tones, then to its first element (the person of a family), so an
 * unknown newer emoji still shows something recognisable instead of nothing.
 */
export function emojiFileName(index: EmojiIndex, emoji: string): string | null {
  // File names carry minimal hex (`a9`, `31-20e3`), as Twemoji names them.
  const hexes = [...emoji].map((char) => (char.codePointAt(0) ?? 0).toString(16));
  const zwj = hexes.indexOf(ZWJ);
  const first = zwj === -1 ? hexes : hexes.slice(0, zwj);
  for (const candidate of [hexes, withoutTones(hexes), first, withoutTones(first)]) {
    const name = findByHexes(index, candidate);
    if (name !== null) return name;
  }
  return null;
}

/** The package's SVG directory, found from the app directory at request time (and so by the tests' `chdir`). */
const emojiDir = (): string => path.join(process.cwd(), 'node_modules', '@twemoji', 'svg');

let index: Promise<EmojiIndex> | null = null;

function loadIndex(): Promise<EmojiIndex> {
  index ??= readdir(emojiDir())
    .then(createEmojiIndex)
    .catch((error: unknown) => {
      // A missing directory is a deployment problem; do not cache the failure forever.
      index = null;
      throw error;
    });
  return index;
}

/** The SVG source of the picture for `emoji`, or null when there is none. */
export async function emojiSvg(emoji: string): Promise<string | null> {
  if (emoji === '' || emoji.length > MAX_EMOJI_UTF16_UNITS) return null;
  const name = emojiFileName(await loadIndex(), emoji);
  return name === null ? null : readFile(path.join(emojiDir(), name), 'utf8');
}

/** The same as a `data:` URI, the form satori takes for `<img>`. */
export async function emojiDataUri(emoji: string): Promise<string | null> {
  const svg = await emojiSvg(emoji);
  return svg === null ? null : `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
