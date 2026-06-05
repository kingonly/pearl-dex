import { describe, it, expect } from 'vitest';
import { pubSchnorr, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
import {
  OrderBook,
  RelayServer,
  signIntent,
  type MarketEvent,
  type OrderIntent,
  type Pair,
  type Side,
} from '../src/coordination/index.js';

const PRL_BTC: Pair = { base: 'PRL', quote: 'BTC' };
const COIN = 100_000_000n;

function trader() {
  const priv = randomPrivateKeyBytes();
  return { priv, xonly: pubSchnorr(priv) };
}
let n = 0;
function order(t: ReturnType<typeof trader>, side: Side, coins: number, price: number): [OrderIntent, Uint8Array] {
  const intent: OrderIntent = {
    makerPubkey: t.xonly,
    pair: PRL_BTC,
    side,
    amountSat: BigInt(coins) * COIN,
    limitPriceSatPerUnit: BigInt(price),
    feeBps: 20,
    expiry: 9_999_999_999,
    nonce: `n${n++}`,
  };
  return [intent, signIntent(intent, t.priv)];
}

describe('market-data feed', () => {
  it('pushes an initial snapshot, updates the book, and prints trades', () => {
    const relay = new RelayServer(new OrderBook({ pairs: [PRL_BTC], minFeeBps: 10, now: () => 1000 }));
    const events: MarketEvent[] = [];
    const unsub = relay.subscribeMarketData((e) => events.push(e));

    // Immediate snapshot on subscribe (empty book).
    expect(events[0]).toMatchObject({ type: 'snapshot' });
    expect(events[0].type === 'snapshot' && events[0].books[0].asks).toEqual([]);

    // An LP rests a sell -> a fresh snapshot with one ask level.
    const lp = trader();
    relay.connect(Buffer.from(lp.xonly).toString('hex')).submit(...order(lp, 'sell', 5, 50_500));
    const lastSnap = [...events].reverse().find((e) => e.type === 'snapshot');
    expect(lastSnap?.type === 'snapshot' && lastSnap.books[0].asks).toEqual([
      { priceSatPerUnit: '50500', baseSat: (5n * COIN).toString() },
    ]);

    // A taker buys 2 -> a trade prints at the resting price, and the ask shrinks to 3.
    const taker = trader();
    events.length = 0;
    relay.connect(Buffer.from(taker.xonly).toString('hex')).submit(...order(taker, 'buy', 2, 51_000));
    const trade = events.find((e) => e.type === 'trade');
    expect(trade).toMatchObject({ type: 'trade', priceSatPerUnit: '50500', baseSat: (2n * COIN).toString() });
    const snap = [...events].reverse().find((e) => e.type === 'snapshot');
    expect(snap?.type === 'snapshot' && snap.books[0].asks).toEqual([
      { priceSatPerUnit: '50500', baseSat: (3n * COIN).toString() },
    ]);

    unsub();
  });
});
