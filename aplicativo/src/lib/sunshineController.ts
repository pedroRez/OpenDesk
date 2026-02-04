import { Command } from '@tauri-apps/plugin-shell';

import { getSunshinePath } from './sunshineSettings';
import { isTauriRuntime } from './hostDaemon';

const FALLBACK_PATHS = [
  'C:\\Program Files\\Sunshine\\sunshine.exe',
  'C:\\Program Files (x86)\\Sunshine\\sunshine.exe',
];

type SunshineProcess = { kill: () => Promise<void> };

let sunshineProcess: SunshineProcess | null = null;

async function tryStart(path: string): Promise<SunshineProcess | null> {
  try {
    const command = Command.create(path, []);
    const process = await command.spawn();
    return process;
  } catch (error) {
    console.warn('[STREAM][HOST] sunshine start fail', { path, error });
    return null;
  }
}

async function resolveSunshinePaths(): Promise<string[]> {
  const userPath = getSunshinePath();
  if (userPath) return [userPath, ...FALLBACK_PATHS];
  return [...FALLBACK_PATHS];
}

export async function ensureSunshineRunning(): Promise<boolean> {
  if (!isTauriRuntime()) {
    console.warn('[STREAM][HOST] sunshine skip (not tauri runtime)');
    return false;
  }
  if (sunshineProcess) {
    console.log('[STREAM][HOST] sunshine ok (already running)');
    return true;
  }

  console.log('[STREAM][HOST] sunshine start');
  const paths = await resolveSunshinePaths();
  for (const path of paths) {
    const process = await tryStart(path);
    if (process) {
      sunshineProcess = process;
      console.log('[STREAM][HOST] sunshine ok', { path });
      return true;
    }
  }

  console.error('[STREAM][HOST] sunshine fail (no valid path)');
  return false;
}

export async function stopSunshine(): Promise<void> {
  if (!sunshineProcess) return;
  try {
    await sunshineProcess.kill();
  } finally {
    sunshineProcess = null;
  }
}
