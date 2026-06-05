import { describe, it, expect } from 'vitest';
import { pubECDSA, pubSchnorr, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
import { pearlSimnet, bitcoinSignet, p2trScript } from '../src/common/index.js';
import { makePreimage, extractPreimage } from '../src/settlement/SwapTree.js';
import { buildBond, buildBondReclaimTx, buildBondForfeitTx } from '../src/settlement/Bond.js';
import {
  computeBondForfeitHeight,
  PEARL_TIMING,
  SIGNET_TIMING,
} from '../src/settlement/Timelocks.js';
import { LocalSigner } from '../src/signer/index.js';

function participant() {
  const priv = randomPrivateKeyBytes();
  return { priv, pub: pubECDSA(priv, true), xonly: pubSchnorr(priv) };
}

function bondFixture(network = bitcoinSignet, forfeitTimeoutHeight = 300) {
  const owner = participant(); // option-holder; reclaims with the preimage
  const counterparty = participant(); // forfeit-claims after the timeout
  const { preimage, preimageHash } = makePreimage();
  const bond = buildBond({
    preimageHash,
    ownerPublicKey: owner.pub,
    counterpartyPublicKey: counterparty.pub,
    forfeitTimeoutHeight,
    network,
    musigOrder: [counterparty.pub, owner.pub],
  });
  return { owner, counterparty, preimage, preimageHash, bond, forfeitTimeoutHeight };
}

describe('Bond (secret-tied forfeitable bond — the free-option fix)', () => {
  it('derives a deterministic taproot bond address with the right HRP', () => {
    const a = bondFixture(bitcoinSignet);
    expect(a.bond.address.startsWith('tb1p')).toBe(true);
    expect(a.bond.outputKey.length).toBe(32);
    expect(a.bond.outputScript.length).toBe(34);

    const p = bondFixture(pearlSimnet);
    expect(p.bond.address.startsWith('rprl1p')).toBe(true);
  });

  it('reclaim: owner spends by revealing the preimage (preimage is recoverable on-chain)', async () => {
    const { owner, preimage, bond } = bondFixture(bitcoinSignet);
    const dest = participant();

    const tx = await buildBondReclaimTx({
      bond,
      utxo: { txid: 'ab'.repeat(32), vout: 0, amountSat: 50_000n },
      ownerSigner: new LocalSigner(owner.priv),
      preimage,
      destinationScript: p2trScript(dest.xonly, bitcoinSignet),
      feeSat: 400n,
    });

    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(1);
    // The reclaim is the claim path: no timelock, and it reveals the same preimage.
    expect(tx.lockTime).toBe(0);
    expect(Buffer.from(extractPreimage(tx.hex, 0))).toEqual(Buffer.from(preimage));
  });

  it('forfeit: counterparty spends after the timeout (carries the forfeit locktime)', async () => {
    const { counterparty, bond, forfeitTimeoutHeight } = bondFixture(pearlSimnet, 321);
    const dest = participant();

    const tx = await buildBondForfeitTx({
      bond,
      utxo: { txid: 'cd'.repeat(32), vout: 1, amountSat: 50_000n },
      counterpartySigner: new LocalSigner(counterparty.priv),
      forfeitTimeoutHeight,
      destinationScript: p2trScript(dest.xonly, pearlSimnet),
      feeSat: 400n,
    });

    expect(tx.lockTime).toBe(321);
  });

  it('forfeit height is set safely after the realized dest refund wall-clock', () => {
    // dest leg refunds at ~1h wall-clock; bond on the BTC chain; 30-min safety margin.
    const h = computeBondForfeitHeight({
      bondChain: SIGNET_TIMING,
      bondChainHeight: 1000,
      destWallSeconds: 3600,
      marginSeconds: 1800,
    });
    // ceil((3600+1800)/600) = 9 blocks past current height.
    expect(h).toBe(1009);

    // On Pearl's faster blocks the same wall-clock window needs more blocks (194s each).
    const hp = computeBondForfeitHeight({
      bondChain: PEARL_TIMING,
      bondChainHeight: 1000,
      destWallSeconds: 3600,
      marginSeconds: 1800,
    });
    expect(hp).toBe(1000 + Math.ceil(5400 / 194)); // 1000 + 28
  });
});
