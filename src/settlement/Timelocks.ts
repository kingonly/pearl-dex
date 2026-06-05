/**
 * Timelock math for cross-chain swaps. The two chains tick at different rates (Pearl ~194s,
 * signet ~600s), so refund timeouts are set per-chain in BLOCK HEIGHT but derived from
 * WALL-CLOCK targets, and must satisfy the atomic-swap safety relation:
 *
 *   T_source(wall) > T_dest(wall) + margin
 *
 * where:
 *   - dest   = the chain the taker RECEIVES on. The taker claims it first (revealing the
 *              preimage), so it gets the SHORTER refund timeout.
 *   - source = the chain the taker FUNDS. The maker claims it after learning the preimage,
 *              so it gets the LONGER refund timeout (margin covers claim + confs + fee-bumps).
 *
 * For BTC->PRL: source = BTC (signet), dest = PRL (pearl).
 * For PRL->BTC: source = PRL (pearl), dest = BTC (signet).
 *
 * NOTE on Pearl's 194s blocks: Pearl is FASTER than Bitcoin (600s), so its block time is not
 * the binding constraint. The real driver of the safety margin is reorg depth on the young
 * Pearl chain (how many confirmations make a leg double-spend-safe). See docs/free-option-analysis.md.
 */

export interface ChainTiming {
  name: string;
  secondsPerBlock: number;
}

export const PEARL_TIMING: ChainTiming = { name: 'pearl', secondsPerBlock: 194 }; // 3m14s
export const SIGNET_TIMING: ChainTiming = { name: 'signet', secondsPerBlock: 600 }; // ~10min

/** Default refund window for the dest (taker-claims-first) leg. */
export const DEFAULT_SHORT_REFUND_SECONDS = 6 * 3600; // 6h
/** Default extra wall-clock the source leg's refund waits beyond the dest leg's. */
export const DEFAULT_MARGIN_SECONDS = 6 * 3600; // 6h

/** Blocks needed to cover at least `seconds` on a chain (round up). */
export function blocksForDuration(seconds: number, timing: ChainTiming): number {
  return Math.ceil(seconds / timing.secondsPerBlock);
}

/** Wall-clock seconds represented by `blocks` on a chain. */
export function secondsForBlocks(blocks: number, timing: ChainTiming): number {
  return blocks * timing.secondsPerBlock;
}

export interface SwapTimeouts {
  /** absolute height on the source chain after which the funder can refund (LONGER). */
  sourceTimeoutHeight: number;
  /** absolute height on the dest chain after which the funder can refund (SHORTER). */
  destTimeoutHeight: number;
  /** realized dest refund wall-clock (after block rounding) — used to size bonds. */
  destWallSeconds: number;
  shortRefundSeconds: number;
  marginSeconds: number;
}

/** Compute per-chain absolute refund heights from wall-clock targets. */
export function computeSwapTimeouts(p: {
  sourceChain: ChainTiming;
  sourceHeight: number;
  destChain: ChainTiming;
  destHeight: number;
  shortRefundSeconds?: number;
  marginSeconds?: number;
}): SwapTimeouts {
  const shortRefundSeconds = p.shortRefundSeconds ?? DEFAULT_SHORT_REFUND_SECONDS;
  const marginSeconds = p.marginSeconds ?? DEFAULT_MARGIN_SECONDS;

  const destBlocks = blocksForDuration(shortRefundSeconds, p.destChain);
  const destTimeoutHeight = p.destHeight + destBlocks;

  // Base the source timeout on the REALIZED dest wall-clock (after block rounding) plus the
  // margin — otherwise rounding the dest leg up can silently erode the safety margin.
  const destWall = secondsForBlocks(destBlocks, p.destChain);
  const sourceTimeoutHeight =
    p.sourceHeight + blocksForDuration(destWall + marginSeconds, p.sourceChain);

  return {
    sourceTimeoutHeight,
    destTimeoutHeight,
    destWallSeconds: destWall,
    shortRefundSeconds,
    marginSeconds,
  };
}

/**
 * Forfeit timeout for a secret-tied bond (see Bond.ts). A bond must only become forfeitable
 * AFTER the swap's dest leg has definitively resolved — i.e. once the owner has provably
 * walked (the preimage was never revealed). We therefore set the forfeit height a safety
 * margin beyond the realized dest wall-clock, expressed in the bond chain's blocks.
 *
 * The owner can always RECLAIM earlier by revealing the preimage (which consummating the swap
 * does anyway), so this height only bounds the counterparty's forfeit-claim, never honest reclaim.
 */
export function computeBondForfeitHeight(p: {
  bondChain: ChainTiming;
  bondChainHeight: number;
  destWallSeconds: number;
  marginSeconds?: number;
}): number {
  const margin = p.marginSeconds ?? DEFAULT_MARGIN_SECONDS;
  return p.bondChainHeight + blocksForDuration(p.destWallSeconds + margin, p.bondChain);
}

/**
 * Validate (in wall-clock, from current heights) that the source refund is sufficiently
 * later than the dest refund. Use on any timeouts before locking funds — including ones a
 * counterparty proposes. Throws if unsafe.
 */
export function assertSafeTimeouts(p: {
  sourceChain: ChainTiming;
  sourceHeight: number;
  sourceTimeoutHeight: number;
  destChain: ChainTiming;
  destHeight: number;
  destTimeoutHeight: number;
  minMarginSeconds?: number;
}): void {
  const minMargin = p.minMarginSeconds ?? DEFAULT_MARGIN_SECONDS;
  const sourceWall = secondsForBlocks(p.sourceTimeoutHeight - p.sourceHeight, p.sourceChain);
  const destWall = secondsForBlocks(p.destTimeoutHeight - p.destHeight, p.destChain);

  if (sourceWall <= destWall) {
    throw new Error(
      `unsafe timelocks: source refund (${sourceWall}s) must be later than dest refund (${destWall}s)`,
    );
  }
  if (sourceWall - destWall < minMargin) {
    throw new Error(
      `insufficient timelock margin: ${sourceWall - destWall}s < required ${minMargin}s`,
    );
  }
}
