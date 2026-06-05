import type { BTC_NETWORK } from '@scure/btc-signer/utils.js';
import { type NormTx, RpcChainClient, type RpcConfig } from './RpcChainClient.js';

export type { RpcConfig } from './RpcChainClient.js';

/**
 * ChainClient for bitcoind (signet) over Core JSON-RPC (HTTP + basic auth).
 *
 * Core vs btcd: `getblock <hash> 2` returns full txs under `tx`; `getrawtransaction <txid> true`
 * needs txindex=1; fee estimation is `estimatesmartfee` (BTC/kvB under `feerate`, or `errors` when
 * it lacks data — common on signet, so we fall back to a 1 sat/vB floor).
 */
export class BitcoinClient extends RpcChainClient {
  readonly name: string;

  constructor(cfg: RpcConfig, network: BTC_NETWORK, name = 'bitcoin') {
    super(cfg, network);
    this.name = name;
  }

  protected async getVerboseTx(txid: string): Promise<NormTx | null> {
    try {
      const raw = await this.call<Parameters<(typeof RpcChainClient)['normalizeTx']>[0]>(
        'getrawtransaction',
        [txid, true],
      );
      return RpcChainClient.normalizeTx(raw);
    } catch (e) {
      if (/-5|No such|not found|No information/i.test(String(e))) return null;
      throw e;
    }
  }

  protected async fetchBlockTxs(height: number): Promise<NormTx[]> {
    const hash = await this.call<string>('getblockhash', [height]);
    const blk = await this.call<{ tx?: Parameters<(typeof RpcChainClient)['normalizeTx']>[0][] }>(
      'getblock',
      [hash, 2],
    );
    return (blk.tx ?? []).map((t) => RpcChainClient.normalizeTx(t));
  }

  async estimateFeeSatPerVbyte(): Promise<number> {
    try {
      const r = await this.call<{ feerate?: number }>('estimatesmartfee', [6]); // BTC per kvB
      if (typeof r?.feerate === 'number' && r.feerate > 0) {
        return Math.max(1, Math.ceil((r.feerate * 1e8) / 1000));
      }
    } catch {
      // signet often has no fee data — fall through to a floor.
    }
    return 1;
  }

  /** Confirmed UTXOs paying `address` (via scantxoutset; no wallet import needed). */
  async listUnspentByAddress(
    address: string,
  ): Promise<{ txid: string; vout: number; amountSat: number; scriptHex: string }[]> {
    const r = await this.call<{
      unspents?: { txid: string; vout: number; scriptPubKey: string; amount: number }[];
    }>('scantxoutset', ['start', [`addr(${address})`]]);
    return (r.unspents ?? []).map((u) => ({
      txid: u.txid,
      vout: u.vout,
      amountSat: RpcChainClient.toSat(u.amount),
      scriptHex: u.scriptPubKey,
    }));
  }
}
