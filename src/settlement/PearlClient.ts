import type { BTC_NETWORK } from '@scure/btc-signer/utils.js';
import { type NormTx, RpcChainClient, type RpcConfig } from './RpcChainClient.js';

export type { RpcConfig } from './RpcChainClient.js';

/**
 * ChainClient for pearld over its btcd-style JSON-RPC (HTTP + basic auth, loopback --notls).
 *
 * btcd quirks vs Core: `getblock <hash> 2` returns full txs under `rawtx` (Core uses `tx`);
 * `getrawtransaction <txid> 1` (int verbose) needs --txindex for confirmed txs. Amounts are floats
 * in PRL (1 PRL = 1e8 grain). Pearl's tx format is byte-identical to Bitcoin, so @scure builds/signs
 * these unchanged — only the RPC envelope and HRP differ.
 */
export class PearlClient extends RpcChainClient {
  readonly name: string;

  constructor(cfg: RpcConfig, network: BTC_NETWORK, name = 'pearl') {
    super(cfg, network);
    this.name = name;
  }

  protected async getVerboseTx(txid: string): Promise<NormTx | null> {
    try {
      const raw = await this.call<Parameters<(typeof RpcChainClient)['normalizeTx']>[0]>(
        'getrawtransaction',
        [txid, 1],
      );
      return RpcChainClient.normalizeTx(raw);
    } catch (e) {
      if (/No information|-5|not found|no such/i.test(String(e))) return null;
      throw e;
    }
  }

  protected async fetchBlockTxs(height: number): Promise<NormTx[]> {
    const hash = await this.call<string>('getblockhash', [height]);
    const blk = await this.call<{ rawtx?: Parameters<(typeof RpcChainClient)['normalizeTx']>[0][] }>(
      'getblock',
      [hash, 2],
    );
    return (blk.rawtx ?? []).map((t) => RpcChainClient.normalizeTx(t));
  }

  async estimateFeeSatPerVbyte(): Promise<number> {
    try {
      const perKb = await this.call<number>('estimatefee', [6]); // PRL per kB
      if (typeof perKb === 'number' && perKb > 0) {
        return Math.max(1, Math.ceil((perKb * 1e8) / 1000));
      }
    } catch {
      // pearld may lack fee data on simnet/testnet — fall through to a floor.
    }
    return 2;
  }

  // ---- simnet/dev helpers ----

  /** Mine `n` blocks to the node's configured mining address (simnet only). */
  async generate(n: number): Promise<string[]> {
    return this.call<string[]>('generate', [n]);
  }

  /** An unspent output, or null if spent/nonexistent. */
  async getTxOut(
    txid: string,
    vout: number,
  ): Promise<{ amountSat: number; scriptHex: string } | null> {
    const r = await this.call<{ value: number; scriptPubKey?: { hex: string } } | null>('gettxout', [
      txid,
      vout,
    ]);
    if (!r) return null;
    return { amountSat: RpcChainClient.toSat(r.value), scriptHex: r.scriptPubKey?.hex ?? '' };
  }

  /** The coinbase outpoint (vout 0) of the block at `height` — used to fund test lockups. */
  async coinbaseUtxoAt(
    height: number,
  ): Promise<{ txid: string; vout: number; amountSat: bigint; scriptHex: string }> {
    const [cb] = await this.fetchBlockTxs(height);
    const o = cb.vout[0];
    return {
      txid: cb.txid,
      vout: o.n,
      amountSat: BigInt(RpcChainClient.toSat(o.value)),
      scriptHex: o.scriptHex,
    };
  }
}
