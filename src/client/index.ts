// Client — the per-user thing a user actually runs.
//
// It holds the user's identity key + swap Signer + wallet (never shared) and ties the three layers
// together: it posts signed order intents to the relay, runs the settlement handshake with whoever
// it is matched against, and drives its own side of the atomic swap via a SwapExecutor. Neither the
// operator nor the counterparty ever touches these keys.
//
// Two `SwapWallet` implementations ship:
//   - WatchDepositWallet — the NON-CUSTODIAL user model (a pure DEX): the user funds from their own
//     wallet, the app only watches for the deposit and helps assemble the signer-authorized claim.
//   - ReferenceWallet    — the LP/daemon model: holds its own capital + key and funds lockups by
//     spending UTXOs (right for an unattended market-maker, NOT for end users).

export {
  SwapClient,
  type SwapClientConfig,
  type SwapClientDeps,
  type SwapHandle,
} from './SwapClient.js';

export {
  WatchDepositWallet,
  type WatchDepositWalletDeps,
  type DepositRequest,
  type PayoutScript,
} from './WatchDepositWallet.js';

export {
  ReferenceWallet,
  type ReferenceWalletDeps,
  type WalletUtxo,
} from './ReferenceWallet.js';
