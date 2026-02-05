export const config = {
  port: Number(process.env.PORT ?? 3333),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  logHeartbeat: process.env.LOG_HEARTBEAT ?? 'sampled',
  heartbeatLogSampleSeconds: Number(process.env.HEARTBEAT_LOG_SAMPLE_SECONDS ?? 60),
  httpLogIgnoreMethods: (process.env.HTTP_LOG_IGNORE_METHODS ?? 'OPTIONS')
    .split(',')
    .map((method) => method.trim().toUpperCase())
    .filter(Boolean),
  platformFeeRate: Number(process.env.PLATFORM_FEE_RATE ?? 0.1),
  sessionExpirationIntervalMs: Number(process.env.SESSION_EXPIRATION_INTERVAL_MS ?? 30000),
  hostHeartbeatTimeoutMs: Number(process.env.HOST_HEARTBEAT_TIMEOUT_MS ?? 60000),
  hostHeartbeatCheckIntervalMs: Number(process.env.HOST_HEARTBEAT_CHECK_INTERVAL_MS ?? 30000),
  hostPenaltyRate: Number(process.env.HOST_PENALTY_RATE ?? 0.3),
};
