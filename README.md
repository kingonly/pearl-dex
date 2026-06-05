# pearl-dex

A **trustless, non-custodial, peer-to-peer exchange** between **Pearl (PRL)** and **Bitcoin (BTC)**.

- **Users are both sides of the market.** Makers and takers bring the liquidity; the operator never holds funds, never quotes prices, never provides liquidity.
- **Off-chain matching, on-chain settlement.** Orders are signed *intents*, not deposits. Settlement is a trustless on-chain atomic swap — neither party can steal, principal is protected by hashlock + timelock.
- **Forfeitable bonds** tied to the swap secret neutralize the *free-option problem* that has historically killed atomic-swap DEXs.
- **Leverages Pearl's `OP_CAT`** (enabled in tapscript — Bitcoin mainnet lacks it) to enforce bond payouts in consensus. This layer is optional and research-gated; the venue stands without it.

> Sibling to [`pearl-swap`](https://github.com/kingonly/pearl-swap) (the liquidity-provider swap engine) and [`pearl-lightning`](https://github.com/kingonly/pearl-lightning) (Lightning on Pearl). pearl-dex reuses pearl-swap's proven taproot atomic-swap settlement core, refactored from an LP counterparty into a pure non-custodial coordinator of two user wallets.

## Status

Settlement core + the free-option bond are built and tested (10 tests, typecheck clean).

- **Done:** ported atomic-swap primitives (`SwapTree`, `Timelocks`, `Funder`, `ChainClient`); the new secret-tied `Bond`; the `SwapPlan` two-user layout; a full two-user BTC→PRL E2E (happy + walk/forfeit paths) against scripted in-memory chains with real transaction construction.
- **Next:** P2P coordinator state machine + persistent fee-bumped watcher (`src/coordination`), the maker commitment bond, live simnet/signet E2E, then the matching/relay server. See `DESIGN.md` §9.

**Read [`DESIGN.md`](./DESIGN.md) for the protocol** and [`MATURITY.md`](./MATURITY.md) for an honest, layer-by-layer assessment of what is battle-tested vs. novel vs. experimental.

## Architecture

| Layer | Responsibility | Custody |
|---|---|---|
| `src/coordination` | Order intake (signed intents), matching, message relay, flat-file registry | none |
| `src/settlement` | Cross-chain atomic swap + bonds (ported/refactored from pearl-swap) | none — funds locked in user-controlled HTLCs |
| `src/client` | Per-user wallet that custodies keys and executes its leg | self-custody |
| `src/common` | Shared types, Pearl/BTC network params, tapscript helpers | — |

## Stack

TypeScript (ESM, NodeNext), `@scure/btc-signer` via `boltz-core`, vitest. Node ≥ 20.10.

```bash
npm install
npm test
npm run typecheck
```
