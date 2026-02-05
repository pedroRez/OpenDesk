import { Command } from '@tauri-apps/plugin-shell';

import { isTauriRuntime } from './hostDaemon';
import { getMoonlightPath } from './moonlightSettings';
import { findExistingPath, normalizeWindowsPath, pathExists } from './pathUtils';

const FALLBACK_PATHS = [
  'C:\\Program Files\\Moonlight Game Streaming\\Moonlight.exe',
  'C:\\Program Files (x86)\\Moonlight Game Streaming\\Moonlight.exe',
];

async function isMoonlightRunning(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    const command = Command.create('cmd', ['/c', 'tasklist', '/FI', 'IMAGENAME eq Moonlight.exe']);
    const output = await command.execute();
    const stdout = (output.stdout ?? '').toString().toLowerCase();
    return stdout.includes('moonlight.exe');
  } catch (error) {
    console.warn('[STREAM][CLIENT] moonlight check fail', { error });
    return false;
  }
}

async function resolveMoonlightPaths(): Promise<string[]> {
  const userPath = getMoonlightPath();
  if (userPath) return [userPath, ...FALLBACK_PATHS].map(normalizeWindowsPath);
  return [...FALLBACK_PATHS].map(normalizeWindowsPath);
}

export async function isMoonlightAvailable(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  const paths = await resolveMoonlightPaths();
  const existing = await findExistingPath(paths);
  return Boolean(existing);
}

export async function launchMoonlight(connectAddress: string): Promise<boolean> {
  if (!isTauriRuntime()) {
    console.warn('[STREAM][CLIENT] moonlight skip (not tauri runtime)');
    return false;
  }

  const alreadyRunning = await isMoonlightRunning();
  if (alreadyRunning) {
    console.log('[STREAM][CLIENT] moonlight already running, attempting reuse');
  }

  const paths = await resolveMoonlightPaths();
  for (const path of paths) {
    const exists = await pathExists(path);
    if (!exists) continue;
    try {
      const command = Command.create(path, [connectAddress]);
      await command.spawn();
      console.log('[STREAM][CLIENT] launch ok', { path });
      return true;
    } catch (error) {
      console.warn('[STREAM][CLIENT] launch fail', { path, error });
    }
  }

  console.error('[STREAM][CLIENT] launch fail (no valid path)');
  return alreadyRunning;
}

export async function detectMoonlightPath(): Promise<string | null> {
  const paths = await resolveMoonlightPaths();
  return findExistingPath(paths);
}
