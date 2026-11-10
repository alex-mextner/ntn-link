import type { ReactNode } from 'react';
// Side-effect import is how Next.js loads a global stylesheet.
// oxlint-disable-next-line import/no-unassigned-import
import './globals.css';

export const metadata = {
  title: 'ntn.link: короткие ссылки на публичные страницы Notion',
  description:
    'Короткие читаемые ссылки на публичные страницы Notion, которые разворачиваются в мессенджерах с настоящим заголовком, описанием и картинкой.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
