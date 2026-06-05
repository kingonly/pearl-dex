import { verifyIntent, type OrderIntent, type Pair, type Side } from './types.js';

/**
 * The operator-side order book + crossing matcher (DESIGN.md §6). Orders are SIGNED INTENTS, never
 * deposits: the book verifies each intent's signature, expiry, and fee commitment, then crosses
 * opposite-side intents by price-time priority. Matching is pure bookkeeping — the operator
 * custodies nothing and is never a counterparty. A produced `Match` carries exactly the terms two
 * parties need to settle via the atomic swap (see Handshake.ts → SwapExecutor).
 *
 * Price convention: `limitPriceSatPerUnit` is QUOTE sats per ONE WHOLE BASE COIN (COIN = 1e8 base
 * sats). So for the PRL/BTC pair a price of 50_000 means "50,000 BTC-sats per 1 PRL".
 */

export const COIN = 100_000_000n;

/** A resting order: the signed intent plus its unfilled remainder and arrival sequence. */
export interface BookedOrder {
  intent: OrderIntent;
  sig: Uint8Array;
  /** unfilled base-asset amount (sats); a partial fill leaves the rest resting. */
  remainingSat: bigint;
  /** arrival order, for time priority within a price level. */
  seq: number;
}

/** A crossing of a buy and a sell into one settleable swap. Neutral on roles (see Handshake.ts). */
export interface Match {
  pair: Pair;
  /** the buy-side intent (acquires base, pays quote) — becomes the swap TAKER. */
  buy: OrderIntent;
  /** the sell-side intent (provides base, receives quote) — becomes the swap MAKER. */
  sell: OrderIntent;
  /** execution price (quote sats per base coin) — the RESTING order's limit price. */
  executionPriceSatPerUnit: bigint;
  /** matched base amount (e.g. PRL sats). */
  fillBaseSat: bigint;
  /** matched quote amount (e.g. BTC sats) at the execution price. */
  fillQuoteSat: bigint;
  /** identity (x-only) pubkeys, hex, for convenience. */
  buyerPubHex: string;
  sellerPubHex: string;
}

export interface SubmitResult {
  accepted: boolean;
  reason?: string;
  /** matches created by this submission (may be empty even when accepted: it just rests). */
  matches: Match[];
}

export interface OrderBookConfig {
  /** pairs the operator coordinates; others are rejected. */
  pairs: Pair[];
  /** minimum operator fee (bps) an intent must commit, or it is rejected (non-custodial fee gate). */
  minFeeBps: number;
  /** unix-seconds clock; injectable for deterministic tests. */
  now?: () => number;
  /**
   * Optional reputation gate: reject intents from a known griefing maker (see MakerReputation /
   * docs/maker-grief-analysis.md). Returns false to refuse the order. Mitigation, not enforcement.
   */
  allowMaker?: (makerPubkeyHex: string) => boolean;
}

const pairKey = (p: Pair) => `${p.base}/${p.quote}`;
const hx = (b: Uint8Array) => Buffer.from(b).toString('hex');

export class OrderBook {
  // pairKey -> side -> resting orders (kept sorted lazily at match time).
  private books = new Map<string, { buy: BookedOrder[]; sell: BookedOrder[] }>();
  private seq = 0;
  private readonly now: () => number;

  constructor(private readonly cfg: OrderBookConfig) {
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Verify and book a signed intent, crossing it against the resting opposite side. */
  submit(intent: OrderIntent, sig: Uint8Array): SubmitResult {
    const reason = this.reject(intent, sig);
    if (reason) return { accepted: false, reason, matches: [] };

    const book = this.bookFor(intent.pair);
    const incoming: BookedOrder = { intent, sig, remainingSat: intent.amountSat, seq: this.seq++ };
    const matches = this.cross(incoming);

    // Whatever is left rests on its own side.
    if (incoming.remainingSat > 0n) {
      (intent.side === 'buy' ? book.buy : book.sell).push(incoming);
    }
    return { accepted: true, matches };
  }

  /** Resting orders for a side (unfilled), for inspection/tests. */
  resting(pair: Pair, side: Side): BookedOrder[] {
    return [...this.bookFor(pair)[side]];
  }

  // ---- internals ----

  private reject(intent: OrderIntent, sig: Uint8Array): string | null {
    if (!this.cfg.pairs.some((p) => pairKey(p) === pairKey(intent.pair))) return 'unsupported pair';
    if (intent.amountSat <= 0n) return 'non-positive amount';
    if (intent.limitPriceSatPerUnit <= 0n) return 'non-positive price';
    if (intent.feeBps < this.cfg.minFeeBps) return `fee below operator minimum (${this.cfg.minFeeBps} bps)`;
    if (intent.expiry <= this.now()) return 'expired';
    if (this.cfg.allowMaker && !this.cfg.allowMaker(hx(intent.makerPubkey))) return 'maker reputation';
    if (!verifyIntent(intent, sig)) return 'bad signature';
    return null;
  }

  private bookFor(pair: Pair) {
    const k = pairKey(pair);
    let b = this.books.get(k);
    if (!b) {
      b = { buy: [], sell: [] };
      this.books.set(k, b);
    }
    return b;
  }

  /** Match `incoming` against the resting opposite side, best-price-then-earliest first. */
  private cross(incoming: BookedOrder): Match[] {
    const book = this.bookFor(incoming.intent.pair);
    const isBuy = incoming.intent.side === 'buy';
    const resting = isBuy ? book.sell : book.buy;

    // Best price for the incoming order: a buyer wants the LOWEST ask; a seller the HIGHEST bid.
    // Tie-break by earliest arrival (time priority).
    resting.sort((a, b) =>
      a.intent.limitPriceSatPerUnit === b.intent.limitPriceSatPerUnit
        ? a.seq - b.seq
        : isBuy
          ? cmp(a.intent.limitPriceSatPerUnit, b.intent.limitPriceSatPerUnit)
          : cmp(b.intent.limitPriceSatPerUnit, a.intent.limitPriceSatPerUnit),
    );

    const matches: Match[] = [];
    for (const rest of resting) {
      if (incoming.remainingSat <= 0n) break;
      if (!crosses(incoming.intent, rest.intent)) break; // sorted: once it stops crossing, done
      if (sameOwner(incoming.intent, rest.intent)) continue; // never self-match

      const fillBase = min(incoming.remainingSat, rest.remainingSat);
      if (fillBase <= 0n) continue;
      const price = rest.intent.limitPriceSatPerUnit; // execute at the resting order's price
      const fillQuote = (fillBase * price) / COIN;
      if (fillQuote <= 0n) continue; // dust below one quote sat

      incoming.remainingSat -= fillBase;
      rest.remainingSat -= fillBase;

      const buy = isBuy ? incoming.intent : rest.intent;
      const sell = isBuy ? rest.intent : incoming.intent;
      matches.push({
        pair: incoming.intent.pair,
        buy,
        sell,
        executionPriceSatPerUnit: price,
        fillBaseSat: fillBase,
        fillQuoteSat: fillQuote,
        buyerPubHex: hx(buy.makerPubkey),
        sellerPubHex: hx(sell.makerPubkey),
      });
    }

    // Drop fully-filled resting orders.
    const live = resting.filter((o) => o.remainingSat > 0n);
    if (isBuy) book.sell = live;
    else book.buy = live;
    return matches;
  }
}

const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const sameOwner = (a: OrderIntent, b: OrderIntent) =>
  Buffer.from(a.makerPubkey).equals(Buffer.from(b.makerPubkey));

/** A buy crosses a sell when the buyer will pay at least what the seller asks. */
function crosses(a: OrderIntent, b: OrderIntent): boolean {
  const buy = a.side === 'buy' ? a : b;
  const sell = a.side === 'buy' ? b : a;
  if (buy.side !== 'buy' || sell.side !== 'sell') return false; // same-side never cross
  return buy.limitPriceSatPerUnit >= sell.limitPriceSatPerUnit;
}
