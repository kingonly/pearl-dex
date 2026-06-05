import type { BTC_NETWORK } from '@scure/btc-signer/utils.js';
import type { ChainClient } from '../settlement/ChainClient.js';
import type { SwapWallet } from '../coordination/index.js';
import type { UtxoRef } from '../settlement/ChainClient.js';

/**
 * The NON-CUSTODIAL, no-wallet user funding model — the one a pure DEX uses.
 *
 * `ReferenceWallet` funds a lockup by SPENDING the user's UTXOs with a key it holds. That's right
 * for an LP daemon (it runs unattended and holds its own capital) but WRONG for an end user: a DEX
 * should never custody the user's balance. `WatchDepositWallet` instead funds a lockup by asking the
 * user to send to it from THEIR OWN wallet and then WATCHING the chain for the deposit (the Boltz
 * "send to this address" model). It holds no key and spends nothing.
 *
 *   - BTC leg: the user sends from whatever Bitcoin wallet they already have.
 *   - PRL leg: the user sends from their Pearl / Privy wallet (Pearl has no other wallet yet).
 *
 * Claims/refunds are signed through the executor's `Signer` (claim/refund authority only, never
 * custody) and pay out to `payoutScript` — the user's OWN receiving address per network, which they
 * provide. So the app never holds funds: it only matches, watches, and helps assemble the claim the
 * user's own signer authorizes.
 */

/** A request shown to the user: "send `amountSat` to `address` on `network`". */
export interface DepositRequest {
  network: BTC_NETWORK;
  address: string;
  amountSat: bigint;
}

/** The user's own receiving script on a given network (where claimed/refunded funds land). */
export interface PayoutScript {
  network: BTC_NETWORK;
  script: Uint8Array;
}

export interface WatchDepositWalletDeps {
  /** chain clients to watch for the user's deposit — one per network this wallet handles. */
  clients: ChainClient[];
  /** the user's OWN receiving script per network. Bring-your-own-address; never derived from a key here. */
  payoutScripts: PayoutScript[];
  /**
   * Called when the swap needs the user to fund a lockup. The UI shows "send <amount> to <address>"
   * (and on the PRL leg drives the user's Pearl/Privy wallet to send). The wallet then watches the
   * chain for the deposit. Omit it only in tests or when funding is injected out-of-band.
   */
  onDepositRequest?: (req: DepositRequest) => void;
  /** confirmations to require before treating the user's deposit as funded. */
  minConfs?: number;
  /** poll interval (ms) while watching for the deposit. */
  pollMs?: number;
  /** give up waiting for the deposit after this long (ms); default: wait indefinitely. */
  timeoutMs?: number;
}

export class WatchDepositWallet implements SwapWallet {
  constructor(private readonly deps: WatchDepositWalletDeps) {}

  /**
   * Fund a lockup WITHOUT custody: prompt the user to deposit, then watch the chain until the
   * deposit lands and return its outpoint. Throws if the seen deposit is short of `amountSat`.
   */
  async fundLockup(
    network: BTC_NETWORK,
    address: string,
    amountSat: bigint,
  ): Promise<UtxoRef & { amountSat: bigint }> {
    const client = this.clientFor(network);
    this.deps.onDepositRequest?.({ network, address, amountSat });
    const funding = await client.watchForLockup(address, this.deps.minConfs ?? 1, {
      pollMs: this.deps.pollMs,
      timeoutMs: this.deps.timeoutMs,
    });
    const got = BigInt(funding.amountSat);
    if (got < amountSat) {
      throw new Error(
        `deposit at ${address} was ${got} sat, short of the required ${amountSat} sat`,
      );
    }
    return { txid: funding.utxo.txid, vout: funding.utxo.vout, amountSat: got };
  }

  /** Where claimed/refunded/reclaimed funds pay out: the user's own address on `network`. */
  payoutScript(network: BTC_NETWORK): Uint8Array {
    const match = this.deps.payoutScripts.find((p) => p.network.bech32 === network.bech32);
    if (!match) {
      throw new Error(`no payout script configured for network ${network.bech32}`);
    }
    return match.script;
  }

  private clientFor(network: BTC_NETWORK): ChainClient {
    const client = this.deps.clients.find((c) => c.network.bech32 === network.bech32);
    if (!client) throw new Error(`no chain client for network ${network.bech32}`);
    return client;
  }
}
