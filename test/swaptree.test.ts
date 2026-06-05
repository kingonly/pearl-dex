import { describe, it, expect } from 'vitest';
import { pubECDSA, pubSchnorr, randomPrivateKeyBytes, sha256 } from '@scure/btc-signer/utils.js';
import { pearlSimnet, bitcoinSignet, p2trScript } from '../src/common/index.js';
import {
  buildSwapLeg,
  buildClaimTx,
  buildRefundTx,
  makePreimage,
  extractPreimage,
  type BuildLegParams,
} from '../src/settlement/SwapTree.js';
import { LocalSigner } from '../src/signer/index.js';

// Generate a participant: 33-byte compressed key for Musig, x-only for the destination.
function participant() {
  const priv = randomPrivateKeyBytes();
  return { priv, pub: pubECDSA(priv, true), xonly: pubSchnorr(priv) };
}

function legParams(network: BuildLegParams['network'], over: Partial<BuildLegParams> = {}) {
  const claim = participant();
  const refund = participant();
  const { preimage, preimageHash } = makePreimage();
  const params: BuildLegParams = {
    preimageHash,
    claimPublicKey: claim.pub,
    refundPublicKey: refund.pub,
    timeoutBlockHeight: 200,
    network,
    musigOrder: [claim.pub, refund.pub],
    ...over,
  };
  return { params, claim, refund, preimage, preimageHash };
}

describe('SwapTree (ported settlement core)', () => {
  it('makePreimage: hash is SHA256(preimage)', () => {
    const { preimage, preimageHash } = makePreimage();
    expect(preimage.length).toBe(32);
    expect(Buffer.from(preimageHash)).toEqual(Buffer.from(sha256(preimage)));
  });

  it('derives a deterministic lockup address with the right HRP per network', () => {
    const { params } = legParams(pearlSimnet);

    const a = buildSwapLeg(params);
    const b = buildSwapLeg(params);
    expect(a.address).toBe(b.address); // deterministic
    expect(a.address.startsWith('rprl1p')).toBe(true);
    expect(a.outputKey.length).toBe(32);
    expect(a.outputScript.length).toBe(34); // OP_1 PUSH32 <key>

    // same keys, BTC signet -> tb1p, different address but same internal key
    const btc = buildSwapLeg({ ...params, network: bitcoinSignet });
    expect(btc.address.startsWith('tb1p')).toBe(true);
    expect(Buffer.from(btc.internalKey)).toEqual(Buffer.from(a.internalKey));
  });

  it('builds a claim tx that reveals the recoverable preimage', async () => {
    const { params, claim, preimage } = legParams(pearlSimnet);
    const leg = buildSwapLeg(params);
    const dest = participant();

    const tx = await buildClaimTx({
      leg,
      utxo: { txid: '11'.repeat(32), vout: 0, amountSat: 100_000n },
      signer: new LocalSigner(claim.priv),
      preimage,
      destinationScript: p2trScript(dest.xonly, pearlSimnet),
      feeSat: 500n,
    });

    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(1);
    expect(Buffer.from(extractPreimage(tx.hex, 0))).toEqual(Buffer.from(preimage));
  });

  it('attaches an extra (operator-fee) output and pays it out of the claimed amount', async () => {
    const { params, claim, preimage } = legParams(pearlSimnet);
    const leg = buildSwapLeg(params);
    const dest = participant();
    const operator = participant();
    const feeScript = p2trScript(operator.xonly, pearlSimnet);

    const tx = await buildClaimTx({
      leg,
      utxo: { txid: '33'.repeat(32), vout: 0, amountSat: 100_000n },
      signer: new LocalSigner(claim.priv),
      preimage,
      destinationScript: p2trScript(dest.xonly, pearlSimnet),
      feeSat: 500n,
      extraOutputs: [{ script: feeScript, amountSat: 2_000n }],
    });

    // Two outputs: the user's payout (input - minerFee - fee) and the operator fee.
    expect(tx.outputsLength).toBe(2);
    expect(tx.getOutput(0).amount).toBe(100_000n - 500n - 2_000n);
    expect(tx.getOutput(1).amount).toBe(2_000n);
    expect(Buffer.from(tx.getOutput(1).script!)).toEqual(Buffer.from(feeScript));
  });

  it('refuses to build when the miner fee + extras would underflow the output', async () => {
    const { params, claim, preimage } = legParams(pearlSimnet);
    const leg = buildSwapLeg(params);
    const dest = participant();

    await expect(
      buildClaimTx({
        leg,
        utxo: { txid: '44'.repeat(32), vout: 0, amountSat: 1_000n },
        signer: new LocalSigner(claim.priv),
        preimage,
        destinationScript: p2trScript(dest.xonly, pearlSimnet),
        feeSat: 900n,
        extraOutputs: [{ script: p2trScript(participant().xonly, pearlSimnet), amountSat: 500n }],
      }),
    ).rejects.toThrow(/underflow/);
  });

  it('builds a refund tx with the timeout locktime', async () => {
    const { params, refund } = legParams(bitcoinSignet, { timeoutBlockHeight: 321 });
    const leg = buildSwapLeg(params);
    const dest = participant();

    const tx = await buildRefundTx({
      leg,
      utxo: { txid: '22'.repeat(32), vout: 1, amountSat: 250_000n },
      signer: new LocalSigner(refund.priv),
      timeoutBlockHeight: 321,
      destinationScript: p2trScript(dest.xonly, bitcoinSignet),
      feeSat: 600n,
    });

    expect(tx.inputsLength).toBe(1);
    expect(tx.lockTime).toBe(321);
  });
});
