import { describe, it, expect } from 'vitest';
import { randomPrivateKeyBytes, pubSchnorr, pubECDSA } from '@scure/btc-signer/utils.js';
import { LocalSigner } from '../src/signer/index.js';
import { signIntentWith, verifyIntent, type OrderIntent, type Pair } from '../src/coordination/index.js';

const PRL_BTC: Pair = { base: 'PRL', quote: 'BTC' };

describe('Signer seam', () => {
  it('LocalSigner exposes the expected keys', () => {
    const priv = randomPrivateKeyBytes();
    const s = new LocalSigner(priv);
    expect(Buffer.from(s.publicKey())).toEqual(Buffer.from(pubECDSA(priv, true)));
    expect(Buffer.from(s.xOnlyPublicKey())).toEqual(Buffer.from(pubSchnorr(priv)));
  });

  it('signs an order intent through the seam; the relay accepts it', async () => {
    const priv = randomPrivateKeyBytes();
    const signer = new LocalSigner(priv);
    const intent: OrderIntent = {
      makerPubkey: signer.xOnlyPublicKey(), // identity = the signer's x-only key
      pair: PRL_BTC,
      side: 'sell',
      amountSat: 100_000_000n,
      limitPriceSatPerUnit: 50_000n,
      feeBps: 20,
      expiry: 9_999_999_999,
      nonce: 'sig-1',
    };
    const sig = await signIntentWith(intent, signer);
    expect(verifyIntent(intent, sig)).toBe(true);

    // A different signer's signature must not verify against this identity.
    const other = new LocalSigner(randomPrivateKeyBytes());
    expect(verifyIntent(intent, await signIntentWith(intent, other))).toBe(false);
  });
});
