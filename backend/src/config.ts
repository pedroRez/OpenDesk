export const config = {
  port: Number(process.env.PORT ?? 3333),
  platformFeeRate: Number(process.env.PLATFORM_FEE_RATE ?? 0.1),
  sessionExpirationIntervalMs: Number(process.env.SESSION_EXPIRATION_INTERVAL_MS ?? 30000),
  hostHeartbeatTimeoutMs: Number(process.env.HOST_HEARTBEAT_TIMEOUT_MS ?? 60000),
  hostHeartbeatCheckIntervalMs: Number(process.env.HOST_HEARTBEAT_CHECK_INTERVAL_MS ?? 30000),
  hostPenaltyRate: Number(process.env.HOST_PENALTY_RATE ?? 0.3),
};
