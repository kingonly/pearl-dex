import type { BTC_NETWORK } from '@scure/btc-signer/utils.js';
import { Transaction } from '@scure/btc-signer';
import type { Signer } from '../signer/index.js';
import {
  buildClaimTx,
  buildRefundTx,
  buildSwapLeg,
  type LockupUtxo,
  type SwapLeg,
} from './SwapTree.js';

/**
 * A forfeitable, SECRET-TIED bond — the mechanism that neutralizes the free-option problem
 * (see DESIGN.md §5.3, docs/free-option-analysis.md).
 *
 * In a timelocked cross-chain swap, whoever can walk away after the counterparty has
 * irrevocably committed holds a free American option on the price. The bond converts that
 * FREE option into a PAID one: the option-holder posts a bond they only get back by
 * consummating the swap.
 *
 * A bond is STRUCTURALLY a swap leg (boltz `reverseSwapTree`) sharing the SAME preimage hash
 * as the swap:
 *   - reclaim leaf : the OWNER reclaims by revealing the preimage. Consummating the swap
 *                    reveals that preimage on-chain anyway, so an honest owner always reclaims.
 *   - forfeit leaf : the COUNTERPARTY claims after `forfeitTimeoutHeight` if the preimage was
 *                    never revealed (i.e. the owner walked) — compensating the optioned party.
 *
 * Because the bond reuses the proven `reverseSwapTree` construction, the only new trust-
 * critical surface is parameterization, not new script. (No covenant needed — the OP_CAT
 * variant in DESIGN.md §5.5 is an optional, research-gated upgrade.)
 */
export type Bond = SwapLeg;

export interface BuildBondParams {
  /** SHA256(preimage) — the SAME value the swap legs commit to. */
  preimageHash: Uint8Array;
  /** the bond owner (option-holder); reclaims by revealing the preimage. */
  ownerPublicKey: Uint8Array;
  /** the counterparty; claims the forfeited bond after the timeout. */
  counterpartyPublicKey: Uint8Array;
  /** absolute height on the bond's chain after which the counterparty can forfeit-claim. */
  forfeitTimeoutHeight: number;
  network: BTC_NETWORK;
  /** Musig aggregation order; both parties must agree (same convention as the swap legs). */
  musigOrder: [Uint8Array, Uint8Array];
}

/** Build a secret-tied bond lockup: a taproot output with reclaim-with-preimage + forfeit leaves. */
export function buildBond(p: BuildBondParams): Bond {
  return buildSwapLeg({
    preimageHash: p.preimageHash,
    claimPublicKey: p.ownerPublicKey, // owner reclaims with the preimage
    refundPublicKey: p.counterpartyPublicKey, // counterparty forfeit-claims after timeout
    timeoutBlockHeight: p.forfeitTimeoutHeight,
    network: p.network,
    musigOrder: p.musigOrder,
  });
}

/**
 * Reclaim transaction: the owner spends the bond back to themselves by revealing the preimage.
 * This is the claim path — no timelock — so an honest owner reclaims the moment they consummate.
 */
export function buildBondReclaimTx(args: {
  bond: Bond;
  utxo: LockupUtxo;
  ownerSigner: Signer;
  preimage: Uint8Array;
  destinationScript: Uint8Array;
  feeSat: bigint;
}): Promise<Transaction> {
  return buildClaimTx({
    leg: args.bond,
    utxo: args.utxo,
    signer: args.ownerSigner,
    preimage: args.preimage,
    destinationScript: args.destinationScript,
    feeSat: args.feeSat,
  });
}

/**
 * Forfeit transaction: the counterparty claims the bond after `forfeitTimeoutHeight`, used when
 * the owner walked (the preimage was never revealed). Carries the timeout as its locktime.
 */
export function buildBondForfeitTx(args: {
  bond: Bond;
  utxo: LockupUtxo;
  counterpartySigner: Signer;
  forfeitTimeoutHeight: number;
  destinationScript: Uint8Array;
  feeSat: bigint;
}): Promise<Transaction> {
  return buildRefundTx({
    leg: args.bond,
    utxo: args.utxo,
    signer: args.counterpartySigner,
    timeoutBlockHeight: args.forfeitTimeoutHeight,
    destinationScript: args.destinationScript,
    feeSat: args.feeSat,
  });
}
