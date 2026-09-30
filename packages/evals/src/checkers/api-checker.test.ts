import { describe, expect, it } from 'vitest';
import { compareExpected } from './api-checker.js';

describe('api compare', () => {
  it('checks nested reservations and price ceilings', () => {
    const mismatches = compareExpected(
      {
        count: 1,
        reservations: [{ party_size: 20, date: '2024-03-18', price_per_hour_lte: 220, has_accessibility: 1 }],
      },
      {
        count: 1,
        reservations: [{ party_size: 20, date: '2024-03-18', price_per_hour: 200, has_accessibility: 1, venue_name: 'Tech Hub' }],
      },
    );
    expect(mismatches).toEqual([]);
  });

  it('fails when the booked venue is over the price cap', () => {
    const mismatches = compareExpected(
      { reservations: [{ price_per_hour_lte: 160 }] },
      { reservations: [{ price_per_hour: 200 }] },
    );
    expect(mismatches.length).toBe(1);
  });
});
