import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { FileRegistry, type Pair } from '../src/coordination/index.js';

const PRL_BTC: Pair = { base: 'PRL', quote: 'BTC' };
const OTHER: Pair = { base: 'USD', quote: 'BTC' };

let n = 0;
function regPath() {
  return join(tmpdir(), `pearl-dex-reg-${process.pid}-${n++}.json`);
}

describe('FileRegistry — flat-file discovery', () => {
  it('round-trips relays and LPs, upserting by url', async () => {
    const path = regPath();
    const reg = new FileRegistry(path);
    try {
      expect(await reg.load()).toEqual({ relays: [], lps: [] }); // missing file -> empty

      await reg.addRelay({ url: 'wss://r1/ws', pairs: [PRL_BTC] });
      await reg.addLp({ url: 'https://lp1', pairs: [PRL_BTC], pubkeyHex: 'ab' });
      await reg.addRelay({ url: 'wss://r1/ws', note: 'updated' }); // same url -> update, not dupe

      const data = await reg.load();
      expect(data.relays).toHaveLength(1);
      expect(data.relays[0]).toMatchObject({ url: 'wss://r1/ws', note: 'updated' });
      expect(data.lps).toHaveLength(1);
      expect(data.lps[0].pubkeyHex).toBe('ab');
    } finally {
      await rm(path, { force: true });
    }
  });

  it('filters by pair (empty pairs = matches anything) and removes entries', async () => {
    const path = regPath();
    const reg = new FileRegistry(path);
    try {
      await reg.addRelay({ url: 'wss://prl', pairs: [PRL_BTC] });
      await reg.addRelay({ url: 'wss://other', pairs: [OTHER] });
      await reg.addRelay({ url: 'wss://any' }); // no pairs -> matches all

      const forPrl = await reg.relaysFor(PRL_BTC);
      expect(forPrl.map((r) => r.url).sort()).toEqual(['wss://any', 'wss://prl']);

      await reg.removeRelay('wss://prl');
      expect((await reg.relaysFor(PRL_BTC)).map((r) => r.url)).toEqual(['wss://any']);
    } finally {
      await rm(path, { force: true });
    }
  });
});
