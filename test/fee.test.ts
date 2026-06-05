import { describe, it, expect } from 'vitest';
import { pubSchnorr, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
import { bitcoinSignet, p2trAddress, p2trScript } from '../src/common/index.js';
import { computeFeeSat, buildFeeOutput, buildFeeTx, type FeePolicy } from '../src/settlement/Fee.js';

function operatorPolicy(bps: number, minSat: bigint): { policy: FeePolicy; opXonly: Uint8Array } {
  const priv = randomPrivateKeyBytes();
  const opXonly = pubSchnorr(priv);
  const policy: FeePolicy = {
    operatorAddress: p2trAddress(opXonly, bitcoinSignet),
    network: bitcoinSignet,
    bps,
    minSat,
  };
  return { policy, opXonly };
}

describe('Fee (non-custodial operator fee)', () => {
  it('computeFeeSat: bps of dest amount, with a floor', () => {
    const { policy } = operatorPolicy(20, 100n); // 0.20%, floor 100
    expect(computeFeeSat(1_000_000n, policy)).toBe(2_000n); // 0.20% of 1,000,000
    expect(computeFeeSat(10_000n, policy)).toBe(100n); // 0.20% = 20 < floor -> 100
  });

  it('buildFeeOutput: pays the operator address the fee amount', () => {
    const { policy, opXonly } = operatorPolicy(20, 100n);
    const out = buildFeeOutput(2_000n, policy);
    expect(out.amountSat).toBe(2_000n);
    expect(Buffer.from(out.script)).toEqual(Buffer.from(p2trScript(opXonly, bitcoinSignet)));
  });

  it('buildFeeTx: standalone fee payment to the operator with change back to the taker', () => {
    const { policy } = operatorPolicy(20, 100n);
    const takerPriv = randomPrivateKeyBytes();
    const takerXonly = pubSchnorr(takerPriv);

    const tx = buildFeeTx({
      input: {
        txid: 'aa'.repeat(32),
        vout: 0,
        amountSat: 100_000n,
        prevScript: p2trScript(takerXonly, bitcoinSignet),
        internalKey: takerXonly,
      },
      privateKey: takerPriv,
      feeSat: 2_000n,
      policy,
      changeScript: p2trScript(takerXonly, bitcoinSignet),
      minerFeeSat: 300n,
    });

    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(2); // fee + change
    expect(typeof tx.hex).toBe('string');
  });

  it('buildFeeTx: throws if the input cannot cover fee + miner fee', () => {
    const { policy } = operatorPolicy(20, 100n);
    const priv = randomPrivateKeyBytes();
    const xonly = pubSchnorr(priv);
    expect(() =>
      buildFeeTx({
        input: { txid: 'bb'.repeat(32), vout: 0, amountSat: 1_000n, prevScript: p2trScript(xonly, bitcoinSignet), internalKey: xonly },
        privateKey: priv,
        feeSat: 2_000n,
        policy,
        changeScript: p2trScript(xonly, bitcoinSignet),
        minerFeeSat: 300n,
      }),
    ).toThrow(/too small/);
  });
});
