import { describe, expect, it } from 'vitest';

import { calculateSettlement } from '../utils/penalty.js';

describe('calculateSettlement', () => {
  it('calculates proportional payout for non-host failure', () => {
    const result = calculateSettlement({
      minutesUsed: 30,
      minutesPurchased: 60,
      pricePerHour: 20,
      platformFeePercent: 0.1,
      penaltyPercent: 0.3,
      failureReason: 'NONE',
    });

    expect(result.platformFee).toBeCloseTo(1);
    expect(result.hostPayout).toBeCloseTo(9);
    expect(result.clientCredit).toBeCloseTo(0);
  });

  it('applies host penalty and client credit', () => {
    const result = calculateSettlement({
      minutesUsed: 15,
      minutesPurchased: 60,
      pricePerHour: 24,
      platformFeePercent: 0.1,
      penaltyPercent: 0.3,
      failureReason: 'HOST',
    });

    expect(result.platformFee).toBeCloseTo(0.6);
    expect(result.hostPayout).toBeCloseTo(3.78);
    expect(result.clientCredit).toBeCloseTo(1.62);
  });

  it('caps usage ratio at 1', () => {
    const result = calculateSettlement({
      minutesUsed: 90,
      minutesPurchased: 60,
      pricePerHour: 10,
      platformFeePercent: 0,
      penaltyPercent: 0.1,
      failureReason: 'CLIENT',
    });

    expect(result.hostPayout).toBeCloseTo(10);
  });
});
