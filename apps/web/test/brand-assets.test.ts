/**
 * The favicon set Next.js serves from `app/` (file conventions) and the extension icons are real
 * images of the sizes they are linked at.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.join(import.meta.dir, '..', '..', '..');
const read = (file: string): Buffer => readFileSync(path.join(repo, file));

/** Width and height from the IHDR chunk of a PNG. */
function pngSize(bytes: Buffer): [number, number] {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe('brand assets', () => {
  test('the favicon PNGs and the apple-touch icon have the sizes they are served at', () => {
    expect(pngSize(read('apps/web/app/icon1.png'))).toEqual([16, 16]);
    expect(pngSize(read('apps/web/app/icon2.png'))).toEqual([32, 32]);
    expect(pngSize(read('apps/web/app/icon3.png'))).toEqual([512, 512]);
    expect(pngSize(read('apps/web/app/apple-icon.png'))).toEqual([180, 180]);
  });

  test('favicon.ico holds 16, 32 and 48 px frames', () => {
    const ico = read('apps/web/app/favicon.ico');
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 3]);
    const widths = [0, 1, 2].map((i) => ico.readUInt8(6 + i * 16));
    expect(widths.toSorted((a, b) => a - b)).toEqual([16, 32, 48]);
  });

  test('every extension icon in the manifest exists at its size', () => {
    const manifest: {
      icons: Record<string, string>;
      action: { default_icon: Record<string, string> };
    } = JSON.parse(read('extension/manifest.base.json').toString('utf8'));
    expect(Object.keys(manifest.icons)).toEqual(['16', '32', '48', '128']);
    expect(Object.keys(manifest.action.default_icon)).toEqual(['16', '32']);
    for (const [size, file] of Object.entries({
      ...manifest.icons,
      ...manifest.action.default_icon,
    })) {
      expect(pngSize(read(`extension/static/${file}`))).toEqual([Number(size), Number(size)]);
    }
  });
});
