import type { BTC_NETWORK } from '@scure/btc-signer/utils.js';
import { addressToScript } from '../common/address.js';
import type {
  ChainClient,
  LockupFunding,
  SpendDetection,
  TxStatus,
  UtxoRef,
  WatchOptions,
} from './ChainClient.js';

export interface RpcConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  tls?: boolean;
  /** how many blocks back the first scan of an address/outpoint looks (restart tolerance). */
  scanLookback?: number;
}

/** A transaction normalized across btcd/Core verbose shapes. */
export interface NormTx {
  txid: string;
  hex: string;
  confirmations?: number;
  vin: { txid?: string; vout?: number }[];
  vout: { value: number; n: number; scriptHex: string }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toHex = (u: Uint8Array) => Buffer.from(u).toString('hex');
const outKey = (u: UtxoRef) => `${u.txid}:${u.vout}`;

/**
 * Shared JSON-RPC + chain-scanning base for both backends (ported from pearl-swap and adapted to
 * pearl-dex's ChainClient, which adds the single-shot getLockup/getSpend probes the executor races
 * against block-height deadlines).
 *
 * Scanning is STATEFUL and incremental: each address/outpoint keeps a cursor so a block is fetched
 * once, not re-scanned every poll. A found-but-too-shallow lockup is remembered and matures in place
 * (fixing a latent missed-confirmation bug in the original: block contents are immutable, so once a
 * block is scanned the only thing left to wait for is confirmations, not a re-scan). The watch*
 * methods just poll the single-shots. Liveness-critical, so kept in one place; subclasses only
 * supply chain-specific RPC shapes. Adequate for simnet/signet dev; a mainnet deployment should
 * back this with an indexer (electrs/esplora) rather than block scans.
 */
export abstract class RpcChainClient implements ChainClient {
  abstract readonly name: string;
  readonly network: BTC_NETWORK;
  private readonly url: string;
  private readonly authHeader: string;
  private readonly lookback: number;
  private rpcId = 0;
  protected stopped = false;

  // incremental scan state
  private lockupCursor = new Map<string, number>(); // address -> next block height to scan
  private lockupHit = new Map<string, { funding: LockupFunding; height: number }>();
  private spendCursor = new Map<string, number>(); // outpoint -> next block height to scan

  constructor(cfg: RpcConfig, network: BTC_NETWORK) {
    this.network = network;
    this.url = `${cfg.tls ? 'https' : 'http'}://${cfg.host}:${cfg.port}`;
    this.authHeader = `Basic ${Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64')}`;
    this.lookback = cfg.scanLookback ?? 144;
  }

  protected async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: this.authHeader },
      body: JSON.stringify({ jsonrpc: '1.0', id: ++this.rpcId, method, params }),
    });
    const text = await res.text();
    let body: { result?: T; error?: { message?: string; code?: number } };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${this.name} ${method}: HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    if (body.error) {
      throw new Error(`${this.name} ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
    }
    return body.result as T;
  }

  async getBlockHeight(): Promise<number> {
    return this.call<number>('getblockcount');
  }

  async broadcast(txHex: string): Promise<string> {
    return this.call<string>('sendrawtransaction', [txHex]);
  }

  async getTransaction(txid: string): Promise<{ hex: string; status: TxStatus } | null> {
    const tx = await this.getVerboseTx(txid);
    if (!tx) return null;
    const confirmations = tx.confirmations ?? 0;
    return { hex: tx.hex, status: { confirmed: confirmations > 0, confirmations } };
  }

  // ---- single-shot probes (pearl-dex additions) ----

  async getLockup(address: string, minConfs: number): Promise<LockupFunding | null> {
    const tip = await this.getBlockHeight();

    // Already found in a block — just wait for it to reach minConfs.
    const hit = this.lockupHit.get(address);
    if (hit) return tip - hit.height + 1 >= minConfs ? hit.funding : null;

    const targetHex = toHex(addressToScript(address, this.network));
    let h = this.lockupCursor.get(address) ?? Math.max(1, tip - this.lookback);
    for (; h <= tip; h++) {
      for (const tx of await this.fetchBlockTxs(h)) {
        for (const v of tx.vout) {
          if (v.scriptHex === targetHex) {
            const funding: LockupFunding = {
              utxo: { txid: tx.txid, vout: v.n },
              amountSat: RpcChainClient.toSat(v.value),
              scriptPubKey: Buffer.from(targetHex, 'hex'),
            };
            this.lockupHit.set(address, { funding, height: h });
            this.lockupCursor.set(address, h + 1);
            return tip - h + 1 >= minConfs ? funding : null;
          }
        }
      }
    }
    this.lockupCursor.set(address, tip + 1);

    // Not in a block yet; for minConfs 0, an unconfirmed mempool funding counts.
    if (minConfs === 0) {
      for (const tx of await this.mempoolTxs()) {
        for (const v of tx.vout) {
          if (v.scriptHex === targetHex) {
            return {
              utxo: { txid: tx.txid, vout: v.n },
              amountSat: RpcChainClient.toSat(v.value),
              scriptPubKey: Buffer.from(targetHex, 'hex'),
            };
          }
        }
      }
    }
    return null;
  }

  async getSpend(utxo: UtxoRef): Promise<SpendDetection | null> {
    const tip = await this.getBlockHeight();
    const k = outKey(utxo);
    const matches = (tx: NormTx) =>
      tx.vin.findIndex((i) => i.txid === utxo.txid && i.vout === utxo.vout);

    // Mempool first (a spend is visible there before it confirms).
    for (const tx of await this.mempoolTxs()) {
      const idx = matches(tx);
      if (idx >= 0) return { spendTxid: tx.txid, spendTxHex: tx.hex, inputIndex: idx };
    }
    let h = this.spendCursor.get(k) ?? Math.max(1, tip - this.lookback);
    for (; h <= tip; h++) {
      for (const tx of await this.fetchBlockTxs(h)) {
        const idx = matches(tx);
        if (idx >= 0) {
          this.spendCursor.set(k, h + 1);
          return { spendTxid: tx.txid, spendTxHex: tx.hex, inputIndex: idx };
        }
      }
    }
    this.spendCursor.set(k, tip + 1);
    return null;
  }

  // ---- blocking watchers (poll the single-shots) ----

  async watchForLockup(
    address: string,
    minConfs: number,
    opts: WatchOptions = {},
  ): Promise<LockupFunding> {
    if (opts.fromHeight !== undefined) this.lockupCursor.set(address, opts.fromHeight);
    return this.poll(() => this.getLockup(address, minConfs), opts, `watchForLockup(${address})`);
  }

  async watchForSpend(utxo: UtxoRef, opts: WatchOptions = {}): Promise<SpendDetection> {
    if (opts.fromHeight !== undefined) this.spendCursor.set(outKey(utxo), opts.fromHeight);
    return this.poll(() => this.getSpend(utxo), opts, `watchForSpend(${outKey(utxo)})`);
  }

  private async poll<T>(probe: () => Promise<T | null>, opts: WatchOptions, what: string): Promise<T> {
    const pollMs = opts.pollMs ?? 1500;
    const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;
    while (!this.stopped) {
      const v = await probe();
      if (v !== null) return v;
      if (Date.now() > deadline) throw new Error(`${what} timed out`);
      await sleep(pollMs);
    }
    throw new Error(`${this.name} client stopped`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  protected async mempoolTxs(): Promise<NormTx[]> {
    const ids = await this.call<string[]>('getrawmempool');
    const out: NormTx[] = [];
    for (const id of ids) {
      const tx = await this.getVerboseTx(id).catch(() => null);
      if (tx) out.push(tx);
    }
    return out;
  }

  /** Normalize a verbose getrawtransaction/block-tx object (btcd & Core share these fields). */
  protected static normalizeTx(raw: {
    txid: string;
    hex: string;
    confirmations?: number;
    vin?: { txid?: string; vout?: number }[];
    vout?: { value: number; n: number; scriptPubKey?: { hex: string } }[];
  }): NormTx {
    return {
      txid: raw.txid,
      hex: raw.hex,
      confirmations: raw.confirmations,
      vin: (raw.vin ?? []).map((i) => ({ txid: i.txid, vout: i.vout })),
      vout: (raw.vout ?? []).map((o) => ({
        value: o.value,
        n: o.n,
        scriptHex: o.scriptPubKey?.hex ?? '',
      })),
    };
  }

  /** coin (BTC/PRL float) -> integer sat/grain (1 coin = 1e8), rounded to avoid float drift. */
  protected static toSat(coin: number): number {
    return Math.round(coin * 1e8);
  }

  // ---- chain-specific hooks ----

  /** Verbose transaction by id, or null if unknown. */
  protected abstract getVerboseTx(txid: string): Promise<NormTx | null>;

  /** All transactions in the block at `height`, normalized. */
  protected abstract fetchBlockTxs(height: number): Promise<NormTx[]>;

  abstract estimateFeeSatPerVbyte(): Promise<number>;
}
