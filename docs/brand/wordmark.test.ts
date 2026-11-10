/**
 * The generated wordmark and lockup are plain stroked SVG paths: `currentColor`, no text, no font,
 * no fixed colours, a sane aspect ratio.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (file: string): string => readFileSync(path.join(import.meta.dir, file), 'utf8');

describe.each([
  ['fastp-wordmark.svg', 2, 4.5],
  ['fastp-lockup.svg', 3, 6],
])('%s', (file, minAspect, maxAspect) => {
  const svg = read(file);

  test('is a well-formed single svg with a viewBox of a sane aspect', () => {
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    const box = /viewBox="(-?\d+) (-?\d+) (\d+) (\d+)"/.exec(svg);
    expect(box).not.toBeNull();
    const aspect = Number(box?.[3]) / Number(box?.[4]);
    expect(aspect).toBeGreaterThan(minAspect);
    expect(aspect).toBeLessThan(maxAspect);
  });

  test('uses currentColor only, with no text, font or fixed colour', () => {
    expect(svg).toContain('currentColor');
    expect(svg).not.toMatch(/<text|<tspan|<style|font|#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
    for (const [, value] of svg.matchAll(/\b(?:fill|stroke)="([^"]*)"/g)) {
      expect(['none', 'currentColor']).toContain(value);
    }
  });

  test('wordmark path data stays small', () => {
    const lettering = /fill="none"[^>]* d="([^"]+)"/.exec(svg);
    expect(lettering?.[1].length).toBeLessThan(6144);
  });
});
