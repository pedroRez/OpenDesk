export type PenaltyResult = {
  proportionalAmount: number;
  platformFee: number;
  hostPayout: number;
  clientCredit: number;
};

export function calculatePenalty(params: {
  minutesUsed: number;
  minutesPurchased: number;
  priceTotal: number;
  penaltyRate: number;
  platformFeeRate: number;
}): PenaltyResult {
  const { minutesUsed, minutesPurchased, priceTotal, penaltyRate, platformFeeRate } =
    params;

  if (minutesPurchased <= 0) {
    throw new Error('minutesPurchased must be greater than zero');
  }

  const usageRatio = Math.min(Math.max(minutesUsed / minutesPurchased, 0), 1);
  const proportionalAmount = priceTotal * usageRatio;
  const platformFee = proportionalAmount * platformFeeRate;
  const hostBase = proportionalAmount - platformFee;
  const hostPayout = hostBase * (1 - penaltyRate);
  const clientCredit = hostBase - hostPayout;

  return {
    proportionalAmount,
    platformFee,
    hostPayout,
    clientCredit,
  };
}
