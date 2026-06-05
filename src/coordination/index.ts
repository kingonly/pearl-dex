// Coordination layer — non-custodial matching + message relay.
//
// Holds no funds, no keys. Stores signed order INTENTS (not deposits), matches crossing intents,
// and routes taker requests to third-party liquidity-provider daemons. Discovery via flat-file
// registry + direct peer connect, so the operator is never a settlement chokepoint (TDEX pattern).
//
// Implemented: the signed-intent + LP types (types.ts); the per-user P2P coordinator state machine
// + persistent, fee-bumped, crash-safe watcher (SwapExecutor.ts + SwapStore.ts); and the operator-
// side matching/relay layer — the crossing matcher (OrderBook.ts), the settlement handshake that
// turns a match into agreed swap terms (Handshake.ts), the transport-abstracted relay (Relay.ts),
// and the flat-file discovery registry (Registry.ts).
// TODO: a real WebSocket adapter over RelayServer; a SwapClient that ties relay + handshake +
// executor together; the third-party LP daemon (repackaged pearl-swap orchestrator).

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

export {
  OrderBook,
  COIN,
  type Match,
  type BookedOrder,
  type SubmitResult,
  type OrderBookConfig,
} from './OrderBook.js';

export {
  deriveAmounts,
  proposeTimeouts,
  validateProposedTimeouts,
  buildSwapParams,
  type SwapNetworks,
  type BondPolicy,
  type SwapAmounts,
  type Heights,
  type ProposedTimeouts,
  type HandshakeMessage,
} from './Handshake.js';

export {
  RelayServer,
  serializeMatch,
  type RelayConnection,
  type ServerMessage,
  type SerializedMatch,
} from './Relay.js';

export { WsRelayServer, connectWsRelay } from './WsRelay.js';

export {
  FileRegistry,
  type RegistryData,
  type RelayEntry,
  type LpEntry,
} from './Registry.js';
