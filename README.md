# pearl-dex

A **trustless, non-custodial, peer-to-peer exchange** between **Pearl (PRL)** and **Bitcoin (BTC)**.

- **Users are both sides of the market.** Makers and takers bring the liquidity; the operator never holds funds, never quotes prices, never provides liquidity.
- **Off-chain matching, on-chain settlement.** Orders are signed *intents*, not deposits. Settlement is a trustless on-chain atomic swap — neither party can steal, principal is protected by hashlock + timelock.
- **Forfeitable bonds** tied to the swap secret neutralize the *free-option problem* that has historically killed atomic-swap DEXs.

> Pearl uniquely enables `OP_CAT` in tapscript (Bitcoin mainnet doesn't), which *could* hard-bind the operator fee in consensus. On review this is **not a dependency and not the moat** — the venue is plain taproot; the fee is enforced operationally via the LP registry; defensibility is liquidity + UX + being the default venue. An `OP_CAT` covenant is parked as an optional future demo, not a roadmap item. See `DESIGN.md` §5.5.

> Sibling to [`pearl-swap`](https://github.com/kingonly/pearl-swap) (the liquidity-provider swap engine) and [`pearl-lightning`](https://github.com/kingonly/pearl-lightning) (Lightning on Pearl). pearl-dex reuses pearl-swap's proven taproot atomic-swap settlement core, refactored from an LP counterparty into a pure non-custodial coordinator of two user wallets.

## Status

All three layers are built and tested end-to-end (43 tests, typecheck clean): a user posts a signed order and the swap settles on-chain — funded by real transactions from a user wallet — with the operator never touching funds.

- **Done:** ported atomic-swap primitives (`SwapTree`, `Timelocks`, `Funder`, `ChainClient`); the secret-tied `Bond`; the `SwapPlan` two-user layout; the operator `Fee` + signed `OrderIntent`s; the **P2P coordinator** — a crash-safe, idempotent, fee-bumped (RBF) state machine (`SwapExecutor` + `SwapStore`); the **matching/relay layer** — crossing matcher (`OrderBook`, price-time priority, partial fills, fee/expiry/signature gates), settlement handshake (`Handshake`), transport-abstracted relay (`RelayServer`), flat-file discovery registry (`FileRegistry`); the **per-user client** (`SwapClient`) — the one object a user runs, tying relay + handshake + executor together with crash-recovery (`resume()`); and a reference **`SwapWallet`** (`ReferenceWallet`) that funds lockups with real key-path taproot transactions and manages its own UTXO pool + change. E2Es drive the **whole pipe**: two `SwapClient`s post crossing signed orders → the relay matches them → handshake *through* the relay → both derive byte-identical terms → executors settle on-chain (maker learns the preimage from the chain); a wallet E2E settles a full two-party swap with real funding txs; plus coordinator E2Es (taker walk → maker forfeit, counterparty-no-fund → refund + bond reclaim, restart/resume, RBF bump) and matcher/handshake/registry/wallet unit tests.
- **Next (only piece left for a live run):** real `PearlClient`/`BitcoinClient` `ChainClient`s over pearld/bitcoind RPC (portable from pearl-swap), then a live simnet/signet run; a WebSocket adapter over `RelayServer` (relay logic done — socket plumbing); the third-party LP daemon (repackaged pearl-swap orchestrator); the maker commitment bond (closes the documented forfeit-griefing gap). The `OP_CAT` covenant remains an optional later PoC, not a dependency. See `DESIGN.md` §9.

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
