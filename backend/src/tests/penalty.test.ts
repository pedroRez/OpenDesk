import { describe, expect, it } from 'vitest';

import { calculatePenalty } from '../utils/penalty.js';

describe('calculatePenalty', () => {
  it('calculates proportional payout and credit', () => {
    const result = calculatePenalty({
      minutesUsed: 30,
      minutesPurchased: 60,
      priceTotal: 20,
      penaltyRate: 0.2,
      platformFeeRate: 0.1,
    });

    expect(result.proportionalAmount).toBeCloseTo(10);
    expect(result.platformFee).toBeCloseTo(1);
    expect(result.hostPayout).toBeCloseTo(7.2);
    expect(result.clientCredit).toBeCloseTo(1.8);
  });

  it('caps usage ratio at 1', () => {
    const result = calculatePenalty({
      minutesUsed: 90,
      minutesPurchased: 60,
      priceTotal: 20,
      penaltyRate: 0.1,
      platformFeeRate: 0,
    });

    expect(result.proportionalAmount).toBeCloseTo(20);
  });
});
