// Live market-data demo: starts the WS relay + serves web/, and simulates makers quoting and
// takers crossing so the dashboard (web/dashboard.html) shows a live book + trade tape.
// Pure market-data generation — posts signed intents directly to the relay; no settlement/chains.
//
//   node scripts/market-demo.mjs    (relay :8730, dashboard http://127.0.0.1:8731/dashboard.html)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomPrivateKeyBytes, pubSchnorr } from '@scure/btc-signer/utils.js';
import { OrderBook, RelayServer, WsRelayServer, signIntent } from '../dist/src/coordination/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', 'web');
const COIN = 100_000_000n;
const PRL_BTC = { base: 'PRL', quote: 'BTC' };

const book = new OrderBook({ pairs: [PRL_BTC], minFeeBps: 10 });
const relay = new RelayServer(book);
await WsRelayServer.start(relay, 8730);

// static file server for the dashboard / landing page
createServer(async (req, res) => {
  const path = (req.url === '/' ? '/dashboard.html' : req.url).split('?')[0];
  try {
    const body = await readFile(join(WEB, path));
    res.writeHead(200, { 'content-type': path.endsWith('.html') ? 'text/html' : 'text/plain' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(8731);

// ── simulation ──────────────────────────────────────────────────────────────
let nonce = 0;
const makers = Array.from({ length: 4 }, () => {
  const priv = randomPrivateKeyBytes();
  return { priv, xonly: pubSchnorr(priv), conn: null };
});
makers.forEach((m) => (m.conn = relay.connect(Buffer.from(m.xonly).toString('hex'))));
const taker = (() => {
  const priv = randomPrivateKeyBytes();
  const xonly = pubSchnorr(priv);
  return { priv, xonly, conn: relay.connect(Buffer.from(xonly).toString('hex')) };
})();

const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
let mid = 50_000;

function post(party, side, coins, price) {
  const intent = {
    makerPubkey: party.xonly,
    pair: PRL_BTC,
    side,
    amountSat: BigInt(coins) * COIN,
    limitPriceSatPerUnit: BigInt(price),
    feeBps: 20,
    expiry: 9_999_999_999,
    nonce: `n${nonce++}`,
  };
  party.conn.submit(intent, signIntent(intent, party.priv));
}

let tick = 0;
setInterval(() => {
  tick++;
  mid = Math.max(40_000, Math.min(60_000, mid + rnd(-250, 250)));
  // each maker refreshes a quote near mid
  const m = makers[tick % makers.length];
  const spread = rnd(150, 600);
  post(m, 'sell', rnd(1, 5), mid + spread + rnd(0, 400));
  post(m, 'buy', rnd(1, 5), mid - spread - rnd(0, 400));
  // every few ticks a taker crosses the book -> a trade prints
  if (tick % 3 === 0) {
    const buy = Math.random() > 0.5;
    post(taker, buy ? 'buy' : 'sell', rnd(1, 3), buy ? mid + 1200 : mid - 1200);
  }
}, 700);

console.log('market demo: relay ws://127.0.0.1:8730 · dashboard http://127.0.0.1:8731/dashboard.html');
