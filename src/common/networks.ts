import { TEST_NETWORK } from '@scure/btc-signer';
import type { BTC_NETWORK } from '@scure/btc-signer/utils.js';

/**
 * Network parameters for `@scure/btc-signer` (the taproot lib boltz-core is built on).
 *
 * Pearl is a btcsuite fork whose TRANSACTION format is byte-identical to Bitcoin (txids
 * are double-SHA256) and which is TAPROOT-ONLY — so @scure/btc-signer builds, signs, and
 * serializes Pearl taproot transactions unchanged; only the bech32 HRP differs. Pearl has
 * NO legacy (p2pkh/p2sh) addresses, so `pubKeyHash`/`scriptHash` here are placeholders
 * required by the BTC_NETWORK type but never exercised for p2tr.
 *
 * Source of truth: github.com/pearl-research-labs/pearl node/chaincfg/params.go.
 */

/** Pearl SimNet — dev PRL backend (mintable). Addresses: `rprl1p...`. (SimNetParams) */
export const pearlSimnet: BTC_NETWORK = {
  bech32: 'rprl',
  pubKeyHash: 0x6f,
  scriptHash: 0xc4,
  wif: 0x64,
};

/** Pearl TestNet2 — the flip target once funded. Addresses: `tprl1p...`. (TestNet2Params) */
export const pearlTestnet: BTC_NETWORK = {
  bech32: 'tprl',
  pubKeyHash: 0x6f,
  scriptHash: 0xc4,
  wif: 0xef,
};

/**
 * Bitcoin signet — shares Bitcoin testnet's address parameters (HRP "tb"), so we reuse
 * @scure's TEST_NETWORK. Signet chosen over testnet3/4 for predictable ~10-min blocks
 * (the timelock-safety math depends on it). Addresses: `tb1p...`.
 */
export const bitcoinSignet: BTC_NETWORK = TEST_NETWORK;
