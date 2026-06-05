import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@scure/btc-signer/utils.js';
import type { Signer } from '../signer/index.js';

/**
 * Coordination-layer types: signed order INTENTS (the non-custodial matching primitive) and
 * the third-party liquidity-provider interface.
 *
 * The operator stores/relays signed intents and routes taker requests; it never holds funds and
 * never provides liquidity. Liquidity comes from (a) other users posting resting intents, or
 * (b) third-party market-maker daemons that quote prices and run the maker side of the swap with
 * THEIR OWN capital. Either way the operator is a pure matchmaker.
 */

export interface Pair {
  /** base asset, e.g. 'PRL'. */
  base: string;
  /** quote asset, e.g. 'BTC'. */
  quote: string;
}

/** 'buy' = acquire base (PRL) paying quote (BTC); 'sell' = the reverse. */
export type Side = 'buy' | 'sell';

/**
 * A maker's resting order — a signed INTENT, never a deposit. Commits the operator fee (`feeBps`)
 * so a match can only be coordinated on terms that pay the operator. Matching is intent-crossing,
 * not custody.
 */
export interface OrderIntent {
  /** maker identity key (x-only schnorr, 32 bytes). */
  makerPubkey: Uint8Array;
  pair: Pair;
  side: Side;
  /** order size in base-asset sats. */
  amountSat: bigint;
  /** limit price, quote sats per base unit. */
  limitPriceSatPerUnit: bigint;
  /** operator fee this order commits to (basis points). */
  feeBps: number;
  /** unix seconds after which the intent is void. */
  expiry: number;
  /** uniqueness/anti-replay. */
  nonce: string;
}

/** Canonical byte serialization of an intent (stable key order; bigints as decimal strings). */
export function serializeIntent(o: OrderIntent): Uint8Array {
  const canonical = JSON.stringify({
    makerPubkey: Buffer.from(o.makerPubkey).toString('hex'),
    pair: { base: o.pair.base, quote: o.pair.quote },
    side: o.side,
    amountSat: o.amountSat.toString(),
    limitPriceSatPerUnit: o.limitPriceSatPerUnit.toString(),
    feeBps: o.feeBps,
    expiry: o.expiry,
    nonce: o.nonce,
  });
  return new TextEncoder().encode(canonical);
}

/** 32-byte digest the maker signs. */
export function intentDigest(o: OrderIntent): Uint8Array {
  return sha256(serializeIntent(o));
}

/** Sign an order intent with the maker's identity private key (BIP-340 schnorr). */
export function signIntent(o: OrderIntent, makerPrivkey: Uint8Array): Uint8Array {
  return schnorr.sign(intentDigest(o), makerPrivkey);
}

/**
 * Sign an order intent via the signing seam (a held key — incl. an in-browser ephemeral key — or a
 * remote/hardware signer). The
 * intent's `makerPubkey` must be the signer's x-only key. Returns the schnorr signature.
 */
export async function signIntentWith(o: OrderIntent, signer: Signer): Promise<Uint8Array> {
  return signer.signSchnorr(intentDigest(o));
}

/** Verify an order intent's signature against its committed maker pubkey. */
export function verifyIntent(o: OrderIntent, sig: Uint8Array): boolean {
  try {
    return schnorr.verify(sig, intentDigest(o), o.makerPubkey);
  } catch {
    return false;
  }
}

/** A price quote from a liquidity provider for a specific taker request. */
export interface Quote {
  pair: Pair;
  side: Side;
  amountSat: bigint;
  priceSatPerUnit: bigint;
  /** operator fee for this trade, in sats. */
  feeSat: bigint;
  /** unix seconds the quote is valid until (tight, to bound the free option). */
  expiry: number;
  /** how to reach the LP daemon to execute the swap. */
  lpEndpoint: string;
}

/**
 * A third-party liquidity provider: holds its OWN BTC+PRL liquidity, quotes prices, and runs the
 * maker side of the swap. The operator routes taker requests to registered LPs but never touches
 * funds. The reference LP daemon repackages pearl-swap's orchestrator — the liquidity-provider
 * model Roy won't run himself; OTHERS run it and bring the capital, while pearl-dex takes the fee.
 */
export interface LiquidityProvider {
  /** pairs this LP makes markets in. */
  markets(): Promise<Pair[]>;
  /** quote a taker request, or null if it won't fill. */
  quote(req: { pair: Pair; side: Side; amountSat: bigint }): Promise<Quote | null>;
}
