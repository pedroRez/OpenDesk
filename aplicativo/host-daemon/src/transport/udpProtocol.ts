import { randomBytes } from 'node:crypto';

export const UDP_PROTOCOL_MAGIC = 0x4f44; // "OD"
export const UDP_PROTOCOL_VERSION = 1;
export const UDP_HEADER_SIZE = 38;
export const DEFAULT_MAX_UDP_PAYLOAD = 1100;
export const MAX_TOTAL_CHUNKS = 4096;

export const UDP_FLAG_KEYFRAME = 1 << 0;

export type UdpPacketHeader = {
  streamId: Buffer;
  seq: number;
  timestampUs: bigint;
  flags: number;
  chunkIndex: number;
  totalChunks: number;
  payloadSize: number;
};

export type UdpPacket = UdpPacketHeader & {
  payload: Buffer;
};

type BuildPacketInput = {
  streamId: Buffer;
  seq: number;
  timestampUs: bigint;
  flags: number;
  chunkIndex: number;
  totalChunks: number;
  payload: Buffer;
};

type PacketizeFrameInput = {
  streamId: Buffer;
  seq: number;
  timestampUs: bigint;
  flags: number;
  framePayload: Buffer;
  maxPayloadBytes?: number;
};

function assertStreamId(streamId: Buffer): void {
  if (!Buffer.isBuffer(streamId)) {
    throw new Error('streamId deve ser Buffer.');
  }
  if (streamId.length !== 16) {
    throw new Error(`streamId invalido: esperado 16 bytes, recebido ${streamId.length}.`);
  }
}

export function parseStreamId(input: string): Buffer {
  const normalized = input.trim().toLowerCase().replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/.test(normalized)) {
    throw new Error(`streamId invalido: "${input}". Use UUID (com ou sem hifen).`);
  }
  return Buffer.from(normalized, 'hex');
}

export function randomStreamId(): Buffer {
  return randomBytes(16);
}

export function streamIdToHex(streamId: Buffer): string {
  assertStreamId(streamId);
  return streamId.toString('hex');
}

export function buildUdpPacket(input: BuildPacketInput): Buffer {
  assertStreamId(input.streamId);
  if (!Number.isInteger(input.seq) || input.seq < 0 || input.seq > 0xffffffff) {
    throw new Error(`seq invalido: ${input.seq}.`);
  }
  if (!Number.isInteger(input.chunkIndex) || input.chunkIndex < 0 || input.chunkIndex > 0xffff) {
    throw new Error(`chunkIndex invalido: ${input.chunkIndex}.`);
  }
  if (!Number.isInteger(input.totalChunks) || input.totalChunks <= 0 || input.totalChunks > 0xffff) {
    throw new Error(`totalChunks invalido: ${input.totalChunks}.`);
  }
  if (input.chunkIndex >= input.totalChunks) {
    throw new Error(`chunkIndex ${input.chunkIndex} fora de totalChunks ${input.totalChunks}.`);
  }
  if (!Buffer.isBuffer(input.payload)) {
    throw new Error('payload deve ser Buffer.');
  }
  if (input.payload.length > 0xffff) {
    throw new Error(`payload muito grande: ${input.payload.length} bytes.`);
  }

  const out = Buffer.allocUnsafe(UDP_HEADER_SIZE + input.payload.length);
  out.writeUInt16BE(UDP_PROTOCOL_MAGIC, 0);
  out.writeUInt8(UDP_PROTOCOL_VERSION, 2);
  out.writeUInt8(input.flags & 0xff, 3);
  input.streamId.copy(out, 4);
  out.writeUInt32BE(input.seq >>> 0, 20);
  out.writeBigUInt64BE(input.timestampUs, 24);
  out.writeUInt16BE(input.chunkIndex, 32);
  out.writeUInt16BE(input.totalChunks, 34);
  out.writeUInt16BE(input.payload.length, 36);
  input.payload.copy(out, UDP_HEADER_SIZE);
  return out;
}

export function parseUdpPacket(datagram: Buffer): UdpPacket | null {
  if (!Buffer.isBuffer(datagram)) return null;
  if (datagram.length < UDP_HEADER_SIZE) return null;
  const magic = datagram.readUInt16BE(0);
  const version = datagram.readUInt8(2);
  if (magic !== UDP_PROTOCOL_MAGIC || version !== UDP_PROTOCOL_VERSION) return null;

  const flags = datagram.readUInt8(3);
  const streamId = Buffer.from(datagram.subarray(4, 20));
  const seq = datagram.readUInt32BE(20);
  const timestampUs = datagram.readBigUInt64BE(24);
  const chunkIndex = datagram.readUInt16BE(32);
  const totalChunks = datagram.readUInt16BE(34);
  const payloadSize = datagram.readUInt16BE(36);

  if (totalChunks <= 0 || totalChunks > MAX_TOTAL_CHUNKS) return null;
  if (chunkIndex >= totalChunks) return null;

  const expectedLen = UDP_HEADER_SIZE + payloadSize;
  if (datagram.length !== expectedLen) return null;
  const payload = Buffer.from(datagram.subarray(UDP_HEADER_SIZE, expectedLen));

  return {
    streamId,
    seq,
    timestampUs,
    flags,
    chunkIndex,
    totalChunks,
    payloadSize,
    payload,
  };
}

export function packetizeFrame(input: PacketizeFrameInput): Buffer[] {
  const maxPayloadBytes = Math.max(128, input.maxPayloadBytes ?? DEFAULT_MAX_UDP_PAYLOAD);
  if (!Buffer.isBuffer(input.framePayload)) {
    throw new Error('framePayload deve ser Buffer.');
  }
  if (input.framePayload.length === 0) {
    return [
      buildUdpPacket({
        streamId: input.streamId,
        seq: input.seq,
        timestampUs: input.timestampUs,
        flags: input.flags,
        chunkIndex: 0,
        totalChunks: 1,
        payload: Buffer.alloc(0),
      }),
    ];
  }

  const totalChunks = Math.ceil(input.framePayload.length / maxPayloadBytes);
  if (totalChunks > MAX_TOTAL_CHUNKS) {
    throw new Error(`frame gerou chunks demais (${totalChunks} > ${MAX_TOTAL_CHUNKS}).`);
  }

  const packets: Buffer[] = [];
  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    const start = chunkIndex * maxPayloadBytes;
    const end = Math.min(input.framePayload.length, start + maxPayloadBytes);
    const payload = Buffer.from(input.framePayload.subarray(start, end));
    packets.push(
      buildUdpPacket({
        streamId: input.streamId,
        seq: input.seq,
        timestampUs: input.timestampUs,
        flags: input.flags,
        chunkIndex,
        totalChunks,
        payload,
      }),
    );
  }
  return packets;
}
