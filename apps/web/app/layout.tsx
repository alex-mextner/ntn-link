import type { ReactNode } from 'react';

export const metadata = {
  title: 'ntn.link — short links with previews for public Notion pages',
  description:
    'Short, readable links for public Notion pages that unfurl with a proper title, description and image.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
