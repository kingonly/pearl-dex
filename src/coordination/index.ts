// Coordination layer — non-custodial matching + message relay.
//
// Holds no funds, no keys. Stores signed order INTENTS (not deposits), matches crossing intents,
// and routes taker requests to third-party liquidity-provider daemons. Discovery via flat-file
// registry + direct peer connect, so the operator is never a settlement chokepoint (TDEX pattern).
//
// Implemented: the signed-intent + LP types (types.ts).
// TODO (DESIGN.md §6-8): the matcher, the ws relay, the registry, and the P2P coordinator state
// machine + persistent fee-bumped watcher.

export {
  serializeIntent,
  intentDigest,
  signIntent,
  verifyIntent,
  type Pair,
  type Side,
  type OrderIntent,
  type Quote,
  type LiquidityProvider,
} from './types.js';
