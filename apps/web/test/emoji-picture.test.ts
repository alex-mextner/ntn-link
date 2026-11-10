/**
 * Emoji -> picture mapping, against the real `@twemoji/svg` files: every emoji the set draws
 * must be found by the spelling Notion stores, including ZWJ sequences, skin tones, flags and
 * keycaps.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEmojiIndex, emojiDataUri, emojiFileName, emojiSvg } from '../lib/emoji-picture';

// The pictures are found relative to the app directory, as when the app runs.
process.chdir(path.join(import.meta.dir, '..'));

const FILES = readdirSync(path.join(process.cwd(), 'node_modules', '@twemoji', 'svg')).filter(
  (name) => name.endsWith('.svg'),
);
const INDEX = createEmojiIndex(FILES);

const fromHex = (hex: string): string =>
  hex
    .split('-')
    .map((part) => String.fromCodePoint(Number.parseInt(part, 16)))
    .join('');

const lookup = (emoji: string): string | null => emojiFileName(INDEX, emoji);

describe('a missing picture directory', () => {
  test('is an error that is not cached: the pictures work again once they are back', async () => {
    const appDir = process.cwd();
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'ntn-emoji-'));
    process.chdir(elsewhere);
    try {
      const lost = await emojiSvg('🤿').then(
        () => false,
        () => true,
      );
      expect(lost).toBe(true);
    } finally {
      process.chdir(appDir);
      rmSync(elsewhere, { recursive: true });
    }
    expect(await emojiSvg('🤿')).not.toBeNull();
  });
});

describe('emojiFileName', () => {
  test("the page icon of the owner's thsm page, the snorkel, is 1f93f", () => {
    expect(lookup('🤿')).toBe('1f93f.svg');
  });

  test('finds the picture of every file the set ships, from its own code points', () => {
    expect(FILES.length).toBeGreaterThan(3600);
    const misses = FILES.filter((file) => lookup(fromHex(file.replace('.svg', ''))) !== file);
    expect(misses).toEqual([]);
  });

  test('a spelling with variation selectors added or dropped finds the same picture', () => {
    const withSelector = FILES.filter((file) => file.includes('-fe0f'));
    expect(withSelector.length).toBeGreaterThan(100);
    const misses = withSelector.filter((file) => {
      const stripped = fromHex(file.replace('.svg', '')).replaceAll('\ufe0f', '');
      return lookup(stripped) === null;
    });
    expect(misses).toEqual([]);
  });

  test('variation selectors do not matter: a heart, a sun, a cloud, with and without FE0F', () => {
    expect(lookup('❤️')).toBe('2764.svg');
    expect(lookup('❤')).toBe('2764.svg');
    expect(lookup('☀')).toBe(lookup('☀️'));
    expect(lookup('☁')).not.toBeNull();
  });

  test('skin tones pick the toned picture', () => {
    expect(lookup('👍🏽')).toBe('1f44d-1f3fd.svg');
    expect(lookup('👍')).toBe('1f44d.svg');
    expect(lookup('🧑🏿‍🚀')).toBe('1f9d1-1f3ff-200d-1f680.svg');
  });

  test('flags: regional indicator pairs and tag sequences', () => {
    expect(lookup('🇧🇾')).toBe('1f1e7-1f1fe.svg');
    expect(lookup('🇷🇺')).toBe('1f1f7-1f1fa.svg');
    expect(lookup('🏴󠁧󠁢󠁥󠁮󠁧󠁿')).toBe('1f3f4-e0067-e0062-e0065-e006e-e0067-e007f.svg');
    expect(lookup('🏳️‍🌈')).toBe('1f3f3-fe0f-200d-1f308.svg');
    expect(lookup('🏳‍🌈')).toBe('1f3f3-fe0f-200d-1f308.svg');
  });

  test('ZWJ sequences are one picture: families, professions, couples', () => {
    expect(lookup('👨‍👩‍👧‍👦')).toBe('1f468-200d-1f469-200d-1f467-200d-1f466.svg');
    expect(lookup('👩‍💻')).toBe('1f469-200d-1f4bb.svg');
    expect(lookup('🧑🏽‍🤝‍🧑🏿')).toBe('1f9d1-1f3fd-200d-1f91d-200d-1f9d1-1f3ff.svg');
    expect(lookup('👩‍❤️‍👨')).toBe('1f469-200d-2764-fe0f-200d-1f468.svg');
  });

  test('keycaps', () => {
    expect(lookup('1️⃣')).toBe('31-20e3.svg');
    expect(lookup('1⃣')).toBe('31-20e3.svg');
    expect(lookup('#️⃣')).toBe('23-20e3.svg');
  });

  test('text and unknown sequences have no picture', () => {
    expect(lookup('')).toBeNull();
    expect(lookup('a')).toBeNull();
    expect(lookup('AB')).toBeNull();
    // A lone regional indicator is not a flag: it draws as the set's lettered tile.
    expect(lookup('🇧')).toBe('1f1e7.svg');
  });

  test('a sequence the set does not draw as one picture falls back to the same without tones, then to its first element', () => {
    const small = createEmojiIndex(['1f468.svg', '1f9d1.svg', '1f9d1-1f3fd.svg']);
    // Toned person + ZWJ + an object with no combined picture -> the toned person.
    expect(emojiFileName(small, '🧑🏽‍🪄')).toBe('1f9d1-1f3fd.svg');
    // Unknown tone variant -> the untoned picture.
    expect(emojiFileName(small, '👨🏿')).toBe('1f468.svg');
    // Unknown family arrangement -> the first person.
    expect(emojiFileName(small, '👨‍🦽')).toBe('1f468.svg');
    expect(emojiFileName(small, '🪄')).toBeNull();
  });

  test('prefers the fully qualified file when a bare one exists too', () => {
    const both = createEmojiIndex(['2764.svg', '2764-fe0f.svg']);
    expect(emojiFileName(both, '❤️')).toBe('2764-fe0f.svg');
    expect(emojiFileName(both, '❤')).toBe('2764.svg');
  });
});

describe('emojiSvg', () => {
  test('reads the SVG of one emoji and nothing else', async () => {
    const svg = await emojiSvg('🤿');
    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox="0 0 36 36"');
  });

  test('is never a general file server: no emoji, no file', async () => {
    for (const bad of ['', '../../package.json', '1f93f.svg', 'x'.repeat(100), '🤿'.repeat(30)]) {
      expect(await emojiSvg(bad)).toBeNull();
    }
  });

  test('the data URI form carries the same bytes', async () => {
    const svg = await emojiSvg('🛕');
    expect(await emojiDataUri('🛕')).toBe(
      `data:image/svg+xml;base64,${Buffer.from(svg ?? '').toString('base64')}`,
    );
    expect(await emojiDataUri('nope')).toBeNull();
  });
});
