// Settlement layer — cross-chain atomic swap + forfeitable secret-tied bonds + operator fee.
//
// Ported from pearl-swap's taproot atomic-swap engine (SwapTree, Timelocks, Funder, ChainClient),
// refactored for the non-custodial P2P model: the operator never holds funds; the two USERS drive
// their own legs. New here: Bond (the free-option fix), SwapPlan (the two-user layout), Fee (the
// non-custodial operator fee).
//
// Still TODO (DESIGN.md §5.4, §7, §8, §10): the P2P coordinator state machine + persistent
// fee-bumped watcher (src/coordination), the maker commitment bond, the OP_CAT covenant that
// hard-binds both the bond payout and the fee output.

export type {
  ChainClient,
  UtxoRef,
  WatchOptions,
  TxStatus,
  LockupFunding,
  SpendDetection,
} from './ChainClient.js';

export { RpcChainClient, type RpcConfig, type NormTx } from './RpcChainClient.js';
export { BitcoinClient } from './BitcoinClient.js';
export { PearlClient } from './PearlClient.js';

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

export {
  computeFeeSat,
  buildFeeOutput,
  buildFeeTx,
  type FeePolicy,
} from './Fee.js';

export { buildP2trKeyPathSpend, type KeyPathInput, type TxOutputSpec } from './Funder.js';

export {
  optionValueSat,
  conservativeBondSat,
  SECONDS_PER_YEAR,
  OPTION_VALUE_CONSTANT,
  CONSERVATIVE_ANNUALIZED_VOL,
  CONSERVATIVE_BOND_SAFETY,
} from './FreeOption.js';

export {
  PEARL_TIMING,
  SIGNET_TIMING,
  computeSwapTimeouts,
  computeBondForfeitHeight,
  assertSafeTimeouts,
  assertSafeBondTimeout,
  blocksForDuration,
  secondsForBlocks,
  DEFAULT_SHORT_REFUND_SECONDS,
  DEFAULT_MARGIN_SECONDS,
  type ChainTiming,
  type SwapTimeouts,
} from './Timelocks.js';
