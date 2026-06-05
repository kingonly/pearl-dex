import { describe, it, expect } from 'vitest';
import { pubECDSA, pubSchnorr, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
import { bitcoinSignet, pearlSimnet, p2trAddress } from '../src/common/index.js';
import { PEARL_TIMING, SIGNET_TIMING } from '../src/settlement/index.js';
import { makePreimage } from '../src/settlement/SwapTree.js';
import { LocalSigner } from '../src/signer/index.js';
import {
  SwapExecutor,
  newTakerRecord,
  newMakerRecord,
  buildSwapParams,
  deriveAmounts,
  proposeTimeouts,
  MemorySwapStore,
  type Match,
  type Pair,
} from '../src/coordination/index.js';
import { ReferenceWallet } from '../src/client/index.js';
import { ScriptedChainClient } from './helpers/ScriptedChain.js';

const PRL_BTC: Pair = { base: 'PRL', quote: 'BTC' };
const COIN = 100_000_000n;
const hx = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('ReferenceWallet', () => {
  it('funds a lockup: lockup at vout 0, change retained, output queryable on-chain', async () => {
    const btc = new ScriptedChainClient(bitcoinSignet, 'btc');
    btc.setHeight(1); // feeRate defaults to 1 sat/vB
    const walletPriv = randomPrivateKeyBytes();
    const wallet = new ReferenceWallet({ walletPrivateKey: walletPriv, clients: [btc] });
    wallet.addUtxo(bitcoinSignet, { txid: '11'.repeat(32), vout: 0, amountSat: 200_000n });

    const lockAddr = p2trAddress(pubSchnorr(randomPrivateKeyBytes()), bitcoinSignet);
    const res = await wallet.fundLockup(bitcoinSignet, lockAddr, 50_000n);

    expect(res.vout).toBe(0);
    expect(res.amountSat).toBe(50_000n);
    expect(btc.broadcasts).toHaveLength(1);

    // The funded output is now queryable at the lockup address with the right amount.
    const lk = await btc.getLockup(lockAddr, 1);
    expect(lk?.amountSat).toBe(50_000);
    expect(lk?.utxo).toEqual({ txid: res.txid, vout: 0 });

    // Change retained = input - lockup - minerFee (154 vB * 1 sat/vB).
    expect(wallet.balance(bitcoinSignet)).toBe(200_000n - 50_000n - 154n);
  });

  it('rejects funding it cannot cover', async () => {
    const btc = new ScriptedChainClient(bitcoinSignet, 'btc');
    const wallet = new ReferenceWallet({ walletPrivateKey: randomPrivateKeyBytes(), clients: [btc] });
    wallet.addUtxo(bitcoinSignet, { txid: '22'.repeat(32), vout: 0, amountSat: 10_000n });
    await expect(wallet.fundLockup(bitcoinSignet, p2trAddress(pubSchnorr(randomPrivateKeyBytes()), bitcoinSignet), 50_000n)).rejects.toThrow(/insufficient/);
  });

  it('drives a full two-party swap end-to-end with real funding transactions', async () => {
    const btc = new ScriptedChainClient(bitcoinSignet, 'btc');
    const prl = new ScriptedChainClient(pearlSimnet, 'prl');
    btc.setHeight(100);
    prl.setHeight(100);

    const taker = { swap: randomPrivateKeyBytes(), wallet: randomPrivateKeyBytes() };
    const maker = { swap: randomPrivateKeyBytes(), wallet: randomPrivateKeyBytes() };

    const match: Match = {
      pair: PRL_BTC,
      buy: { makerPubkey: new Uint8Array(32) } as Match['buy'],
      sell: { makerPubkey: new Uint8Array(32) } as Match['sell'],
      executionPriceSatPerUnit: 50_000n,
      fillBaseSat: COIN,
      fillQuoteSat: 50_000n,
      buyerPubHex: '00',
      sellerPubHex: '01',
    };
    const timeouts = proposeTimeouts({
      heights: { quoteHeight: 100, baseHeight: 100 },
      quoteTiming: SIGNET_TIMING,
      baseTiming: PEARL_TIMING,
    });
    const { preimage, preimageHash } = makePreimage();
    const params = buildSwapParams({
      match,
      networks: { base: pearlSimnet, quote: bitcoinSignet },
      takerSwapPubHex: hx(pubECDSA(taker.swap, true)),
      makerSwapPubHex: hx(pubECDSA(maker.swap, true)),
      preimageHashHex: hx(preimageHash),
      timeouts,
    });
    const amounts = deriveAmounts(match, { bps: 150, minSat: 1_000n });

    // Real wallets, seeded with spendable UTXOs on each chain.
    const takerWallet = new ReferenceWallet({ walletPrivateKey: taker.wallet, clients: [btc, prl] });
    takerWallet.addUtxo(bitcoinSignet, { txid: 'a1'.repeat(32), vout: 0, amountSat: 200_000n });
    const makerWallet = new ReferenceWallet({ walletPrivateKey: maker.wallet, clients: [btc, prl] });
    makerWallet.addUtxo(pearlSimnet, { txid: 'b2'.repeat(32), vout: 0, amountSat: 2n * COIN });

    const FAST = { minConfs: 1, pollMs: 2, bumpAfterMs: 10_000, maxBumps: 2 };
    const takerExec = new SwapExecutor(newTakerRecord({ id: 'w', params, preimage, amounts }), {
      store: new MemorySwapStore(), source: btc, dest: prl, bond: btc, wallet: takerWallet, swapSigner: new LocalSigner(taker.swap), policy: FAST,
    });
    const makerExec = new SwapExecutor(newMakerRecord({ id: 'w', params, amounts }), {
      store: new MemorySwapStore(), source: btc, dest: prl, bond: btc, wallet: makerWallet, swapSigner: new LocalSigner(maker.swap), policy: FAST,
    });

    const [takerRec, makerRec] = await Promise.all([takerExec.run(), makerExec.run()]);

    expect(takerRec.phase).toBe('completed');
    expect(makerRec.phase).toBe('completed');
    expect(makerRec.preimageHex).toBe(hx(preimage)); // maker learned the secret on-chain

    // Real funds moved: the taker spent BTC (source + bond), the maker spent PRL (dest).
    expect(takerWallet.balance(bitcoinSignet)).toBeLessThan(200_000n - 50_000n);
    expect(makerWallet.balance(pearlSimnet)).toBeLessThan(2n * COIN - COIN);
  });
});
