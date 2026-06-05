import { describe, it, expect, afterAll } from 'vitest';
import { pubSchnorr, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
import { bitcoinSignet, pearlSimnet } from '../src/common/index.js';
import { PEARL_TIMING, SIGNET_TIMING } from '../src/settlement/index.js';
import {
  OrderBook,
  RelayServer,
  WsRelayServer,
  connectWsRelay,
  MemorySwapStore,
  type Pair,
} from '../src/coordination/index.js';
import { SwapClient, type SwapClientConfig } from '../src/client/index.js';
import { ScriptedChainClient } from './helpers/ScriptedChain.js';
import { ScriptedWallet } from './helpers/ScriptedWallet.js';

const PRL_BTC: Pair = { base: 'PRL', quote: 'BTC' };
const COIN = 100_000_000n;
const hx = (b: Uint8Array) => Buffer.from(b).toString('hex');

const servers: WsRelayServer[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
});

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await sleep(3);
  }
}

describe('WsRelayServer — settlement over a real WebSocket transport', () => {
  it('two clients connect over ws, post crossing orders, and settle the swap', async () => {
    const btc = new ScriptedChainClient(bitcoinSignet, 'btc');
    const prl = new ScriptedChainClient(pearlSimnet, 'prl');
    btc.setHeight(100);
    prl.setHeight(100);

    const server = await WsRelayServer.start(new RelayServer(new OrderBook({ pairs: [PRL_BTC], minFeeBps: 10, now: () => 1000 })));
    servers.push(server);

    const buyer = keys();
    const seller = keys();
    const buyerConn = await connectWsRelay(server.url, hx(buyer.idXonly));
    const sellerConn = await connectWsRelay(server.url, hx(seller.idXonly));

    const mk = (k: ReturnType<typeof keys>, conn: Awaited<ReturnType<typeof connectWsRelay>>) =>
      new SwapClient({
        connection: conn,
        identityPrivateKey: k.id,
        swapPrivateKey: k.swap,
        wallet: new ScriptedWallet([btc, prl], k.swapXonly),
        source: btc,
        dest: prl,
        bond: btc,
        store: new MemorySwapStore(),
        config: config(),
      });

    const buyerClient = mk(buyer, buyerConn);
    const sellerClient = mk(seller, sellerConn);
    buyerClient.start();
    sellerClient.start();

    const order = { pair: PRL_BTC, amountSat: COIN, limitPriceSatPerUnit: 50_000n, feeBps: 20, expiry: 9_999_999_999 };
    sellerClient.placeOrder({ ...order, side: 'sell', nonce: 'sell-1' });
    await sleep(80); // let the resting sell book before the buy crosses (separate sockets)
    buyerClient.placeOrder({ ...order, side: 'buy', nonce: 'buy-1' });

    await waitUntil(() => buyerClient.activeSwaps().length === 1 && sellerClient.activeSwaps().length === 1, 8000);
    const takerRec = await buyerClient.activeSwaps()[0].done;
    const makerRec = await sellerClient.activeSwaps()[0].done;

    expect(takerRec.phase).toBe('completed');
    expect(makerRec.phase).toBe('completed');
    expect(takerRec.params).toEqual(makerRec.params); // identical terms negotiated over the wire
    expect(makerRec.preimageHex).toBe(takerRec.preimageHex);

    buyerConn.close();
    sellerConn.close();
  }, 20_000);
});
