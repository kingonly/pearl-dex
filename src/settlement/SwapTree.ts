import { randomBytes } from 'node:crypto';
import { Address, OutScript, SigHash, Transaction } from '@scure/btc-signer';
import type { BTC_NETWORK } from '@scure/btc-signer/utils.js';
import { sha256, taprootTweakPubkey } from '@scure/btc-signer/utils.js';
import {
  detectPreimage,
  Musig,
  reverseSwapTree,
  TaprootUtils,
  type Types,
} from 'boltz-core';
import type { Signer } from '../signer/index.js';

/** Signal RBF (BIP-125) so an unconfirmed claim/refund can be fee-bumped before its deadline. */
const RBF_SEQUENCE = 0xfffffffd;
/** Minimum spendable output; anything smaller is folded into the miner fee rather than created. */
export const DEFAULT_DUST_SAT = 330n;

/** An extra output to attach to a spend (e.g. the operator fee on the taker's dest claim). */
export interface SpendOutput {
  script: Uint8Array;
  amountSat: bigint;
}

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
 * Build and sign a single-input taproot SCRIPT-PATH spend of a swap leg, THROUGH the Signer seam.
 *
 * We no longer hand a private key to boltz-core's `constructClaimTransaction`. Instead we assemble
 * the tx ourselves and obtain the one signature from a `Signer` (a held key, or a remote/hardware
 * signer that only signs a 32-byte hash). This is what lets a browser user sign claims without the
 * app ever holding the key. The witness is the same boltz produces: `[sig, preimage?, leaf, control]`.
 *
 *   - claim  (isRefund=false): witness includes the preimage; lockTime = 0 (claim leaf has no CLTV).
 *   - refund (isRefund=true):  no preimage; lockTime = timeout (the refund leaf's CLTV).
 *
 * `extraOutputs` (claim only) are appended after the primary payout — used to pay the operator fee
 * out of the taker's received amount. The primary payout receives `input - minerFee - Σextra`; if
 * that would fall below dust the spend is refused rather than creating a negative/unspendable output.
 */
async function buildScriptPathSpend(args: {
  leg: SwapLeg;
  utxo: LockupUtxo;
  signer: Signer;
  isRefund: boolean;
  preimage?: Uint8Array;
  lockTime: number;
  destinationScript: Uint8Array;
  feeSat: bigint;
  extraOutputs?: SpendOutput[];
  dustSat?: bigint;
}): Promise<Transaction> {
  const tapLeaf = args.isRefund ? args.leg.tree.refundLeaf : args.leg.tree.claimLeaf;
  const extra = args.extraOutputs ?? [];
  const extraTotal = extra.reduce((acc, o) => acc + o.amountSat, 0n);
  const dust = args.dustSat ?? DEFAULT_DUST_SAT;
  const payout = args.utxo.amountSat - args.feeSat - extraTotal;
  if (payout < dust) {
    throw new Error(
      `output underflow: input ${args.utxo.amountSat} - minerFee ${args.feeSat} - extra ${extraTotal} ` +
        `= ${payout} < dust ${dust} (raise the locked amount or lower the fee)`,
    );
  }

  const tx = new Transaction({ version: 2, lockTime: args.lockTime, allowUnknownOutputs: true });
  tx.addOutput({ amount: payout, script: args.destinationScript });
  for (const o of extra) tx.addOutput({ amount: o.amountSat, script: o.script });
  tx.addInput({ txid: args.utxo.txid, index: args.utxo.vout, sequence: RBF_SEQUENCE });

  // Taproot script-path sighash over the single input, committing to the leaf being satisfied.
  const sigHash = tx.preimageWitnessV1(
    0,
    [args.leg.outputScript],
    SigHash.DEFAULT,
    [args.utxo.amountSat],
    undefined,
    tapLeaf.output,
    tapLeaf.version,
  );
  const signature = await args.signer.signSchnorr(sigHash);

  const witness: Uint8Array[] = [signature];
  if (!args.isRefund) witness.push(args.preimage as Uint8Array);
  witness.push(tapLeaf.output);
  witness.push(
    TaprootUtils.createControlBlock(
      TaprootUtils.taprootHashTree(args.leg.tree.tree),
      tapLeaf,
      args.leg.internalKey,
    ),
  );
  tx.updateInput(0, { finalScriptWitness: witness });
  return tx;
}

/**
 * Script-path claim transaction: spend the lockup by revealing the preimage. Used by the
 * recipient to claim a leg, and by the bond owner to reclaim a bond. Signals RBF so we can
 * fee-bump before the timeout. Signs through the `Signer` seam (never holds the key).
 *
 * `extraOutputs` attaches additional payments (the operator fee output on the taker's dest claim).
 */
export function buildClaimTx(args: {
  leg: SwapLeg;
  utxo: LockupUtxo;
  signer: Signer;
  preimage: Uint8Array;
  destinationScript: Uint8Array;
  feeSat: bigint;
  extraOutputs?: SpendOutput[];
  dustSat?: bigint;
}): Promise<Transaction> {
  return buildScriptPathSpend({
    leg: args.leg,
    utxo: args.utxo,
    signer: args.signer,
    isRefund: false,
    preimage: args.preimage,
    lockTime: 0,
    destinationScript: args.destinationScript,
    feeSat: args.feeSat,
    extraOutputs: args.extraOutputs,
    dustSat: args.dustSat,
  });
}

/**
 * Script-path refund transaction: spend the lockup after `timeoutBlockHeight`. Used by the
 * party who locked funds when the swap stalls, and by the counterparty to claim a forfeited
 * bond after its timeout. Signs through the `Signer` seam.
 */
export function buildRefundTx(args: {
  leg: SwapLeg;
  utxo: LockupUtxo;
  signer: Signer;
  timeoutBlockHeight: number;
  destinationScript: Uint8Array;
  feeSat: bigint;
  dustSat?: bigint;
}): Promise<Transaction> {
  return buildScriptPathSpend({
    leg: args.leg,
    utxo: args.utxo,
    signer: args.signer,
    isRefund: true,
    lockTime: args.timeoutBlockHeight,
    destinationScript: args.destinationScript,
    feeSat: args.feeSat,
    dustSat: args.dustSat,
  });
}
