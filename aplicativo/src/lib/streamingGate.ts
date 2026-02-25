import { Command } from '@tauri-apps/plugin-shell';

import { isTauriRuntime } from './hostDaemon';

const FIREWALL_RULE_PREFIX = 'OpenDesk Sunshine';

export const SUNSHINE_TCP_PORTS = [47984, 47989, 47990];
export const SUNSHINE_UDP_PORT_RANGES = [{ start: 47998, end: 48010 }];

type GatePortsSpec = {
  tcp: string;
  udp: string;
};

type CommandPayload = unknown;

class StreamingGatePermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamingGatePermissionError';
  }
}

export type StreamingGateOptions = {
  clientAddress?: string | null;
  extraPorts?: number[];
};

type StreamingGateInput = StreamingGateOptions | string | null | undefined;

const normalizeGateOptions = (input?: StreamingGateInput): StreamingGateOptions => {
  if (!input) return {};
  if (typeof input === 'string') return { clientAddress: input };
  return input;
};

const isWindows = () => {
  if (typeof navigator === 'undefined') return false;
  return navigator.userAgent.toLowerCase().includes('windows');
};

const normalizePorts = (ports: number[]): number[] => {
  const unique = Array.from(new Set(ports.filter((port) => Number.isFinite(port))));
  return unique
    .map((port) => Math.trunc(port))
    .filter((port) => port > 0 && port <= 65535)
    .sort((a, b) => a - b);
};

const isPortInRange = (port: number, range: { start: number; end: number }) =>
  port >= range.start && port <= range.end;

const buildPortSpec = (extraPorts: number[] = []): GatePortsSpec => {
  const normalizedExtra = normalizePorts(extraPorts);
  const tcpPorts = normalizePorts([...SUNSHINE_TCP_PORTS, ...normalizedExtra]);
  const udpExtra = normalizedExtra.filter(
    (port) => !SUNSHINE_UDP_PORT_RANGES.some((range) => isPortInRange(port, range)),
  );
  const udpRanges = SUNSHINE_UDP_PORT_RANGES.map((range) => `${range.start}-${range.end}`);
  const udpPorts = udpRanges.concat(udpExtra.map((port) => String(port)));
  return {
    tcp: tcpPorts.join(','),
    udp: udpPorts.join(','),
  };
};

const buildRuleName = (pcId: string) => `${FIREWALL_RULE_PREFIX} ${pcId}`;
let gatePermissionWarningShown = false;

const toByteView = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'number')) {
    return Uint8Array.from(value.map((entry) => entry & 0xff));
  }
  if (value && typeof value === 'object') {
    const maybeData = (value as { data?: unknown }).data;
    if (Array.isArray(maybeData) && maybeData.every((entry) => typeof entry === 'number')) {
      return Uint8Array.from(maybeData.map((entry) => entry & 0xff));
    }
  }
  return null;
};

const decodePayload = (value: CommandPayload | null | undefined): string => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  const bytes = toByteView(value);
  if (bytes) {
    // netsh on Windows may emit non-UTF8 bytes; decode as windows-1252 when available.
    try {
      return new TextDecoder('windows-1252').decode(bytes);
    } catch {
      return new TextDecoder().decode(bytes);
    }
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[object]';
    }
  }
  return String(value);
};

const normalizeAscii = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const isElevationErrorText = (text: string): boolean => {
  const normalized = normalizeAscii(text);
  return (
    normalized.includes('requires elevation') ||
    normalized.includes('exige elevacao') ||
    normalized.includes('run as administrator') ||
    normalized.includes('executar como administrador')
  );
};

const asPermissionError = (detail: string): StreamingGatePermissionError | null =>
  isElevationErrorText(detail) ? new StreamingGatePermissionError(detail) : null;

const handleGatePermissionError = (action: 'open' | 'close', pcId: string, error: unknown): boolean => {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  const permissionError = error instanceof StreamingGatePermissionError ? error : asPermissionError(detail);
  if (!permissionError) return false;
  if (!gatePermissionWarningShown) {
    gatePermissionWarningShown = true;
    console.warn('[STREAM_GATE] netsh requires administrator privileges; skipping firewall sync.', {
      action,
      pcId,
      error: permissionError.message,
    });
  }
  return true;
};

const execNetsh = async (args: string[]) => {
  const command = Command.create('netsh', args, { encoding: 'raw' });
  const result = await command.execute();
  return {
    code: result.code ?? 0,
    stdout: decodePayload(result.stdout).trim(),
    stderr: decodePayload(result.stderr).trim(),
  };
};

const deleteFirewallRules = async (name: string): Promise<void> => {
  const result = await execNetsh(['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`]);
  if (result.code !== 0 && result.stderr) {
    const lower = result.stderr.toLowerCase();
    const isMissingRule =
      lower.includes('no rules match') ||
      lower.includes('nenhuma regra') ||
      lower.includes('not found') ||
      lower.includes('no rules');
    const permissionError = asPermissionError(result.stderr);
    if (permissionError) {
      throw permissionError;
    }
    if (!isMissingRule) {
      console.warn('[STREAM_GATE] delete rule fail', { name, error: result.stderr });
    }
  }
};

const addFirewallRule = async (params: {
  name: string;
  action: 'allow' | 'block';
  protocol: 'TCP' | 'UDP';
  ports: string;
  remoteIp: string;
}): Promise<void> => {
  const { name, action, protocol, ports, remoteIp } = params;
  if (!ports) return;
  const result = await execNetsh([
    'advfirewall',
    'firewall',
    'add',
    'rule',
    `name=${name}`,
    'dir=in',
    `action=${action}`,
    `protocol=${protocol}`,
    `localport=${ports}`,
    `remoteip=${remoteIp}`,
    'profile=any',
  ]);
  if (result.code !== 0) {
    const detail = result.stderr || result.stdout || 'erro desconhecido';
    const permissionError = asPermissionError(detail);
    if (permissionError) {
      throw permissionError;
    }
    throw new Error(detail);
  }
};

const resolveRemoteIp = (clientAddress?: string | null) => {
  const trimmed = clientAddress?.trim();
  return trimmed ? trimmed : 'any';
};

export async function openStreamingGate(pcId: string, input?: StreamingGateInput): Promise<void> {
  if (!pcId || !isTauriRuntime() || !isWindows()) return;
  const options = normalizeGateOptions(input);
  const name = buildRuleName(pcId);
  const portSpec = buildPortSpec(options.extraPorts ?? []);
  const remoteIp = resolveRemoteIp(options.clientAddress);

  try {
    await deleteFirewallRules(name);
    await addFirewallRule({ name, action: 'allow', protocol: 'TCP', ports: portSpec.tcp, remoteIp });
    await addFirewallRule({ name, action: 'allow', protocol: 'UDP', ports: portSpec.udp, remoteIp });
  } catch (error) {
    if (handleGatePermissionError('open', pcId, error)) return;
    throw error;
  }
}

export async function closeStreamingGate(pcId: string, options: StreamingGateOptions = {}): Promise<void> {
  if (!pcId || !isTauriRuntime() || !isWindows()) return;
  const name = buildRuleName(pcId);
  const portSpec = buildPortSpec(options.extraPorts ?? []);

  try {
    await deleteFirewallRules(name);
    await addFirewallRule({ name, action: 'block', protocol: 'TCP', ports: portSpec.tcp, remoteIp: 'any' });
    await addFirewallRule({ name, action: 'block', protocol: 'UDP', ports: portSpec.udp, remoteIp: 'any' });
  } catch (error) {
    if (handleGatePermissionError('close', pcId, error)) return;
    throw error;
  }
}



