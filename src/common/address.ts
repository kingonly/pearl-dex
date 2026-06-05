import { Address, OutScript, p2tr } from '@scure/btc-signer';
import type { BTC_NETWORK } from '@scure/btc-signer/utils.js';

/**
 * Derive a P2TR (taproot, witness v1, bech32m) address from a 32-byte x-only internal
 * public key for the given network. On Pearl simnet → `rprl1p...`, TestNet2 → `tprl1p...`,
 * signet → `tb1p...`.
 */
export function p2trAddress(internalPubkey: Uint8Array, network: BTC_NETWORK): string {
  const addr = p2tr(internalPubkey, undefined, network).address;
  if (!addr) throw new Error('failed to derive p2tr address');
  return addr;
}

/** The scriptPubKey (output script) for a key-path P2TR with the given internal key. */
export function p2trScript(internalPubkey: Uint8Array, network: BTC_NETWORK): Uint8Array {
  return p2tr(internalPubkey, undefined, network).script;
}

/** Convert any address (for `network`) to its output script — used as a tx destination. */
export function addressToScript(addr: string, network: BTC_NETWORK): Uint8Array {
  const out = Address(network).decode(addr);
  if (!out) throw new Error(`invalid address: ${addr}`);
  return OutScript.encode(out);
}

/** Decode an address into its `@scure/btc-signer` output descriptor (e.g. `{type:'tr', pubkey}`). */
export function decodeAddress(addr: string, network: BTC_NETWORK) {
  const out = Address(network).decode(addr);
  if (!out) throw new Error(`invalid address: ${addr}`);
  return out;
}
