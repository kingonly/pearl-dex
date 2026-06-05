import { pubSchnorr } from '@scure/btc-signer/utils.js';
import type { BTC_NETWORK } from '@scure/btc-signer/utils.js';
import { addressToScript, p2trScript } from '../common/index.js';
import { buildP2trKeyPathSpend } from '../settlement/Funder.js';
import type { ChainClient, UtxoRef } from '../settlement/ChainClient.js';
import type { SwapWallet } from '../coordination/index.js';

/**
 * A reference SwapWallet: funds swap lockups by spending the user's own taproot (key-path) UTXOs,
 * and pays claimed/refunded funds back to the user's own p2tr address. This is the production
 * counterpart of the test ScriptedWallet — it builds and broadcasts REAL funding transactions via
 * the ChainClient. Custody lives here and nowhere else.
 *
 * "Bring your own UTXOs": the wallet tracks a UTXO pool per chain that the caller seeds (and which
 * it maintains as it spends and creates change). Automatic chain scanning / UTXO discovery needs a
 * richer ChainClient (listUnspent) than the swap interface exposes and is left to the live adapter;
 * for now the user/host feeds UTXOs in. All wallet outputs are simple key-path p2tr under one key.
 */

export interface WalletUtxo extends UtxoRef {
  amountSat: bigint;
}

export interface ReferenceWalletDeps {
  /** key controlling the wallet's own funds (and the payout destination). */
  walletPrivateKey: Uint8Array;
  /** chain clients used to broadcast funding txs (one per network the wallet funds on). */
  clients: ChainClient[];
  /** approximate vbytes of a 1-in/2-out key-path funding tx, for the miner fee. */
  approxVbytes?: number;
  /** outputs below this are treated as dust and folded into the miner fee instead of change. */
  dustSat?: bigint;
}

export class ReferenceWallet implements SwapWallet {
  private readonly xonly: Uint8Array;
  private readonly clients = new Map<string, ChainClient>();
  /** per-network UTXO pool, keyed by network bech32. */
  private readonly pool = new Map<string, WalletUtxo[]>();
  private readonly approxVbytes: number;
  private readonly dustSat: bigint;

  constructor(private readonly deps: ReferenceWalletDeps) {
    this.xonly = pubSchnorr(deps.walletPrivateKey);
    for (const c of deps.clients) this.clients.set(c.network.bech32, c);
    this.approxVbytes = deps.approxVbytes ?? 154;
    this.dustSat = deps.dustSat ?? 330n;
  }

  /** Seed (or top up) the wallet's spendable UTXOs on a chain. */
  addUtxo(network: BTC_NETWORK, utxo: WalletUtxo): void {
    const list = this.pool.get(network.bech32) ?? [];
    list.push(utxo);
    this.pool.set(network.bech32, list);
  }

  /** Total spendable balance on a chain. */
  balance(network: BTC_NETWORK): bigint {
    return (this.pool.get(network.bech32) ?? []).reduce((a, u) => a + u.amountSat, 0n);
  }

  // ---- SwapWallet ----

  async fundLockup(
    network: BTC_NETWORK,
    address: string,
    amountSat: bigint,
  ): Promise<UtxoRef & { amountSat: bigint }> {
    const client = this.clientFor(network);
    const rate = await client.estimateFeeSatPerVbyte();
    const minerFee = BigInt(Math.ceil(rate * this.approxVbytes));
    const need = amountSat + minerFee;

    const utxo = this.select(network, need);
    if (!utxo) throw new Error(`insufficient funds on ${network.bech32}: need ${need}, have ${this.balance(network)}`);

    const ownScript = p2trScript(this.xonly, network);
    const outputs = [{ script: addressToScript(address, network), amountSat }];
    const change = utxo.amountSat - amountSat - minerFee;
    if (change >= this.dustSat) outputs.push({ script: ownScript, amountSat: change });

    const tx = buildP2trKeyPathSpend({
      input: {
        txid: utxo.txid,
        vout: utxo.vout,
        amountSat: utxo.amountSat,
        prevScript: ownScript,
        internalKey: this.xonly,
      },
      privateKey: this.deps.walletPrivateKey,
      outputs,
    });

    await client.broadcast(tx.hex);
    const txid = tx.id;

    // Update the pool: drop the spent input, add the change output (output index 1).
    this.remove(network, utxo);
    if (change >= this.dustSat) this.addUtxo(network, { txid, vout: 1, amountSat: change });

    // The lockup is output index 0 of the funding tx.
    return { txid, vout: 0, amountSat };
  }

  payoutScript(network: BTC_NETWORK): Uint8Array {
    return p2trScript(this.xonly, network);
  }

  // ---- internals ----

  private clientFor(network: BTC_NETWORK): ChainClient {
    const c = this.clients.get(network.bech32);
    if (!c) throw new Error(`wallet has no client for network ${network.bech32}`);
    return c;
  }

  /** First-fit UTXO selection (a real wallet would optimize; reference keeps it simple). */
  private select(network: BTC_NETWORK, need: bigint): WalletUtxo | undefined {
    return (this.pool.get(network.bech32) ?? []).find((u) => u.amountSat >= need);
  }

  private remove(network: BTC_NETWORK, utxo: WalletUtxo): void {
    const list = this.pool.get(network.bech32) ?? [];
    this.pool.set(
      network.bech32,
      list.filter((u) => !(u.txid === utxo.txid && u.vout === utxo.vout)),
    );
  }
}
