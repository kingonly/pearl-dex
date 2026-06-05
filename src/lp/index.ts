// LP — third-party liquidity-provider daemon.
//
// An always-on market maker that posts fresh, inventory-sized resting orders to the relay so takers
// always find a counterparty (the cold-start fix). It brings its own capital and earns the spread;
// the operator never provides liquidity. Built on top of SwapClient, so a fill settles via the same
// non-custodial atomic-swap pipe as any other trade.

export { MarketMaker, type MarketMakerDeps } from './MarketMaker.js';
export {
  SpreadPolicy,
  type PricingPolicy,
  type Inventory,
  type DesiredOrder,
} from './PricingPolicy.js';
