export const config = {
  port: Number(process.env.PORT ?? 3333),
  platformFeeRate: Number(process.env.PLATFORM_FEE_RATE ?? 0.1),
  sessionExpirationIntervalMs: Number(process.env.SESSION_EXPIRATION_INTERVAL_MS ?? 60000),
};
