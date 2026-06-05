// Client — per-user self-custody wallet + swap executor.
//
// Each side runs this; it holds the user's keys and drives that user's leg of the swap.
// Neither the operator nor the counterparty ever touches these keys.
//
// TODO (roadmap step 4, see DESIGN.md §9):
//   - Wallet:    key mgmt + UTXO selection on BTC and PRL
//   - Executor:  lock / claim / refund / bond per the coordinator state machine

export {};
