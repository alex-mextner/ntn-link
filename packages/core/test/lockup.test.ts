import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { LOCKUP_LOGO_PATH, LOCKUP_STROKE, LOCKUP_VIEWBOX, LOCKUP_WORD_PATH } from '../src/lockup';

const svg = readFileSync(new URL('../../../docs/brand/fastp-lockup.svg', import.meta.url), 'utf8');

test('the lockup constants are the paths of docs/brand/fastp-lockup.svg', () => {
  expect(svg).toContain(`viewBox="${LOCKUP_VIEWBOX}"`);
  expect(svg).toContain(`d="${LOCKUP_LOGO_PATH}"`);
  expect(svg).toContain(`d="${LOCKUP_WORD_PATH}"`);
  expect(svg).toContain(`stroke-width="${LOCKUP_STROKE}"`);
});
