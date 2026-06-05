import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pubECDSA, pubSchnorr, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
import { pearlSimnet, pearlTestnet } from '../src/common/index.js';
import { PearlClient, PEARL_TIMING } from '../src/settlement/index.js';
import { OrderBook, RelayServer, MemorySwapStore, type Pair } from '../src/coordination/index.js';
import { SwapClient, ReferenceWallet } from '../src/client/index.js';
import { LocalSigner } from '../src/signer/index.js';

/**
 * LIVE on-chain proof of the whole pipe against two real pearld simnet nodes (real RPC, real
 * transactions). It's a genuine cross-chain swap: node1 plays the quote/"BTC" chain (labelled
 * pearlSimnet) and node2 the base/"PRL" chain (labelled pearlTestnet). The taproot bytes are
 * HRP-independent, so two simnet nodes give two distinct, independently-mined ledgers — and both
 * are mintable, sidestepping the unfunded signet faucet. Skips unless both nodes are reachable.
 */

const USER = 'prlswap';
const PASS = 'a4d93591317c9e77675808261f26141e';
const PRL_BTC: Pair = { base: 'PRL', quote: 'BTC' };
const COIN = 100_000_000n;
const hx = (b: Uint8Array) => Buffer.from(b).toString('hex');

const keyJson = JSON.parse(
  readFileSync(join(homedir(), 'pearl-swap', 'backends', 'prl-simnet-key.json'), 'utf8'),
) as { privHex: string };
const daemonPriv = Buffer.from(keyJson.privHex, 'hex');

const node1 = new PearlClient(
  { host: '127.0.0.1', port: 48557, user: USER, pass: PASS, scanLookback: 3 },
  pearlSimnet,
  'node1',
);
const node2 = new PearlClient(
  { host: '127.0.0.1', port: 48567, user: USER, pass: PASS, scanLookback: 3 },
  pearlTestnet,
  'node2',
);

let online = false;
try {
  online = (await node1.getBlockHeight()) > 0 && (await node2.getBlockHeight()) > 0;
} catch {
  online = false;
}

function party() {
  const id = randomPrivateKeyBytes();
  const swap = randomPrivateKeyBytes();
  return { id, idXonly: pubSchnorr(id), swap, swapXonly: pubSchnorr(swap), swapPub: pubECDSA(swap, true) };
}

/** First unspent mature coinbase paying the daemon mining address on a node. */
async function findUnspentCoinbase(client: PearlClient) {
  for (let h = 1; h <= 199; h++) {
    const cb = await client.coinbaseUtxoAt(h);
    if (await client.getTxOut(cb.txid, cb.vout)) return cb;
  }
  throw new Error('no unspent mature coinbase');
}

describe.skipIf(!online)('LIVE: two-pearld-node cross-chain swap via the full pipe', () => {
  it('two clients post crossing orders and settle on-chain', async () => {
    const book = new OrderBook({ pairs: [PRL_BTC], minFeeBps: 10 });
    const relay = new RelayServer(book);
    const buyer = party();
    const seller = party();

    // Seed each party's wallet from a real coinbase on the chain it funds.
    const cb1 = await findUnspentCoinbase(node1); // taker funds source+bond here (node1)
    const cb2 = await findUnspentCoinbase(node2); // maker funds dest here (node2)

    const takerWallet = new ReferenceWallet({ walletPrivateKey: daemonPriv, clients: [node1, node2], approxVbytes: 300 });
    takerWallet.addUtxo(pearlSimnet, { txid: cb1.txid, vout: cb1.vout, amountSat: cb1.amountSat });
    const makerWallet = new ReferenceWallet({ walletPrivateKey: daemonPriv, clients: [node1, node2], approxVbytes: 300 });
    makerWallet.addUtxo(pearlTestnet, { txid: cb2.txid, vout: cb2.vout, amountSat: cb2.amountSat });

    const config = {
      networks: { base: pearlTestnet, quote: pearlSimnet },
      bond: { bps: 150, minSat: 1_000_000n }, // >> on-chain fee, so the small bond still nets out
      quoteTiming: PEARL_TIMING,
      baseTiming: PEARL_TIMING,
      // huge refund windows so on-demand mining never reaches a timeout during the happy path.
      shortRefundSeconds: 1_000_000,
      marginSeconds: 1_000_000,
      executorPolicy: { minConfs: 1, pollMs: 400, bumpAfterMs: 20_000, maxBumps: 2, approxVbytes: 300 },
    };

    const mkClient = (p: ReturnType<typeof party>, wallet: ReferenceWallet) =>
      new SwapClient({
        connection: relay.connect(hx(p.idXonly)),
        identityPrivateKey: p.id,
        swapSigner: new LocalSigner(p.swap),
        wallet,
        source: node1,
        dest: node2,
        bond: node1,
        store: new MemorySwapStore(),
        config,
        log: (m) => console.log(m),
      });

    const buyerClient = mkClient(buyer, takerWallet);
    const sellerClient = mkClient(seller, makerWallet);
    buyerClient.start();
    sellerClient.start();

    // Mine both chains so broadcasts confirm and lockups gain confirmations.
    const miner = setInterval(() => {
      void node1.generate(1).catch(() => {});
      void node2.generate(1).catch(() => {});
    }, 500);

    try {
      // 1 PRL (dest) for 0.05 "BTC" (source); amounts kept well above on-chain fees.
      const order = { pair: PRL_BTC, amountSat: COIN, limitPriceSatPerUnit: 5_000_000n, feeBps: 20, expiry: 9_999_999_999 };
      sellerClient.placeOrder({ ...order, side: 'sell', nonce: 'sell-1' });
      const buy = buyerClient.placeOrder({ ...order, side: 'buy', nonce: 'buy-1' });
      expect(buy.matches).toHaveLength(1);

      await waitUntil(() => buyerClient.activeSwaps().length === 1 && sellerClient.activeSwaps().length === 1, 30_000);
      const takerRec = await Promise.race([buyerClient.activeSwaps()[0].done, timeout(150_000, 'taker')]);
      const makerRec = await Promise.race([sellerClient.activeSwaps()[0].done, timeout(150_000, 'maker')]);

      expect(takerRec.phase).toBe('completed');
      expect(makerRec.phase).toBe('completed');
      expect(makerRec.preimageHex).toBe(takerRec.preimageHex); // maker learned the secret on-chain
      console.log('LIVE SWAP COMPLETE', {
        taker: takerRec.phase,
        maker: makerRec.phase,
        sourceClaim: makerRec.txids['source_claim'],
        destClaim: takerRec.txids['dest_claim'],
        bondReclaim: takerRec.txids['bond_reclaim'],
      });
    } finally {
      clearInterval(miner);
    }
  }, 200_000);
});

async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}
function timeout(ms: number, who: string): Promise<never> {
  return new Promise((_, rej) => setTimeout(() => rej(new Error(`${who} swap timed out after ${ms}ms`)), ms));
}
