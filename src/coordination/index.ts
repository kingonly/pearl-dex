// Coordination layer — non-custodial matching + message relay.
//
// Holds no funds, no keys. Stores signed order INTENTS (not deposits), matches crossing intents,
// and routes taker requests to third-party liquidity-provider daemons. Discovery via flat-file
// registry + direct peer connect, so the operator is never a settlement chokepoint (TDEX pattern).
//
// Implemented: the signed-intent + LP types (types.ts); the per-user P2P coordinator state machine
// + persistent, fee-bumped, crash-safe watcher (SwapExecutor.ts + SwapStore.ts) that drives a
// SwapPlan to completion for one party.
// TODO (DESIGN.md §6-8): the intent matcher, the ws relay, and the flat-file registry (the
// operator-side discovery/crossing service that feeds agreed terms into two parties' executors).

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

export {
  SwapExecutor,
  newTakerRecord,
  newMakerRecord,
  type SwapWallet,
  type ExecutorPolicy,
  type SwapExecutorDeps,
} from './SwapExecutor.js';

export {
  MemorySwapStore,
  FileSwapStore,
  type SwapStore,
  type SwapRecord,
  type SwapRole,
  type SwapPhase,
  type SwapParamsJSON,
  type AbortReason,
  type UtxoRecord,
} from './SwapStore.js';
