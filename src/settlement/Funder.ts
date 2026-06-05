import { Transaction } from '@scure/btc-signer';

export interface KeyPathInput {
  txid: string;
  vout: number;
  amountSat: bigint;
  /** the p2tr scriptPubKey being spent. */
  prevScript: Uint8Array;
  /** x-only internal key of the p2tr output (no script tree). */
  internalKey: Uint8Array;
}

export interface TxOutputSpec {
  script: Uint8Array;
  amountSat: bigint;
}

/**
 * Build + sign a taproot KEY-PATH spend of a single p2tr UTXO to the given outputs. This is
 * how a user funds a swap lockup or a bond: spend one of their own p2tr UTXOs into a
 * `buildSwapLeg` / `buildBond` lockup address. @scure applies the default taproot tweak when
 * only `tapInternalKey` is set (no script tree on the user's own output). Ported from pearl-swap.
 */
export function buildP2trKeyPathSpend(args: {
  input: KeyPathInput;
  privateKey: Uint8Array;
  outputs: TxOutputSpec[];
}): Transaction {
  const tx = new Transaction();
  tx.addInput({
    txid: args.input.txid,
    index: args.input.vout,
    witnessUtxo: { script: args.input.prevScript, amount: args.input.amountSat },
    tapInternalKey: args.input.internalKey,
  });
  for (const o of args.outputs) {
    tx.addOutput({ script: o.script, amount: o.amountSat });
  }
  tx.sign(args.privateKey);
  tx.finalize();
  return tx;
}
