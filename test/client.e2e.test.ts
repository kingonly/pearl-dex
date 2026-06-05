import { describe, it, expect } from 'vitest';
import { pubECDSA, pubSchnorr, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
import { bitcoinSignet, pearlSimnet, p2trAddress } from '../src/common/index.js';
import { PEARL_TIMING, SIGNET_TIMING } from '../src/settlement/index.js';
import {
  OrderBook,
  RelayServer,
  buildSwapParams,
  deriveAmounts,
  proposeTimeouts,
  newTakerRecord,
  MemorySwapStore,
  type Match,
  type Pair,
} from '../src/coordination/index.js';
import { SwapClient, type SwapClientConfig } from '../src/client/index.js';
import { ScriptedChainClient } from './helpers/ScriptedChain.js';
import { ScriptedWallet } from './helpers/ScriptedWallet.js';

const PRL_BTC: Pair = { base: 'PRL', quote: 'BTC' };
const COIN = 100_000_000n;
const hx = (b: Uint8Array) => Buffer.from(b).toString('hex');

const FEE = {
  operatorAddress: p2trAddress(pubSchnorr(randomPrivateKeyBytes()), pearlSimnet),
  network: pearlSimnet,
  bps: 20,
  minSat: 100n,
};

function config(): SwapClientConfig {
  return {
    networks: { base: pearlSimnet, quote: bitcoinSignet },
    bond: { bps: 150, minSat: 1_000n },
    quoteTiming: SIGNET_TIMING,
    baseTiming: PEARL_TIMING,
    fee: FEE,
    executorPolicy: { minConfs: 1, pollMs: 2, bumpAfterMs: 10_000, maxBumps: 2 },
  };
}

function keys() {
  const idPriv = randomPrivateKeyBytes();
  const swapPriv = randomPrivateKeyBytes();
  return { idPriv, idXonly: pubSchnorr(idPriv), swapPriv, swapXonly: pubSchnorr(swapPriv) };
}

async function waitUntil(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 3));
  }
}

describe('SwapClient — intent → match → handshake → settlement, one object per user', () => {
  it('two clients place crossing orders and settle the swap end-to-end', async () => {
    const btc = new ScriptedChainClient(bitcoinSignet, 'btc');
    const prl = new ScriptedChainClient(pearlSimnet, 'prl');
    btc.setHeight(100);
    prl.setHeight(100);

    const book = new OrderBook({ pairs: [PRL_BTC], minFeeBps: 10, now: () => 1000 });
    const relay = new RelayServer(book);

    const buyer = keys();
    const seller = keys();

    const mkClient = (k: ReturnType<typeof keys>) =>
      new SwapClient({
        connection: relay.connect(hx(k.idXonly)),
        identityPrivateKey: k.idPriv,
        swapPrivateKey: k.swapPriv,
        wallet: new ScriptedWallet([btc, prl], k.swapXonly),
        source: btc,
        dest: prl,
        bond: btc,
        store: new MemorySwapStore(),
        config: config(),
      });

    const buyerClient = mkClient(buyer); // becomes the taker (acquires PRL, pays BTC)
    const sellerClient = mkClient(seller); // becomes the maker (provides PRL)
    buyerClient.start();
    sellerClient.start();

    const order = {
      pair: PRL_BTC,
      amountSat: 1n * COIN,
      limitPriceSatPerUnit: 50_000n,
      feeBps: 20,
      expiry: 9_999_999_999,
    };
    sellerClient.placeOrder({ ...order, side: 'sell', nonce: 's1' }); // rests
    const buy = buyerClient.placeOrder({ ...order, side: 'buy', nonce: 'b1' }); // crosses
    expect(buy.matches).toHaveLength(1);

    await waitUntil(() => buyerClient.activeSwaps().length === 1 && sellerClient.activeSwaps().length === 1);
    const takerRec = await buyerClient.activeSwaps()[0].done;
    const makerRec = await sellerClient.activeSwaps()[0].done;

    expect(takerRec.role).toBe('taker');
    expect(makerRec.role).toBe('maker');
    expect(takerRec.phase).toBe('completed');
    expect(makerRec.phase).toBe('completed');

    // Both clients keyed the swap with the same deterministic id and derived identical terms.
    expect(buyerClient.activeSwaps()[0].id).toBe(sellerClient.activeSwaps()[0].id);
    expect(takerRec.params).toEqual(makerRec.params);
    expect(takerRec.params.operatorFee).toBeDefined(); // fee committed into the plan

    // Real settlement: the maker learned the taker's preimage on-chain.
    expect(makerRec.preimageHex).toBe(takerRec.preimageHex);
    expect(BigInt(takerRec.lockups.source!.amountSat)).toBe(50_000n); // BTC funded
    expect(BigInt(makerRec.lockups.dest!.amountSat)).toBe(COIN); // PRL funded
  });

  it('resume() reloads a persisted in-flight swap and drives it to completion', async () => {
    const btc = new ScriptedChainClient(bitcoinSignet, 'btc');
    const prl = new ScriptedChainClient(pearlSimnet, 'prl');
    btc.setHeight(100);
    prl.setHeight(100);

    const book = new OrderBook({ pairs: [PRL_BTC], minFeeBps: 10, now: () => 1000 });
    const relay = new RelayServer(book);
    const k = keys();
    const cp = keys(); // counterparty (only needed for the maker pubkey in the params)
    const store = new MemorySwapStore();
    const wallet = new ScriptedWallet([btc, prl], k.swapXonly);

    // Fabricate a matched swap's terms and persist a fresh taker record (as if the handshake
    // completed just before a crash), then pre-fund all three lockups on-chain.
    const fillBaseSat = 1n * COIN;
    const match: Match = {
      pair: PRL_BTC,
      buy: { makerPubkey: k.idXonly } as Match['buy'],
      sell: { makerPubkey: cp.idXonly } as Match['sell'],
      executionPriceSatPerUnit: 50_000n,
      fillBaseSat,
      fillQuoteSat: 50_000n,
      buyerPubHex: hx(k.idXonly),
      sellerPubHex: hx(cp.idXonly),
    };
    const timeouts = proposeTimeouts({
      heights: { quoteHeight: 100, baseHeight: 100 },
      quoteTiming: SIGNET_TIMING,
      baseTiming: PEARL_TIMING,
    });
    const { preimage, preimageHash } = (await import('../src/settlement/SwapTree.js')).makePreimage();
    const params = buildSwapParams({
      match,
      networks: { base: pearlSimnet, quote: bitcoinSignet },
      takerSwapPubHex: hx(pubECDSA(k.swapPriv, true)),
      makerSwapPubHex: hx(pubECDSA(cp.swapPriv, true)),
      preimageHashHex: hx(preimageHash),
      timeouts,
    });
    const amounts = deriveAmounts(match, { bps: 150, minSat: 1_000n });
    const record = newTakerRecord({ id: 'resume-swap', params, preimage, amounts });
    await store.save(record); // persisted, phase 'created'

    // The on-chain lockups already exist (source + bond funded by us, dest funded by the maker).
    const { buildSwapPlan } = await import('../src/settlement/SwapPlan.js');
    const { networkForTag } = await import('../src/common/index.js');
    const plan = buildSwapPlan({
      preimageHash,
      taker: { pub: pubECDSA(k.swapPriv, true) },
      maker: { pub: pubECDSA(cp.swapPriv, true) },
      sourceNetwork: networkForTag(params.sourceNetwork),
      destNetwork: networkForTag(params.destNetwork),
      bondNetwork: networkForTag(params.bondNetwork),
      sourceTimeoutHeight: params.sourceTimeoutHeight,
      destTimeoutHeight: params.destTimeoutHeight,
      bondForfeitHeight: params.bondForfeitHeight,
    });
    btc.injectLockup(plan.sourceLeg.address, { utxo: { txid: 'aa'.repeat(32), vout: 0 }, amountSat: 50_000, scriptPubKey: Buffer.from(plan.sourceLeg.outputScript) });
    btc.injectLockup(plan.optionBond.address, { utxo: { txid: 'bb'.repeat(32), vout: 0 }, amountSat: Number(amounts.bondSat), scriptPubKey: Buffer.from(plan.optionBond.outputScript) });
    prl.injectLockup(plan.destLeg.address, { utxo: { txid: 'cc'.repeat(32), vout: 0 }, amountSat: Number(COIN), scriptPubKey: Buffer.from(plan.destLeg.outputScript) });

    // A fresh client resumes the persisted swap and drives it home.
    const client = new SwapClient({
      connection: relay.connect(hx(k.idXonly)),
      identityPrivateKey: k.idPriv,
      swapPrivateKey: k.swapPriv,
      wallet,
      source: btc,
      dest: prl,
      bond: btc,
      store,
      config: config(),
    });
    const resumed = await client.resume();
    expect(resumed).toHaveLength(1);
    const rec = await resumed[0].done;
    expect(rec.phase).toBe('completed');
    // It adopted the existing lockups rather than re-funding (wallet never called).
    expect([...wallet.funded.values()].reduce((a, b) => a + b, 0)).toBe(0);
  });
});
