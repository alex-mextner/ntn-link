/**
 * Generated 1200x630 card for links whose page has no social image. Fonts are bundled
 * (latin + cyrillic subsets of Noto Sans Bold) so rendering needs no network and Cyrillic
 * titles never fall back to tofu boxes.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageResponse } from 'next/og';

// Distinct family names, chained in `fontFamily`: satori only falls back between families,
// two subsets registered under one name leave the second one unused.
const FONT_FILES = [
  { family: 'Noto Sans Latin', file: 'noto-sans-latin-700-normal.woff' },
  { family: 'Noto Sans Cyrillic', file: 'noto-sans-cyrillic-700-normal.woff' },
] as const;
const FONT_STACK = FONT_FILES.map(({ family }) => family).join(', ');
const TITLE_MAX = 90;
const DESCRIPTION_MAX = 140;

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

function clip(text: string, max: number): string {
  const chars = [...text.trim()];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}

export async function renderTitleCard(
  title: string,
  description: string,
  workspace: string,
  headers: Record<string, string>,
): Promise<ImageResponse> {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 72,
        background: 'linear-gradient(135deg, #1f2937 0%, #111827 100%)',
        color: '#f9fafb',
        fontFamily: FONT_STACK,
      }}
    >
      <div style={{ display: 'flex', height: 40, fontSize: 30, color: '#9ca3af' }}>
        {workspace}.notion.site
      </div>
      {/* Fixed-height regions with clipping: a long or unbroken title can never push past the
          630 px frame or over the workspace label, whatever the glyph widths. */}
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
        <div
          style={{
            display: 'flex',
            width: '100%',
            maxHeight: 300,
            overflow: 'hidden',
            fontSize: 64,
            lineHeight: 1.15,
            wordBreak: 'break-word',
          }}
        >
          {clip(title, TITLE_MAX)}
        </div>
        {description === '' ? null : (
          <div
            style={{
              display: 'flex',
              width: '100%',
              maxHeight: 80,
              overflow: 'hidden',
              fontSize: 30,
              lineHeight: 1.25,
              color: '#d1d5db',
              marginTop: 24,
              wordBreak: 'break-word',
            }}
          >
            {clip(description, DESCRIPTION_MAX)}
          </div>
        )}
      </div>
    </div>,
    { width: 1200, height: 630, fonts: await loadFonts(), headers },
  );
}
