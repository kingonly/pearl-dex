// Settlement layer — cross-chain atomic swap + forfeitable secret-tied bonds.
//
// Ported from pearl-swap's taproot atomic-swap engine (SwapTree, Timelocks, Funder, ChainClient),
// refactored for the non-custodial P2P model: the operator never holds funds; the two USERS drive
// their own legs. New here: Bond (the free-option fix) and SwapPlan (the two-user layout).
//
// Still TODO (DESIGN.md §5.4, §7, §8): the P2P coordinator state machine + persistent fee-bumped
// watcher (lives in src/coordination), and the maker commitment bond.

export type {
  ChainClient,
  UtxoRef,
  WatchOptions,
  TxStatus,
  LockupFunding,
  SpendDetection,
} from './ChainClient.js';

export {
  buildSwapLeg,
  buildClaimTx,
  buildRefundTx,
  makePreimage,
  extractPreimage,
  type SwapLeg,
  type BuildLegParams,
  type LockupUtxo,
} from './SwapTree.js';

export {
  buildBond,
  buildBondReclaimTx,
  buildBondForfeitTx,
  type Bond,
  type BuildBondParams,
} from './Bond.js';

export { buildSwapPlan, type SwapPlan, type SwapPlanParams, type Participant } from './SwapPlan.js';

export { buildP2trKeyPathSpend, type KeyPathInput, type TxOutputSpec } from './Funder.js';

export {
  PEARL_TIMING,
  SIGNET_TIMING,
  computeSwapTimeouts,
  computeBondForfeitHeight,
  assertSafeTimeouts,
  blocksForDuration,
  secondsForBlocks,
  type ChainTiming,
  type SwapTimeouts,
} from './Timelocks.js';
