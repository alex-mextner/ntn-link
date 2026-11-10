/**
 * Layout decisions of the generated 1200x630 card, kept apart from the JSX so they can be
 * tested without rendering an image. The card shows the page title and as much of the
 * beginning of the page as fits; whole lines only, so nothing is cut mid-sentence by the frame.
 */

/**
 * Emoji and their joiners. The bundled fonts have no emoji, and satori would fetch every
 * emoji picture from a CDN at render time; a card that must render offline draws none.
 * (©, ® and ™ are text, not emoji.)
 */
const EMOJI =
  /(?![©®™])\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[\u{e0020}-\u{e007f}]|\u200d|\ufe0e|\ufe0f|\u20e3/gu;

/** Characters of a line without emoji, collapsed whitespace, cut with an ellipsis over `max`. */
export function clip(text: string, max: number): string {
  const chars = [...text.replace(EMOJI, '').replace(/\s+/gu, ' ').trim()];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}

const WIDE = /[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]/u;
const BROAD = /[WMЖШЩЮЫwm@%]/u;
const CAPITAL = /[\p{Lu}\d]/u;

/**
 * Width of one character in em for Noto Sans Bold, rounded up per class so that the estimate
 * errs towards "wraps": a line that is believed to fit in one row must really fit.
 */
function charWidthEm(char: string): number {
  if (char === ' ') return 0.27;
  if (WIDE.test(char)) return 1;
  if (BROAD.test(char)) return 0.95;
  return CAPITAL.test(char) ? 0.75 : 0.6;
}

export interface PlannedLine {
  text: string;
  /** Rows the line is given: the container is exactly this tall, so nothing can overlap. */
  rows: number;
}

export interface ExcerptBudget {
  /** Rows of text that fit under the title. */
  rows: number;
  /** Width of one row in em of the text size. */
  rowEm: number;
  /** Most rows one source line may occupy before it is ellipsized. */
  rowsPerLine: number;
}

/** Word wrapping wastes the end of every row; 8% extra width covers it. */
const WRAP_WASTE = 1.08;

/** Estimated rows `text` takes in rows `rowEm` em wide, between 1 and `maxRows`. */
export function rowsNeeded(text: string, rowEm: number, maxRows: number): number {
  const em = [...text].reduce((sum, char) => sum + charWidthEm(char), 0) * WRAP_WASTE;
  return Math.min(maxRows, Math.max(1, Math.ceil(em / rowEm)));
}

function rowsFor(line: string, budget: ExcerptBudget): number {
  return rowsNeeded(line, budget.rowEm, budget.rowsPerLine);
}

/**
 * Picks the leading lines whose estimated rows fit the budget. A line that would overflow is
 * not drawn; the first line is always drawn (clamped) so a long opening paragraph still shows.
 */
export function planExcerpt(lines: readonly string[], budget: ExcerptBudget): PlannedLine[] {
  const chosen: PlannedLine[] = [];
  let rows = 0;
  const maxChars = Math.floor((budget.rowEm * budget.rowsPerLine) / 0.6);
  for (const raw of lines) {
    const text = clip(raw, maxChars);
    if (text === '') continue;
    const needed = rowsFor(text, budget);
    if (chosen.length > 0 && rows + needed > budget.rows) break;
    chosen.push({ text, rows: needed });
    rows += needed;
    if (rows >= budget.rows) break;
  }
  return chosen;
}
