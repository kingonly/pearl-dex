# pearl-dex — Protocol Design

A trustless, non-custodial, peer-to-peer exchange between **Pearl (PRL)** and **Bitcoin (BTC)**.
The operator runs only matching + coordination; it never custodies funds, quotes prices, or
provides liquidity. Liquidity comes from the two sides of the market.

This document is the protocol spec. For an honest maturity/risk breakdown see `MATURITY.md`.

---

## 1. Goals and non-goals

**Goals**
- Non-custodial: no party (including the operator) ever holds another party's funds.
- Trustless settlement: principal is protected cryptographically (hashlock + timelock); a
  counterparty can at worst waste your time, never steal your money.
- Operator carries **zero inventory and zero float** — it is infrastructure, not a market maker.
- Economically sound per-trade: the **free-option problem** is neutralized by forfeitable bonds,
  so makers are not bled by adverse selection.

**Non-goals**
- Not a custodial exchange (no KYC/MTL surface from holding funds).
- Not a wrapped/pegged-asset bridge (that reintroduces a federated custodian — see Liquid's peg).
- Not an on-chain order book or AMM (Pearl is UTXO/taproot, no smart-contract layer).
- No price oracle in v1 — makers set their own limit prices; the venue only matches intents.

---

## 2. Trust model

| Party | Can they steal funds? | Can they grief (waste time/lock capital)? |
|---|---|---|
| Operator | **No** — never holds keys or funds | Can refuse to relay (route around it; direct connect supported) |
| Counterparty | **No** — HTLC protects principal | Yes, but **forfeits a bond** for doing so |

The only residual counterparty risk is *griefing* (locking your capital for a timeout window or
exercising the price option by walking). Both are made **costly** via bonds (§5), not merely
detected.

---

## 3. Pearl tapscript capabilities (confirmed from `~/pearl/node/txscript/opcode.go`)

- **`OP_CAT` — ENABLED** in tapscript (BIP-347). 520-byte element cap; cost-metered. Bitcoin
  mainnet does **not** have this.
- **`OP_CHECKXMSSSIG`** (post-quantum XMSS sig verification) — not used here.
- **`OP_ADD` / `OP_SUB` — enabled**, but only at Bitcoin's ~32-bit `CScriptNum` width.
- **Disabled:** `OP_MUL`, `OP_DIV`, `OP_MOD`, `OP_LSHIFT`, `OP_RSHIFT`, bitwise ops,
  `OP_SUBSTR/LEFT/RIGHT`. → **no in-script big-integer or proportional arithmetic.**
- **Standard BIP-341** taproot sighash, Schnorr signatures, all SIGHASH flags. Byte-compatible
  with Bitcoin's taproot.
- **No** `OP_CHECKSIGFROMSTACK`, **no** introspection opcodes (`OP_INSPECT*`), **no** streaming SHA256.

**Implication:** Covenants are possible via the pure-`OP_CAT` sighash-reconstruction technique
(the BIP-341 sigmsg is only ~210–250 bytes because its sub-hashes are pre-digested, so it fits in
one 520-byte element). But without CSFS or wide arithmetic, covenants are limited to
**equality / concatenation / field-pinning** constraints — enough to bind an output's amount and
destination, not enough for in-script proportional math.

Pearl is **taproot-only** (no legacy/segwit-v0). Every lock/refund/HTLC is expressed as P2TR with
tapscript leaves. (pearl-swap already does this — port it.)

---

## 4. Architecture — three layers, strict separation

1. **Coordination layer (the operator).** Registry + message relay. Stores signed order *intents*
   and relays protocol messages between matched peers. Holds no funds, no keys. Discovery via a
   flat-file registry + direct peer connect (TDEX pattern) so the operator is never a censorship
   chokepoint or in the settlement critical path.
2. **Settlement layer.** The cross-chain atomic swap + bonds. This is `pearl-swap`'s proven
   taproot swap engine, refactored from **LP-counterparty** to **coordinator-of-two-user-wallets**.
3. **Client.** Each side runs a wallet that custodies its own keys and drives its leg of the swap.

---

## 5. Settlement protocol

### 5.1 Primitive choice

- **v1: HTLC (hashlock) atomic swap** — the Tier-Nolan construction pearl-swap already implements
  (`SHA256(preimage)`, taproot claim/refund leaves). Battle-tested (~12 years). Ship this first.
- **v2: Schnorr adaptor signatures / PTLCs** — privacy upgrade (unlinkable, smaller; a cooperative
  swap looks like a normal key-path payment). Both chains are secp256k1+Schnorr, so **no cross-curve
  DLEQ** is needed (unlike BTC↔XMR). Drop-in over the same orchestration.

### 5.2 Roles and the swap (BTC→PRL example)

Alice has BTC, wants PRL. Bob (maker) has PRL, wants BTC. Secret preimage `x`, `H = SHA256(x)`.

- Both legs are **MuSig2(Alice, Bob) taproot outputs** with a cooperative key-path spend and
  script-path leaves: a **hashlock-claim** leaf and a **timelock-refund** leaf.
- **Cross-chain timelock safety inequality:**

  ```
  T_btc_refund  >  T_prl_refund + Δ
  ```

  i.e. the leg the preimage-LEARNER claims (BTC) must time out *later* than the leg the recipient
  claims (PRL), by margin Δ. Δ is set by **confirmation / reorg safety on both chains**.
  **The binding input is Pearl's young-chain reorg depth, NOT its 194 s block time** (which is
  faster than Bitcoin's 600 s). As Pearl's hashrate matures, required confirmations drop and Δ
  shrinks — improving the economics over time.

### 5.3 The free-option problem and the secret-tied bond

In any timelocked cross-chain swap, **whoever can walk away after the counterparty has irrevocably
committed holds a free American option** on the price over the window. Here Alice reveals `x` last
(by claiming PRL), so **Alice holds the option**. Option value ≈ `0.4 · σ · √T · S` — for a thin,
volatile new coin this is ~0.3–1.8% of notional (see `docs/free-option-analysis.md`).

**Fix — a forfeitable bond tied to the swap secret.** Alice posts a bond with two tapscript leaves:

```
reclaim leaf : <x> OP_SIZE 32 OP_EQUALVERIFY OP_SHA256 <H> OP_EQUALVERIFY <Alice_pk> OP_CHECKSIG
forfeit leaf : <bond_timeout> OP_CHECKLOCKTIMEVERIFY OP_DROP <Bob_pk> OP_CHECKSIG
               ; bond_timeout ≥ T_prl_refund
```

- If Alice **consummates**, she reveals `x` on-chain anyway → she reclaims her bond (reclaim leaf).
- If Alice **walks** (exercises the option), `x` is never revealed → she cannot reclaim, and Bob
  takes the bond after `bond_timeout`. The forfeited bond **compensates the optioned maker**.

Set bond ≈ option value (~1–2% of notional) and the option is struck deep out-of-the-money;
rational Alice never griefs. **This needs only hashlock + CLTV — Pearl supports it today, no covenant.**

### 5.4 Bilateral bonding (both sides can grief)

Bob can also grief — by not locking PRL after Alice locks BTC, wasting Alice's capital for `T_btc`.
So the **maker posts a commitment bond when accepting the match**, before the taker locks,
forfeitable to the taker if the maker fails to lock his leg. Net: two bonds, each forfeitable to the
counterparty for failing an obligated step; the option-holder's bond additionally absorbs the price
optionality. (This is Komodo's "both deposit" structure, tied to the swap secret + timeouts.)

> **Key property:** the bond breaks the safety-vs-window tension. Refund timelocks stay long for
> reorg safety, but because walking forfeits the bond, rational players consummate immediately,
> collapsing the *effective* option window toward one-chain confirmation time. We get the cheap
> corner of the option-cost table by economics, not by weakening safety.

### 5.5 `OP_CAT` enhancement (optional, research-gated — see MATURITY.md §3)

`OP_CAT` upgrades the bond from convention-enforced to **consensus-enforced**:

1. **Bond-payout binding.** Via on-stack BIP-341 sigmsg reconstruction, the forfeit leaf can require
   that the spending tx pays *exactly* the bond amount to *exactly* the maker's address — removing
   fee-management fragility and edge cases. Field-pinning the outputs hash fits within 520 bytes for
   simple 1–2-output spends.
2. **Atomic claim-or-forfeit.** Bind swap-claim and bond-resolution into one enforced tx shape so no
   one can claim the swap leg while griefing the bond leg.

**Boundary:** covenants here are equality/structure constraints only — `OP_MUL`/`OP_MOD` are
disabled, so no in-script proportional/fee math. Feasibility of the pure-`OP_CAT` construction on
Pearl's exact engine (cost budget, 32-bit `OP_ADD`) is the one genuine unknown → prototype spike
before depending on it. **v1 ships on §5.3–5.4 with no covenant.**

---

## 6. Coordination & matching

- **Orders are signed intents:** `{maker_pubkey, pair, side, amount, limit_price, expiry, sig}`.
  Never deposits. The operator stores and relays them; matching is intent-crossing, not a custodial
  central limit order book.
- **Discovery:** flat-file registry of relays + direct peer connect. Clients can settle without the
  registry — it is a convenience directory, not consensus.
- **No protocol fee path that requires custody.** Operator monetization (if any) is a separate,
  non-custodial concern (e.g. a signed-intent listing/relay fee), out of scope for the settlement spec.

---

## 7. Swap state machine

```
matched
  → maker_bonded            (maker posts commitment bond)
  → taker_locked            (taker locks source leg + posts option bond)
  → maker_locked            (maker locks destination leg)
  → taker_claimed           (taker claims dest, revealing x)
  → maker_claimed           (maker claims source with x)
  → settled

failure branches (all timelock-resolved, NO operator adjudication):
  maker never locks   → taker refunds source + claims maker commitment bond
  taker walks         → both refund + maker claims taker option bond
  crash mid-swap      → persistent, fee-bumped watcher completes/refunds idempotently on restart
```

pearl-swap's `SwapOrchestrator` already encodes most of this state machine; it becomes the
**coordinator** watching two external user wallets instead of holding both sides.

---

## 8. Liveness & the watcher (a safety property)

Both parties must be responsive within their timelock windows. The watcher (chain monitor that
claims/refunds on deadline) must be **persistent, idempotent, restart-safe, and fee-bumped (RBF/CPFP)**
— a missed claim window can leak funds. In pearl-swap this hardening was deferred (Phase 2); here it
is **load-bearing for safety** and part of v1.

---

## 9. Build roadmap

1. **Refactor pearl-swap LP→coordinator.** Orchestrator drives two *separate* user wallets; prove a
   two-user on-chain HTLC swap end-to-end (the swap itself is already proven cross-chain).
2. **Bilateral secret-tied bonds** (§5.3–5.4) — pure hashlock+CLTV leaves, no covenant. Makes the
   venue economically sound.
3. **Matching + relay server** (§6) — signed intents, crossing, relay; flat-file registry.
4. **Client** for both sides (self-custody wallet + swap executor).
5. **Research spike (parallel):** prototype the `OP_CAT` bond-payout covenant against Pearl's actual
   tapscript engine. If it lands → differentiator. If not → v1 stands on steps 1–4.

Steps 1–4 are a working system on Pearl as-is. Step 5 is the part that beats anything vanilla-Bitcoin
could do — isolated as an upgrade, not a dependency.
