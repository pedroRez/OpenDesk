import { invoke } from '@tauri-apps/api/core';

import { getSunshinePath, setSunshinePath } from './sunshineSettings';
import { isTauriRuntime } from './hostDaemon';
import {
  detectSunshinePathNative,
  findExistingPath,
  getWindowsEnv,
  normalizeWindowsPath,
  pathExists,
  whichBinary,
} from './pathUtils';

const FALLBACK_PATHS = [
  'C:\\Program Files\\Sunshine\\sunshine.exe',
  'C:\\Program Files (x86)\\Sunshine\\sunshine.exe',
];

type SunshineProcess = { kill: () => Promise<void> };

let sunshineProcess: SunshineProcess | null = null;
let sunshineCheckInFlight: Promise<SunshineEnsureResult> | null = null;

export async function isSunshineRunning(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    const result = await invoke<boolean>('is_process_running', { processName: 'sunshine.exe' });
    return Boolean(result);
  } catch (error) {
    console.warn('[SUNSHINE] check fail', { error });
    return false;
  }
}

async function tryStart(path: string): Promise<SunshineProcess | null> {
  try {
    await invoke('launch_exe', { path, args: [] });
    return { kill: async () => {} };
  } catch (error) {
    console.warn('[SUNSHINE] launch fail', { error });
    return null;
  }
}

async function resolveSunshinePaths(): Promise<string[]> {
  const paths: string[] = [];
  const userPath = getSunshinePath();
  if (userPath) {
    paths.push(userPath);
  }
  const programFiles = await getWindowsEnv('ProgramFiles');
  const programFilesX86 = await getWindowsEnv('ProgramFiles(x86)');
  if (programFiles) {
    paths.push(`${programFiles}\\Sunshine\\sunshine.exe`);
  }
  if (programFilesX86) {
    paths.push(`${programFilesX86}\\Sunshine\\sunshine.exe`);
  }
  paths.push(...FALLBACK_PATHS);

  const normalized = paths.map(normalizeWindowsPath).filter(Boolean);
  const unique = Array.from(new Set(normalized));

  const wherePath = await whichBinary('sunshine');
  if (wherePath) {
    unique.push(wherePath);
  }
  return Array.from(new Set(unique));
}

export type SunshineEnsureResult = {
  ok: boolean;
  started: boolean;
  reason?: 'path_missing' | 'launch_failed';
};

export async function ensureSunshineRunning(): Promise<SunshineEnsureResult> {
  if (!isTauriRuntime()) {
    console.warn('[SUNSHINE] skip (not tauri runtime)');
    return { ok: false, started: false, reason: 'launch_failed' };
  }
  if (sunshineCheckInFlight) {
    return sunshineCheckInFlight;
  }

  sunshineCheckInFlight = (async () => {
    if (sunshineProcess) {
      const stillRunning = await isSunshineRunning();
      if (stillRunning) {
        console.log('[SUNSHINE] already running');
        return { ok: true, started: false };
      }
      sunshineProcess = null;
    }
    const running = await isSunshineRunning();
    if (running) {
      console.log('[SUNSHINE] already running');
      sunshineProcess = { kill: async () => {} };
      return { ok: true, started: false };
    }

    const paths = await resolveSunshinePaths();
    let attempted = false;
    for (const path of paths) {
      const exists = await pathExists(path);
      if (!exists) continue;
      attempted = true;
      console.log('[SUNSHINE] detected path=', path);
      const process = await tryStart(path);
      if (process) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        const nowRunning = await isSunshineRunning();
        if (nowRunning) {
          sunshineProcess = process;
          console.log('[SUNSHINE] launch ok');
          return { ok: true, started: true };
        }
        console.warn('[SUNSHINE] launch fail', { error: 'process not detected' });
        return { ok: false, started: false, reason: 'launch_failed' };
      }
    }
    if (attempted) {
      console.warn('[SUNSHINE] launch fail', { error: 'launch failed' });
      return { ok: false, started: false, reason: 'launch_failed' };
    }
    console.warn('[SUNSHINE] launch fail', { error: 'path missing' });
    return { ok: false, started: false, reason: 'path_missing' };
  })();

  try {
    return await sunshineCheckInFlight;
  } finally {
    sunshineCheckInFlight = null;
  }
}

export async function detectSunshinePath(): Promise<string | null> {
  const nativeDetected = await detectSunshinePathNative();
  const detected = nativeDetected ?? (await findExistingPath(await resolveSunshinePaths()));
  if (detected) {
    const current = getSunshinePath();
    if (current !== detected) {
      setSunshinePath(detected);
      console.log('[SUNSHINE] detected path=', detected);
    }
  } else {
    console.log('[SUNSHINE] detected path fail');
  }
  return detected;
}

export async function stopSunshine(): Promise<void> {
  if (!sunshineProcess) return;
  try {
    await sunshineProcess.kill();
  } finally {
    sunshineProcess = null;
  }
}
