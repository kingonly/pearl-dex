import { describe, it, expect } from 'vitest';
import { pubSchnorr, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
import { bitcoinSignet, pearlSimnet, p2trAddress, addressToScript } from '../src/common/index.js';
import { BitcoinClient, PearlClient } from '../src/settlement/index.js';

// The real chain backends are down, so we drive the REAL clients (Core + btcd verbose parsing,
// normalizeTx, and the base incremental scanner) against an in-memory JSON-RPC stub by overriding
// the protected `call`. This covers the chain-specific RPC shapes (tx vs rawtx, verbose flag) and
// the getLockup/getSpend cursor + confirmation-maturation logic.

interface RawTx {
  txid: string;
  hex: string;
  vin?: { txid?: string; vout?: number }[];
  vout?: { value: number; n: number; scriptPubKey?: { hex: string } }[];
}
interface Model {
  height: number;
  blocks: Map<number, RawTx[]>; // height -> txs
  mempool: RawTx[];
}

function dispatch(model: Model, shape: 'core' | 'btcd', method: string, params: unknown[]): unknown {
  switch (method) {
    case 'getblockcount':
      return model.height;
    case 'getblockhash':
      return `h${params[0]}`;
    case 'getblock': {
      const h = Number(String(params[0]).slice(1));
      const txs = model.blocks.get(h) ?? [];
      return shape === 'core' ? { tx: txs } : { rawtx: txs };
    }
    case 'getrawtransaction': {
      const txid = params[0] as string;
      for (const [h, txs] of model.blocks) {
        const t = txs.find((x) => x.txid === txid);
        if (t) return { ...t, confirmations: model.height - h + 1 };
      }
      const m = model.mempool.find((x) => x.txid === txid);
      if (m) return { ...m, confirmations: 0 };
      throw new Error('-5 No information available about transaction');
    }
    case 'getrawmempool':
      return model.mempool.map((t) => t.txid);
    default:
      throw new Error(`unexpected RPC ${method}`);
  }
}

class FakeBitcoin extends BitcoinClient {
  constructor(public model: Model) {
    super({ host: 'x', port: 1, user: 'u', pass: 'p' }, bitcoinSignet);
  }
  protected async call<T>(method: string, params: unknown[] = []): Promise<T> {
    return dispatch(this.model, 'core', method, params) as T;
  }
}
class FakePearl extends PearlClient {
  constructor(public model: Model) {
    super({ host: 'x', port: 1, user: 'u', pass: 'p' }, pearlSimnet);
  }
  protected async call<T>(method: string, params: unknown[] = []): Promise<T> {
    return dispatch(this.model, 'btcd', method, params) as T;
  }
}

const lockupAddr = (net: typeof bitcoinSignet) => {
  const addr = p2trAddress(pubSchnorr(randomPrivateKeyBytes()), net);
  return { addr, scriptHex: Buffer.from(addressToScript(addr, net)).toString('hex') };
};

describe('RpcChainClient (BitcoinClient / PearlClient ports)', () => {
  it('getLockup finds a funding output and waits for it to reach minConfs', async () => {
    const { addr, scriptHex } = lockupAddr(bitcoinSignet);
    const model: Model = {
      height: 100,
      blocks: new Map([[100, [{ txid: 'f1', hex: 'aa', vout: [{ value: 0.0005, n: 0, scriptPubKey: { hex: scriptHex } }] }]]]),
      mempool: [],
    };
    const c = new FakeBitcoin(model);

    // At tip=100 the funding has 1 conf; minConfs 2 -> not yet.
    expect(await c.getLockup(addr, 2)).toBeNull();
    // A new block matures it (now 2 confs) — returned from the remembered hit, no re-scan needed.
    model.height = 101;
    const lk = await c.getLockup(addr, 2);
    expect(lk).not.toBeNull();
    expect(lk!.utxo).toEqual({ txid: 'f1', vout: 0 });
    expect(lk!.amountSat).toBe(50_000); // 0.0005 * 1e8
  });

  it('getSpend detects a spend in the mempool and in a block', async () => {
    const model: Model = { height: 200, blocks: new Map(), mempool: [] };
    const c = new FakeBitcoin(model);
    const target = { txid: 'src', vout: 0 };

    expect(await c.getSpend(target)).toBeNull();

    // Mempool spend.
    model.mempool = [{ txid: 'claim', hex: 'bb', vin: [{ txid: 'src', vout: 0 }] }];
    const m = await c.getSpend(target);
    expect(m).toMatchObject({ spendTxid: 'claim', inputIndex: 0 });

    // Block spend of a different outpoint.
    const other = { txid: 'src2', vout: 1 };
    model.blocks.set(199, [{ txid: 'r', hex: 'cc', vin: [{ txid: 'zzz' }, { txid: 'src2', vout: 1 }] }]);
    const b = await c.getSpend(other);
    expect(b).toMatchObject({ spendTxid: 'r', inputIndex: 1 });
  });

  it('getTransaction reports confirmations; unknown txids are null', async () => {
    const model: Model = {
      height: 105,
      blocks: new Map([[100, [{ txid: 'tx1', hex: 'deadbeef', vout: [] }]]]),
      mempool: [],
    };
    const c = new FakeBitcoin(model);
    const got = await c.getTransaction('tx1');
    expect(got).toMatchObject({ hex: 'deadbeef', status: { confirmed: true, confirmations: 6 } });
    expect(await c.getTransaction('nope')).toBeNull();
  });

  it('PearlClient parses btcd block shape (rawtx) for getLockup', async () => {
    const { addr, scriptHex } = lockupAddr(pearlSimnet);
    const model: Model = {
      height: 50,
      blocks: new Map([[50, [{ txid: 'p1', hex: 'ab', vout: [{ value: 1, n: 0, scriptPubKey: { hex: scriptHex } }] }]]]),
      mempool: [],
    };
    const c = new FakePearl(model);
    const lk = await c.getLockup(addr, 1);
    expect(lk).not.toBeNull();
    expect(lk!.utxo).toEqual({ txid: 'p1', vout: 0 });
    expect(lk!.amountSat).toBe(100_000_000); // 1 PRL
  });
});
