# Maturity & Risk — honest, layer by layer

"Is this battle-tested?" — the answer differs sharply by layer. This document exists so we never
fool ourselves (or anyone we pitch) about what is proven vs. novel vs. experimental.

Summary: **~70% inheriting proven work, ~30% new composition, plus one frontier bet we can defer.**
This is **not** a turnkey existing protocol you redeploy. The closest existing system is
**BasicSwap** (Particl, MIT) — we fork its *ideas* and re-express them for taproot-only Pearl, then
add the bond economics.

---

## Layer 1 — HTLC cross-chain atomic swap: BATTLE-TESTED

- Tier Nolan construction (2013). ~12 years in production.
- Live in Decred↔BTC, Litecoin↔BTC, **BasicSwap**, **Komodo AtomicDEX**.
- This is the trust-critical settlement core, and we **inherit** it (pearl-swap already implements
  the taproot version; BasicSwap is MIT and studiable).
- Risk: low. The primitive is as proven as anything in cross-chain crypto.

## Layer 2 — Forfeitable bonds to kill the free option: LIGHTLY DEPLOYED, NEW CODE

- The *idea* runs in production: Komodo's `bobdeposit` (over-collateralized maker bond) + taker
  `dexfee`. So it's not unprecedented — but on a niche, low-volume DEX, with known weaknesses, not
  at scale.
- The **specific bilateral secret-tied bond** in DESIGN.md §5.3–5.4 is a sensible *composition* of
  proven primitives (hashlock, CLTV, Komodo-style deposits) — but it is **not a single named
  protocol with a track record.** It is new code implementing well-understood ideas.
- Risk: medium. Needs adversarial testing and ideally an external security review. Cannot be pointed
  to as "X has run this for years."

## Layer 3 — `OP_CAT` covenant-enforced bond payout: FRONTIER / EXPERIMENTAL

- `OP_CAT` covenants have been demonstrated in research and on testnets, but `OP_CAT` is **not live
  on Bitcoin mainnet**, and **no production system at scale** settles real value through pure-`OP_CAT`
  sighash-reconstruction covenants.
- On Pearl this is genuinely novel territory.
- Risk: high — **so it is deliberately optional and behind a research spike.** The venue stands on
  Layers 1–2 even if this never ships.

---

## How this shapes engineering

- Lean hard on proven primitives and existing implementations (BasicSwap, pearl-swap) for the
  **trust-critical paths**.
- Keep the **novel parts isolated and heavily tested**: bonds (Layer 2) and covenant (Layer 3) live
  behind clear module boundaries with their own adversarial test suites.
- The covenant is an upgrade, never a dependency. If the prototype spike fails, v1 is unaffected.
- Before mainnet value flows: external security review of the bond logic; conservative bonds/timelocks
  at launch (highest volatility, weakest chain security) tightened as both normalize.

## Existing-systems reference (what we are NOT reinventing)

| System | License | What we take |
|---|---|---|
| BasicSwap (Particl) | MIT | non-custodial P2P architecture, coin-interface abstraction, HTLC + adaptor protocol docs |
| Komodo AtomicDEX / BarterDEX | — | the "both deposit / forfeitable bond" economics, pubkey order-book pattern |
| TDEX (Liquid) | open source | flat-file registry + direct-connect discovery, Request/Accept/Complete/Fail choreography |
| pearl-swap (ours) | — | the taproot atomic-swap settlement engine (refactor LP→coordinator) |

Single-transaction swaps (Liquid/TDEX) are **not** inheritable — they only work because both assets
share one ledger. BTC↔PRL is genuinely cross-chain, so we are in HTLC/adaptor territory with
timelocks and the free-option problem. Wrapping/pegging BTC onto Pearl would remove that, but only by
introducing a federated custodian — which violates the non-custodial goal. We do not wrap.
