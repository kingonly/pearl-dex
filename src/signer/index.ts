import { schnorr } from '@noble/curves/secp256k1.js';
import { pubECDSA, pubSchnorr } from '@scure/btc-signer/utils.js';

/**
 * The signing seam. Everything that needs the user's key — signing an order intent, and signing the
 * taproot script-path spends that claim/refund/reclaim a swap — depends only on this interface, not
 * on holding raw key bytes. That lets the same code run against:
 *
 *   - LocalSigner          — a key we hold (the LP daemon; advanced self-custody; tests).
 *   - PrivySigner (later)  — a Privy embedded wallet that NEVER exposes the key and only signs a
 *                            hash on request. This is why the interface is "sign a hash", not
 *                            "give me the private key": it's the lowest common denominator that both
 *                            a local key and a managed signer (Privy, hardware) can satisfy.
 *
 * BIP-340 Schnorr over a 32-byte message covers both needs: order intents are signed that way, and
 * taproot script-path leaves are `<pubkey> OP_CHECKSIG` (Schnorr over the taproot sighash). The
 * public keys are exposed synchronously (cached at construction) because address / Musig-aggregate
 * derivation is synchronous; signing is async to accommodate a remote signer.
 */
export interface Signer {
  /** 33-byte compressed secp256k1 public key (Musig aggregation, leaf CHECKSIG keys). */
  publicKey(): Uint8Array;
  /** 32-byte x-only public key (BIP-340 / order-intent identity, taproot). */
  xOnlyPublicKey(): Uint8Array;
  /** BIP-340 Schnorr signature over a 32-byte message hash. */
  signSchnorr(hash: Uint8Array): Promise<Uint8Array>;
}

/** A signer backed by a key we hold locally. Used by the LP daemon, self-custody users, and tests. */
export class LocalSigner implements Signer {
  private readonly pub: Uint8Array;
  private readonly xonly: Uint8Array;

  constructor(private readonly privateKey: Uint8Array) {
    this.pub = pubECDSA(privateKey, true);
    this.xonly = pubSchnorr(privateKey);
  }

  publicKey(): Uint8Array {
    return this.pub;
  }
  xOnlyPublicKey(): Uint8Array {
    return this.xonly;
  }
  async signSchnorr(hash: Uint8Array): Promise<Uint8Array> {
    return schnorr.sign(hash, this.privateKey);
  }
}
