import { Transaction } from '@scure/btc-signer';
import type { BTC_NETWORK } from '@scure/btc-signer/utils.js';
import { addressToScript } from '../common/address.js';
import { buildP2trKeyPathSpend, type KeyPathInput, type TxOutputSpec } from './Funder.js';

/**
 * Operator monetization — a small fee on each matched swap. The operator NEVER custodies funds;
 * the fee is just an output paid to the operator's address as part of settlement (Komodo
 * "dexfee" model). The taker bears it (it comes out of the value they receive).
 *
 * Enforcement tiers (see DESIGN.md §10):
 *   v1 (soft):  a standalone fee tx the taker broadcasts as a precondition to being matched, OR
 *               an extra output in the taker's dest-leg claim. Enforced by the reference client +
 *               the matching service refusing to coordinate orders that don't commit the fee.
 *   v2 (hard):  OP_CAT covenant binds the dest-leg claim leaf to REQUIRE the fee output — the
 *               leg is unspendable unless it pays the fee. Same covenant machinery as the
 *               bond-payout enforcement; Pearl-specific and defensible (vanilla BTC can't do it).
 */
export interface FeePolicy {
  /** operator payout address on the chain the fee is collected on. */
  operatorAddress: string;
  network: BTC_NETWORK;
  /** fee in basis points of the dest amount (e.g. 20 = 0.20%). */
  bps: number;
  /** floor in sats, so dust-sized trades still pay something. */
  minSat: bigint;
}

/** The operator fee for a trade of `destAmountSat`, as bps with a floor. */
export function computeFeeSat(destAmountSat: bigint, policy: FeePolicy): bigint {
  const bpsFee = (destAmountSat * BigInt(policy.bps)) / 10_000n;
  return bpsFee > policy.minSat ? bpsFee : policy.minSat;
}

/** The fee as a transaction output (used by the 2-output-claim / covenant-bound path). */
export function buildFeeOutput(feeSat: bigint, policy: FeePolicy): TxOutputSpec {
  return { script: addressToScript(policy.operatorAddress, policy.network), amountSat: feeSat };
}

/**
 * v1 bootstrap: a standalone fee payment from one of the taker's own UTXOs to the operator,
 * broadcast as a precondition to matching. Trivial to build (reuses the key-path funder), and
 * replaceable by the covenant-bound in-claim fee once the OP_CAT spike lands.
 */
export function buildFeeTx(args: {
  input: KeyPathInput;
  privateKey: Uint8Array;
  feeSat: bigint;
  policy: FeePolicy;
  changeScript: Uint8Array;
  minerFeeSat: bigint;
}): Transaction {
  const change = args.input.amountSat - args.feeSat - args.minerFeeSat;
  if (change < 0n) throw new Error('fee tx input too small to cover fee + miner fee');
  const outputs: TxOutputSpec[] = [buildFeeOutput(args.feeSat, args.policy)];
  if (change > 0n) outputs.push({ script: args.changeScript, amountSat: change });
  return buildP2trKeyPathSpend({ input: args.input, privateKey: args.privateKey, outputs });
}
