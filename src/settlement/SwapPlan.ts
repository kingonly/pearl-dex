import type { BTC_NETWORK } from '@scure/btc-signer/utils.js';
import { buildSwapLeg, type SwapLeg } from './SwapTree.js';
import { buildBond, type Bond } from './Bond.js';

/**
 * The full on-chain layout of one peer-to-peer swap: both swap legs plus the taker's
 * secret-tied option bond. This is the coordinator-layer artifact — given the two parties'
 * pubkeys, the chains, and the timeouts, it derives every lockup address both sides need.
 *
 * Roles (BTC->PRL example; symmetric for PRL->BTC by swapping the networks):
 *   - TAKER  has BTC, wants PRL. Funds the SOURCE leg; claims the DEST leg with the preimage
 *            (revealing it); refunds source after sourceTimeout. Holds the price option, so the
 *            taker POSTS the option bond.
 *   - MAKER  has PRL, wants BTC. Funds the DEST leg; claims the SOURCE leg with the preimage
 *            (learned when the taker claims dest); refunds dest after destTimeout.
 *
 * The taker generates the preimage (they reveal it first). All three outputs commit to the
 * same `preimageHash`, so the single secret that consummates the swap also reclaims the bond.
 *
 * NOTE: the maker's COMMITMENT bond (anti-grief for "maker accepts then never locks dest") is
 * a separate, asymmetric protection and is not built here yet — see DESIGN.md §5.4. The option
 * bond below is the free-option fix and the headline mechanism.
 */
export interface Participant {
  /** 33-byte compressed public key (used for Musig aggregation and the claim/refund leaves). */
  pub: Uint8Array;
}

export interface SwapPlanParams {
  /** SHA256(preimage); the taker holds the preimage. */
  preimageHash: Uint8Array;
  taker: Participant;
  maker: Participant;
  /** chain the taker funds (source leg). */
  sourceNetwork: BTC_NETWORK;
  /** chain the maker funds and the taker receives on (dest leg). */
  destNetwork: BTC_NETWORK;
  /** absolute height after which the taker can refund the source leg (LONGER). */
  sourceTimeoutHeight: number;
  /** absolute height after which the maker can refund the dest leg (SHORTER). */
  destTimeoutHeight: number;
  /** chain on which the taker posts the option bond (defaults to the source chain). */
  bondNetwork: BTC_NETWORK;
  /** absolute height on the bond chain after which the maker can claim a forfeited bond. */
  bondForfeitHeight: number;
}

export interface SwapPlan {
  /** source leg: taker funds; maker claims with preimage; taker refunds after sourceTimeout. */
  sourceLeg: SwapLeg;
  /** dest leg: maker funds; taker claims with preimage; maker refunds after destTimeout. */
  destLeg: SwapLeg;
  /** option bond: taker posts; taker reclaims with preimage; maker forfeit-claims after timeout. */
  optionBond: Bond;
}

/** Derive both swap legs and the taker's option bond. Pure: agrees on addresses given inputs. */
export function buildSwapPlan(p: SwapPlanParams): SwapPlan {
  // Fixed Musig aggregation order for all three outputs so both parties derive identical keys.
  const musigOrder: [Uint8Array, Uint8Array] = [p.maker.pub, p.taker.pub];

  const sourceLeg = buildSwapLeg({
    preimageHash: p.preimageHash,
    claimPublicKey: p.maker.pub, // maker claims the source leg with the preimage
    refundPublicKey: p.taker.pub, // taker refunds the source leg after its timeout
    timeoutBlockHeight: p.sourceTimeoutHeight,
    network: p.sourceNetwork,
    musigOrder,
  });

  const destLeg = buildSwapLeg({
    preimageHash: p.preimageHash,
    claimPublicKey: p.taker.pub, // taker claims the dest leg, revealing the preimage
    refundPublicKey: p.maker.pub, // maker refunds the dest leg after its timeout
    timeoutBlockHeight: p.destTimeoutHeight,
    network: p.destNetwork,
    musigOrder,
  });

  const optionBond = buildBond({
    preimageHash: p.preimageHash,
    ownerPublicKey: p.taker.pub, // taker reclaims the bond with the preimage
    counterpartyPublicKey: p.maker.pub, // maker forfeit-claims the bond after the timeout
    forfeitTimeoutHeight: p.bondForfeitHeight,
    network: p.bondNetwork,
    musigOrder,
  });

  return { sourceLeg, destLeg, optionBond };
}
