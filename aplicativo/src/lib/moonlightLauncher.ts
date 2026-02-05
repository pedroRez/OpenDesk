import { Command } from '@tauri-apps/plugin-shell';

import { isTauriRuntime } from './hostDaemon';
import { getMoonlightPath } from './moonlightSettings';

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
  if (userPath) return [userPath, ...FALLBACK_PATHS];
  return [...FALLBACK_PATHS];
}

export async function isMoonlightAvailable(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  const paths = await resolveMoonlightPaths();
  return paths.length > 0;
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
