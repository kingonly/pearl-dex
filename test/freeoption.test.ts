import { describe, it, expect } from 'vitest';
import {
  optionValueSat,
  conservativeBondSat,
  CONSERVATIVE_ANNUALIZED_VOL,
} from '../src/settlement/index.js';
import { deriveAmounts } from '../src/coordination/index.js';
import type { Match } from '../src/coordination/index.js';

const COIN = 100_000_000n;
const SIX_HOURS = 6 * 3600;

describe('FreeOption — conservative bond sizing (no-risks: bond dominates the option)', () => {
  it('optionValueSat matches 0.4·σ·√T·S', () => {
    // 1 BTC notional, 300% vol, 6h window. T = 6h/365.25d.
    const v = optionValueSat({ notionalSat: COIN, annualizedVol: 3.0, windowSeconds: SIX_HOURS });
    // 0.4 * 3 * sqrt(21600/31557600) ≈ 0.03139 → ~3.14M sats.
    expect(v).toBeGreaterThan(3_100_000n);
    expect(v).toBeLessThan(3_200_000n);
  });

  it('the bond strictly dominates the option value (safety multiple ≥ 1)', () => {
    const v = optionValueSat({ notionalSat: COIN, annualizedVol: 3.0, windowSeconds: SIX_HOURS });
    const bond = conservativeBondSat({ notionalSat: COIN, windowSeconds: SIX_HOURS });
    expect(bond).toBeGreaterThanOrEqual(v); // never under-covers
    expect(bond).toBeGreaterThan(2n * v - v / 100n); // ≈ 2× option (default safety)
  });

  it('beats a flat 1.5% bond exactly when it matters — a volatile pair', () => {
    const flat = (COIN * 150n) / 10_000n; // 1.5% = 1.5M
    const conservative = conservativeBondSat({ notionalSat: COIN, windowSeconds: SIX_HOURS });
    // At 300% vol / 6h the option (~3.1M) already exceeds 1.5%, so the conservative bond is larger.
    expect(conservative).toBeGreaterThan(flat);
  });

  it('grows with volatility and with the window (monotonic)', () => {
    const base = conservativeBondSat({ notionalSat: COIN, windowSeconds: SIX_HOURS, annualizedVol: 1.0 });
    const moreVol = conservativeBondSat({ notionalSat: COIN, windowSeconds: SIX_HOURS, annualizedVol: 2.0 });
    const longer = conservativeBondSat({ notionalSat: COIN, windowSeconds: 24 * 3600, annualizedVol: 1.0 });
    expect(moreVol).toBeGreaterThan(base);
    expect(longer).toBeGreaterThan(base);
  });

  it('floors small trades and never exceeds the notional', () => {
    // Small notional where the option-based size is below the floor → the floor wins.
    const floored = conservativeBondSat({ notionalSat: 10_000n, windowSeconds: SIX_HOURS, floorSat: 5_000n });
    expect(floored).toBe(5_000n);
    // Absurd window → option value would exceed the notional → capped at the notional.
    const capped = conservativeBondSat({ notionalSat: COIN, windowSeconds: 100 * 365 * 24 * 3600 });
    expect(capped).toBe(COIN);
  });

  it('deriveAmounts uses the LARGER of flat-bps and the conservative size when a window is given', () => {
    const match = {
      fillQuoteSat: COIN, // BTC the taker funds (source notional)
      fillBaseSat: 50n * COIN, // PRL the maker funds
    } as unknown as Match;

    // No window → flat-bps only (unchanged legacy behavior).
    const flatOnly = deriveAmounts(match, { bps: 150, minSat: 1_000n });
    expect(flatOnly.bondSat).toBe((COIN * 150n) / 10_000n);

    // With the window → conservative high-vol size dominates the 1.5% flat bond.
    const conservative = deriveAmounts(
      match,
      { bps: 150, minSat: 1_000n },
      { exposureWindowSeconds: SIX_HOURS },
    );
    expect(conservative.bondSat).toBeGreaterThan(flatOnly.bondSat);
    expect(conservative.bondSat).toBe(
      conservativeBondSat({
        notionalSat: COIN,
        windowSeconds: SIX_HOURS,
        annualizedVol: CONSERVATIVE_ANNUALIZED_VOL,
        floorSat: 1_000n,
      }),
    );
  });
});
