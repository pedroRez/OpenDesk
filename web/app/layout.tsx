import type { ReactNode } from 'react';

import './globals.css';

export const metadata = {
  title: 'OpenDesk',
  description: 'Marketplace de PCs remotos por hora',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
