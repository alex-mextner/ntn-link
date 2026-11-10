/**
 * Renders the real card (satori + resvg) offline: the layout must hold for text the estimate
 * gets wrong, and emoji must never make the renderer reach for the network.
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { renderTitleCard } from '../lib/title-card';

// The bundled fonts are found relative to the app directory, as when the app runs.
process.chdir(path.join(import.meta.dir, '..'));

async function render(title: string, excerpt: string[]): Promise<Uint8Array> {
  const response = await renderTitleCard({ title, description: '', excerpt }, 'thsm', {});
  return new Uint8Array(await response.arrayBuffer());
}

const PNG_MAGIC = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);

describe('renderTitleCard', () => {
  test('wide capitals that wrap further than estimated still render a PNG', async () => {
    const bytes = await render('Page', Array<string>(5).fill('W'.repeat(55)));
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
      const bytes = await render('👍🏽 Page 🇧🇾', ['👍🏽 Hello', '🏽 only a tone', '☀️ Weather']);
      expect(bytes.slice(0, 4)).toEqual(PNG_MAGIC);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(urls).toEqual([]);
  });
});
