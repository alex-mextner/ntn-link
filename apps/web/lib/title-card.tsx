/**
 * Generated 1200x630 card for links whose page has no social image: the ntn.link identity
 * (ink background, violet and sky glow, link glyph) around the page title. Fonts are bundled
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
        padding: 64,
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
          height: 44,
          padding: '0 20px',
          fontSize: 26,
          color: '#c9c9de',
          background: 'rgba(255,255,255,0.08)',
          border: '1px solid rgba(255,255,255,0.16)',
          borderRadius: 22,
        }}
      >
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
            letterSpacing: -1.5,
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
              color: '#b4b4cc',
              marginTop: 24,
              wordBreak: 'break-word',
            }}
          >
            {clip(description, DESCRIPTION_MAX)}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', height: 44 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 44,
            height: 44,
            borderRadius: 13,
            backgroundImage: 'linear-gradient(135deg, #a99bff 0%, #5fc8f8 100%)',
          }}
        >
          <Glyph size={26} />
        </div>
        <div style={{ display: 'flex', marginLeft: 14, fontSize: 30, color: '#f3f3f8' }}>
          ntn
          <span style={{ color: '#8fc0ff' }}>.link</span>
        </div>
      </div>
    </div>,
    { width: 1200, height: 630, fonts: await loadFonts(), headers },
  );
}
