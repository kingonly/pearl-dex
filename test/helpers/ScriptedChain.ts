import { Address, OutScript, Transaction } from '@scure/btc-signer';
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
 * height and injecting lockups; the protocol builds REAL transactions against it. A broadcast
 * is parsed and AUTO-LINKED — every input it spends is recorded as a spend of that outpoint, so
 * a counterparty's `watchForSpend`/`getSpend` resolves and can extract the revealed preimage.
 * This lets two SwapExecutors (taker + maker) interact through the same scripted chains and
 * exercises the full P2P swap + bond flow — including walk/forfeit — deterministically.
 * Ported from pearl-swap, extended for the coordinator e2e.
 */
export class ScriptedChainClient implements ChainClient {
  readonly name: string;
  readonly network: BTC_NETWORK;
  readonly broadcasts: string[] = [];
  private height = 0;
  private stopped = false;
  private lockups = new Map<string, LockupFunding>();
  private spends = new Map<string, SpendDetection>();
  /** broadcast txid -> raw hex; all broadcasts are treated as confirmed at the current height. */
  private txs = new Map<string, string>();
  private feeRate = 1;
  /** number of upcoming broadcasts whose tx should report as UNCONFIRMED (to force a fee bump). */
  private withholdN = 0;
  private unconfirmed = new Set<string>();

  constructor(network: BTC_NETWORK, name = 'scripted') {
    this.network = network;
    this.name = name;
  }

  // ---- test controls ----
  setHeight(n: number): void {
    this.height = n;
  }
  setFeeRate(satPerVbyte: number): void {
    this.feeRate = satPerVbyte;
  }
  injectLockup(address: string, funding: LockupFunding): void {
    this.lockups.set(address, funding);
  }
  injectSpend(utxo: UtxoRef, spend: SpendDetection): void {
    this.spends.set(key(utxo), spend);
  }
  /** Make the next `n` broadcasts report as unconfirmed, so the executor RBF-bumps the fee. */
  withholdBroadcasts(n: number): void {
    this.withholdN = n;
  }

  // ---- ChainClient ----
  async getBlockHeight(): Promise<number> {
    return this.height;
  }
  async getTransaction(txid: string): Promise<{ hex: string; status: TxStatus } | null> {
    const hex = this.txs.get(txid);
    if (!hex) return null;
    if (this.unconfirmed.has(txid)) return { hex, status: { confirmed: false, confirmations: 0 } };
    return { hex, status: { confirmed: true, confirmations: 1, blockHeight: this.height } };
  }
  async estimateFeeSatPerVbyte(): Promise<number> {
    return this.feeRate;
  }
  async broadcast(txHex: string): Promise<string> {
    this.broadcasts.push(txHex);
    const tx = Transaction.fromRaw(Buffer.from(txHex, 'hex'), {
      allowUnknownOutputs: true,
      disableScriptCheck: true,
    });
    const txid = tx.id;
    this.txs.set(txid, txHex);
    if (this.withholdN > 0) {
      this.withholdN -= 1;
      this.unconfirmed.add(txid);
    }
    // Auto-link: record every consumed outpoint as spent by this tx, so the counterparty's
    // watch/getSpend resolves and (for a script-path claim) reveals the preimage.
    for (let i = 0; i < tx.inputsLength; i++) {
      const input = tx.getInput(i);
      if (!input.txid) continue;
      const ref: UtxoRef = { txid: hexFrom(input.txid), vout: input.index ?? 0 };
      this.spends.set(key(ref), { spendTxid: txid, spendTxHex: txHex, inputIndex: i });
    }
    // Auto-register: index every output by its address so getLockup() finds wallet-funded lockups
    // (a real chain makes broadcast outputs queryable). p2tr/known outputs only; others skipped.
    for (let i = 0; i < tx.outputsLength; i++) {
      const out = tx.getOutput(i);
      if (!out?.script || out.amount === undefined) continue;
      const addr = addressFromScript(out.script, this.network);
      if (!addr) continue;
      this.lockups.set(addr, {
        utxo: { txid, vout: i },
        amountSat: Number(out.amount),
        scriptPubKey: Buffer.from(out.script),
      });
    }
    return txid;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  async getLockup(address: string, _minConfs: number): Promise<LockupFunding | null> {
    return this.lockups.get(address) ?? null;
  }
  async getSpend(utxo: UtxoRef): Promise<SpendDetection | null> {
    return this.spends.get(key(utxo)) ?? null;
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
    return this.poll(() => this.spends.get(key(utxo)), opts, `spend ${utxo.txid}`);
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

const key = (u: UtxoRef) => `${u.txid}:${u.vout}`;
const hexFrom = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Best-effort address for an output script (p2tr and other standard types); null if undecodable. */
function addressFromScript(script: Uint8Array, network: BTC_NETWORK): string | null {
  try {
    // OutScript.decode's return type isn't structurally identical to Address.encode's param in
    // @scure's types (ArrayBuffer vs SharedArrayBuffer variance); the value is valid at runtime.
    return Address(network).encode(OutScript.decode(script) as Parameters<ReturnType<typeof Address>['encode']>[0]) || null;
  } catch {
    return null;
  }
}
