# The maker-grief gap: why a plain-HTLC maker commitment bond is impossible

This documents a result we proved while trying to build the "maker commitment bond" (DESIGN.md
§5.4). The short version: **you cannot close the maker-grief gap with hashlock/timelock bonds
alone.** The earlier roadmap framing ("add a bilateral Komodo-style commitment bond") was wrong — a
symmetric bond does not fix it; it just moves the problem. Closing it for real needs a covenant, a
Lightning-style pre-signed penalty, or a coordination-layer (reputation) mitigation.

## The setup

A BTC→PRL swap, original funding order:

1. **Taker** funds the source leg (BTC) **and posts the option bond** (BTC).
2. **Maker** sees that, funds the dest leg (PRL).
3. **Taker** claims dest, revealing the preimage `x` → maker learns `x`, claims source.

The taker holds the option (reveals `x` last), so the taker posts the bond. To penalize a *walk* the
forfeit height must satisfy `bondForfeit < sourceTimeout` (else the taker could refund source, then
safely reveal `x` and reclaim the bond, escaping the penalty).

## The two stalls are on-chain-indistinguishable

There are two ways the swap can stall after step 1:

- **Taker walk** — the maker *did* fund dest (step 2), but the taker never claims it. `x` is never
  revealed.
- **Maker grief** — the maker accepts but *never* funds dest. The taker never claims (there's
  nothing to claim), so `x` is never revealed.

In **both** cases the only on-chain fact is *"`x` was never revealed."* The dest leg lives on the
*other* chain, so a bond on the source chain cannot tell whether the maker funded it. This is the
crux.

## Why the option bond alone leaves a profitable grief

With only the taker's option bond, a maker can: accept → wait for the taker's source+bond → never
fund dest → after `bondForfeit`, claim the forfeited option bond. The maker **profits** the bond
(~1–2%) at the taker's expense. The taker still recovers its source principal (refund), so the loss
is bounded, but the grief is cheap and profitable.

## Why a symmetric maker bond does NOT fix it

Add a maker commitment bond, secret-tied the same way (maker reclaims with `x`, taker forfeits after
timeout). The maker only learns `x` in the happy path, so on any stall the maker can't reclaim and
the taker forfeits it. Tally each scenario with both bonds equal to `B`:

| Scenario | Option bond (taker's) | Commitment bond (maker's) | Taker net | Maker net |
|---|---|---|---|---|
| Happy | taker reclaims | maker reclaims | 0 | 0 |
| **Taker walk** | maker forfeits (+B maker) | taker forfeits (+B taker) | 0 | 0 |
| **Maker grief** | maker forfeits (+B maker) | taker forfeits (+B taker) | 0 | 0 |

The bonds **cancel in every stall** — because the trigger (`x` unrevealed) is identical. So:

- Maker grief is no longer profitable ✓ (maker nets 0, taker nets 0 — the gap we wanted to close).
- **But the taker walk is no longer penalized** ✗ — the taker nets 0 on a walk, so the free option
  is back. We traded one hole for the other.

Symmetric bonds keyed on an indistinguishable trigger are a **dual**, not a fix.

## Why no asymmetric hashlock construction works

To keep the walk penalty *and* deter grief you must distinguish the two stalls on-chain. The only
distinguisher is "did the maker fund dest" — an event on the other chain. HTLC primitives can gate a
spend on (a) a timelock, or (b) knowledge of a secret. A timelock can't tell the stalls apart. And
**grief is an omission** (the maker *doesn't* fund) — an omission reveals no secret, so no
secret-gated leaf can be triggered by it. A second maker secret `z` doesn't help: the maker always
knows its own `z`, so any bond it can reclaim with `z` has no teeth, and any leaf the *taker* can
take with `z` requires the maker to have revealed `z` — which a grieving maker simply won't do.

∴ With plain hashlock + timelock, the maker-grief gap is **not closeable**. (This is a real
impossibility given the primitives, not a missing feature.)

## What actually closes it

1. **OP_CAT covenant (Pearl-specific).** Bind the maker's forfeit of the taker's option bond to a
   transaction shape that *proves the maker funded dest* (e.g. references the dest lockup via
   reconstructed sigmsg). Then a maker that never funded dest literally cannot forfeit the bond. This
   is the one case where the demoted OP_CAT covenant (DESIGN.md §5.5) buys something genuinely
   unavailable elsewhere — still frontier, still optional.
2. **Lightning-style pre-signed penalty.** Make it a stateful, interactive channel-like protocol with
   revocation keys, so misbehavior is punished by a counter-signed penalty tx. A large protocol shift
   away from the simple atomic-swap model; out of scope for v1.
3. **Coordination-layer reputation (shippable now).** The relay can't *prevent* grief
   cryptographically, but it can make it not worth it: track which makers fail to fund dest after a
   match and de-prioritize / refuse repeat offenders. Griefing then costs the maker its standing on
   the venue, which (for an LP that wants flow) exceeds the ~1–2% it could steal. This is a heuristic
   mitigation with the usual reputation caveats (self-reporting can be gamed; needs the relay to
   corroborate via chain observation for anything adversarial), not cryptographic enforcement.

## Decision

v1 ships the **taker option bond** (penalizes the walk, the more common and more damaging abuse) plus
a **coordination-layer reputation mitigation** for maker grief, and documents the residual: a
first-time grief can cost a taker its bond (~1–2%, principal always safe). The cryptographic close is
the OP_CAT covenant — kept as the optional Pearl-specific upgrade where it has unique value, not a v1
dependency. We do **not** ship a symmetric "commitment bond," because it would silently re-open the
free-option hole the option bond exists to close.
