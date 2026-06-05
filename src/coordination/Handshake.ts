import type { BTC_NETWORK } from '@scure/btc-signer/utils.js';
import { tagForNetwork } from '../common/networks.js';
import {
  assertSafeBondTimeout,
  assertSafeTimeouts,
  computeBondForfeitHeight,
  computeSwapTimeouts,
  type ChainTiming,
} from '../settlement/Timelocks.js';
import { buildFeeOutput, computeFeeSat, type FeePolicy } from '../settlement/Fee.js';
import type { Match } from './OrderBook.js';
import type { SwapParamsJSON } from './SwapStore.js';

/**
 * Bridges a matched order (OrderBook.Match) to the agreed on-chain swap terms (SwapParamsJSON) that
 * both parties feed into their SwapExecutors. The operator's matcher fixes the economics (who, what,
 * how much, at what price); the two parties then exchange a tiny settlement HANDSHAKE over the relay
 * to fill in the cryptographic terms (swap keys, preimage hash) and agree the timelocks. Both sides
 * call `buildSwapParams` with the SAME inputs and MUST derive byte-identical params — otherwise they
 * compute different lockup addresses and can't settle.
 *
 * Role mapping (PRL/BTC): the BUY side (acquires base PRL, pays quote BTC) is the swap TAKER — it
 * has BTC, funds the source leg, holds the preimage, posts the bond. The SELL side is the MAKER.
 * source leg = quote chain (BTC); dest leg = base chain (PRL); bond = source chain.
 */

/** Network params for each leg of a pair: `base` is the base-asset (PRL) chain, `quote` the BTC chain. */
export interface SwapNetworks {
  base: BTC_NETWORK;
  quote: BTC_NETWORK;
}

/** Bond sizing: a fraction of the quote (BTC) trade value, with a floor. ~1–2% covers the option. */
export interface BondPolicy {
  bps: number;
  minSat: bigint;
}

export interface SwapAmounts {
  /** quote (BTC) the taker funds on the source leg. */
  sourceSat: bigint;
  /** base (PRL) the maker funds on the dest leg. */
  destSat: bigint;
  /** option bond the taker posts (on the source/BTC chain). */
  bondSat: bigint;
}

/** Current best heights on each chain (used to derive absolute timelock heights). */
export interface Heights {
  /** quote (BTC) chain height. */
  quoteHeight: number;
  /** base (PRL) chain height. */
  baseHeight: number;
}

export interface ProposedTimeouts {
  sourceTimeoutHeight: number;
  destTimeoutHeight: number;
  bondForfeitHeight: number;
}

/** The two settlement-handshake messages relayed between matched peers. */
export type HandshakeMessage =
  | { type: 'taker_init'; swapPubHex: string; preimageHashHex: string }
  | { type: 'maker_ack'; swapPubHex: string; timeouts: ProposedTimeouts };

const hx = (b: Uint8Array) => Buffer.from(b).toString('hex');
const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);

/** Derive the per-leg amounts (and bond) for a match. */
export function deriveAmounts(match: Match, bond: BondPolicy): SwapAmounts {
  const sourceSat = match.fillQuoteSat; // BTC the taker funds
  const destSat = match.fillBaseSat; // PRL the maker funds
  const bondSat = maxBig(bond.minSat, (sourceSat * BigInt(bond.bps)) / 10_000n);
  return { sourceSat, destSat, bondSat };
}

/**
 * Propose timelock heights from current heights (the maker proposes; the taker validates). The bond
 * forfeit height is placed AFTER the dest leg resolves but strictly BEFORE the source timeout — that
 * ordering is what makes a taker walk penalizable (see SwapExecutor's KNOWN GAP note). We use a
 * smaller margin for the bond than for the source so it sits clearly between the two.
 */
export function proposeTimeouts(p: {
  heights: Heights;
  /** timing of the quote (BTC) chain — the source/bond leg. */
  quoteTiming: ChainTiming;
  /** timing of the base (PRL) chain — the dest leg. */
  baseTiming: ChainTiming;
  shortRefundSeconds?: number;
  marginSeconds?: number;
  /** margin for the bond forfeit beyond dest resolution; defaults to half the source margin. */
  bondMarginSeconds?: number;
}): ProposedTimeouts {
  const t = computeSwapTimeouts({
    sourceChain: p.quoteTiming,
    sourceHeight: p.heights.quoteHeight,
    destChain: p.baseTiming,
    destHeight: p.heights.baseHeight,
    shortRefundSeconds: p.shortRefundSeconds,
    marginSeconds: p.marginSeconds,
  });

  const bondMargin = p.bondMarginSeconds ?? Math.floor((p.marginSeconds ?? 6 * 3600) / 2);
  let bondForfeitHeight = computeBondForfeitHeight({
    bondChain: p.quoteTiming,
    bondChainHeight: p.heights.quoteHeight,
    destWallSeconds: t.destWallSeconds,
    marginSeconds: bondMargin,
  });
  // Hard guarantee: forfeit strictly before the source can refund.
  if (bondForfeitHeight >= t.sourceTimeoutHeight) bondForfeitHeight = t.sourceTimeoutHeight - 1;

  return {
    sourceTimeoutHeight: t.sourceTimeoutHeight,
    destTimeoutHeight: t.destTimeoutHeight,
    bondForfeitHeight,
  };
}

/** Validate timeouts a counterparty proposed before committing funds (taker side). Throws if unsafe. */
export function validateProposedTimeouts(p: {
  heights: Heights;
  quoteTiming: ChainTiming;
  baseTiming: ChainTiming;
  timeouts: ProposedTimeouts;
  minMarginSeconds?: number;
}): void {
  assertSafeTimeouts({
    sourceChain: p.quoteTiming,
    sourceHeight: p.heights.quoteHeight,
    sourceTimeoutHeight: p.timeouts.sourceTimeoutHeight,
    destChain: p.baseTiming,
    destHeight: p.heights.baseHeight,
    destTimeoutHeight: p.timeouts.destTimeoutHeight,
    minMarginSeconds: p.minMarginSeconds,
  });
  // The bond is on the SOURCE (quote) chain, so vs the source timeout this is a same-chain height
  // comparison: forfeit must come before source refund (else a walker could refund source, then
  // safely reveal the preimage and reclaim the bond, escaping the penalty).
  assertSafeBondTimeout({
    bondForfeitHeight: p.timeouts.bondForfeitHeight,
    sourceTimeoutHeight: p.timeouts.sourceTimeoutHeight,
  });
  // vs the dest timeout the bond is on a DIFFERENT chain, so compare in wall-clock: the bond may
  // only become forfeitable after the dest leg has resolved (the taker has provably been able to
  // walk).
  const bondWall = (p.timeouts.bondForfeitHeight - p.heights.quoteHeight) * p.quoteTiming.secondsPerBlock;
  const destWall = (p.timeouts.destTimeoutHeight - p.heights.baseHeight) * p.baseTiming.secondsPerBlock;
  if (bondWall <= destWall) {
    throw new Error('unsafe bond: forfeit must (in wall-clock) come after the dest timeout');
  }
}

/**
 * Assemble the agreed SwapParamsJSON. BOTH parties call this with identical inputs and must get
 * identical output (deterministic). The operator fee (if a policy is given) is computed on the base
 * (PRL) amount and carried as a committed term of the plan.
 */
export function buildSwapParams(p: {
  match: Match;
  networks: SwapNetworks;
  /** 33-byte ECDSA swap key (hex) of the taker (buy side). */
  takerSwapPubHex: string;
  /** 33-byte ECDSA swap key (hex) of the maker (sell side). */
  makerSwapPubHex: string;
  preimageHashHex: string;
  timeouts: ProposedTimeouts;
  fee?: FeePolicy;
}): SwapParamsJSON {
  let operatorFee: SwapParamsJSON['operatorFee'];
  if (p.fee) {
    const feeSat = computeFeeSat(p.match.fillBaseSat, p.fee);
    const out = buildFeeOutput(feeSat, p.fee);
    operatorFee = { scriptHex: hx(out.script), amountSat: out.amountSat.toString() };
  }
  return {
    preimageHashHex: p.preimageHashHex,
    takerPubHex: p.takerSwapPubHex,
    makerPubHex: p.makerSwapPubHex,
    sourceNetwork: tagForNetwork(p.networks.quote),
    destNetwork: tagForNetwork(p.networks.base),
    bondNetwork: tagForNetwork(p.networks.quote),
    sourceTimeoutHeight: p.timeouts.sourceTimeoutHeight,
    destTimeoutHeight: p.timeouts.destTimeoutHeight,
    bondForfeitHeight: p.timeouts.bondForfeitHeight,
    operatorFee,
  };
}
