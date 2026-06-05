import type { BTC_NETWORK } from '@scure/btc-signer/utils.js';
import { addressToScript, p2trScript } from '../../src/common/index.js';
import type { UtxoRef } from '../../src/settlement/ChainClient.js';
import type { SwapWallet } from '../../src/coordination/SwapExecutor.js';
import type { ScriptedChainClient } from './ScriptedChain.js';

/**
 * A test SwapWallet: funds a lockup by injecting it into the matching scripted chain and counts
 * the calls (so tests can assert restart idempotency — that a resumed executor does NOT re-fund).
 * Payouts go to the party's own p2tr key. Stands in for a real user wallet driving the executor.
 */
export class ScriptedWallet implements SwapWallet {
  /** address -> number of times fundLockup was invoked for it (idempotency assertions). */
  readonly funded = new Map<string, number>();
  private n = 0;

  constructor(
    private readonly clients: ScriptedChainClient[],
    private readonly xonly: Uint8Array,
  ) {}

  async fundLockup(
    network: BTC_NETWORK,
    address: string,
    amountSat: bigint,
  ): Promise<UtxoRef & { amountSat: bigint }> {
    const client = this.clientFor(network);
    const txid = (++this.n).toString(16).padStart(64, '0');
    const utxo = { txid, vout: 0 };
    client.injectLockup(address, {
      utxo,
      amountSat: Number(amountSat),
      scriptPubKey: Buffer.from(addressToScript(address, network)),
    });
    this.funded.set(address, (this.funded.get(address) ?? 0) + 1);
    return { ...utxo, amountSat };
  }

  payoutScript(network: BTC_NETWORK): Uint8Array {
    return p2trScript(this.xonly, network);
  }

  private clientFor(network: BTC_NETWORK): ScriptedChainClient {
    const c = this.clients.find((x) => x.network.bech32 === network.bech32);
    if (!c) throw new Error(`no scripted client for network ${network.bech32}`);
    return c;
  }
}
