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

> The venue does **not** use any of this. Covenants are an optional, deferred PoC (§5.5); v1 and the
> business case stand on plain taproot. This section documents the capability, not a dependency.

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

### 5.4 The maker-grief gap — and why a commitment bond can't close it (corrected)

The maker can also grief: accept the match, wait for the taker to lock source + option bond, then
never fund dest and forfeit-claim the taker's bond (~1–2% profit; the taker's principal is safe via
refund). An earlier draft proposed a symmetric "maker commitment bond" (Komodo "both deposit") as the
fix. **On analysis that is wrong** — see [`docs/maker-grief-analysis.md`](./docs/maker-grief-analysis.md)
for the proof. The two stalls — *taker walk* and *maker never funds dest* — are
**on-chain-indistinguishable** (in both, the preimage is never revealed; the dest leg is on the other
chain). A bond keyed on that trigger fires identically in both, so a symmetric maker bond simply
*cancels* the option bond in the walk case too, re-opening the free option. You cannot gate a
forfeiture on an **omission** (not funding) with hashlocks — omissions reveal no secret.

The real closes: an **OP_CAT covenant** binding the maker's forfeit to proof it funded dest (the one
place the demoted §5.5 covenant has unique value); a **Lightning-style pre-signed penalty** (big
protocol shift); or a **coordination-layer reputation** mitigation (shippable now — the relay
de-prioritizes makers that fail to fund after matching; griefing costs an LP its flow, which exceeds
the bond it could steal). **v1 ships the taker option bond + relay reputation, and does NOT ship a
symmetric commitment bond** (it would silently re-open the free-option hole §5.3 exists to close).

> **Key property:** the bond breaks the safety-vs-window tension. Refund timelocks stay long for
> reorg safety, but because walking forfeits the bond, rational players consummate immediately,
> collapsing the *effective* option window toward one-chain confirmation time. We get the cheap
> corner of the option-cost table by economics, not by weakening safety.

### 5.5 `OP_CAT` enhancement (NOT a dependency — optional future PoC, see MATURITY.md §3)

> **Demoted (2026-06-05).** Originally framed as *the* differentiator; on review it is neither
> needed for safety nor the real moat, so it is off the critical path. v1 — and the venue as a
> whole — is plain taproot. Keep this section as a record of the idea and a possible later spike.

What `OP_CAT` *could* add, and why each turns out to be weak:

1. **Bond-payout binding** — make the forfeit leaf require the spend pay exactly the bond amount to
   the maker, via on-stack BIP-341 sigmsg reconstruction. **Redundant:** the secret-tied bond is
   already self-enforcing. Whoever spends the forfeit leaf *is* the beneficiary (the maker), signing
   for it themselves — there is no third party to cheat, so there is nothing for a covenant to
   enforce. A covenant only matters when the spend must pay someone *other* than the spender.
2. **Hard-bound operator fee** — make the dest-leg claim unspendable unless it pays the fee output
   (see §10.1). This is the *only* unique thing `OP_CAT` buys, and even it is largely covered by the
   realistic liquidity model: an LP simply won't fund the dest leg without a committed fee (§10.1).
   The covenant's unique value is confined to true user-to-user swaps with no LP in the middle.

**Why not depend on it:** it is the single most speculative piece in the project — `OP_CAT`
covenants are not battle-tested at scale anywhere, and ours would be a pure-sigmsg-reconstruction
covenant against Pearl's quirky engine (520-byte cap, 32-bit `OP_ADD`, no `OP_MUL`/`OP_MOD`, no
introspection). The one legitimate reason to build it later is **narrative/credibility** ("look what
Pearl can do that Bitcoin can't") — a marketing/demo artifact for the Pearl relationship, not a
product gate. **v1 ships on §5.3–5.4 with no covenant.**

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
  → taker_locked            (taker locks source leg + posts option bond)
  → maker_locked            (maker locks destination leg)
  → taker_claimed           (taker claims dest, revealing x)
  → maker_claimed           (maker claims source with x)
  → settled

failure branches (all timelock-resolved, NO operator adjudication):
  maker never locks   → taker refunds source; option bond at risk (§5.4 grief gap, reputation-mitigated)
  taker walks         → both refund + maker claims taker option bond
  crash mid-swap      → persistent, fee-bumped watcher completes/refunds idempotently on restart
```

(No `maker_bonded` step: §5.4 shows a maker commitment bond can't be made sound with hashlocks.)

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
2. **Taker option bond** (§5.3) — pure hashlock+CLTV leaves, no covenant. Neutralizes the free option.
3. **Matching + relay server** (§6) — signed intents, crossing, relay; flat-file registry. This is
   also what makes the soft fee real (the operator/LP registry enforces it operationally — §10.1).
4. **Client** for both sides (self-custody wallet + swap executor).
5. **Relay reputation** (§5.4) — mitigate maker grief by de-prioritizing makers that fail to fund
   after matching (a symmetric commitment bond is unsound — see docs/maker-grief-analysis.md).
6. **(Optional, later) `OP_CAT` PoC** — a credibility/demo spike, NOT a roadmap gate. Revisit only
   if there is real volume to defend *and* evidence the soft fee actually leaks. See §5.5.

Steps 1–4 are a working system on Pearl as-is; step 5 hardens it. Step 6 is explicitly optional —
the venue is plain taproot and does not wait on any covenant work.

---

## 10. Monetization & third-party liquidity

The operator earns a **fee on volume** without ever custodying funds, and never provides liquidity
itself. Two mechanisms, designed to coexist.

### 10.1 The operator fee (`src/settlement/Fee.ts`)

A small fee (bps of trade size, with a floor) paid to the operator's address as part of
settlement — the taker bears it. The operator is never in the money flow; the fee is just an
output. Enforcement in tiers:

- **v1 — soft, and the actual plan:** the fee is enforced *operationally*, not in script. `feeBps` is
  a signed field of the `OrderIntent` so it can't be silently stripped (§10.3); the reference client
  includes the fee (an extra output in the dest-leg claim, or a standalone `buildFeeTx` Komodo
  "dexfee" tx); and — the load-bearing part — **the LP/maker won't fund the dest leg without a
  committed fee** (§10.2). Since liquidity comes from registered LP daemons, the operator's fee is a
  relationship with the LP, not something a taker can route around. Defensibility is liquidity
  concentration + UX + being the default venue, not protocol lock-in (an open venue is forkable
  regardless of chain).
- **v2 — hard, OP_CAT, NOT planned (see §5.5):** a covenant *could* make the dest-leg claim
  unspendable unless it pays the fee. This is the only thing a covenant uniquely adds, and it only
  bites in true user-to-user swaps with no LP enforcing the fee. Given the speculative cost of
  `OP_CAT` covenants, this is parked as an optional future PoC, not the fee's moat.

The fee is carried as a committed term of the `SwapPlan` (`operatorFee`), so it travels with the
swap layout both parties derive.

### 10.2 Third-party liquidity providers (`LiquidityProvider`)

Pure P2P has a cold-start / coincidence-of-wants problem: a taker needs a maker wanting the exact
opposite right now. The fix that preserves "operator brings no capital": **let third parties run
market-maker daemons.**

- An LP holds its OWN BTC+PRL liquidity, quotes prices (CFMM or external feed, TDEX-style), and runs
  the **maker side** of the swap. The reference LP daemon repackages **pearl-swap's orchestrator** —
  the liquidity-provider model the operator won't run himself; others run it and bring the capital.
- The operator routes taker requests to registered LPs (`quote()` → best quote wins → execute the
  §5 swap) but never touches funds. The operator fee applies to LP-filled swaps too.
- Result: takers always get filled (LP guarantees liquidity), the operator stays a non-custodial,
  capital-free matchmaker, and the first organic flow (e.g. miners off-ramping PRL→BTC) has a
  counterparty without the operator becoming one.

### 10.3 Signed order intents (`src/coordination/types.ts`)

Orders are **signed intents, never deposits**: `{makerPubkey, pair, side, amount, limitPrice,
feeBps, expiry, nonce}` signed with the maker's BIP-340 key. The fee commitment is inside the
signature, so a match can only be coordinated on fee-bearing terms. The operator stores/relays
intents and matches crossings; it custodies nothing.

### 10.4 Honest economics

Revenue = take-rate × volume, and volume is gated by Pearl's success — this is a **leveraged bet on
Pearl**, side-business-scale until/unless PRL has real volume. The early asset is *owning the default
venue* (strategic/acquisition value, or a token later), not the fee stream. The pure-P2P design
trades away easy monetization and liquidity UX for zero capital; §10.2 (third-party LPs) + owning the
wallet/UX are the levers that make the fee actually materialize. See `docs/free-option-analysis.md`
for why each *trade* is sound; the open risk is *volume*, not the mechanism.
