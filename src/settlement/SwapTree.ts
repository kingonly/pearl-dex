import { randomBytes } from 'node:crypto';
import { Address, OutScript, Transaction } from '@scure/btc-signer';
import type { BTC_NETWORK } from '@scure/btc-signer/utils.js';
import { sha256, taprootTweakPubkey } from '@scure/btc-signer/utils.js';
import {
  constructClaimTransaction,
  constructRefundTransaction,
  detectPreimage,
  Musig,
  OutputType,
  reverseSwapTree,
  TaprootUtils,
  type Types,
} from 'boltz-core';

/**
 * One leg of a chain swap: a P2TR lockup whose key-path is a Musig2 aggregate of the two
 * parties' keys, with a script tree of {claim-with-preimage, refund-after-timeout}.
 *
 * Ported from pearl-swap. We use boltz-core's `reverseSwapTree` for BOTH legs (recipient
 * claims by revealing the preimage; sender refunds after the timeout). Cross-chain atomicity
 * holds because both legs commit to the SAME `preimageHash = SHA256(preimage)` in their claim
 * leaves (`SIZE 32 EQUALVERIFY HASH160 ripemd160(preimageHash) EQUALVERIFY <claimKey> CHECKSIG`).
 *
 * The same structure backs the secret-tied Bond (see Bond.ts): a bond IS a swap leg whose
 * claim key is the bond owner (reclaims with the preimage) and whose refund key is the
 * counterparty (claims the forfeited bond after the timeout).
 */
export interface SwapLeg {
  tree: Types.SwapTree;
  /** Musig2 aggregate of the two participant keys (x-only) — the taproot internal key. */
  internalKey: Uint8Array;
  /** taproot output key (the witness program). */
  outputKey: Uint8Array;
  /** lockup address on the leg's network (rprl1p.../tprl1p.../tb1p...). */
  address: string;
  /** lockup scriptPubKey. */
  outputScript: Uint8Array;
}

export interface BuildLegParams {
  /** SHA256(preimage) — identical on both legs (and on a secret-tied bond). */
  preimageHash: Uint8Array;
  /** key that claims by revealing the preimage. */
  claimPublicKey: Uint8Array;
  /** key that refunds after the timeout. */
  refundPublicKey: Uint8Array;
  /** absolute block height (on this leg's chain) after which refund is spendable. */
  timeoutBlockHeight: number;
  network: BTC_NETWORK;
  /**
   * The two participant public keys in Musig aggregation order. Both parties MUST agree on
   * the order or they derive different addresses. These are the same two keys as claim/refund,
   * just ordered for key aggregation.
   */
  musigOrder: [Uint8Array, Uint8Array];
}

/** A random preimage and its SHA256 hash (the value committed in both legs and the bond). */
export function makePreimage(): { preimage: Uint8Array; preimageHash: Uint8Array } {
  const preimage = new Uint8Array(randomBytes(32));
  return { preimage, preimageHash: sha256(preimage) };
}

/**
 * Extract the preimage from a script-path claim transaction's witness. This is how a party
 * learns the secret once the counterparty claims a leg (or reclaims a bond), enabling it to
 * claim the other leg. `vin` is the input index spending the lockup (from `watchForSpend`).
 */
export function extractPreimage(spendTxHex: string, vin: number): Uint8Array {
  const tx = Transaction.fromRaw(Buffer.from(spendTxHex, 'hex'), {
    allowUnknownOutputs: true,
    disableScriptCheck: true,
  });
  return detectPreimage(vin, tx);
}

/** Build a swap leg: tree + Musig-aggregated internal key + taproot address/script. */
export function buildSwapLeg(p: BuildLegParams): SwapLeg {
  const tree = reverseSwapTree(
    false, // not Liquid
    p.preimageHash,
    p.claimPublicKey,
    p.refundPublicKey,
    p.timeoutBlockHeight,
  );

  const internalKey = Musig.aggregateKeys(p.musigOrder);
  const merkleRoot = TaprootUtils.taprootHashTree(tree.tree).hash;
  const tweaked = taprootTweakPubkey(internalKey, merkleRoot);
  const outputKey = tweaked[0];

  const address = Address(p.network).encode({ type: 'tr', pubkey: outputKey });
  const outputScript = OutScript.encode({ type: 'tr', pubkey: outputKey });

  return { tree, internalKey, outputKey, address, outputScript };
}

export interface LockupUtxo {
  txid: string;
  vout: number;
  amountSat: bigint;
}

/**
 * Script-path claim transaction: spend the lockup by revealing the preimage. Used by the
 * recipient to claim a leg, and by the bond owner to reclaim a bond. Signals RBF so we can
 * fee-bump before the timeout.
 */
export function buildClaimTx(args: {
  leg: SwapLeg;
  utxo: LockupUtxo;
  claimPrivateKey: Uint8Array;
  preimage: Uint8Array;
  destinationScript: Uint8Array;
  feeSat: bigint;
}): Transaction {
  const details: Types.ClaimDetails = {
    type: OutputType.Taproot,
    transactionId: args.utxo.txid,
    vout: args.utxo.vout,
    script: args.leg.outputScript,
    amount: args.utxo.amountSat,
    privateKey: args.claimPrivateKey,
    preimage: args.preimage,
    swapTree: args.leg.tree,
    internalKey: args.leg.internalKey,
    cooperative: false,
  };
  return constructClaimTransaction([details], args.destinationScript, args.feeSat, true);
}

/**
 * Script-path refund transaction: spend the lockup after `timeoutBlockHeight`. Used by the
 * party who locked funds when the swap stalls, and by the counterparty to claim a forfeited
 * bond after its timeout.
 */
export function buildRefundTx(args: {
  leg: SwapLeg;
  utxo: LockupUtxo;
  refundPrivateKey: Uint8Array;
  timeoutBlockHeight: number;
  destinationScript: Uint8Array;
  feeSat: bigint;
}): Transaction {
  const details: Types.RefundDetails = {
    type: OutputType.Taproot,
    transactionId: args.utxo.txid,
    vout: args.utxo.vout,
    script: args.leg.outputScript,
    amount: args.utxo.amountSat,
    privateKey: args.refundPrivateKey,
    swapTree: args.leg.tree,
    internalKey: args.leg.internalKey,
    cooperative: false,
  };
  return constructRefundTransaction(
    [details],
    args.destinationScript,
    args.timeoutBlockHeight,
    args.feeSat,
    true,
  );
}
