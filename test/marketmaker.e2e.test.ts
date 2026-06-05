import { describe, it, expect } from 'vitest';
import { pubSchnorr, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
import { bitcoinSignet, pearlSimnet } from '../src/common/index.js';
import { PEARL_TIMING, SIGNET_TIMING } from '../src/settlement/index.js';
import { OrderBook, RelayServer, MemorySwapStore, type Pair } from '../src/coordination/index.js';
import { SwapClient, ReferenceWallet, type SwapClientConfig } from '../src/client/index.js';
import { MarketMaker, SpreadPolicy } from '../src/lp/index.js';
import { ScriptedChainClient } from './helpers/ScriptedChain.js';

const PRL_BTC: Pair = { base: 'PRL', quote: 'BTC' };
const COIN = 100_000_000n;
const hx = (b: Uint8Array) => Buffer.from(b).toString('hex');

function config(): SwapClientConfig {
  return {
    networks: { base: pearlSimnet, quote: bitcoinSignet },
    bond: { bps: 150, minSat: 1_000n },
    quoteTiming: SIGNET_TIMING,
    baseTiming: PEARL_TIMING,
    executorPolicy: { minConfs: 1, pollMs: 2, bumpAfterMs: 10_000, maxBumps: 2 },
  };
}
function keys() {
  const id = randomPrivateKeyBytes();
  const swap = randomPrivateKeyBytes();
  return { id, idXonly: pubSchnorr(id), swap, swapXonly: pubSchnorr(swap) };
}
async function waitUntil(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 3));
  }
}

describe('MarketMaker — LP provides liquidity so a lone taker fills', () => {
  it('a taker buys against the LP with no human counterparty, and the swap settles', async () => {
    const btc = new ScriptedChainClient(bitcoinSignet, 'btc');
    const prl = new ScriptedChainClient(pearlSimnet, 'prl');
    btc.setHeight(100);
    prl.setHeight(100);

    const relay = new RelayServer(new OrderBook({ pairs: [PRL_BTC], minFeeBps: 10, now: () => 1000 }));

    // The LP: its own capital (PRL to sell, BTC to buy with) and an auto-quoting daemon.
    const lp = keys();
    const lpWallet = new ReferenceWallet({ walletPrivateKey: lp.swap, clients: [btc, prl] });
    lpWallet.addUtxo(pearlSimnet, { txid: '0a'.repeat(32), vout: 0, amountSat: 10n * COIN }); // 10 PRL
    lpWallet.addUtxo(bitcoinSignet, { txid: '0b'.repeat(32), vout: 0, amountSat: COIN }); // 1 "BTC"
    const lpClient = new SwapClient({
      connection: relay.connect(hx(lp.idXonly)),
      identityPrivateKey: lp.id,
      swapPrivateKey: lp.swap,
      wallet: lpWallet,
      source: btc,
      dest: prl,
      bond: btc,
      store: new MemorySwapStore(),
      config: config(),
    });
    lpClient.start();

    const mm = new MarketMaker({
      client: lpClient,
      pair: PRL_BTC,
      policy: new SpreadPolicy({ refPriceSatPerUnit: 50_000n, spreadBps: 100, sizeBaseSat: 5n * COIN }),
      inventory: () => ({ baseSat: lpWallet.balance(pearlSimnet), quoteSat: lpWallet.balance(bitcoinSignet) }),
      feeBps: 20,
      now: () => 1000,
    });

    // The taker: only BTC (it will buy PRL, funding the source leg in BTC).
    const taker = keys();
    const takerWallet = new ReferenceWallet({ walletPrivateKey: taker.swap, clients: [btc, prl] });
    takerWallet.addUtxo(bitcoinSignet, { txid: '0c'.repeat(32), vout: 0, amountSat: COIN });
    const takerClient = new SwapClient({
      connection: relay.connect(hx(taker.idXonly)),
      identityPrivateKey: taker.id,
      swapPrivateKey: taker.swap,
      wallet: takerWallet,
      source: btc,
      dest: prl,
      bond: btc,
      store: new MemorySwapStore(),
      config: config(),
    });
    takerClient.start();

    try {
      // LP posts two-sided quotes; the taker then buys 1 PRL above the LP's ask -> crosses.
      mm.start();
      expect(lpClient).toBeDefined();
      takerClient.placeOrder({
        pair: PRL_BTC,
        side: 'buy',
        amountSat: COIN, // 1 PRL
        limitPriceSatPerUnit: 51_000n, // >= LP ask (50_500)
        feeBps: 20,
        expiry: 9_999_999_999,
        nonce: 'taker-buy',
      });

      await waitUntil(() => takerClient.activeSwaps().length === 1 && lpClient.activeSwaps().length === 1, 8000);
      const takerRec = await takerClient.activeSwaps()[0].done;
      const lpRec = await lpClient.activeSwaps()[0].done;

      expect(takerRec.phase).toBe('completed');
      expect(lpRec.phase).toBe('completed');
      expect(takerRec.role).toBe('taker');
      expect(lpRec.role).toBe('maker'); // taker bought -> LP's resting sell filled -> LP is the maker
      expect(lpRec.preimageHex).toBe(takerRec.preimageHex);

      // Inventory moved: the LP sold ~1 PRL and gained the quote.
      expect(lpWallet.balance(pearlSimnet)).toBeLessThan(10n * COIN);
    } finally {
      mm.stop();
    }
  }, 20_000);
});
