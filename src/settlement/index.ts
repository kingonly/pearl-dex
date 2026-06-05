// Settlement layer — cross-chain atomic swap + forfeitable bonds.
//
// Ported/refactored from pearl-swap's taproot atomic-swap engine, with the key change:
// the orchestrator is a COORDINATOR driving two external user wallets, not an LP counterparty
// holding both sides.
//
// TODO (roadmap step 1–2, see DESIGN.md §5, §9):
//   - SwapTree:      taproot output w/ hashlock-claim + timelock-refund leaves (port pearl-swap)
//   - Bond:          secret-tied bond output (reclaim-via-preimage / forfeit-on-timeout leaves)
//   - Timelocks:     cross-chain safety inequality T_btc > T_prl + Δ (port pearl-swap/Timelocks)
//   - Orchestrator:  coordinator state machine (DESIGN.md §7), watching two user wallets
//   - Watcher:       persistent, idempotent, restart-safe, fee-bumped (SAFETY-critical here)

export {};
