import process from 'node:process';
import path from 'node:path';

type EnvBootstrapInfo = {
  cwd: string;
  nodeEnv: string;
  loadedFiles: string[];
  missingFiles: string[];
};

const nodeEnv = (process.env.NODE_ENV ?? 'development').trim() || 'development';
const cwd = process.cwd();

// Highest-precedence first because process.loadEnvFile does not overwrite existing keys.
const candidateFiles = [
  `.env.${nodeEnv}.local`,
  ...(nodeEnv === 'test' ? [] : ['.env.local']),
  `.env.${nodeEnv}`,
  '.env',
];

const loadedFiles: string[] = [];
const missingFiles: string[] = [];

for (const relativeFile of candidateFiles) {
  const absoluteFile = path.resolve(cwd, relativeFile);
  try {
    process.loadEnvFile(absoluteFile);
    loadedFiles.push(relativeFile);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : null;
    if (code === 'ENOENT') {
      missingFiles.push(relativeFile);
      continue;
    }
    throw error;
  }
}

export function getEnvBootstrapInfo(): EnvBootstrapInfo {
  return {
    cwd,
    nodeEnv,
    loadedFiles: [...loadedFiles],
    missingFiles: [...missingFiles],
  };
}
