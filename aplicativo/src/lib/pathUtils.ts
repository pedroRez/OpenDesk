import { Command } from '@tauri-apps/plugin-shell';

import { isTauriRuntime } from './hostDaemon';

const envCache: Record<string, string | null> = {};

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

export async function whichBinary(binary: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  try {
    const command = Command.create('cmd', ['/c', 'where', binary]);
    const result = await command.execute();
    const stdout = (result.stdout ?? '').toString().trim();
    if (!stdout) return null;
    const first = stdout.split(/\r?\n/)[0]?.trim();
    return first ? normalizeWindowsPath(first) : null;
  } catch (error) {
    console.warn('[PATH] where fail', { binary, error });
    return null;
  }
}

export async function getWindowsEnv(name: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  if (Object.prototype.hasOwnProperty.call(envCache, name)) {
    return envCache[name];
  }
  try {
    const escaped = name.replace(/'/g, "''");
    const command = Command.create('powershell', [
      '-NoProfile',
      '-Command',
      `[Environment]::GetEnvironmentVariable('${escaped}')`,
    ]);
    const result = await command.execute();
    const stdout = (result.stdout ?? '').toString().trim();
    const value = stdout ? normalizeWindowsPath(stdout) : null;
    envCache[name] = value;
    return value;
  } catch (error) {
    console.warn('[PATH] env fail', { name, error });
    envCache[name] = null;
    return null;
  }
}
