'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function HostPanelPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/host/dashboard');
  }, [router]);

  return null;
}
