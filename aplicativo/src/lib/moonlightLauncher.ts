import { invoke } from '@tauri-apps/api/core';
import { Command } from '@tauri-apps/plugin-shell';

import { isTauriRuntime } from './hostDaemon';
import { getMoonlightPath, setMoonlightPath } from './moonlightSettings';
import {
  detectMoonlightPathNative,
  findExistingPath,
  getWindowsEnv,
  normalizeWindowsPath,
  pathExists,
  whichBinary,
} from './pathUtils';

const FALLBACK_PATHS = [
  'C:\\Program Files\\Moonlight Game Streaming\\Moonlight.exe',
  'C:\\Program Files (x86)\\Moonlight Game Streaming\\Moonlight.exe',
];

type MoonlightCommandOutput = {
  code: number;
  stdout: string;
  stderr: string;
};

type MoonlightLaunchResult = {
  ok: boolean;
  needsPair: boolean;
  message?: string;
};

function parseHost(connectAddress: string): string {
  const trimmed = connectAddress.trim();
  if (!trimmed) return '';
  const [host] = trimmed.split(':');
  if (!host || host === '127.0.0.1' || host.toLowerCase() === 'localhost') {
    return '';
  }
  return host;
}

function parseApps(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.toLowerCase().startsWith('list'))
    .map((line) => line.replace(/^\d+[\)\.\-]\s*/, '').trim())
    .filter(Boolean);
}

function pickPreferredApp(apps: string[]): string | null {
  if (apps.length === 0) return null;
  const preferred = apps.find((app) => app.toLowerCase() === 'desktop')
    ?? apps.find((app) => app.toLowerCase() === 'steam');
  return preferred ?? apps[0];
}

function needsPairingFromOutput(output: MoonlightCommandOutput): boolean {
  const combined = `${output.stdout}\n${output.stderr}`.toLowerCase();
  return combined.includes('pair') || combined.includes('not paired') || combined.includes('not paired with');
}

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
  const paths: string[] = [];
  const userPath = getMoonlightPath();
  if (userPath) {
    paths.push(userPath);
  }
  const programFiles = await getWindowsEnv('ProgramFiles');
  const programFilesX86 = await getWindowsEnv('ProgramFiles(x86)');
  if (programFiles) {
    paths.push(`${programFiles}\\Moonlight Game Streaming\\Moonlight.exe`);
  }
  if (programFilesX86) {
    paths.push(`${programFilesX86}\\Moonlight Game Streaming\\Moonlight.exe`);
  }
  paths.push(...FALLBACK_PATHS);

  const normalized = paths.map(normalizeWindowsPath).filter(Boolean);
  const unique = Array.from(new Set(normalized));

  const wherePath = await whichBinary('moonlight');
  if (wherePath) {
    unique.push(wherePath);
  }
  return Array.from(new Set(unique));
}

export async function isMoonlightAvailable(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  const paths = await resolveMoonlightPaths();
  const existing = await findExistingPath(paths);
  return Boolean(existing);
}

export async function launchMoonlight(connectAddress: string): Promise<MoonlightLaunchResult> {
  if (!isTauriRuntime()) {
    console.warn('[STREAM][CLIENT] moonlight skip (not tauri runtime)');
    return { ok: false, needsPair: false, message: 'Nao esta no app desktop.' };
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
      const host = parseHost(connectAddress);
      if (!host) {
        console.warn('[MOONLIGHT] invalid connectAddress', { connectAddress });
        return { ok: false, needsPair: false, message: 'Endereco invalido.' };
      }

      const listOutput = await invoke<MoonlightCommandOutput>('moonlight_list', { path, host });
      console.log('[MOONLIGHT] list', {
        host,
        stdout: listOutput.stdout,
        stderr: listOutput.stderr,
        code: listOutput.code,
      });

      const apps = parseApps(listOutput.stdout);
      const app = pickPreferredApp(apps);
      if (!app) {
        const needsPair = needsPairingFromOutput(listOutput);
        console.warn('[MOONLIGHT] list fail (no apps)', { host, needsPair });
        return {
          ok: false,
          needsPair,
          message: listOutput.stderr || listOutput.stdout || 'Nao foi possivel listar apps.',
        };
      }

      const streamOutput = await invoke<MoonlightCommandOutput>('moonlight_stream', { path, host, app });
      console.log('[MOONLIGHT] stream', {
        host,
        app,
        ok: true,
        stderr: streamOutput.stderr,
      });
      return { ok: true, needsPair: false };
    } catch (error) {
      console.warn('[MOONLIGHT] stream', { ok: false, error });
    }
  }

  console.error('[STREAM][CLIENT] launch fail (no valid path)');
  return {
    ok: alreadyRunning,
    needsPair: false,
    message: alreadyRunning ? undefined : 'Moonlight nao encontrado.',
  };
}

export async function pairMoonlight(connectAddress: string): Promise<MoonlightLaunchResult> {
  if (!isTauriRuntime()) {
    return { ok: false, needsPair: false, message: 'Nao esta no app desktop.' };
  }
  const host = parseHost(connectAddress);
  if (!host) {
    return { ok: false, needsPair: false, message: 'Endereco invalido.' };
  }

  const paths = await resolveMoonlightPaths();
  for (const path of paths) {
    const exists = await pathExists(path);
    if (!exists) continue;
    try {
      const output = await invoke<MoonlightCommandOutput>('moonlight_pair', { path, host });
      if (output.code === 0) {
        console.log('[MOONLIGHT] pair', { host, ok: true, stderr: output.stderr });
        return { ok: true, needsPair: false };
      }
      console.warn('[MOONLIGHT] pair', { host, ok: false, stderr: output.stderr, code: output.code });
      return {
        ok: false,
        needsPair: false,
        message: output.stderr || output.stdout || 'Falha ao parear.',
      };
    } catch (error) {
      return { ok: false, needsPair: false, message: error instanceof Error ? error.message : 'Falha ao parear.' };
    }
  }

  return { ok: false, needsPair: false, message: 'Moonlight nao encontrado.' };
}

export async function detectMoonlightPath(): Promise<string | null> {
  const nativeDetected = await detectMoonlightPathNative();
  const detected = nativeDetected ?? (await findExistingPath(await resolveMoonlightPaths()));
  if (detected) {
    const current = getMoonlightPath();
    if (current !== detected) {
      setMoonlightPath(detected);
      console.log('[PATH] autodetected moonlightPath=', detected);
    }
  } else {
    console.log('[PATH] autodetect moonlightPath fail');
  }
  return detected;
}
