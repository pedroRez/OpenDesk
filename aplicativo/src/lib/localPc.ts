import { request } from './api';
import { getLocalPcId } from './hostState';

type PcStatus = 'ONLINE' | 'OFFLINE' | 'BUSY';

type PcSummary = {
  id: string;
  status: PcStatus;
};

export async function markLocalPcOffline(): Promise<boolean> {
  const localPcId = getLocalPcId();
  if (!localPcId) return false;

  const pc = await request<PcSummary>(`/pcs/${localPcId}`);
  if (pc.status === 'OFFLINE') {
    return false;
  }

  await request(`/pcs/${localPcId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'OFFLINE' }),
  });

  return true;
}
