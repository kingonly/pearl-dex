import type { BTC_NETWORK } from '@scure/btc-signer/utils.js';

/** A reference to a specific transaction output. */
export interface UtxoRef {
  txid: string;
  vout: number;
}

/** Tuning for the polling watch methods. */
export interface WatchOptions {
  /** poll interval in ms */
  pollMs?: number;
  /** give up (reject) after this many ms */
  timeoutMs?: number;
  /** block height to start scanning from */
  fromHeight?: number;
}

/** Confirmation status of a transaction. */
export interface TxStatus {
  confirmed: boolean;
  confirmations: number;
  blockHeight?: number;
}

/** A funding output detected at a watched address (a swap lockup or a bond). */
export interface LockupFunding {
  utxo: UtxoRef;
  amountSat: number;
  /** raw scriptPubKey of the funding output */
  scriptPubKey: Buffer;
}

/** The transaction that spent a watched output (claim / refund / bond reclaim / bond forfeit). */
export interface SpendDetection {
  spendTxid: string;
  spendTxHex: string;
  /** index of the input in spendTx that consumed the watched outpoint */
  inputIndex: number;
}

/**
 * Uniform interface over a chain backend. Two implementations (ported from pearl-swap):
 *   - PearlClient   -> pearld (btcd-style JSON-RPC over HTTP + websocket notifications, TLS)
 *   - BitcoinClient -> bitcoind signet (or an Esplora HTTP API)
 *
 * pearl-dex is non-custodial: clients are driven by the two USERS' wallets, never by an
 * operator holding funds. The settlement code depends only on this interface.
 */
export interface ChainClient {
  readonly name: string;
  readonly network: BTC_NETWORK;

  /** Current best block height. */
  getBlockHeight(): Promise<number>;

  /** Fetch a transaction (raw hex + confirmation status), or null if unknown. */
  getTransaction(txid: string): Promise<{ hex: string; status: TxStatus } | null>;

  /** Broadcast a fully-signed transaction; resolves with its txid. */
  broadcast(txHex: string): Promise<string>;

  /**
   * Single-shot: return the lockup funding `address` with at least `minConfs` confirmations,
   * or null if none is visible yet. The coordinator uses this to race a counterparty's lockup
   * against a block-height deadline (the blocking `watchForLockup` can only race wall-clock time).
   */
  getLockup(address: string, minConfs: number): Promise<LockupFunding | null>;

  /**
   * Single-shot: return the spend of `utxo` if it has been spent, else null. Lets the
   * coordinator poll for a counterparty claim while also checking the timeout height.
   */
  getSpend(utxo: UtxoRef): Promise<SpendDetection | null>;

  /**
   * Resolve once a lockup funding the given address is seen with at least `minConfs`
   * confirmations. Used to detect a counterparty's lockup or bond before acting.
   */
  watchForLockup(address: string, minConfs: number, opts?: WatchOptions): Promise<LockupFunding>;

  /**
   * Resolve once the given output is spent. The spend tx may reveal the swap preimage
   * (script-path claim), which the caller extracts to claim the other leg / reclaim a bond.
   */
  watchForSpend(utxo: UtxoRef, opts?: WatchOptions): Promise<SpendDetection>;

  /** Rough fee estimate in sat/vByte (PRL: may be a static floor on testnet). */
  estimateFeeSatPerVbyte(): Promise<number>;

  /** Tear down RPC/websocket connections. */
  stop(): Promise<void>;
}
