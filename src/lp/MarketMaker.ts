import type { SwapClient } from '../client/index.js';
import type { Pair } from '../coordination/index.js';
import type { Inventory, PricingPolicy } from './PricingPolicy.js';

/**
 * A third-party liquidity-provider daemon — the cold-start fix. It is an always-on SwapClient that
 * continuously posts fresh resting orders (from a PricingPolicy, sized to its inventory) so any
 * taker order crosses immediately, without the operator ever providing liquidity. The LP brings its
 * OWN capital (a funded wallet on both chains); the operator just relays.
 *
 * The LP is role-agnostic: when a taker BUYS base the LP's resting SELL fills and the LP is the
 * swap maker; when a taker SELLS base the LP's resting BUY fills and the LP is the swap taker. The
 * underlying SwapClient handles either role, so the daemon only has to keep quotes fresh and sized.
 *
 * This is the "others run the LP, not Roy" model: anyone runs this against the relay to earn the
 * spread, while the venue takes its fee — liquidity without the operator holding capital.
 */

export interface MarketMakerDeps {
  /** the LP's SwapClient (its identity, swap key, wallet, chain clients, relay connection). */
  client: SwapClient;
  pair: Pair;
  policy: PricingPolicy;
  /** current spendable inventory (e.g. read from the LP's wallet balances). */
  inventory: () => Inventory;
  /** operator fee (bps) committed in each order — must clear the relay's minimum. */
  feeBps: number;
  /** how long each posted order is valid (seconds). Refresh well within this. */
  orderTtlSec?: number;
  /** how often to re-post quotes (ms). */
  refreshMs?: number;
  /** unix-seconds clock (injectable for tests). */
  now?: () => number;
  log?: (msg: string) => void;
}

export class MarketMaker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private seq = 0;
  private readonly now: () => number;

  constructor(private readonly deps: MarketMakerDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Post one round of quotes now (sized to current inventory). Returns whether anything was posted. */
  quoteOnce(): boolean {
    const inv = this.deps.inventory();
    const orders = this.deps.policy.quotes(inv, this.deps.pair);
    const expiry = this.now() + (this.deps.orderTtlSec ?? 120);
    let posted = 0;
    for (const o of orders) {
      const res = this.deps.client.placeOrder({
        pair: this.deps.pair,
        side: o.side,
        amountSat: o.amountSat,
        limitPriceSatPerUnit: o.limitPriceSatPerUnit,
        feeBps: this.deps.feeBps,
        expiry,
        nonce: `mm-${this.seq++}`,
      });
      if (res.accepted) posted++;
      else this.deps.log?.(`quote rejected: ${res.reason}`);
    }
    this.deps.log?.(`posted ${posted} quote(s); inventory base=${inv.baseSat} quote=${inv.quoteSat}`);
    return posted > 0;
  }

  /** Start quoting and re-quoting on an interval (re-sizing as inventory changes after fills). */
  start(): void {
    this.quoteOnce();
    this.timer = setInterval(() => this.quoteOnce(), this.deps.refreshMs ?? 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
