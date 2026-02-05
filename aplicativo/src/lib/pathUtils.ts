import { Command } from '@tauri-apps/plugin-shell';

import { isTauriRuntime } from './hostDaemon';

export function normalizeWindowsPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const unquoted = trimmed.replace(/^"|"$/g, '').replace(/^'|'$/g, '');
  return unquoted.replace(/\//g, '\\');
}

export async function pathExists(path: string): Promise<boolean> {
  if (!path || !isTauriRuntime()) return false;
  try {
    const command = Command.create('powershell', [
      '-NoProfile',
      '-Command',
      `Test-Path -LiteralPath "${path.replace(/"/g, '""')}"`,
    ]);
    const result = await command.execute();
    const stdout = (result.stdout ?? '').toString().trim().toLowerCase();
    return stdout === 'true';
  } catch (error) {
    console.warn('[PATH] check fail', { path, error });
    return false;
  }
}

export async function findExistingPath(paths: string[]): Promise<string | null> {
  for (const path of paths) {
    if (!path) continue;
    const exists = await pathExists(path);
    if (exists) return path;
  }
  return null;
}
