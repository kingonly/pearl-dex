# Maturity & Risk — honest, layer by layer

"Is this battle-tested?" — the answer differs sharply by layer. This document exists so we never
fool ourselves (or anyone we pitch) about what is proven vs. novel vs. experimental.

Summary: **~70% inheriting proven work, ~30% new composition.** (An `OP_CAT` covenant was once a
fourth, frontier layer; as of 2026-06-05 it is **dropped from the plan** — neither needed for safety
nor the real moat. See Layer 3 below and DESIGN.md §5.5.)
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

## Layer 3 — `OP_CAT` covenant: DROPPED FROM THE PLAN (optional future PoC only)

- **Not needed for the bond.** The secret-tied bond is self-enforcing — whoever spends the forfeit
  leaf is its beneficiary, so there is nothing for a covenant to enforce (DESIGN.md §5.5).
- **Not the fee's moat.** A covenant could hard-bind the fee output, but the realistic LP-registry
  model already enforces the fee operationally; the covenant only bites in LP-less user-to-user
  swaps. Defensibility is liquidity + UX + default-venue, not script lock-in.
- **Highest risk in the project.** `OP_CAT` covenants are demonstrated in research/testnets but **not
  live on Bitcoin mainnet** and run **no production value at scale** via pure-sighash-reconstruction;
  on Pearl's exact engine it's untrodden. Not worth gating anything on.
- **Kept only as a possible later demo** — "what Pearl can do that Bitcoin can't," a credibility
  artifact for the Pearl relationship, never a dependency. The venue stands fully on Layers 1–2.

---

## How this shapes engineering

- Lean hard on proven primitives and existing implementations (BasicSwap, pearl-swap) for the
  **trust-critical paths**.
- Keep the **novel parts isolated and heavily tested**: the bonds (Layer 2) live behind clear module
  boundaries with their own adversarial test suites.
- No covenant in the plan — the venue is plain taproot. If an `OP_CAT` PoC is ever built, it stays an
  isolated demo, never a dependency.
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
