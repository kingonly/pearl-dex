// Coordination layer — non-custodial matching + message relay.
//
// Holds no funds, no keys. Stores signed order INTENTS (not deposits) and relays protocol
// messages between matched peers. Discovery via flat-file registry + direct peer connect, so the
// operator is never a settlement chokepoint (TDEX pattern).
//
// TODO (roadmap step 3, see DESIGN.md §6):
//   - OrderIntent:   { maker_pubkey, pair, side, amount, limit_price, expiry, sig } + verify()
//   - Matcher:       intent-crossing (NOT a custodial CLOB)
//   - Relay:         message transport between matched peers (ws)
//   - Registry:      flat-file directory of relays

export {};
