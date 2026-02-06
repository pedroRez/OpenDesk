import { invoke } from '@tauri-apps/api/core';

import { isTauriRuntime } from './hostDaemon';

export type HardwareProfile = {
  cpuName: string;
  ramGb: number;
  gpuName: string;
  storageSummary: string;
  osName?: string;
  screenResolution?: string;
};

export async function getLocalMachineId(): Promise<string | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  try {
    const id = await invoke<string>('get_local_pc_id');
    return id ?? null;
  } catch (error) {
    console.warn('[HARDWARE] local pc id fail', error);
    return null;
  }
}

export async function getHardwareProfile(requestId: string): Promise<HardwareProfile> {
  if (!isTauriRuntime()) {
    throw new Error('Deteccao de hardware disponivel apenas no app desktop.');
  }
  return invoke<HardwareProfile>('get_hardware_profile', { requestId });
}

export async function cancelHardwareProfile(requestId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke('cancel_hardware_profile', { requestId });
  } catch (error) {
    console.warn('[HARDWARE] cancel fail', error);
  }
}
