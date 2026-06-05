import { describe, it, expect } from 'vitest';
import { pubSchnorr, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
import { MakerReputation, OrderBook, signIntent, type OrderIntent, type Pair } from '../src/coordination/index.js';

const PRL_BTC: Pair = { base: 'PRL', quote: 'BTC' };
const hx = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('MakerReputation — maker-grief mitigation (heuristic)', () => {
  it('allows new makers, blocks established griefers, recovers with good fills', () => {
    const rep = new MakerReputation({ minObservations: 5, maxGriefRate: 0.2 });
    const maker = 'abcd';

    expect(rep.allow(maker)).toBe(true); // unknown maker -> innocent until proven

    // Few observations: still allowed even if all griefs (not enough signal).
    rep.recordGrief(maker);
    rep.recordGrief(maker);
    expect(rep.allow(maker)).toBe(true);

    // Cross the observation threshold with a high grief rate -> blocked.
    rep.recordGrief(maker);
    rep.recordFunded(maker);
    rep.recordFunded(maker); // 5 matches, 3 griefs => 0.6 > 0.2
    expect(rep.stats(maker).griefRate).toBeCloseTo(0.6);
    expect(rep.allow(maker)).toBe(false);

    // A long run of good fills pulls the rate back under the threshold.
    for (let i = 0; i < 20; i++) rep.recordFunded(maker); // 25 matches, 3 griefs => 0.12
    expect(rep.allow(maker)).toBe(true);
  });

  it('OrderBook refuses orders from a maker the reputation gate blocks', () => {
    const rep = new MakerReputation({ minObservations: 1, maxGriefRate: 0 });
    const book = new OrderBook({ pairs: [PRL_BTC], minFeeBps: 10, now: () => 1000, allowMaker: (m) => rep.allow(m) });

    const priv = randomPrivateKeyBytes();
    const xonly = pubSchnorr(priv);
    const intent: OrderIntent = {
      makerPubkey: xonly,
      pair: PRL_BTC,
      side: 'sell',
      amountSat: 100_000_000n,
      limitPriceSatPerUnit: 50_000n,
      feeBps: 20,
      expiry: 2000,
      nonce: 'n1',
    };

    // Clean maker -> accepted.
    expect(book.submit(intent, signIntent(intent, priv)).accepted).toBe(true);

    // Flag the maker as a griefer, then a new order is refused on reputation.
    rep.recordGrief(hx(xonly));
    const intent2 = { ...intent, nonce: 'n2' };
    expect(book.submit(intent2, signIntent(intent2, priv))).toMatchObject({
      accepted: false,
      reason: 'maker reputation',
    });
  });
});
