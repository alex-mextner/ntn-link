/**
 * Generated 1200x630 card for links whose page has no cover of its own: the ntn.link identity
 * (ink background, violet and sky glow, link glyph) around the page title, followed by the
 * beginning of the page's text in large type, so the card says what the page is about instead
 * of showing a generic Notion banner. Fonts are bundled (latin + cyrillic subsets of Noto Sans
 * Bold) so rendering needs no network and Cyrillic text never falls back to tofu boxes.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageResponse } from 'next/og';
import { clip, planExcerpt, rowsNeeded } from './card-layout';

// Distinct family names, chained in `fontFamily`: satori only falls back between families,
// two subsets registered under one name leave the second one unused.
const FONT_FILES = [
  { family: 'Noto Sans Latin', file: 'noto-sans-latin-700-normal.woff' },
  { family: 'Noto Sans Cyrillic', file: 'noto-sans-cyrillic-700-normal.woff' },
] as const;
const FONT_STACK = FONT_FILES.map(({ family }) => family).join(', ');
const TITLE_MAX = 90;

const TITLE_SIZE = 66;
const TITLE_LINE_HEIGHT = 1.12;
const TITLE_ROWS = 2;
const TEXT_SIZE = 34;
const TEXT_LINE_HEIGHT = 1.32;
const TEXT_ROW_EM = (1200 - 2 * 56) / TEXT_SIZE;
const TITLE_ROW_EM = (1200 - 2 * 56) / TITLE_SIZE;
const TEXT_ROWS = 5;
const TEXT_ROWS_PER_LINE = 2;
const TEXT_LINE_GAP = 12;

type Font = { name: string; data: Buffer; weight: 700; style: 'normal' };
let fonts: Promise<Font[]> | null = null;

function loadFonts(): Promise<Font[]> {
  fonts ??= Promise.all(
    FONT_FILES.map(async ({ family, file }) => ({
      name: family,
      data: await readFile(path.join(process.cwd(), 'assets', 'fonts', file)),
      weight: 700 as const,
      style: 'normal' as const,
    })),
  );
  return fonts;
}

/** The ntn.link glyph (two interlocked chain links), the same path as app/icon.svg. */
function Glyph({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#0b0b14"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
      <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
    </svg>
  );
}

export interface TitleCardContent {
  title: string;
  description: string;
  /** Leading lines of the page's text; the description stands in when there are none. */
  excerpt: readonly string[];
}

export async function renderTitleCard(
  content: TitleCardContent,
  workspace: string,
  headers: Record<string, string>,
): Promise<ImageResponse> {
  const title = clip(content.title, TITLE_MAX);
  const source = content.excerpt.length > 0 ? content.excerpt : [content.description];
  // A title on two rows takes a text row's height from the excerpt so the frame never overflows.
  const titleRows = rowsNeeded(title, TITLE_ROW_EM, TITLE_ROWS);
  const lines = planExcerpt(source, {
    rows: TEXT_ROWS - (titleRows - 1),
    rowEm: TEXT_ROW_EM,
    rowsPerLine: TEXT_ROWS_PER_LINE,
  });
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 56,
        // Violet glow top right, sky glow bottom left, over near-black ink.
        backgroundColor: '#0a0a12',
        backgroundImage:
          'radial-gradient(circle at 92% 0%, rgba(124,92,255,0.55) 0%, rgba(124,92,255,0) 52%), radial-gradient(circle at 0% 100%, rgba(56,189,248,0.30) 0%, rgba(56,189,248,0) 50%)',
        color: '#f3f3f8',
        fontFamily: FONT_STACK,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          alignSelf: 'flex-start',
          height: 40,
          padding: '0 18px',
          fontSize: 24,
          color: '#c9c9de',
          background: 'rgba(255,255,255,0.08)',
          border: '1px solid rgba(255,255,255,0.16)',
          borderRadius: 20,
        }}
      >
        {workspace}.notion.site
      </div>
      {/* Fixed-height regions with clipping: a long or unbroken title can never push past the
          630 px frame or over the workspace label, whatever the glyph widths. The excerpt is
          pre-fitted to whole rows (card-layout.ts), the clipping is only a safety net. */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            display: 'flex',
            width: '100%',
            maxHeight: TITLE_SIZE * TITLE_LINE_HEIGHT * TITLE_ROWS + 4,
            overflow: 'hidden',
            fontSize: TITLE_SIZE,
            lineHeight: TITLE_LINE_HEIGHT,
            letterSpacing: -1.5,
            wordBreak: 'break-word',
          }}
        >
          {title}
        </div>
        {lines.length === 0 ? null : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              width: '100%',
              maxHeight: TEXT_ROWS * TEXT_SIZE * TEXT_LINE_HEIGHT + 4 * TEXT_LINE_GAP,
              overflow: 'hidden',
              marginTop: 28,
              fontSize: TEXT_SIZE,
              lineHeight: TEXT_LINE_HEIGHT,
              color: '#bdbdd6',
            }}
          >
            {lines.map((line, index) => (
              <div
                key={index}
                style={{
                  display: 'block',
                  width: '100%',
                  // Exactly the rows planned, and never shrunk by the flex column: a line that
                  // wraps more than estimated is clipped by `lineClamp`, never drawn over its neighbour.
                  height: Math.ceil(line.rows * TEXT_SIZE * TEXT_LINE_HEIGHT),
                  flexShrink: 0,
                  overflow: 'hidden',
                  marginTop: index === 0 ? 0 : TEXT_LINE_GAP,
                  lineClamp: line.rows,
                  wordBreak: 'break-word',
                }}
              >
                {line.text}
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', height: 40 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 40,
            height: 40,
            borderRadius: 12,
            backgroundImage: 'linear-gradient(135deg, #a99bff 0%, #5fc8f8 100%)',
          }}
        >
          <Glyph size={24} />
        </div>
        <div style={{ display: 'flex', marginLeft: 12, fontSize: 28, color: '#f3f3f8' }}>
          ntn
          <span style={{ color: '#8fc0ff' }}>.link</span>
        </div>
      </div>
    </div>,
    { width: 1200, height: 630, fonts: await loadFonts(), headers },
  );
}
