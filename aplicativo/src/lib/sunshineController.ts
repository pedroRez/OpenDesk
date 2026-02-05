import { invoke } from '@tauri-apps/api/core';
import { Command } from '@tauri-apps/plugin-shell';

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
let sunshineCheckInFlight: Promise<boolean> | null = null;

async function isSunshineRunning(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    const command = Command.create('cmd', ['/c', 'tasklist', '/FI', 'IMAGENAME eq sunshine.exe']);
    const output = await command.execute();
    const stdout = (output.stdout ?? '').toString().toLowerCase();
    return stdout.includes('sunshine.exe');
  } catch (error) {
    console.warn('[STREAM][HOST] sunshine check fail', { error });
    return false;
  }
}

async function tryStart(path: string): Promise<SunshineProcess | null> {
  try {
    console.log('[LAUNCH] starting sunshine', { path });
    await invoke('start_sunshine', { path });
    console.log('[LAUNCH] sunshine ok', { path });
    return { kill: async () => {} };
  } catch (error) {
    console.warn('[LAUNCH] sunshine fail', { path, error });
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

export async function ensureSunshineRunning(): Promise<boolean> {
  if (!isTauriRuntime()) {
    console.warn('[STREAM][HOST] sunshine skip (not tauri runtime)');
    return false;
  }
  if (sunshineProcess) {
    console.log('[STREAM][HOST] sunshine already running');
    return true;
  }
  if (sunshineCheckInFlight) {
    return sunshineCheckInFlight;
  }

  sunshineCheckInFlight = (async () => {
    const running = await isSunshineRunning();
    if (running) {
      console.log('[STREAM][HOST] sunshine already running');
      return true;
    }

    console.log('[STREAM][HOST] sunshine start');
    const paths = await resolveSunshinePaths();
    for (const path of paths) {
      const exists = await pathExists(path);
      if (!exists) continue;
      const process = await tryStart(path);
      if (process) {
        sunshineProcess = process;
        console.log('[STREAM][HOST] sunshine ok', { path });
        return true;
      }
    }

    console.error('[STREAM][HOST] sunshine fail (no valid path)');
    return false;
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
      console.log('[PATH] autodetected sunshinePath=', detected);
    }
  } else {
    console.log('[PATH] autodetect sunshinePath fail');
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
