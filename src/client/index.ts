// Client — the per-user, self-custody thing a user actually runs.
//
// It holds the user's keys + wallet (never shared) and ties the three layers together: it posts
// signed order intents to the relay, runs the settlement handshake with whoever it is matched
// against, and drives its own side of the atomic swap via a SwapExecutor. Neither the operator nor
// the counterparty ever touches these keys.
//
// TODO: a thin WebSocket adapter so `connection` is a real socket; reference wallet implementations
// (BTC + PRL UTXO selection) for `SwapWallet`.

export {
  SwapClient,
  type SwapClientConfig,
  type SwapClientDeps,
  type SwapHandle,
} from './SwapClient.js';

export {
  ReferenceWallet,
  type ReferenceWalletDeps,
  type WalletUtxo,
} from './ReferenceWallet.js';
