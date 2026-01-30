'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';

import { useAuth } from '../lib/auth';

export default function ProtectedRoute({
  children,
  redirectTo,
}: {
  children: ReactNode;
  redirectTo: string;
}) {
  const router = useRouter();
  const { isLoading, isAuthenticated } = useAuth();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace(redirectTo);
    }
  }, [isLoading, isAuthenticated, redirectTo, router]);

  if (isLoading || !isAuthenticated) {
    return <div style={{ padding: 32 }}>Carregando...</div>;
  }

  return <>{children}</>;
}
