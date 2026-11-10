import { describe, expect, test } from 'bun:test';
import { clip, planCardText, planExcerpt, rowsNeeded } from '../lib/card-layout';

// The text row of the generated card: (1200 - 2 * 56) px at 34 px.
const ROW_EM = (1200 - 2 * 56) / 34;
const budget = { rows: 5, rowEm: ROW_EM, rowsPerLine: 2 };

describe('clip', () => {
  test('collapses whitespace and cuts with an ellipsis by characters, not UTF-16 units', () => {
    expect(clip('  a \n b  ', 10)).toBe('a b');
    expect(clip('𝒜𝒜𝒜𝒜', 3)).toBe('𝒜𝒜…');
    expect(clip('abc', 3)).toBe('abc');
  });

  test('drops emoji (the card is drawn without a network) but keeps ©, ™ and plain text', () => {
    expect(clip('☀️ Погода 🏄‍♂️ 🇧🇾 1️⃣', 40)).toBe('Погода 1');
    expect(clip('© Acme™', 40)).toBe('© Acme™');
  });

  test('leaves no emoji modifier or tag behind: a skin tone alone would still be fetched as an image', () => {
    expect(clip('👍🏽 Hello', 40)).toBe('Hello');
    expect(clip('🏽 Hello', 40)).toBe('Hello');
    expect(clip('🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f} UK', 40)).toBe('UK');
  });
});

describe('rowsNeeded', () => {
  test('errs towards wrapping: capitals and wide glyphs take more room than lowercase', () => {
    expect(rowsNeeded('a'.repeat(30), ROW_EM, 2)).toBe(1);
    expect(rowsNeeded('W'.repeat(55), ROW_EM, 2)).toBe(2);
    expect(rowsNeeded('字'.repeat(40), ROW_EM, 2)).toBe(2);
    expect(rowsNeeded('a'.repeat(500), ROW_EM, 2)).toBe(2);
  });
});

describe('planExcerpt', () => {
  test('gives each line the rows it needs, so the card can size every container exactly', () => {
    const plan = planExcerpt(['a'.repeat(20), 'b'.repeat(60), 'c'.repeat(100), 'd'], budget);
    expect(plan.map((line) => line.rows)).toEqual([1, 2, 2]);
  });

  test('five wide lines are budgeted as two rows each, never as one', () => {
    const plan = planExcerpt(Array<string>(5).fill('W'.repeat(55)), budget);
    expect(plan.map((line) => line.rows)).toEqual([2, 2]);
  });

  test('never draws a line that would overflow, but always draws the first one', () => {
    const plan = planExcerpt(['x'.repeat(1000), 'next'], { rows: 2, rowEm: 10, rowsPerLine: 2 });
    expect(plan).toHaveLength(1);
    expect(plan[0]?.text.endsWith('…')).toBe(true);
    expect(plan[0]?.rows).toBe(2);
  });

  test('skips blank lines and an empty page gives nothing', () => {
    expect(planExcerpt(['', '   ', '🙂', 'text'], budget).map((line) => line.text)).toEqual([
      'text',
    ]);
    expect(planExcerpt([], budget)).toEqual([]);
  });
});

describe('planCardText', () => {
  test('is what both the card and its preview show: clipped title, planned lines, description fallback', () => {
    const plan = planCardText(
      'Title',
      ['one', 'two', 'three', 'four', 'five', 'six'],
      'desc',
      false,
    );
    expect(plan.title).toBe('Title');
    expect(plan.lines.map((line) => line.text)).toEqual(['one', 'two', 'three', 'four', 'five']);
    expect(planCardText('Title', [], 'desc', false).lines.map((line) => line.text)).toEqual([
      'desc',
    ]);
  });

  test('a title on two rows leaves one text row less', () => {
    const long = 'Wide title '.repeat(8);
    const plan = planCardText(long, ['a', 'b', 'c', 'd', 'e'], '', false);
    expect(plan.lines).toHaveLength(4);
  });

  test('the icon row above the title takes one text row, also under a two-row title', () => {
    const five = ['a', 'b', 'c', 'd', 'e'];
    expect(planCardText('Title', five, '', true).lines).toHaveLength(4);
    expect(planCardText('Wide title '.repeat(8), five, '', true).lines).toHaveLength(3);
  });
});
