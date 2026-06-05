import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pubSchnorr, randomPrivateKeyBytes } from '@scure/btc-signer/utils.js';
import { bitcoinSignet, p2trAddress } from '../src/common/index.js';
import { BitcoinClient } from '../src/settlement/index.js';

/**
 * Live read-path validation of BitcoinClient against a real bitcoind signet node (Core RPC shapes,
 * block fetch + parse, fee estimate). Skips unless the node is reachable. Proves the BTC client
 * works against actual Bitcoin, not just the in-memory stub — the last unverified surface before a
 * real BTC↔PRL run (which additionally needs signet's ~10-min blocks and bitcoind -txindex).
 */

function envFor(): { user: string; pass: string; port: number } | null {
  try {
    const txt = readFileSync(join(homedir(), 'pearl-swap', 'backends', 'bitcoind.env'), 'utf8');
    const get = (k: string) => txt.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
    const user = get('BTC_RPC_USER');
    const pass = get('BTC_RPC_PASS');
    const port = Number(get('BTC_RPC_PORT'));
    if (!user || !pass || !port) return null;
    return { user, pass, port };
  } catch {
    return null;
  }
}

const env = envFor();
const client = env
  ? new BitcoinClient({ host: '127.0.0.1', port: env.port, user: env.user, pass: env.pass, scanLookback: 4 }, bitcoinSignet)
  : null;

let online = false;
try {
  online = client !== null && (await client.getBlockHeight()) > 0;
} catch {
  online = false;
}

describe.skipIf(!online)('LIVE: BitcoinClient against real bitcoind signet', () => {
  it('reads the synced tip', async () => {
    const h = await client!.getBlockHeight();
    expect(h).toBeGreaterThan(300_000); // signet is well past this
  });

  it('scans real blocks and returns null for an unfunded address (no throw)', async () => {
    const addr = p2trAddress(pubSchnorr(randomPrivateKeyBytes()), bitcoinSignet);
    const lk = await client!.getLockup(addr, 1); // scans the last few real signet blocks
    expect(lk).toBeNull();
  }, 30_000);

  it('estimates a fee floor', async () => {
    const rate = await client!.estimateFeeSatPerVbyte();
    expect(rate).toBeGreaterThanOrEqual(1);
  });
});
