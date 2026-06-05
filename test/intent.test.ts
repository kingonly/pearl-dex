import { describe, it, expect } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  signIntent,
  verifyIntent,
  type OrderIntent,
} from '../src/coordination/types.js';

function maker() {
  const priv = schnorr.utils.randomSecretKey();
  return { priv, pub: schnorr.getPublicKey(priv) };
}

function intent(makerPubkey: Uint8Array, over: Partial<OrderIntent> = {}): OrderIntent {
  return {
    makerPubkey,
    pair: { base: 'PRL', quote: 'BTC' },
    side: 'sell',
    amountSat: 5_000_000n,
    limitPriceSatPerUnit: 30n,
    feeBps: 20,
    expiry: 1_900_000_000,
    nonce: 'abc123',
    ...over,
  };
}

describe('OrderIntent (signed, non-custodial matching primitive)', () => {
  it('sign + verify round-trips', () => {
    const m = maker();
    const o = intent(m.pub);
    const sig = signIntent(o, m.priv);
    expect(verifyIntent(o, sig)).toBe(true);
  });

  it('rejects a tampered order (amount changed after signing)', () => {
    const m = maker();
    const o = intent(m.pub);
    const sig = signIntent(o, m.priv);
    const tampered = { ...o, amountSat: 9_999_999n };
    expect(verifyIntent(tampered, sig)).toBe(false);
  });

  it('rejects a tampered fee commitment (operator fee stripped)', () => {
    const m = maker();
    const o = intent(m.pub, { feeBps: 20 });
    const sig = signIntent(o, m.priv);
    const stripped = { ...o, feeBps: 0 };
    expect(verifyIntent(stripped, sig)).toBe(false);
  });

  it('rejects a signature from the wrong key', () => {
    const m = maker();
    const other = maker();
    const o = intent(m.pub);
    const sig = signIntent(o, other.priv);
    expect(verifyIntent(o, sig)).toBe(false);
  });
});
