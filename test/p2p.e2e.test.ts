import { describe, it, expect } from 'vitest';
import { pubECDSA, pubSchnorr, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
import { bitcoinSignet, pearlSimnet, p2trScript } from '../src/common/index.js';
import { makePreimage, extractPreimage, buildClaimTx, buildRefundTx } from '../src/settlement/SwapTree.js';
import { buildBondReclaimTx, buildBondForfeitTx } from '../src/settlement/Bond.js';
import { buildSwapPlan } from '../src/settlement/SwapPlan.js';
import { LocalSigner } from '../src/signer/index.js';
import { ScriptedChainClient } from './helpers/ScriptedChain.js';

// Two-user BTC->PRL swap. TAKER has BTC (source), MAKER has PRL (dest). The taker holds the
// preimage and the price option, so the taker posts the option bond on the BTC chain.
function participant() {
  const priv = randomPrivateKeyBytes();
  return { priv, pub: pubECDSA(priv, true), xonly: pubSchnorr(priv) };
}

const FEE = 1_000n;
const SRC_AMT = 120_000; // BTC the taker locks
const DEST_AMT = 100_000; // PRL the maker locks
const BOND_AMT = 2_000; // ~1.7% option bond
const TXID = (b: string) => b.repeat(32);

function setup() {
  const taker = participant();
  const maker = participant();
  const { preimage, preimageHash } = makePreimage();

  const SOURCE_TIMEOUT = 1000; // BTC refund (longer)
  const DEST_TIMEOUT = 500; // PRL refund (shorter)
  const BOND_FORFEIT = 900; // BTC height after which maker forfeit-claims the bond

  const plan = buildSwapPlan({
    preimageHash,
    taker: { pub: taker.pub },
    maker: { pub: maker.pub },
    sourceNetwork: bitcoinSignet,
    destNetwork: pearlSimnet,
    sourceTimeoutHeight: SOURCE_TIMEOUT,
    destTimeoutHeight: DEST_TIMEOUT,
    bondNetwork: bitcoinSignet,
    bondForfeitHeight: BOND_FORFEIT,
  });

  const btc = new ScriptedChainClient(bitcoinSignet, 'btc');
  const prl = new ScriptedChainClient(pearlSimnet, 'prl');

  const srcUtxo = { txid: TXID('a1'), vout: 0 };
  const bondUtxo = { txid: TXID('b2'), vout: 0 };
  const destUtxo = { txid: TXID('c3'), vout: 0 };

  return {
    taker,
    maker,
    preimage,
    plan,
    btc,
    prl,
    srcUtxo,
    bondUtxo,
    destUtxo,
    SOURCE_TIMEOUT,
    DEST_TIMEOUT,
    BOND_FORFEIT,
  };
}

describe('P2P swap + option bond (scripted chains, BTC->PRL)', () => {
  it('happy path: taker claims dest revealing x, maker claims source with x, taker reclaims bond with x', async () => {
    const s = setup();

    // Taker has funded the source (BTC) leg and the option bond; maker has funded the dest (PRL) leg.
    s.btc.injectLockup(s.plan.sourceLeg.address, {
      utxo: s.srcUtxo,
      amountSat: SRC_AMT,
      scriptPubKey: Buffer.from(s.plan.sourceLeg.outputScript),
    });
    s.btc.injectLockup(s.plan.optionBond.address, {
      utxo: s.bondUtxo,
      amountSat: BOND_AMT,
      scriptPubKey: Buffer.from(s.plan.optionBond.outputScript),
    });
    s.prl.injectLockup(s.plan.destLeg.address, {
      utxo: s.destUtxo,
      amountSat: DEST_AMT,
      scriptPubKey: Buffer.from(s.plan.destLeg.outputScript),
    });
    s.prl.setHeight(100); // below DEST_TIMEOUT

    // 1. Taker claims the dest (PRL) leg, revealing the preimage on the PRL chain.
    const takerDestClaim = await buildClaimTx({
      leg: s.plan.destLeg,
      utxo: { ...s.destUtxo, amountSat: BigInt(DEST_AMT) },
      signer: new LocalSigner(s.taker.priv),
      preimage: s.preimage,
      destinationScript: p2trScript(s.taker.xonly, pearlSimnet),
      feeSat: FEE,
    });
    await s.prl.broadcast(takerDestClaim.hex);
    s.prl.injectSpend(s.destUtxo, {
      spendTxid: takerDestClaim.id,
      spendTxHex: takerDestClaim.hex,
      inputIndex: 0,
    });

    // 2. Maker watches the dest leg, learns the preimage, claims the source (BTC) leg with it.
    const spend = await s.prl.watchForSpend(s.destUtxo, { pollMs: 5, timeoutMs: 1000 });
    const learned = extractPreimage(spend.spendTxHex, spend.inputIndex);
    expect(Buffer.from(learned)).toEqual(Buffer.from(s.preimage)); // preimage crossed chains

    const makerSourceClaim = await buildClaimTx({
      leg: s.plan.sourceLeg,
      utxo: { ...s.srcUtxo, amountSat: BigInt(SRC_AMT) },
      signer: new LocalSigner(s.maker.priv),
      preimage: learned,
      destinationScript: p2trScript(s.maker.xonly, bitcoinSignet),
      feeSat: FEE,
    });
    await s.btc.broadcast(makerSourceClaim.hex);

    // 3. Taker reclaims the option bond by revealing the same preimage (it is NOT forfeited).
    const takerBondReclaim = await buildBondReclaimTx({
      bond: s.plan.optionBond,
      utxo: { ...s.bondUtxo, amountSat: BigInt(BOND_AMT) },
      ownerSigner: new LocalSigner(s.taker.priv),
      preimage: s.preimage,
      destinationScript: p2trScript(s.taker.xonly, bitcoinSignet),
      feeSat: FEE,
    });
    await s.btc.broadcast(takerBondReclaim.hex);

    // The one secret consummated the swap AND reclaimed the bond.
    expect(Buffer.from(extractPreimage(makerSourceClaim.hex, 0))).toEqual(Buffer.from(s.preimage));
    expect(Buffer.from(extractPreimage(takerBondReclaim.hex, 0))).toEqual(Buffer.from(s.preimage));
    expect(takerBondReclaim.lockTime).toBe(0); // reclaim path, no timelock
    expect(s.btc.broadcasts).toHaveLength(2); // source claim + bond reclaim
    expect(s.prl.broadcasts).toHaveLength(1); // dest claim
  }, 15_000);

  it('walk path: taker never claims dest; both refund; maker forfeit-claims the option bond', async () => {
    const s = setup();

    // Taker funded source + bond; maker funded dest; then the taker walks (price moved).
    // No dest claim is ever broadcast, so the preimage is never revealed.

    // Maker refunds the dest (PRL) leg after DEST_TIMEOUT.
    const makerDestRefund = await buildRefundTx({
      leg: s.plan.destLeg,
      utxo: { ...s.destUtxo, amountSat: BigInt(DEST_AMT) },
      signer: new LocalSigner(s.maker.priv),
      timeoutBlockHeight: s.DEST_TIMEOUT,
      destinationScript: p2trScript(s.maker.xonly, pearlSimnet),
      feeSat: FEE,
    });

    // Taker refunds the source (BTC) leg after SOURCE_TIMEOUT.
    const takerSourceRefund = await buildRefundTx({
      leg: s.plan.sourceLeg,
      utxo: { ...s.srcUtxo, amountSat: BigInt(SRC_AMT) },
      signer: new LocalSigner(s.taker.priv),
      timeoutBlockHeight: s.SOURCE_TIMEOUT,
      destinationScript: p2trScript(s.taker.xonly, bitcoinSignet),
      feeSat: FEE,
    });

    // Maker forfeit-claims the option bond after BOND_FORFEIT (compensation for the walk).
    const makerBondForfeit = await buildBondForfeitTx({
      bond: s.plan.optionBond,
      utxo: { ...s.bondUtxo, amountSat: BigInt(BOND_AMT) },
      counterpartySigner: new LocalSigner(s.maker.priv),
      forfeitTimeoutHeight: s.BOND_FORFEIT,
      destinationScript: p2trScript(s.maker.xonly, bitcoinSignet),
      feeSat: FEE,
    });

    expect(makerDestRefund.lockTime).toBe(s.DEST_TIMEOUT);
    expect(takerSourceRefund.lockTime).toBe(s.SOURCE_TIMEOUT);
    expect(makerBondForfeit.lockTime).toBe(s.BOND_FORFEIT);
    // The bond forfeit becomes spendable only after both swap legs can refund (dest first).
    expect(s.BOND_FORFEIT).toBeGreaterThan(s.DEST_TIMEOUT);
  });
});
