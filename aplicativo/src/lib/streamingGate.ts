import { Command } from '@tauri-apps/plugin-shell';

import { isTauriRuntime } from './hostDaemon';

const FIREWALL_RULE_PREFIX = 'OpenDesk Sunshine';

export const SUNSHINE_TCP_PORTS = [47984, 47989, 47990];
export const SUNSHINE_UDP_PORT_RANGES = [{ start: 47998, end: 48010 }];

type GatePortsSpec = {
  tcp: string;
  udp: string;
};

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

const execNetsh = async (args: string[]) => {
  const command = Command.create('netsh', args);
  const result = await command.execute();
  return {
    code: result.code ?? 0,
    stdout: (result.stdout ?? '').toString().trim(),
    stderr: (result.stderr ?? '').toString().trim(),
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

  await deleteFirewallRules(name);
  await addFirewallRule({ name, action: 'allow', protocol: 'TCP', ports: portSpec.tcp, remoteIp });
  await addFirewallRule({ name, action: 'allow', protocol: 'UDP', ports: portSpec.udp, remoteIp });
}

export async function closeStreamingGate(pcId: string, options: StreamingGateOptions = {}): Promise<void> {
  if (!pcId || !isTauriRuntime() || !isWindows()) return;
  const name = buildRuleName(pcId);
  const portSpec = buildPortSpec(options.extraPorts ?? []);

  await deleteFirewallRules(name);
  await addFirewallRule({ name, action: 'block', protocol: 'TCP', ports: portSpec.tcp, remoteIp: 'any' });
  await addFirewallRule({ name, action: 'block', protocol: 'UDP', ports: portSpec.udp, remoteIp: 'any' });
}



