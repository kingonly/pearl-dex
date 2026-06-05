# pearl-dex

A **trustless, non-custodial, peer-to-peer exchange** between **Pearl (PRL)** and **Bitcoin (BTC)**.

- **Users are both sides of the market.** Makers and takers bring the liquidity; the operator never holds funds, never quotes prices, never provides liquidity.
- **Off-chain matching, on-chain settlement.** Orders are signed *intents*, not deposits. Settlement is a trustless on-chain atomic swap — neither party can steal, principal is protected by hashlock + timelock.
- **Forfeitable bonds** tied to the swap secret neutralize the *free-option problem* that has historically killed atomic-swap DEXs.

> Pearl uniquely enables `OP_CAT` in tapscript (Bitcoin mainnet doesn't), which *could* hard-bind the operator fee in consensus. On review this is **not a dependency and not the moat** — the venue is plain taproot; the fee is enforced operationally via the LP registry; defensibility is liquidity + UX + being the default venue. An `OP_CAT` covenant is parked as an optional future demo, not a roadmap item. See `DESIGN.md` §5.5.

> Sibling to [`pearl-swap`](https://github.com/kingonly/pearl-swap) (the liquidity-provider swap engine) and [`pearl-lightning`](https://github.com/kingonly/pearl-lightning) (Lightning on Pearl). pearl-dex reuses pearl-swap's proven taproot atomic-swap settlement core, refactored from an LP counterparty into a pure non-custodial coordinator of two user wallets.

## Status

Every layer — from a signed order to on-chain settlement — is built, tested, and **proven live on real pearld nodes** (47 unit/integration tests + a live on-chain swap test, typecheck clean).

> **Live milestone:** two `SwapClient`s posted crossing signed orders → the relay matched them → handshake over the relay → executors settled a real cross-chain atomic swap against two live pearld simnet nodes. Verified on-chain: dest claim (taker received PRL), source claim (maker learned the preimage *from the chain* and claimed), and bond reclaim — all confirmed, the secret genuinely crossing chains. See `test/live.simnet.test.ts` (skips unless both nodes are up).

- **Done:** ported atomic-swap primitives (`SwapTree`, `Timelocks`, `Funder`, `ChainClient`); the secret-tied `Bond`; the `SwapPlan` two-user layout; the operator `Fee` + signed `OrderIntent`s; the **P2P coordinator** — a crash-safe, idempotent, fee-bumped (RBF) state machine (`SwapExecutor` + `SwapStore`); the **matching/relay layer** — crossing matcher (`OrderBook`, price-time priority, partial fills, fee/expiry/signature gates), settlement handshake (`Handshake`), transport-abstracted relay (`RelayServer`), flat-file discovery registry (`FileRegistry`); the **per-user client** (`SwapClient`) tying relay + handshake + executor together with crash-recovery (`resume()`); a reference **`SwapWallet`** (`ReferenceWallet`) that funds lockups with real key-path taproot transactions; and the **live chain clients** (`PearlClient` over pearld btcd-RPC, `BitcoinClient` over bitcoind Core-RPC, sharing an incremental block-scanning `RpcChainClient`). E2Es drive the **whole pipe**: two `SwapClient`s post crossing signed orders → relay matches → handshake *through* the relay → both derive byte-identical terms → executors settle on-chain (maker learns the preimage from the chain); a wallet E2E settles a full two-party swap with real funding txs; the chain clients are tested against an in-memory JSON-RPC stub (Core `tx` vs btcd `rawtx` shapes, confirmation maturation); plus coordinator E2Es (taker walk → maker forfeit, counterparty-no-fund → refund + bond reclaim, restart/resume, RBF bump) and matcher/handshake/registry/wallet unit tests.
- **Next:** a real BTC↔PRL run once the signet wallet is funded (the `BitcoinClient` is built + unit-tested; only the faucet blocks it); a WebSocket adapter over `RelayServer` (relay logic done — socket plumbing); the third-party LP daemon (repackaged pearl-swap orchestrator); the maker commitment bond (closes the documented forfeit-griefing gap). The `OP_CAT` covenant remains an optional later PoC, not a dependency. See `DESIGN.md` §9.

**Read [`DESIGN.md`](./DESIGN.md) for the protocol** and [`MATURITY.md`](./MATURITY.md) for an honest, layer-by-layer assessment of what is battle-tested vs. novel vs. experimental.

## Architecture

| Layer | Responsibility | Custody |
|---|---|---|
| `src/coordination` | Signed intents, the crossing matcher (`OrderBook`), settlement handshake, relay (`RelayServer`), discovery registry, and the per-user swap coordinator (`SwapExecutor` + `SwapStore`) | none |
| `src/settlement` | Cross-chain atomic swap + bonds (ported/refactored from pearl-swap) | none — funds locked in user-controlled HTLCs |
| `src/client` | `SwapClient` — the one object a user runs: posts intents, runs the handshake, drives its executor; custodies its keys + wallet | self-custody |
| `src/common` | Shared types, Pearl/BTC network params, tapscript helpers | — |

## Stack

TypeScript (ESM, NodeNext), `@scure/btc-signer` via `boltz-core`, vitest. Node ≥ 20.10.

```bash
npm install
npm test
npm run typecheck
```
