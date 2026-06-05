import { WebSocketServer, type WebSocket as WsServerSocket } from 'ws';
import { RelayServer } from './Relay.js';
import type { MarketEvent, RelayConnection, ServerMessage } from './Relay.js';
import type { OrderIntent, Pair, Side } from './types.js';
import type { SubmitResult } from './OrderBook.js';

/**
 * WebSocket transport for the relay. `RelayServer` is pure in-memory routing; this layers a real
 * socket on top so separate parties (separate machines/processes) can connect to one operator.
 * Still non-custodial: the wire carries only signed intents and opaque handshake envelopes.
 *
 * A client authenticates by sending its identity pubkey (hex) in a `hello`; the server binds that
 * socket to `RelayServer.connect(id)` and forwards each routed ServerMessage back over the socket.
 * The client side (`connectWsRelay`) implements the same `RelayConnection` interface SwapClient
 * already uses, so nothing downstream changes. The server uses the `ws` package; the client uses
 * Node's built-in global `WebSocket`.
 */

interface WireIntent {
  makerPubkey: string;
  pair: Pair;
  side: Side;
  amountSat: string;
  limitPriceSatPerUnit: string;
  feeBps: number;
  expiry: number;
  nonce: string;
}

type ClientMsg =
  | { t: 'hello'; id: string }
  | { t: 'submit'; intent: WireIntent; sig: string }
  | { t: 'peer'; to: string; payload: unknown }
  | { t: 'subscribe' }; // market-data subscription (no identity needed)

type ServerEnvelope = { t: 'server'; msg: ServerMessage } | { t: 'md'; ev: MarketEvent };

const hx = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));

function encodeIntent(o: OrderIntent): WireIntent {
  return {
    makerPubkey: hx(o.makerPubkey),
    pair: o.pair,
    side: o.side,
    amountSat: o.amountSat.toString(),
    limitPriceSatPerUnit: o.limitPriceSatPerUnit.toString(),
    feeBps: o.feeBps,
    expiry: o.expiry,
    nonce: o.nonce,
  };
}

function decodeIntent(w: WireIntent): OrderIntent {
  return {
    makerPubkey: unhex(w.makerPubkey),
    pair: w.pair,
    side: w.side,
    amountSat: BigInt(w.amountSat),
    limitPriceSatPerUnit: BigInt(w.limitPriceSatPerUnit),
    feeBps: w.feeBps,
    expiry: w.expiry,
    nonce: w.nonce,
  };
}

/** The operator's WebSocket relay endpoint, wrapping a RelayServer. */
export class WsRelayServer {
  private constructor(
    private readonly wss: WebSocketServer,
    readonly port: number,
    private readonly relay: RelayServer,
  ) {}

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  /** Start listening (port 0 = ephemeral); resolves once bound. */
  static start(relay: RelayServer, port = 0): Promise<WsRelayServer> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port });
      wss.on('error', reject);
      wss.on('listening', () => {
        const addr = wss.address();
        const boundPort = typeof addr === 'object' && addr ? addr.port : port;
        const server = new WsRelayServer(wss, boundPort, relay);
        wss.on('connection', (ws) => server.onConnection(ws));
        resolve(server);
      });
    });
  }

  private onConnection(ws: WsServerSocket): void {
    let conn: RelayConnection | null = null;
    let unsubMd: (() => void) | null = null;
    ws.on('message', (data) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(data.toString()) as ClientMsg;
      } catch {
        return;
      }
      if (msg.t === 'subscribe') {
        if (!unsubMd) {
          unsubMd = this.relay.subscribeMarketData((ev) =>
            ws.send(JSON.stringify({ t: 'md', ev } satisfies ServerEnvelope)),
          );
        }
        return;
      }
      if (msg.t === 'hello') {
        if (conn) return; // already bound
        conn = this.relay.connect(msg.id);
        conn.onMessage((m) => ws.send(JSON.stringify({ t: 'server', msg: m } satisfies ServerEnvelope)));
        return;
      }
      if (!conn) return; // must hello first
      if (msg.t === 'submit') conn.submit(decodeIntent(msg.intent), unhex(msg.sig));
      else if (msg.t === 'peer') conn.sendTo(msg.to, msg.payload);
    });
    ws.on('close', () => {
      conn?.close();
      unsubMd?.();
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}

/**
 * Connect to a WsRelayServer as `id`, returning a RelayConnection that behaves like the in-memory
 * one. `submit` is fire-and-forget over the socket and returns optimistically (accepted, no inline
 * matches) — matches arrive asynchronously as `match` ServerMessages, which is how SwapClient
 * already drives the flow. Resolves once the socket is open and the hello is sent.
 */
export function connectWsRelay(url: string, id: string): Promise<RelayConnection> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let handler: ((m: ServerMessage) => void) | undefined;
    const queue: ServerMessage[] = [];

    ws.addEventListener('message', (ev: MessageEvent) => {
      let env: ServerEnvelope;
      try {
        env = JSON.parse(String(ev.data)) as ServerEnvelope;
      } catch {
        return;
      }
      if (env.t !== 'server') return;
      if (handler) handler(env.msg);
      else queue.push(env.msg); // buffer until onMessage is registered
    });
    ws.addEventListener('error', () => reject(new Error('ws relay connect failed')));
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ t: 'hello', id } satisfies ClientMsg));
      const conn: RelayConnection = {
        id,
        submit(intent, sig): SubmitResult {
          ws.send(JSON.stringify({ t: 'submit', intent: encodeIntent(intent), sig: hx(sig) } satisfies ClientMsg));
          return { accepted: true, matches: [] };
        },
        sendTo(peerId, payload) {
          ws.send(JSON.stringify({ t: 'peer', to: peerId, payload } satisfies ClientMsg));
        },
        onMessage(h) {
          handler = h;
          while (queue.length) h(queue.shift()!);
        },
        close() {
          ws.close();
        },
      };
      resolve(conn);
    });
  });
}
