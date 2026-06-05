import { describe, it, expect } from 'vitest';
import { pubSchnorr, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
import { bitcoinSignet, pearlSimnet, p2trScript } from '../src/common/index.js';
import { WatchDepositWallet, type DepositRequest } from '../src/client/index.js';
import { ScriptedChainClient } from './helpers/ScriptedChain.js';

// WatchDepositWallet is the non-custodial user funding model: it holds NO key and spends nothing —
// it prompts the user to deposit from their own wallet and watches the chain for it. We simulate the
// user's external send by injecting the lockup into the scripted chain when the deposit is requested.
function user() {
  const priv = randomPrivateKeyBytes();
  return { priv, xonly: pubSchnorr(priv) };
}

describe('WatchDepositWallet (non-custodial user funding)', () => {
  it('funds a lockup by watching for the user external deposit (no key, no spend)', async () => {
    const btc = new ScriptedChainClient(bitcoinSignet, 'btc');
    const u = user();
    const requests: DepositRequest[] = [];

    const wallet = new WatchDepositWallet({
      clients: [btc],
      payoutScripts: [{ network: bitcoinSignet, script: p2trScript(u.xonly, bitcoinSignet) }],
      onDepositRequest: (req) => {
        requests.push(req);
        // The user sends from their own wallet -> the deposit appears on-chain.
        btc.injectLockup(req.address, {
          utxo: { txid: 'de'.repeat(32), vout: 0 },
          amountSat: Number(req.amountSat),
          scriptPubKey: Buffer.from([]),
        });
      },
      pollMs: 2,
    });

    const out = await wallet.fundLockup(bitcoinSignet, 'tb1pexamplelockupaddr', 50_000n);
    expect(out).toEqual({ txid: 'de'.repeat(32), vout: 0, amountSat: 50_000n });
    expect(requests).toEqual([
      { network: bitcoinSignet, address: 'tb1pexamplelockupaddr', amountSat: 50_000n },
    ]);
  });

  it('rejects a deposit short of the required amount', async () => {
    const btc = new ScriptedChainClient(bitcoinSignet, 'btc');
    const u = user();
    const wallet = new WatchDepositWallet({
      clients: [btc],
      payoutScripts: [{ network: bitcoinSignet, script: p2trScript(u.xonly, bitcoinSignet) }],
      onDepositRequest: (req) =>
        btc.injectLockup(req.address, {
          utxo: { txid: 'ab'.repeat(32), vout: 0 },
          amountSat: 10_000, // short
          scriptPubKey: Buffer.from([]),
        }),
      pollMs: 2,
    });
    await expect(wallet.fundLockup(bitcoinSignet, 'tb1pshort', 50_000n)).rejects.toThrow(/short of/);
  });

  it('pays out to the user own address per network; an unknown network throws', () => {
    const u = user();
    const script = p2trScript(u.xonly, pearlSimnet);
    const wallet = new WatchDepositWallet({
      clients: [new ScriptedChainClient(pearlSimnet, 'prl')],
      payoutScripts: [{ network: pearlSimnet, script }],
    });
    expect(Buffer.from(wallet.payoutScript(pearlSimnet))).toEqual(Buffer.from(script));
    expect(() => wallet.payoutScript(bitcoinSignet)).toThrow(/no payout script/);
  });
});
