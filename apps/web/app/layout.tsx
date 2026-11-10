import type { ReactNode } from 'react';
// Side-effect import is how Next.js loads a global stylesheet.
// oxlint-disable-next-line import/no-unassigned-import
import './globals.css';

export const metadata = {
  title: 'ntn.link: short links for public Notion pages',
  description:
    'Short, readable links for public Notion pages that unfurl in messengers with the real title, description and image.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#07070c' },
    { media: '(prefers-color-scheme: light)', color: '#f6f6fb' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
