import { describe, it, expect } from 'vitest';
import { pubSchnorr, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
import { OrderBook, signIntent, type OrderIntent, type Pair, type Side } from '../src/coordination/index.js';

const PRL_BTC: Pair = { base: 'PRL', quote: 'BTC' };
const NOW = 1000;
const COIN = 100_000_000n;

function trader() {
  const priv = randomPrivateKeyBytes();
  return { priv, xonly: pubSchnorr(priv) };
}

let nonce = 0;
function order(
  t: { priv: Uint8Array; xonly: Uint8Array },
  side: Side,
  amountCoins: number,
  priceSat: number,
  opts: Partial<OrderIntent> = {},
): { intent: OrderIntent; sig: Uint8Array } {
  const intent: OrderIntent = {
    makerPubkey: t.xonly,
    pair: PRL_BTC,
    side,
    amountSat: BigInt(amountCoins) * COIN,
    limitPriceSatPerUnit: BigInt(priceSat),
    feeBps: 20,
    expiry: NOW + 1000,
    nonce: `n${nonce++}`,
    ...opts,
  };
  return { intent, sig: signIntent(intent, t.priv) };
}

function book() {
  return new OrderBook({ pairs: [PRL_BTC], minFeeBps: 10, now: () => NOW });
}

describe('OrderBook — crossing matcher', () => {
  it('crosses a buy against a resting sell at the resting price', () => {
    const b = book();
    const seller = trader();
    const buyer = trader();

    const rest = b.submit(...sargs(order(seller, 'sell', 1, 50_000)));
    expect(rest).toMatchObject({ accepted: true });
    expect(rest.matches).toHaveLength(0); // just rests

    const cross = b.submit(...sargs(order(buyer, 'buy', 1, 50_000)));
    expect(cross.matches).toHaveLength(1);
    const m = cross.matches[0];
    expect(m.executionPriceSatPerUnit).toBe(50_000n);
    expect(m.fillBaseSat).toBe(COIN);
    expect(m.fillQuoteSat).toBe(50_000n); // 1 PRL * 50_000 / COIN
    expect(m.buyerPubHex).toBe(Buffer.from(buyer.xonly).toString('hex'));
    expect(m.sellerPubHex).toBe(Buffer.from(seller.xonly).toString('hex'));
  });

  it('honors price-time priority: best ask first, earliest seq to break ties', () => {
    const b = book();
    const s1 = trader();
    const s2 = trader();
    const buyer = trader();
    b.submit(...sargs(order(s1, 'sell', 1, 50_000))); // worse ask, earlier
    b.submit(...sargs(order(s2, 'sell', 1, 49_000))); // better ask

    // Buy 2 PRL @ 50_000 -> fills the 49_000 ask first, then the 50_000 ask.
    const r = b.submit(...sargs(order(buyer, 'buy', 2, 50_000)));
    expect(r.matches.map((m) => m.executionPriceSatPerUnit)).toEqual([49_000n, 50_000n]);
    expect(r.matches.every((m) => m.fillBaseSat === COIN)).toBe(true);
  });

  it('partially fills and rests the remainder', () => {
    const b = book();
    const seller = trader();
    const buyer = trader();
    b.submit(...sargs(order(seller, 'sell', 1, 50_000)));
    const r = b.submit(...sargs(order(buyer, 'buy', 3, 50_000)));
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].fillBaseSat).toBe(COIN);
    const restingBuys = b.resting(PRL_BTC, 'buy');
    expect(restingBuys).toHaveLength(1);
    expect(restingBuys[0].remainingSat).toBe(2n * COIN); // 3 - 1 left
  });

  it('does not cross when the spread is open', () => {
    const b = book();
    b.submit(...sargs(order(trader(), 'sell', 1, 50_000)));
    const r = b.submit(...sargs(order(trader(), 'buy', 1, 49_000)));
    expect(r.matches).toHaveLength(0);
    expect(r.accepted).toBe(true);
  });

  it('never self-matches the same identity', () => {
    const b = book();
    const t = trader();
    b.submit(...sargs(order(t, 'sell', 1, 50_000)));
    const r = b.submit(...sargs(order(t, 'buy', 1, 50_000)));
    expect(r.matches).toHaveLength(0); // skipped despite crossing prices
  });

  it('rejects bad signatures, expiry, low fees, and unsupported pairs', () => {
    const b = book();
    const t = trader();

    const tampered = order(t, 'buy', 1, 50_000);
    tampered.sig[0] ^= 0xff;
    expect(b.submit(tampered.intent, tampered.sig)).toMatchObject({ accepted: false, reason: 'bad signature' });

    expect(b.submit(...sargs(order(t, 'buy', 1, 50_000, { expiry: NOW - 1 })))).toMatchObject({
      accepted: false,
      reason: 'expired',
    });

    expect(b.submit(...sargs(order(t, 'buy', 1, 50_000, { feeBps: 5 })))).toMatchObject({
      accepted: false,
    });

    const wrongPair = order(t, 'buy', 1, 50_000, { pair: { base: 'XYZ', quote: 'BTC' } });
    expect(b.submit(wrongPair.intent, wrongPair.sig)).toMatchObject({
      accepted: false,
      reason: 'unsupported pair',
    });
  });
});

// helper: spread an {intent, sig} into submit() args
function sargs(o: { intent: OrderIntent; sig: Uint8Array }): [OrderIntent, Uint8Array] {
  return [o.intent, o.sig];
}
