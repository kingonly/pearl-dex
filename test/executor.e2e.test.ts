import { describe, it, expect } from 'vitest';
import { pubECDSA, pubSchnorr, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
import { bitcoinSignet, pearlSimnet } from '../src/common/index.js';
import { makePreimage, extractPreimage } from '../src/settlement/SwapTree.js';
import {
  SwapExecutor,
  newTakerRecord,
  newMakerRecord,
  MemorySwapStore,
  type SwapExecutorDeps,
  type SwapParamsJSON,
  type SwapRecord,
  type SwapStore,
} from '../src/coordination/index.js';
import { ScriptedChainClient } from './helpers/ScriptedChain.js';
import { ScriptedWallet } from './helpers/ScriptedWallet.js';

// Two-user BTC->PRL swap driven end-to-end by the coordinator state machine. Taker has BTC
// (source + bond on BTC), maker has PRL (dest). Both executors run concurrently against the SAME
// scripted chains, so they interact only through on-chain state (non-custodial, as in production).

function participant() {
  const priv = randomPrivateKeyBytes();
  return { priv, pub: pubECDSA(priv, true), xonly: pubSchnorr(priv) };
}
const hx = (b: Uint8Array) => Buffer.from(b).toString('hex');

const SRC_AMT = 120_000n; // BTC the taker locks
const DEST_AMT = 100_000n; // PRL the maker locks
const BOND_AMT = 2_000n; // ~1.7% option bond
const SOURCE_TIMEOUT = 1000; // BTC refund (longest)
const BOND_FORFEIT = 900; // BTC: maker forfeit-claims after this (must be > destTimeout, < sourceTimeout)
const DEST_TIMEOUT = 500; // PRL refund (shortest)

const FAST = { minConfs: 1, pollMs: 2, bumpAfterMs: 10_000, maxBumps: 2 };

function makeWorld() {
  const taker = participant();
  const maker = participant();
  const { preimage, preimageHash } = makePreimage();

  const params: SwapParamsJSON = {
    preimageHashHex: hx(preimageHash),
    takerPubHex: hx(taker.pub),
    makerPubHex: hx(maker.pub),
    sourceNetwork: 'bitcoinSignet',
    destNetwork: 'pearlSimnet',
    bondNetwork: 'bitcoinSignet',
    sourceTimeoutHeight: SOURCE_TIMEOUT,
    destTimeoutHeight: DEST_TIMEOUT,
    bondForfeitHeight: BOND_FORFEIT,
  };

  const btc = new ScriptedChainClient(bitcoinSignet, 'btc');
  const prl = new ScriptedChainClient(pearlSimnet, 'prl');
  btc.setHeight(100);
  prl.setHeight(100);

  const amounts = { sourceSat: SRC_AMT, destSat: DEST_AMT, bondSat: BOND_AMT };

  const takerWallet = new ScriptedWallet([btc, prl], taker.xonly);
  const makerWallet = new ScriptedWallet([btc, prl], maker.xonly);
  const takerStore = new MemorySwapStore();
  const makerStore = new MemorySwapStore();

  const takerDeps = (store: SwapStore): SwapExecutorDeps => ({
    store,
    source: btc,
    dest: prl,
    bond: btc,
    wallet: takerWallet,
    swapPrivateKey: taker.priv,
    policy: FAST,
  });
  const makerDeps = (store: SwapStore): SwapExecutorDeps => ({
    store,
    source: btc,
    dest: prl,
    bond: btc,
    wallet: makerWallet,
    swapPrivateKey: maker.priv,
    policy: FAST,
  });

  return {
    taker, maker, preimage, preimageHash, params, btc, prl, amounts,
    takerWallet, makerWallet, takerStore, makerStore, takerDeps, makerDeps,
  };
}

const totalFunded = (w: ScriptedWallet) => [...w.funded.values()].reduce((a, b) => a + b, 0);

async function waitUntil(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 3));
  }
}

describe('SwapExecutor — P2P coordinator (scripted BTC->PRL)', () => {
  it('happy path: both executors drive the swap to completion concurrently', async () => {
    const w = makeWorld();
    const takerExec = new SwapExecutor(
      newTakerRecord({ id: 's1', params: w.params, preimage: w.preimage, amounts: w.amounts }),
      w.takerDeps(w.takerStore),
    );
    const makerExec = new SwapExecutor(
      newMakerRecord({ id: 's1', params: w.params, amounts: w.amounts }),
      w.makerDeps(w.makerStore),
    );

    const [takerRec, makerRec] = await Promise.all([takerExec.run(), makerExec.run()]);

    expect(takerRec.phase).toBe('completed');
    expect(makerRec.phase).toBe('completed');

    // The maker independently learned the taker's preimage from the on-chain dest claim.
    expect(makerRec.preimageHex).toBe(hx(w.preimage));

    // Each side broadcast exactly its expected txs.
    expect(takerRec.txids).toHaveProperty('dest_claim'); // taker claimed PRL (revealed preimage)
    expect(takerRec.txids).toHaveProperty('bond_reclaim'); // taker reclaimed the bond with x
    expect(makerRec.txids).toHaveProperty('source_claim'); // maker claimed BTC with x

    // PRL: dest claim only. BTC: source claim + bond reclaim.
    expect(w.prl.broadcasts).toHaveLength(1);
    expect(w.btc.broadcasts).toHaveLength(2);

    // The preimage actually crossed chains via the dest claim.
    const destClaimHex = w.prl.broadcasts[0];
    expect(hx(extractPreimage(destClaimHex, 0))).toBe(hx(w.preimage));

    // Each lockup funded exactly once: taker funds source + bond (2), maker funds dest (1).
    expect(totalFunded(w.takerWallet)).toBe(2);
    expect(totalFunded(w.makerWallet)).toBe(1);
  });

  it('walk path: taker refuses to consummate; maker refunds dest and forfeit-claims the bond', async () => {
    const w = makeWorld();
    const takerExec = new SwapExecutor(
      newTakerRecord({ id: 's2', params: w.params, preimage: w.preimage, amounts: w.amounts }),
      { ...w.takerDeps(w.takerStore), policy: { ...FAST, shouldConsummate: () => false } },
    );
    const makerExec = new SwapExecutor(
      newMakerRecord({ id: 's2', params: w.params, amounts: w.amounts }),
      w.makerDeps(w.makerStore),
    );

    const takerDone = takerExec.run();
    const makerDone = makerExec.run();

    // Taker walks immediately after both legs are funded; maker is watching dest for a claim.
    await waitUntil(() => takerExec.phase === 'aborting' && makerExec.phase === 'dest_funded');

    // PRL hits dest timeout -> maker sees the taker walked, refunds dest, then waits for forfeit.
    w.prl.setHeight(DEST_TIMEOUT);
    await waitUntil(() => makerExec.phase === 'dest_refunded');

    // BTC hits bond forfeit height -> maker claims the forfeited bond (its compensation).
    w.btc.setHeight(BOND_FORFEIT);
    await waitUntil(() => makerExec.current.txids['bond_forfeit'] !== undefined);

    // BTC hits source timeout -> taker recovers its source principal (loses the bond, by design).
    w.btc.setHeight(SOURCE_TIMEOUT);

    const [takerRec, makerRec] = await Promise.all([takerDone, makerDone]);

    expect(takerRec.phase).toBe('refunded');
    expect(takerRec.abortReason).toBe('walk');
    expect(takerRec.txids).toHaveProperty('source_refund');
    expect(takerRec.txids).not.toHaveProperty('bond_reclaim'); // walker does NOT reclaim the bond

    expect(makerRec.phase).toBe('refunded');
    expect(makerRec.abortReason).toBe('dest_not_claimed');
    expect(makerRec.txids).toHaveProperty('dest_refund');
    expect(makerRec.txids).toHaveProperty('bond_forfeit');
  });

  it('counterparty-no-fund: maker never funds dest; taker refunds source and reclaims its bond', async () => {
    const w = makeWorld();
    const takerExec = new SwapExecutor(
      newTakerRecord({ id: 's3', params: w.params, preimage: w.preimage, amounts: w.amounts }),
      w.takerDeps(w.takerStore),
    );
    const takerDone = takerExec.run(); // no maker at all

    // Taker funds source + bond, then waits for a dest lockup that never comes.
    await waitUntil(() => takerExec.phase === 'awaiting_counterparty');
    // PRL passes the funding deadline (destTimeout) -> taker aborts.
    w.prl.setHeight(DEST_TIMEOUT);
    await waitUntil(() => takerExec.phase === 'aborting');
    // BTC passes source timeout -> taker refunds source, then reclaims the bond (honest abort).
    w.btc.setHeight(SOURCE_TIMEOUT);

    const rec = await takerDone;
    expect(rec.phase).toBe('refunded');
    expect(rec.abortReason).toBe('counterparty_no_fund');
    expect(rec.txids).toHaveProperty('source_refund');
    expect(rec.txids).toHaveProperty('bond_reclaim'); // honest taker recovers its bond
    // source refund + bond reclaim on BTC.
    expect(w.btc.broadcasts).toHaveLength(2);
  });

  it('restart-safety: a fresh executor resumes from the store without re-funding or double-claiming', async () => {
    const w = makeWorld();

    // A store that lets us "crash" the taker right after it funds the source leg (before the bond).
    const crashAt = 'source_funded';
    let crashed = false;
    const base = w.takerStore;
    const crashStore: SwapStore = {
      load: (id) => base.load(id),
      list: () => base.list(),
      save: async (r) => {
        await base.save(r);
        if (r.phase === crashAt && !crashed) {
          crashed = true;
          exec1.stop();
        }
      },
    };

    const exec1 = new SwapExecutor(
      newTakerRecord({ id: 's4', params: w.params, preimage: w.preimage, amounts: w.amounts }),
      { ...w.takerDeps(crashStore) },
    );
    const makerExec = new SwapExecutor(
      newMakerRecord({ id: 's4', params: w.params, amounts: w.amounts }),
      w.makerDeps(w.makerStore),
    );
    const makerDone = makerExec.run();

    // Run the taker until it "crashes" shortly after funding the bond.
    await exec1.run();
    expect(crashed).toBe(true);
    const mid = await base.load('s4');
    expect(mid).not.toBeNull();

    // A brand-new executor loads the persisted record and resumes to completion.
    const exec2 = new SwapExecutor(mid as SwapRecord, w.takerDeps(base));
    const [takerRec] = await Promise.all([exec2.run(), makerDone]);

    expect(takerRec.phase).toBe('completed');
    expect(makerExec.phase).toBe('completed');

    // Idempotency across the restart: source funded by exec1, bond by exec2, neither re-funded.
    // A total of 2 fundLockup calls proves the resumed executor adopted the existing source lockup
    // instead of re-funding it.
    expect(totalFunded(w.takerWallet)).toBe(2);
    // The taker still broadcast its two BTC txs (source claim... actually dest claim on PRL + bond
    // reclaim on BTC + maker's source claim on BTC) exactly once each — no double-claim.
    expect(w.prl.broadcasts).toHaveLength(1); // single dest claim
    expect(w.btc.broadcasts).toHaveLength(2); // maker source claim + taker bond reclaim
  });

  it('fee-bump: an unconfirmed claim is RBF-rebroadcast at a higher fee until it lands', async () => {
    const w = makeWorld();
    // The taker's first dest-claim broadcast (on PRL) reports unconfirmed -> force one fee bump.
    w.prl.withholdBroadcasts(1);
    const bumpPolicy = { ...FAST, bumpAfterMs: 25, pollMs: 2, maxBumps: 3 };

    const takerExec = new SwapExecutor(
      newTakerRecord({ id: 's5', params: w.params, preimage: w.preimage, amounts: w.amounts }),
      { ...w.takerDeps(w.takerStore), policy: bumpPolicy },
    );
    const makerExec = new SwapExecutor(
      newMakerRecord({ id: 's5', params: w.params, amounts: w.amounts }),
      { ...w.makerDeps(w.makerStore), policy: bumpPolicy },
    );

    const [takerRec, makerRec] = await Promise.all([takerExec.run(), makerExec.run()]);

    expect(takerRec.phase).toBe('completed');
    expect(makerRec.phase).toBe('completed');
    // The dest claim was broadcast twice (original + one RBF bump); the recorded txid is the bump.
    expect(w.prl.broadcasts).toHaveLength(2);
    // The two broadcasts differ (a higher fee changes the tx and therefore its id).
    expect(w.prl.broadcasts[0]).not.toBe(w.prl.broadcasts[1]);
  });
});
