import type { ReactNode } from 'react';

import './globals.css';
import AppHeader from '../components/AppHeader';
import Providers from './providers';

export const metadata = {
  title: 'OpenDesk',
  description: 'Marketplace de PCs remotos por hora',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <Providers>
          <AppHeader />
          {children}
        </Providers>
      </body>
    </html>
  );
}
