import { describe, it, expect } from 'vitest';
import { pubECDSA, pubSchnorr, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
import { bitcoinSignet, pearlSimnet } from '../src/common/index.js';
import { makePreimage } from '../src/settlement/SwapTree.js';
import { PEARL_TIMING, SIGNET_TIMING } from '../src/settlement/index.js';
import {
  OrderBook,
  RelayServer,
  signIntent,
  buildSwapParams,
  deriveAmounts,
  proposeTimeouts,
  validateProposedTimeouts,
  newTakerRecord,
  newMakerRecord,
  SwapExecutor,
  MemorySwapStore,
  type OrderIntent,
  type Pair,
  type Side,
  type ServerMessage,
  type Match,
  type SwapParamsJSON,
  type SwapRecord,
  type HandshakeMessage,
} from '../src/coordination/index.js';
import { ScriptedChainClient } from './helpers/ScriptedChain.js';
import { ScriptedWallet } from './helpers/ScriptedWallet.js';
import { LocalSigner } from '../src/signer/index.js';

// Full pipe: two parties post crossing signed intents -> the relay matches them -> they run the
// settlement handshake THROUGH the relay -> both derive identical swap terms -> their SwapExecutors
// settle the atomic swap end-to-end. The relay never holds funds, keys, or the secret.

const PRL_BTC: Pair = { base: 'PRL', quote: 'BTC' };
const COIN = 100_000_000n;
const NETWORKS = { base: pearlSimnet, quote: bitcoinSignet };
const BOND = { bps: 150, minSat: 1_000n };
const FAST = { minConfs: 1, pollMs: 2, bumpAfterMs: 10_000, maxBumps: 2 };
const hx = (b: Uint8Array) => Buffer.from(b).toString('hex');

function party() {
  const idPriv = randomPrivateKeyBytes();
  const swapPriv = randomPrivateKeyBytes();
  return {
    idPriv,
    idXonly: pubSchnorr(idPriv),
    swapPriv,
    swapPub: pubECDSA(swapPriv, true),
    swapXonly: pubSchnorr(swapPriv),
  };
}

let nonce = 0;
function intent(idXonly: Uint8Array, side: Side, amountCoins: number, priceSat: number): OrderIntent {
  return {
    makerPubkey: idXonly,
    pair: PRL_BTC,
    side,
    amountSat: BigInt(amountCoins) * COIN,
    limitPriceSatPerUnit: BigInt(priceSat),
    feeBps: 20,
    expiry: 9_999_999_999,
    nonce: `n${nonce++}`,
  };
}

// Minimal Match reconstruction from the wire economics (all that the handshake needs).
function matchFromWire(sm: ServerMessage & { type: 'match' }): Match {
  return {
    pair: sm.match.pair,
    buy: { makerPubkey: new Uint8Array(32) } as Match['buy'],
    sell: { makerPubkey: new Uint8Array(32) } as Match['sell'],
    executionPriceSatPerUnit: BigInt(sm.match.executionPriceSatPerUnit),
    fillBaseSat: BigInt(sm.match.fillBaseSat),
    fillQuoteSat: BigInt(sm.match.fillQuoteSat),
    buyerPubHex: sm.match.buyerPubHex,
    sellerPubHex: sm.match.sellerPubHex,
  };
}

describe('Relay E2E — intent → match → handshake → settlement', () => {
  it('matches crossing intents and settles the swap, both sides deriving identical terms', async () => {
    const btc = new ScriptedChainClient(bitcoinSignet, 'btc');
    const prl = new ScriptedChainClient(pearlSimnet, 'prl');
    btc.setHeight(100);
    prl.setHeight(100);

    const book = new OrderBook({ pairs: [PRL_BTC], minFeeBps: 10, now: () => 1000 });
    const relay = new RelayServer(book);

    const buyer = party(); // taker (acquires PRL, pays BTC)
    const seller = party(); // maker (provides PRL)

    const made: Record<'taker' | 'maker', { params?: SwapParamsJSON; done?: Promise<SwapRecord> }> = {
      taker: {},
      maker: {},
    };

    function wire(p: ReturnType<typeof party>) {
      const conn = relay.connect(hx(p.idXonly));
      const wallet = new ScriptedWallet([btc, prl], p.swapXonly);
      const store = new MemorySwapStore();
      const deps = () => ({
        store,
        source: btc,
        dest: prl,
        bond: btc,
        wallet,
        swapSigner: new LocalSigner(p.swapPriv),
        policy: FAST,
      });
      let preimage: ReturnType<typeof makePreimage> | undefined;
      let match: Match | undefined;
      let counterparty = '';

      conn.onMessage(async (m) => {
        if (m.type === 'match') {
          match = matchFromWire(m);
          counterparty = m.counterparty;
          if (m.role === 'taker') {
            preimage = makePreimage();
            // Let both 'match' messages land before initiating the handshake.
            await Promise.resolve();
            const msg: HandshakeMessage = {
              type: 'taker_init',
              swapPubHex: hx(p.swapPub),
              preimageHashHex: hx(preimage.preimageHash),
            };
            conn.sendTo(counterparty, msg);
          }
          return;
        }
        // m.type === 'peer'
        const payload = m.payload as HandshakeMessage;
        const heights = { quoteHeight: await btc.getBlockHeight(), baseHeight: await prl.getBlockHeight() };

        if (payload.type === 'taker_init') {
          // maker side: propose timeouts, ack, then settle.
          const timeouts = proposeTimeouts({ heights, quoteTiming: SIGNET_TIMING, baseTiming: PEARL_TIMING });
          const ack: HandshakeMessage = { type: 'maker_ack', swapPubHex: hx(p.swapPub), timeouts };
          conn.sendTo(m.from, ack);
          const params = buildSwapParams({
            match: match!,
            networks: NETWORKS,
            takerSwapPubHex: payload.swapPubHex,
            makerSwapPubHex: hx(p.swapPub),
            preimageHashHex: payload.preimageHashHex,
            timeouts,
          });
          const amounts = deriveAmounts(match!, BOND);
          made.maker.params = params;
          made.maker.done = new SwapExecutor(newMakerRecord({ id: 'swap', params, amounts }), deps()).run();
        } else if (payload.type === 'maker_ack') {
          // taker side: validate the proposed timeouts, then settle.
          validateProposedTimeouts({ heights, quoteTiming: SIGNET_TIMING, baseTiming: PEARL_TIMING, timeouts: payload.timeouts });
          const params = buildSwapParams({
            match: match!,
            networks: NETWORKS,
            takerSwapPubHex: hx(p.swapPub),
            makerSwapPubHex: payload.swapPubHex,
            preimageHashHex: hx(preimage!.preimageHash),
            timeouts: payload.timeouts,
          });
          const amounts = deriveAmounts(match!, BOND);
          made.taker.params = params;
          made.taker.done = new SwapExecutor(
            newTakerRecord({ id: 'swap', params, preimage: preimage!.preimage, amounts }),
            deps(),
          ).run();
        }
      });
      return conn;
    }

    const buyerConn = wire(buyer);
    const sellerConn = wire(seller);

    // Seller rests a sell; buyer crosses it -> match -> handshake -> settlement kicks off. Submit
    // through the handler-bearing connections so the match notifications reach the wired handlers.
    const sellOrder = intent(seller.idXonly, 'sell', 1, 50_000);
    const sellSubmit = sellerConn.submit(sellOrder, signIntent(sellOrder, seller.idPriv));
    expect(sellSubmit.matches).toHaveLength(0);
    const buyOrder = intent(buyer.idXonly, 'buy', 1, 50_000);
    const buySubmit = buyerConn.submit(buyOrder, signIntent(buyOrder, buyer.idPriv));
    expect(buySubmit.matches).toHaveLength(1);

    // Wait for both executors to be launched by the async handshake, then for them to finish.
    await waitUntil(() => made.taker.done !== undefined && made.maker.done !== undefined);
    const [takerRec, makerRec] = await Promise.all([made.taker.done!, made.maker.done!]);

    expect(takerRec.phase).toBe('completed');
    expect(makerRec.phase).toBe('completed');

    // The crux: both sides independently derived the SAME on-chain terms.
    expect(made.taker.params).toEqual(made.maker.params);
    // The maker learned the taker's preimage on-chain (proves real settlement, not just agreement).
    expect(makerRec.preimageHex).toBe(takerRec.preimageHex);

    // Economics flowed through: taker funds 50_000 BTC-sats (source), maker funds 1 PRL (dest).
    expect(takerRec.lockups.source && BigInt(takerRec.lockups.source.amountSat)).toBe(50_000n);
    expect(makerRec.lockups.dest && BigInt(makerRec.lockups.dest.amountSat)).toBe(COIN);

    // Sanity: distinct identities, real handshake over the relay.
    expect(buyerConn.id).not.toBe(hx(seller.idXonly));
  });

  it('rejects an intent whose identity does not match the connection', () => {
    const book = new OrderBook({ pairs: [PRL_BTC], minFeeBps: 10, now: () => 1000 });
    const relay = new RelayServer(book);
    const a = party();
    const b = party();
    const conn = relay.connect(hx(a.idXonly));
    const foreign = intent(b.idXonly, 'buy', 1, 50_000); // signed by b, submitted on a's connection
    const res = conn.submit(foreign, signIntent(foreign, b.idPriv));
    expect(res).toMatchObject({ accepted: false });
  });
});

async function waitUntil(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 3));
  }
}
