/**
 * Renders the real card (satori + resvg) offline: the layout must hold for text the estimate
 * gets wrong, emoji must never make the renderer reach for the network, and the page icon
 * (an emoji picture or an image) must really be in the pixels, not just in the markup.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CardIcon } from '@ntn-link/core';
import { renderTitleCard } from '../lib/title-card';
import { countPixels, decodePng, solidPng, type Box, type Pixels } from './support/png';

// The bundled fonts and emoji pictures are found relative to the app directory, as when the app runs.
process.chdir(path.join(import.meta.dir, '..'));

async function renderBytes(
  title: string,
  excerpt: string[],
  icon: CardIcon | null = null,
): Promise<Uint8Array> {
  const response = await renderTitleCard({ title, description: '', excerpt, icon }, 'thsm', {});
  return new Uint8Array(await response.arrayBuffer());
}

async function renderPixels(icon: CardIcon | null): Promise<Pixels> {
  return decodePng(
    await renderBytes('Наши с Леночкой Путешествия', ['Лето 2026 — Египет Беларусь Россия'], icon),
  );
}

const PNG_MAGIC = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);

/** The 96 px icon slot in the top-left corner (56 px padding), and its lower half below the label. */
const ICON_BOX: Box = { x: 56, y: 56, width: 96, height: 96 };
const ICON_LOWER_HALF: Box = { x: 56, y: 104, width: 96, height: 48 };
/** Background is near-black ink with glows away from this corner: anything brighter is the icon. */
const isInk = (r: number, g: number, b: number) => Math.max(r, g, b) < 60;
const isDrawn = (r: number, g: number, b: number) => !isInk(r, g, b);
/** Strongly coloured pixels of the emoji, and the flat red of the test picture. */
const isSaturated = (r: number, g: number, b: number) =>
  Math.max(r, g, b) - Math.min(r, g, b) > 120;
const isRed = (r: number, g: number, b: number) => r > 200 && g < 60 && b < 70;

describe('renderTitleCard', () => {
  test('wide capitals that wrap further than estimated still render a PNG', async () => {
    const bytes = await renderBytes('Page', Array<string>(5).fill('W'.repeat(55)));
    expect(bytes.slice(0, 4)).toEqual(PNG_MAGIC);
  });

  test('emoji, skin tones and flags never trigger a network request', async () => {
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        urls.push(String(input instanceof Request ? input.url : input));
        throw new Error('offline');
      },
      { preconnect: () => {} },
    );
    try {
      const bytes = await renderBytes('👍🏽 Page 🇧🇾', ['👍🏽 Hello', '🏽 only a tone', '☀️ Weather'], {
        kind: 'emoji',
        emoji: '👨‍👩‍👧‍👦',
      });
      expect(bytes.slice(0, 4)).toEqual(PNG_MAGIC);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(urls).toEqual([]);
  });
});

describe('page icon on the card', () => {
  test('a card without an icon leaves the icon slot empty', async () => {
    const card = await renderPixels(null);
    expect(countPixels(card, ICON_LOWER_HALF, isDrawn)).toBeLessThan(5);
  });

  test("the page's emoji is drawn in front of the workspace label as a picture", async () => {
    const card = await renderPixels({ kind: 'emoji', emoji: '🤿' });
    // The snorkel mask fills the slot with pixels, many of them strongly coloured (the card's
    // own background around the slot is dark and grey-blue).
    expect(countPixels(card, ICON_BOX, isDrawn)).toBeGreaterThan(1500);
    expect(countPixels(card, ICON_BOX, isSaturated)).toBeGreaterThan(300);
    // The workspace label moved right of the icon instead of sitting under it.
    expect(countPixels(card, { x: 56 + 96, y: 60, width: 30, height: 30 }, isDrawn)).toBeLessThan(
      5,
    );
  });

  test.each([
    ['a ZWJ family', '👨‍👩‍👧‍👦'],
    ['a flag', '🇧🇾'],
    ['a skin tone', '👍🏽'],
    ['a rainbow flag ZWJ sequence', '🏳️‍🌈'],
    ['a bare symbol without its variation selector', '❤'],
  ])('%s is drawn', async (_name, emoji) => {
    const card = await renderPixels({ kind: 'emoji', emoji });
    expect(countPixels(card, ICON_LOWER_HALF, isDrawn)).toBeGreaterThan(300);
  });

  test('a picture icon is drawn as a rounded square, not an emoji', async () => {
    const dataUri = `data:image/png;base64,${Buffer.from(solidPng(64, [230, 20, 30])).toString('base64')}`;
    const card = await renderPixels({ kind: 'image', dataUri });
    const area = ICON_BOX.width * ICON_BOX.height;
    // Almost the whole slot, minus the rounded corners.
    expect(countPixels(card, ICON_BOX, isRed)).toBeGreaterThan(area - 700);
    expect(countPixels(card, { x: 56, y: 56, width: 3, height: 3 }, isRed)).toBe(0);
  });

  test('an emoji with no picture is left out, the card still renders', async () => {
    const card = await renderPixels({ kind: 'emoji', emoji: 'not an emoji' });
    expect(countPixels(card, ICON_LOWER_HALF, isDrawn)).toBeLessThan(5);
  });

  test('if the emoji pictures cannot be read the card is still served, without the icon, and says why', async () => {
    const appDir = process.cwd();
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'ntn-card-'));
    const logged: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    process.chdir(elsewhere);
    try {
      const card = await renderPixels({ kind: 'emoji', emoji: '🤿' });
      expect(countPixels(card, ICON_LOWER_HALF, isDrawn)).toBeLessThan(5);
    } finally {
      process.chdir(appDir);
      console.error = realError;
      rmSync(elsewhere, { recursive: true });
    }
    expect(logged).toHaveLength(1);
  });
});
