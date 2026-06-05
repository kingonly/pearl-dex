/**
 * Conservative sizing of the secret-tied option bond (DESIGN.md §5.3).
 *
 * The party who reveals the preimage last (the taker) holds a free American option on the price over
 * the swap window. Its value is the standard at-the-money approximation
 *
 *     V ≈ 0.4 · σ · √T · S
 *
 * where σ = annualized volatility, T = the option's life in years, S = notional. The bond must
 * *dominate* V — if the bond is smaller, a rational taker still walks whenever the realized move
 * exceeds the bond, and the free option re-opens. A flat-% bond does NOT dominate V (V grows with
 * σ·√T while a flat bond is constant), so we size the bond to V with deliberately pessimistic inputs
 * and a safety multiple.
 *
 * "No risks" posture: assume HIGH volatility (a thin, new pair) and multiply the option value by a
 * safety factor, so the bond strictly exceeds any plausible option value over the window. The bond is
 * only ever *posted and reclaimed* by an honest taker (consummating reveals the preimage), so erring
 * large costs an honest user nothing but locked capital for the swap window — and makes walking
 * unambiguously unprofitable.
 */

/** Seconds in a year (365.25 days) — for converting the swap window to the annualized-vol time base. */
export const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

/** ATM option-value constant, 1/√(2π) ≈ 0.3989 (Bachelier/Black at-the-money). Rounded UP to 0.4. */
export const OPTION_VALUE_CONSTANT = 0.4;

/**
 * Conservative default annualized volatility for a thin, newly-launched pair: 300%. This is the high
 * end of the empirical range (see docs/free-option-analysis.md) — chosen deliberately so the bond
 * over-covers rather than under-covers. Lower it only with real volatility data for the pair.
 */
export const CONSERVATIVE_ANNUALIZED_VOL = 3.0;

/** Multiply the computed option value by this so the bond strictly dominates it. 2× = double cover. */
export const CONSERVATIVE_BOND_SAFETY = 2;

/** The option value V ≈ 0.4·σ·√T·S in sats, given notional `S`, annualized vol `σ`, window `T`. */
export function optionValueSat(p: {
  notionalSat: bigint;
  annualizedVol: number;
  windowSeconds: number;
}): bigint {
  const tYears = Math.max(0, p.windowSeconds) / SECONDS_PER_YEAR;
  const fraction = OPTION_VALUE_CONSTANT * p.annualizedVol * Math.sqrt(tYears);
  return ceilFractionOf(fraction, p.notionalSat);
}

/**
 * The conservative bond: `safetyMultiple × optionValue`, floored at `floorSat`, capped at the notional
 * (a bond above 100% of the trade is never needed — option value is bounded by the notional). With the
 * defaults this is a deliberately over-collateralized, "walking is never profitable" bond.
 */
export function conservativeBondSat(p: {
  notionalSat: bigint;
  windowSeconds: number;
  annualizedVol?: number;
  safetyMultiple?: number;
  floorSat?: bigint;
}): bigint {
  const vol = p.annualizedVol ?? CONSERVATIVE_ANNUALIZED_VOL;
  const safety = p.safetyMultiple ?? CONSERVATIVE_BOND_SAFETY;
  const option = optionValueSat({
    notionalSat: p.notionalSat,
    annualizedVol: vol,
    windowSeconds: p.windowSeconds,
  });
  let bond = ceilFractionOf(safety, option); // safety × option value
  if (p.floorSat !== undefined && bond < p.floorSat) bond = p.floorSat;
  if (bond > p.notionalSat) bond = p.notionalSat; // never exceed the notional
  return bond;
}

/** ceil(fraction · amount) for a float fraction and a bigint amount, without losing the bigint. */
function ceilFractionOf(fraction: number, amount: bigint): bigint {
  if (fraction <= 0) return 0n;
  // Scale to integer math to avoid float error on large amounts: ceil(fraction·amount) via a
  // fixed-point factor, then divide. 1e9 gives ~9 significant digits of the fraction, ample here.
  const SCALE = 1_000_000_000n;
  const scaled = BigInt(Math.ceil(fraction * 1e9)); // fraction × 1e9, rounded up
  return (amount * scaled + (SCALE - 1n)) / SCALE; // ceil division by 1e9
}
