import { COIN } from '../coordination/index.js';
import type { Pair, Side } from '../coordination/index.js';

/** An order the policy wants resting on the book. */
export interface DesiredOrder {
  side: Side;
  amountSat: bigint;
  limitPriceSatPerUnit: bigint;
}

/**
 * How a market maker prices. Given current inventory it returns the resting orders it wants on the
 * book. The MarketMaker (MarketMaker.ts) takes care of posting/refreshing them and of which role
 * each fill puts the LP in. Prices are quote-sats per one whole base coin (see OrderBook).
 */

export interface Inventory {
  /** base-asset (e.g. PRL) the LP can sell, in sats. */
  baseSat: bigint;
  /** quote-asset (e.g. BTC) the LP can spend to buy base, in sats. */
  quoteSat: bigint;
}

export interface PricingPolicy {
  quotes(inventory: Inventory, pair: Pair): DesiredOrder[];
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * A symmetric two-sided quote around a reference price: sell base at `ref*(1+spread)`, buy base at
 * `ref*(1-spread)`, each up to `sizeBaseSat` and capped by what inventory can actually back (you
 * can only sell base you hold, and only buy as much base as your quote balance covers at the bid).
 * The spread is what pays for the free-option bond cost + the operator fee + the LP's margin.
 */
export class SpreadPolicy implements PricingPolicy {
  constructor(
    private readonly cfg: {
      refPriceSatPerUnit: bigint;
      spreadBps: number;
      /** target order size per side, in base sats. */
      sizeBaseSat: bigint;
    },
  ) {}

  quotes(inv: Inventory): DesiredOrder[] {
    const s = BigInt(this.cfg.spreadBps);
    const ask = (this.cfg.refPriceSatPerUnit * (10_000n + s)) / 10_000n;
    const bid = (this.cfg.refPriceSatPerUnit * (10_000n - s)) / 10_000n;
    const out: DesiredOrder[] = [];

    // Sell base for quote — limited by base inventory.
    const sellSize = min(this.cfg.sizeBaseSat, inv.baseSat);
    if (sellSize > 0n) out.push({ side: 'sell', amountSat: sellSize, limitPriceSatPerUnit: ask });

    // Buy base with quote — limited by how much base the quote balance covers at the bid.
    const buyCap = bid > 0n ? (inv.quoteSat * COIN) / bid : 0n;
    const buySize = min(this.cfg.sizeBaseSat, buyCap);
    if (buySize > 0n) out.push({ side: 'buy', amountSat: buySize, limitPriceSatPerUnit: bid });

    return out;
  }
}
