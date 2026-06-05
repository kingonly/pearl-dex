# Free-option economics — does the math close?

The question that decides viability: can timelocks + a bond be tuned so the per-trade free-option
cost is smaller than the spread a maker charges anyway? If yes, each trade is economically sound and
the rest is engineering + go-to-market.

## Model

The free option ≈ an at-the-money option on the PRL/BTC price over the window the option-holder can
still walk. ATM approximation:

```
V / S  ≈  0.4 · σ · √T
```

`S` = notional, `σ` = annualized volatility, `T` = option window (years). Order-of-magnitude, not a
pricing engine; consistent with Han et al. (AFT'19) ~1–2.3% for ETH/BTC over multi-hour windows.

## The window T

```
T  ≈  max( BTC_confs × 600s ,  PRL_confs × 194s )  + coordination overhead
```

The binding input is **Pearl's young-chain reorg depth** (how many confs to be double-spend-safe),
**not** the 194 s block time (faster than Bitcoin's 600 s). T lands realistically in **30 min – 2 h**,
Pearl-dominated at launch, and **shrinks as Pearl's hashrate matures**.

## Per-trade option cost (`V/S = 0.4 · σ · √T`)

| window T | σ = 75% | σ = 150% | σ = 300% |
|---|---|---|---|
| 30 min  | 0.23% | 0.45% | 0.91% |
| 60 min  | 0.32% | 0.64% | 1.28% |
| 120 min | 0.45% | 0.91% | 1.81% |

Range ~0.23% (benign) to ~1.8% (brutal: 300%-vol launch coin × 2 h young-chain window). Center
~0.5–1%.

## Does the spread cover it?

A maker on a thin new pair quotes a **wide** spread regardless — 1.5–3%+ is normal for illiquid
pairs. Un-bonded, the math already roughly closes except in the brutal corner. **Bonded**, it closes
comfortably: the bond converts the *free* option into a *paid* one, struck near `V`, so the residual
adverse-selection cost collapses and the forfeited bond compensates the maker when walking happens.

## Verdict

The free-option math is **not** the dealbreaker — it closes with short effective windows
(forced by the bond) + a modest 1–2% forfeitable bond + the wide spread a thin pair gets anyway, and
it improves as the chain matures. **The real existential risk is cold-start liquidity** (whether a
two-sided market forms on a thin coin), not the option math.

### Caveats (in order of how much to worry)
1. **Launch volatility dominates and is worst exactly when you need it least.** Economics are
   backwards for bootstrapping: hardest at t=0, easier later. Launch with conservative bonds/spreads.
2. **Pearl reorg security is an input, not a constant.** Low launch hashrate → more confs → larger T
   → larger bonds. Get the real hashrate/difficulty trajectory to replace assumed conf-counts.
3. **Bond friction may thin an already-thin book.** Every taker locks a bond for the window.
4. **None of this conjures counterparties.** Safe + fairly-priced ≠ liquid.
