import { describe, expect, test } from 'bun:test';
import { EXCERPT_LIMITS, cardExcerpt, unwrapRecordMap } from '../../src/render';
import { ROOT, THSM_ID, bid, mapOf, pageWith, readFixture } from './helpers';

const text = (value: string) => ({ type: 'text', properties: { title: [[value]] } });

describe('cardExcerpt', () => {
  test('reads the beginning of the page in order: text, headings, lists, quotes, callouts', () => {
    const map = mapOf(
      pageWith({
        [bid(1)]: { type: 'header', properties: { title: [['Overview']] } },
        [bid(2)]: text('First paragraph.'),
        [bid(3)]: { type: 'bulleted_list', properties: { title: [['one']] } },
        [bid(4)]: { type: 'numbered_list', properties: { title: [['alpha']] } },
        [bid(5)]: { type: 'numbered_list', properties: { title: [['beta']] } },
        [bid(6)]: { type: 'quote', properties: { title: [['Said']] } },
        [bid(7)]: { type: 'callout', properties: { title: [['Note']] } },
        [bid(8)]: { type: 'to_do', properties: { title: [['Pack']], checked: [['Yes']] } },
      }),
    );
    expect(cardExcerpt(map, ROOT)).toEqual([
      'Overview',
      'First paragraph.',
      '• one',
      '1. alpha',
      '2. beta',
      'Said',
      'Note',
      '• Pack',
    ]);
  });

  test('skips what has no text and keeps going past it', () => {
    const map = mapOf(
      pageWith({
        [bid(1)]: { type: 'image', properties: { source: [['https://x.example/a.png']] } },
        [bid(2)]: { type: 'divider' },
        [bid(3)]: text(''),
        [bid(4)]: { type: 'text', properties: { title: [['‣', [['p', bid(9)]]]] } },
        [bid(5)]: text('  Real   text \n here '),
      }),
    );
    expect(cardExcerpt(map, ROOT)).toEqual(['Real text here']);
  });

  test('reads columns left to right and lists sub-page titles', () => {
    const map = mapOf(
      pageWith(
        {
          [bid(1)]: { type: 'column_list', content: [bid(2), bid(3)] },
          [bid(2)]: { type: 'column', content: [bid(4)] },
          [bid(3)]: { type: 'column', content: [bid(5)] },
          [bid(4)]: text('left'),
          [bid(5)]: text('right'),
          [bid(6)]: { type: 'page', properties: { title: [['Oman trip']] } },
        },
        [bid(1), bid(6)],
      ),
    );
    expect(cardExcerpt(map, ROOT)).toEqual(['left', 'right', 'Oman trip']);
  });

  test('is bounded in lines, line length and total size', () => {
    const many = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [bid(i + 1), text(`line ${i}`)]),
    );
    expect(cardExcerpt(mapOf(pageWith(many)), ROOT)).toHaveLength(EXCERPT_LIMITS.maxLines);
    const long = mapOf(pageWith({ [bid(1)]: text('я'.repeat(1000)) }));
    expect([...(cardExcerpt(long, ROOT)[0] ?? '')]).toHaveLength(EXCERPT_LIMITS.maxLineChars);
    const wide = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        bid(i + 1),
        text('x'.repeat(EXCERPT_LIMITS.maxLineChars)),
      ]),
    );
    const total = cardExcerpt(mapOf(pageWith(wide)), ROOT).join('').length;
    expect(total).toBeLessThan(EXCERPT_LIMITS.maxTotalChars + EXCERPT_LIMITS.maxLineChars);
  });

  test('a page without readable children has no excerpt, and a missing root does not throw', () => {
    expect(cardExcerpt(mapOf(pageWith({})), ROOT)).toEqual([]);
    expect(cardExcerpt(mapOf({}), ROOT)).toEqual([]);
  });

  test('the recorded thsm page gives its headings and trips, not the mention-only line', () => {
    const map = unwrapRecordMap(readFixture('thsm-loadPageChunk.json'));
    const lines = cardExcerpt(map, THSM_ID);
    expect(lines.slice(0, 3)).toEqual([
      'Лето 2026 — Египет Беларусь Россия',
      'Гениальный план на жизнь',
      'Осень 2026 — Черногория',
    ]);
  });
});
