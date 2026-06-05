import { describe, it, expect } from 'vitest';
import { pubECDSA, pubSchnorr, randomPrivateKeyBytes, sha256 } from '@scure/btc-signer/utils.js';
import { bitcoinSignet, pearlSimnet, p2trAddress } from '../src/common/index.js';
import { PEARL_TIMING, SIGNET_TIMING } from '../src/settlement/index.js';
import {
  deriveAmounts,
  proposeTimeouts,
  validateProposedTimeouts,
  buildSwapParams,
  type Match,
  type Heights,
} from '../src/coordination/index.js';

const COIN = 100_000_000n;
const hx = (b: Uint8Array) => Buffer.from(b).toString('hex');

function fakeMatch(fillBaseCoins: number, priceSat: number): Match {
  const fillBaseSat = BigInt(fillBaseCoins) * COIN;
  const buy = { makerPubkey: new Uint8Array(32) } as Match['buy'];
  const sell = { makerPubkey: new Uint8Array(32) } as Match['sell'];
  return {
    pair: { base: 'PRL', quote: 'BTC' },
    buy,
    sell,
    executionPriceSatPerUnit: BigInt(priceSat),
    fillBaseSat,
    fillQuoteSat: (fillBaseSat * BigInt(priceSat)) / COIN,
    buyerPubHex: '00',
    sellerPubHex: '01',
  };
}

const NETWORKS = { base: pearlSimnet, quote: bitcoinSignet };
const HEIGHTS: Heights = { quoteHeight: 100, baseHeight: 100 };
const timingArgs = { heights: HEIGHTS, quoteTiming: SIGNET_TIMING, baseTiming: PEARL_TIMING };

describe('Handshake — match → agreed swap terms', () => {
  it('derives leg amounts and a bonded fraction of the quote value', () => {
    const m = fakeMatch(1, 50_000); // 1 PRL @ 50_000 BTC-sats
    const a = deriveAmounts(m, { bps: 150, minSat: 1_000n });
    expect(a.destSat).toBe(COIN); // PRL the maker funds
    expect(a.sourceSat).toBe(50_000n); // BTC the taker funds
    expect(a.bondSat).toBe((50_000n * 150n) / 10_000n > 1_000n ? (50_000n * 150n) / 10_000n : 1_000n);
  });

  it('places the bond forfeit before the source timeout and (in wall-clock) after the dest', () => {
    const t = proposeTimeouts(timingArgs);
    expect(t.destTimeoutHeight).toBeGreaterThan(HEIGHTS.baseHeight);
    expect(t.sourceTimeoutHeight).toBeGreaterThan(HEIGHTS.quoteHeight);
    // bond + source are both on the BTC chain -> raw height comparison is valid.
    expect(t.bondForfeitHeight).toBeLessThan(t.sourceTimeoutHeight); // walk is penalizable
    // bond (BTC) vs dest (PRL) is cross-chain -> compare wall-clock; encoded by validate not throwing.
    expect(() => validateProposedTimeouts({ ...timingArgs, timeouts: t })).not.toThrow();
  });

  it('validates safe timeouts and rejects tampered ones', () => {
    const t = proposeTimeouts(timingArgs);
    expect(() =>
      validateProposedTimeouts({ ...timingArgs, timeouts: t }),
    ).not.toThrow();

    // Source timeout pulled in close to current height -> too little wall-clock margin over dest.
    expect(() =>
      validateProposedTimeouts({
        ...timingArgs,
        timeouts: { ...t, sourceTimeoutHeight: HEIGHTS.quoteHeight + 50 },
      }),
    ).toThrow();

    // Bond forfeit after the source timeout -> the taker could escape the penalty.
    expect(() =>
      validateProposedTimeouts({
        ...timingArgs,
        timeouts: { ...t, bondForfeitHeight: t.sourceTimeoutHeight + 1 },
      }),
    ).toThrow();
  });

  it('both parties derive byte-identical swap params from the same inputs', () => {
    const taker = pubECDSA(randomPrivateKeyBytes(), true);
    const maker = pubECDSA(randomPrivateKeyBytes(), true);
    const preimageHashHex = hx(sha256(randomPrivateKeyBytes()));
    const m = fakeMatch(1, 50_000);
    const timeouts = proposeTimeouts(timingArgs);

    const args = {
      match: m,
      networks: NETWORKS,
      takerSwapPubHex: hx(taker),
      makerSwapPubHex: hx(maker),
      preimageHashHex,
      timeouts,
    };
    const fromTaker = buildSwapParams(args);
    const fromMaker = buildSwapParams(args);
    expect(fromTaker).toEqual(fromMaker);
    expect(fromTaker.sourceNetwork).toBe('bitcoinSignet'); // BTC = source/quote
    expect(fromTaker.destNetwork).toBe('pearlSimnet'); // PRL = dest/base
    expect(fromTaker.bondNetwork).toBe('bitcoinSignet');
  });

  it('commits the operator fee output when a fee policy is supplied', () => {
    const m = fakeMatch(10, 50_000); // 10 PRL
    const opAddr = p2trAddress(pubSchnorr(randomPrivateKeyBytes()), pearlSimnet);
    const params = buildSwapParams({
      match: m,
      networks: NETWORKS,
      takerSwapPubHex: hx(pubECDSA(randomPrivateKeyBytes(), true)),
      makerSwapPubHex: hx(pubECDSA(randomPrivateKeyBytes(), true)),
      preimageHashHex: hx(sha256(randomPrivateKeyBytes())),
      timeouts: proposeTimeouts(timingArgs),
      fee: { operatorAddress: opAddr, network: pearlSimnet, bps: 20, minSat: 100n },
    });
    expect(params.operatorFee).toBeDefined();
    // 20 bps of 10 PRL (10 * COIN) = 0.20% = 2_000_000 sats, above the 100 floor.
    expect(params.operatorFee!.amountSat).toBe(((10n * COIN * 20n) / 10_000n).toString());
  });
});
