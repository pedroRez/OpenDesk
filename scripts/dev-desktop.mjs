import { spawn } from 'node:child_process';
import process from 'node:process';

const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const healthUrl = (process.env.DEV_DESKTOP_HEALTH_URL ?? 'http://127.0.0.1:3333/health').trim();
const healthTimeoutMsRaw = Number(process.env.DEV_DESKTOP_HEALTH_TIMEOUT_MS ?? '1500');
const healthTimeoutMs = Number.isFinite(healthTimeoutMsRaw) ? Math.max(250, Math.trunc(healthTimeoutMsRaw)) : 1500;

function spawnPnpm(name, args) {
  const child = spawn(pnpmCmd, args, {
    stdio: 'inherit',
    shell: false,
  });
  child.on('error', (error) => {
    console.error(`[dev:desktop] failed to start ${name}:`, error);
  });
  return child;
}

async function isBackendHealthy() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), healthTimeoutMs);
  try {
    const response = await fetch(healthUrl, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => null);
    return payload && typeof payload === 'object' && (payload).status === 'ok';
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

const runningChildren = new Set();
let shuttingDown = false;

function registerChild(child) {
  runningChildren.add(child);
  child.on('exit', () => {
    runningChildren.delete(child);
  });
  return child;
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of runningChildren) {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore child kill errors on shutdown
    }
  }
  setTimeout(() => {
    for (const child of runningChildren) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore child kill errors on forced shutdown
      }
    }
    process.exit(exitCode);
  }, 1200).unref();
}

async function main() {
  const backendUp = await isBackendHealthy();
  const desktop = registerChild(spawnPnpm('desktop', ['--filter', 'aplicativo', 'dev']));

  if (backendUp) {
    console.log(`[dev:desktop] backend healthy at ${healthUrl}; reusing existing backend.`);
    desktop.on('exit', (code, signal) => {
      if (signal) {
        shutdown(1);
        return;
      }
      shutdown(code ?? 0);
    });
    return;
  }

  console.log(`[dev:desktop] backend offline at ${healthUrl}; starting backend + desktop.`);
  const backend = registerChild(spawnPnpm('backend', ['--filter', 'backend', 'dev']));

  desktop.on('exit', (code, signal) => {
    if (signal) {
      shutdown(1);
      return;
    }
    shutdown(code ?? 0);
  });

  backend.on('exit', async (code, signal) => {
    if (shuttingDown) return;
    if (signal || code === 0) {
      shutdown(code ?? 0);
      return;
    }

    // Backend command can fail if another instance is already bound to :3333.
    if (await isBackendHealthy()) {
      console.warn(
        `[dev:desktop] backend process exited (code=${code}), but ${healthUrl} is healthy; keeping desktop running.`,
      );
      return;
    }

    console.error(`[dev:desktop] backend process exited with code=${code}.`);
    shutdown(code ?? 1);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch((error) => {
  console.error('[dev:desktop] fatal startup error:', error);
  shutdown(1);
});
