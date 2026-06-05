import { pubSchnorr, sha256 } from '@scure/btc-signer/utils.js';
import type { Signer } from '../signer/index.js';
import type { ChainClient } from '../settlement/ChainClient.js';
import type { ChainTiming } from '../settlement/Timelocks.js';
import { makePreimage } from '../settlement/SwapTree.js';
import type { FeePolicy } from '../settlement/Fee.js';
import {
  buildSwapParams,
  deriveAmounts,
  proposeTimeouts,
  validateProposedTimeouts,
  signIntent,
  SwapExecutor,
  newTakerRecord,
  newMakerRecord,
  type BondPolicy,
  type ExecutorPolicy,
  type HandshakeMessage,
  type Match,
  type OrderIntent,
  type Pair,
  type RelayConnection,
  type SerializedMatch,
  type ServerMessage,
  type Side,
  type SwapStore,
  type SwapRecord,
  type SwapWallet,
  type SwapNetworks,
} from '../coordination/index.js';

/**
 * The per-user client — the one thing a user actually runs. It ties the three layers together for
 * its owner: it posts signed order intents to the operator's relay, runs the settlement handshake
 * with whoever it is matched against, and then drives its own side of the atomic swap via a
 * SwapExecutor. It is fully self-custodial: the user's keys and the SwapWallet live here and never
 * leave; the operator/relay only ever sees signed intents and opaque handshake envelopes.
 *
 * This is the production home of the orchestration first proven in test/relay.e2e.test.ts. Both
 * matched clients derive byte-identical swap terms from the handshake (buildSwapParams is
 * deterministic), so they compute the same lockup addresses and settle peer-to-peer.
 *
 * Restart-safety: in-flight swaps are SwapExecutor records in the SwapStore; `resume()` reloads and
 * relaunches every non-terminal one. A crash DURING the handshake (before any executor record is
 * persisted) loses only an un-started swap — nothing is on-chain yet, so it is safe to drop.
 */

export interface SwapClientConfig {
  /** which chains back the pair: `base` = base-asset (PRL) chain, `quote` = BTC chain. */
  networks: SwapNetworks;
  /** option-bond sizing. */
  bond: BondPolicy;
  /** timing of the quote (BTC) chain. */
  quoteTiming: ChainTiming;
  /** timing of the base (PRL) chain. */
  baseTiming: ChainTiming;
  /** operator fee committed into each swap (optional). */
  fee?: FeePolicy;
  /** executor tuning (poll intervals, fee-bump, etc.). */
  executorPolicy?: ExecutorPolicy;
  /** timeout-proposal knobs (maker side). */
  shortRefundSeconds?: number;
  marginSeconds?: number;
}

export interface SwapClientDeps {
  /** this client's link to the operator's relay (bound to its identity pubkey). */
  connection: RelayConnection;
  /** identity key — signs order intents (BIP-340 schnorr). */
  identityPrivateKey: Uint8Array;
  /**
   * swap signer — authority over this user's swap legs / bond, through the Signer seam (a held key
   * via LocalSigner, or a remote/Privy signer that only signs hashes). Never custodies funds: legs
   * always pay out to `wallet.payoutScript`. This is what lets a browser user sign without the app
   * holding their key.
   */
  swapSigner: Signer;
  wallet: SwapWallet;
  /** quote (BTC) chain client = the swap's SOURCE/bond leg. */
  source: ChainClient;
  /** base (PRL) chain client = the swap's DEST leg. */
  dest: ChainClient;
  /** defaults to `source` (bond is on the quote chain). */
  bond?: ChainClient;
  store: SwapStore;
  config: SwapClientConfig;
  log?: (msg: string) => void;
}

/** A live swap this client is driving. */
export interface SwapHandle {
  id: string;
  role: 'taker' | 'maker';
  params: SwapRecord['params'];
  done: Promise<SwapRecord>;
}

interface Pending {
  id: string;
  role: 'taker' | 'maker';
  match: Match;
  counterparty: string;
  /** taker only: the secret it generated. */
  preimage?: { preimage: Uint8Array; preimageHash: Uint8Array };
}

const hx = (b: Uint8Array) => Buffer.from(b).toString('hex');

export class SwapClient {
  /** identity (x-only) pubkey hex — the id the relay binds this connection to. */
  readonly id: string;
  private readonly swapPubHex: string;
  private readonly pending = new Map<string, Pending>(); // keyed by counterparty id
  private readonly handles = new Map<string, SwapHandle>(); // keyed by swap id
  private readonly completeHandlers: ((r: SwapRecord) => void)[] = [];

  constructor(private readonly deps: SwapClientDeps) {
    this.id = hx(pubSchnorr(deps.identityPrivateKey));
    this.swapPubHex = hx(deps.swapSigner.publicKey());
    if (deps.connection.id !== this.id) {
      throw new Error('relay connection id does not match this client identity');
    }
  }

  /** Begin handling relay messages (matches + handshake envelopes). */
  start(): void {
    this.deps.connection.onMessage((m) => {
      void this.handle(m);
    });
  }

  /** Build, sign and submit an order intent through the relay. */
  placeOrder(o: {
    pair: Pair;
    side: Side;
    amountSat: bigint;
    limitPriceSatPerUnit: bigint;
    feeBps: number;
    expiry: number;
    nonce: string;
  }) {
    const intent: OrderIntent = {
      makerPubkey: pubSchnorr(this.deps.identityPrivateKey),
      pair: o.pair,
      side: o.side,
      amountSat: o.amountSat,
      limitPriceSatPerUnit: o.limitPriceSatPerUnit,
      feeBps: o.feeBps,
      expiry: o.expiry,
      nonce: o.nonce,
    };
    return this.deps.connection.submit(intent, signIntent(intent, this.deps.identityPrivateKey));
  }

  /** Register a callback fired when any swap this client drives reaches a terminal phase. */
  onSwapComplete(handler: (record: SwapRecord) => void): void {
    this.completeHandlers.push(handler);
  }

  /** Active swaps this client is driving. */
  activeSwaps(): SwapHandle[] {
    return [...this.handles.values()];
  }

  /**
   * Reload and relaunch every non-terminal swap from the store (crash recovery). Call once on
   * startup before `start()`. Each executor is itself idempotent, so re-running is safe.
   */
  async resume(): Promise<SwapHandle[]> {
    const records = await this.deps.store.list();
    const resumed: SwapHandle[] = [];
    for (const rec of records) {
      if (isTerminal(rec.phase) || this.handles.has(rec.id)) continue;
      resumed.push(this.launch(rec));
    }
    return resumed;
  }

  // ---- internals ----

  private async handle(m: ServerMessage): Promise<void> {
    if (m.type === 'match') return this.onMatch(m);
    return this.onPeer(m);
  }

  private async onMatch(m: ServerMessage & { type: 'match' }): Promise<void> {
    const match = matchFromWire(m.match);
    const id = swapId(m.match);
    const p: Pending = { id, role: m.role, match, counterparty: m.counterparty };
    this.pending.set(m.counterparty, p);

    if (m.role === 'taker') {
      p.preimage = makePreimage();
      // Let both 'match' notifications land before initiating the handshake.
      await Promise.resolve();
      this.send(m.counterparty, {
        type: 'taker_init',
        swapPubHex: this.swapPubHex,
        preimageHashHex: hx(p.preimage.preimageHash),
      });
    }
  }

  private async onPeer(m: ServerMessage & { type: 'peer' }): Promise<void> {
    const p = this.pending.get(m.from);
    if (!p) {
      this.log(`dropping handshake from unknown/unmatched peer ${m.from}`);
      return;
    }
    const msg = m.payload as HandshakeMessage;
    const heights = {
      quoteHeight: await this.deps.source.getBlockHeight(),
      baseHeight: await this.deps.dest.getBlockHeight(),
    };
    const { quoteTiming, baseTiming, shortRefundSeconds, marginSeconds } = this.deps.config;

    if (msg.type === 'taker_init' && p.role === 'maker') {
      const timeouts = proposeTimeouts({ heights, quoteTiming, baseTiming, shortRefundSeconds, marginSeconds });
      this.send(m.from, { type: 'maker_ack', swapPubHex: this.swapPubHex, timeouts });
      const params = buildSwapParams({
        match: p.match,
        networks: this.deps.config.networks,
        takerSwapPubHex: msg.swapPubHex,
        makerSwapPubHex: this.swapPubHex,
        preimageHashHex: msg.preimageHashHex,
        timeouts,
        fee: this.deps.config.fee,
      });
      const amounts = deriveAmounts(p.match, this.deps.config.bond);
      this.pending.delete(m.from);
      this.launch(newMakerRecord({ id: p.id, params, amounts }));
    } else if (msg.type === 'maker_ack' && p.role === 'taker') {
      validateProposedTimeouts({ heights, quoteTiming, baseTiming, timeouts: msg.timeouts, minMarginSeconds: marginSeconds });
      const params = buildSwapParams({
        match: p.match,
        networks: this.deps.config.networks,
        takerSwapPubHex: this.swapPubHex,
        makerSwapPubHex: msg.swapPubHex,
        preimageHashHex: hx(p.preimage!.preimageHash),
        timeouts: msg.timeouts,
        fee: this.deps.config.fee,
      });
      const amounts = deriveAmounts(p.match, this.deps.config.bond);
      this.pending.delete(m.from);
      this.launch(newTakerRecord({ id: p.id, params, preimage: p.preimage!.preimage, amounts }));
    } else {
      this.log(`unexpected handshake ${msg.type} for role ${p.role}`);
    }
  }

  /** Build the executor for a record and start driving it; tracks the handle and fires completion. */
  private launch(record: SwapRecord): SwapHandle {
    const exec = new SwapExecutor(record, {
      store: this.deps.store,
      source: this.deps.source,
      dest: this.deps.dest,
      bond: this.deps.bond ?? this.deps.source,
      wallet: this.deps.wallet,
      swapSigner: this.deps.swapSigner,
      policy: this.deps.config.executorPolicy,
      log: this.deps.log,
    });
    const done = exec.run().then((rec) => {
      for (const h of this.completeHandlers) h(rec);
      return rec;
    });
    const handle: SwapHandle = { id: record.id, role: record.role, params: record.params, done };
    this.handles.set(record.id, handle);
    return handle;
  }

  private send(to: string, payload: HandshakeMessage): void {
    this.deps.connection.sendTo(to, payload);
  }

  private log(msg: string): void {
    this.deps.log?.(`[client ${this.id.slice(0, 8)}] ${msg}`);
  }
}

function isTerminal(phase: SwapRecord['phase']): boolean {
  return phase === 'completed' || phase === 'refunded' || phase === 'failed';
}

/** Reconstruct the minimal Match the handshake needs from the wire form. */
function matchFromWire(sm: SerializedMatch): Match {
  return {
    pair: sm.pair,
    buy: { makerPubkey: Uint8Array.from(Buffer.from(sm.buyerPubHex, 'hex')) } as Match['buy'],
    sell: { makerPubkey: Uint8Array.from(Buffer.from(sm.sellerPubHex, 'hex')) } as Match['sell'],
    executionPriceSatPerUnit: BigInt(sm.executionPriceSatPerUnit),
    fillBaseSat: BigInt(sm.fillBaseSat),
    fillQuoteSat: BigInt(sm.fillQuoteSat),
    buyerPubHex: sm.buyerPubHex,
    sellerPubHex: sm.sellerPubHex,
  };
}

/**
 * Deterministic swap id both parties compute identically (the SwapStore record key). Derived from
 * the match economics + both identities, so each side keys the same swap. (Two identical repeated
 * trades between the same pair of parties would collide — acceptable for v1; add a match nonce later.)
 */
function swapId(sm: SerializedMatch): string {
  const canonical = [
    sm.pair.base,
    sm.pair.quote,
    sm.buyerPubHex,
    sm.sellerPubHex,
    sm.executionPriceSatPerUnit,
    sm.fillBaseSat,
    sm.fillQuoteSat,
  ].join('|');
  return hx(sha256(new TextEncoder().encode(canonical))).slice(0, 32);
}
