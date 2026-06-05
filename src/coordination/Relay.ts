import { OrderBook, type Match, type SubmitResult } from './OrderBook.js';
import type { OrderIntent, Pair } from './types.js';

/**
 * The operator-side relay server (DESIGN.md §6). It runs the OrderBook matcher and relays messages
 * between matched peers — and that is ALL it does: it never holds funds, keys, or the swap secret,
 * and it is never a counterparty. When two intents cross it notifies both parties (who is taker /
 * maker, the counterparty's id, the agreed economics); the parties then run the settlement handshake
 * (Handshake.ts) by sending opaque envelopes THROUGH the relay to each other, and settle peer-to-peer
 * via their own SwapExecutors.
 *
 * The transport is abstracted: this in-memory implementation IS the server logic and is what the
 * tests drive; a real WebSocket/libp2p server is a thin adapter that maps sockets to `connect()` and
 * forwards JSON-encoded messages. A party is identified by its x-only identity pubkey (hex) — the
 * same key it signs intents with — so a connection can only submit intents it actually signed.
 */

/** A match as delivered over the wire: bigints as decimal strings, pubkeys as hex. */
export interface SerializedMatch {
  pair: Pair;
  buyerPubHex: string;
  sellerPubHex: string;
  executionPriceSatPerUnit: string;
  fillBaseSat: string;
  fillQuoteSat: string;
}

export type ServerMessage =
  | { type: 'match'; role: 'taker' | 'maker'; counterparty: string; match: SerializedMatch }
  | { type: 'peer'; from: string; payload: unknown };

export interface RelayConnection {
  /** this party's identity (x-only pubkey hex). */
  readonly id: string;
  /** Submit a signed intent. The intent's makerPubkey must match this connection's id. */
  submit(intent: OrderIntent, sig: Uint8Array): SubmitResult;
  /** Relay an opaque handshake envelope to a matched peer. */
  sendTo(peerId: string, payload: unknown): void;
  /** Register the handler for messages pushed to this party. */
  onMessage(handler: (m: ServerMessage) => void): void;
  close(): void;
}

interface Conn extends RelayConnection {
  handler?: (m: ServerMessage) => void;
}

export function serializeMatch(m: Match): SerializedMatch {
  return {
    pair: m.pair,
    buyerPubHex: m.buyerPubHex,
    sellerPubHex: m.sellerPubHex,
    executionPriceSatPerUnit: m.executionPriceSatPerUnit.toString(),
    fillBaseSat: m.fillBaseSat.toString(),
    fillQuoteSat: m.fillQuoteSat.toString(),
  };
}

const hx = (b: Uint8Array) => Buffer.from(b).toString('hex');

export class RelayServer {
  private conns = new Map<string, Conn>();

  constructor(private readonly book: OrderBook) {}

  /** Open a connection for a party identified by its x-only identity pubkey (hex). */
  connect(id: string): RelayConnection {
    const conn: Conn = {
      id,
      submit: (intent, sig) => this.onSubmit(conn, intent, sig),
      sendTo: (peerId, payload) => this.deliver(peerId, { type: 'peer', from: id, payload }),
      onMessage: (handler) => {
        conn.handler = handler;
      },
      close: () => {
        if (this.conns.get(id) === conn) this.conns.delete(id);
      },
    };
    this.conns.set(id, conn);
    return conn;
  }

  private onSubmit(conn: Conn, intent: OrderIntent, sig: Uint8Array): SubmitResult {
    // A connection may only submit intents under its own identity (prevents spoofing other parties).
    if (hx(intent.makerPubkey) !== conn.id) {
      return { accepted: false, reason: 'intent identity does not match connection', matches: [] };
    }
    const result = this.book.submit(intent, sig);
    for (const m of result.matches) this.notifyMatch(m);
    return result;
  }

  /**
   * Tell both matched parties about the cross (each learns its role + the counterparty). The MAKER
   * is notified first: the taker initiates the settlement handshake, so the maker must be ready to
   * receive the taker's first envelope.
   */
  private notifyMatch(m: Match): void {
    const sm = serializeMatch(m);
    this.deliver(m.sellerPubHex, {
      type: 'match',
      role: 'maker',
      counterparty: m.buyerPubHex,
      match: sm,
    });
    this.deliver(m.buyerPubHex, {
      type: 'match',
      role: 'taker',
      counterparty: m.sellerPubHex,
      match: sm,
    });
  }

  private deliver(to: string, msg: ServerMessage): void {
    this.conns.get(to)?.handler?.(msg);
  }
}
