export type SettlementResult = {
  hostPayout: number;
  clientCredit: number;
  platformFee: number;
};

export type FailureReason = 'HOST' | 'CLIENT' | 'PLATFORM' | 'NONE';

export function calculateSettlement(params: {
  minutesPurchased: number;
  minutesUsed: number;
  pricePerHour: number;
  platformFeePercent: number;
  penaltyPercent: number;
  failureReason: FailureReason;
}): SettlementResult {
  const {
    minutesPurchased,
    minutesUsed,
    pricePerHour,
    platformFeePercent,
    penaltyPercent,
    failureReason,
  } = params;

  if (minutesPurchased <= 0) {
    throw new Error('minutesPurchased must be greater than zero');
  }
  if (pricePerHour < 0) {
    throw new Error('pricePerHour must be greater than or equal to zero');
  }

  const totalPurchased = (pricePerHour * minutesPurchased) / 60;
  const usageRatio = Math.min(Math.max(minutesUsed / minutesPurchased, 0), 1);
  const proportionalAmount = totalPurchased * usageRatio;
  const platformFee = proportionalAmount * platformFeePercent;
  const hostBase = proportionalAmount - platformFee;

  if (failureReason !== 'HOST') {
    return {
      hostPayout: hostBase,
      clientCredit: 0,
      platformFee,
    };
  }

  const hostPayout = hostBase * (1 - penaltyPercent);
  const clientCredit = hostBase - hostPayout;

  return {
    hostPayout,
    clientCredit,
    platformFee,
  };
}
