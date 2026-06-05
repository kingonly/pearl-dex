import type { BTC_NETWORK } from '@scure/btc-signer/utils.js';
import type {
  ChainClient,
  LockupFunding,
  SpendDetection,
  TxStatus,
  UtxoRef,
} from '../../src/settlement/ChainClient.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Test double for ChainClient: a controllable in-memory chain. Tests drive it by setting the
 * height and injecting lockups/spends; the protocol builds REAL transactions against it
 * (broadcasts are recorded, not validated). Lets us exercise the full P2P swap + bond flow —
 * including the walk/forfeit path — deterministically without a live node. Ported from pearl-swap.
 */
export class ScriptedChainClient implements ChainClient {
  readonly name: string;
  readonly network: BTC_NETWORK;
  readonly broadcasts: string[] = [];
  private height = 0;
  private stopped = false;
  private bcastN = 0;
  private lockups = new Map<string, LockupFunding>();
  private spends = new Map<string, SpendDetection>();

  constructor(network: BTC_NETWORK, name = 'scripted') {
    this.network = network;
    this.name = name;
  }

  // ---- test controls ----
  setHeight(n: number): void {
    this.height = n;
  }
  injectLockup(address: string, funding: LockupFunding): void {
    this.lockups.set(address, funding);
  }
  injectSpend(utxo: UtxoRef, spend: SpendDetection): void {
    this.spends.set(`${utxo.txid}:${utxo.vout}`, spend);
  }

  // ---- ChainClient ----
  async getBlockHeight(): Promise<number> {
    return this.height;
  }
  async getTransaction(): Promise<{ hex: string; status: TxStatus } | null> {
    return null;
  }
  async estimateFeeSatPerVbyte(): Promise<number> {
    return 1;
  }
  async broadcast(txHex: string): Promise<string> {
    this.broadcasts.push(txHex);
    return `scripted-tx-${++this.bcastN}`;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  async watchForLockup(
    address: string,
    _minConfs: number,
    opts: { pollMs?: number; timeoutMs?: number } = {},
  ): Promise<LockupFunding> {
    return this.poll(() => this.lockups.get(address), opts, `lockup ${address}`);
  }
  async watchForSpend(
    utxo: UtxoRef,
    opts: { pollMs?: number; timeoutMs?: number } = {},
  ): Promise<SpendDetection> {
    return this.poll(() => this.spends.get(`${utxo.txid}:${utxo.vout}`), opts, `spend ${utxo.txid}`);
  }

  private async poll<T>(
    get: () => T | undefined,
    opts: { pollMs?: number; timeoutMs?: number },
    what: string,
  ): Promise<T> {
    const pollMs = opts.pollMs ?? 5;
    const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;
    while (!this.stopped) {
      const v = get();
      if (v !== undefined) return v;
      if (Date.now() > deadline) throw new Error(`scripted watch timed out: ${what}`);
      await sleep(pollMs);
    }
    throw new Error('scripted client stopped');
  }
}
