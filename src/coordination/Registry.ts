import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Pair } from './types.js';

/**
 * Flat-file discovery registry (DESIGN.md §6): a directory of known relays and third-party LP
 * daemons. It is a CONVENIENCE directory, not consensus — clients can discover peers and settle
 * without it, and nothing here custodies funds or authorizes trades. Just a JSON list two parties
 * can use to find a relay and the LPs making markets on a pair.
 */

export interface RelayEntry {
  /** how to reach the relay (e.g. wss://relay.example/ws). */
  url: string;
  /** pairs this relay coordinates (empty = unknown/all). */
  pairs?: Pair[];
  note?: string;
}

export interface LpEntry {
  /** how to reach the LP daemon to request a quote / execute. */
  url: string;
  /** pairs this LP makes markets in. */
  pairs?: Pair[];
  /** LP identity (x-only) pubkey hex, if published. */
  pubkeyHex?: string;
}

export interface RegistryData {
  relays: RelayEntry[];
  lps: LpEntry[];
}

const EMPTY: RegistryData = { relays: [], lps: [] };

/** A registry backed by one JSON file. Concurrent writers are not coordinated (single-operator). */
export class FileRegistry {
  constructor(private readonly path: string) {}

  async load(): Promise<RegistryData> {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8')) as Partial<RegistryData>;
      return { relays: data.relays ?? [], lps: data.lps ?? [] };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY };
      throw e;
    }
  }

  private async save(data: RegistryData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(data, null, 2));
  }

  /** Add or update a relay (keyed by url). */
  async addRelay(entry: RelayEntry): Promise<void> {
    const data = await this.load();
    data.relays = upsert(data.relays, entry, (r) => r.url);
    await this.save(data);
  }

  /** Add or update an LP (keyed by url). */
  async addLp(entry: LpEntry): Promise<void> {
    const data = await this.load();
    data.lps = upsert(data.lps, entry, (l) => l.url);
    await this.save(data);
  }

  async removeRelay(url: string): Promise<void> {
    const data = await this.load();
    data.relays = data.relays.filter((r) => r.url !== url);
    await this.save(data);
  }

  async removeLp(url: string): Promise<void> {
    const data = await this.load();
    data.lps = data.lps.filter((l) => l.url !== url);
    await this.save(data);
  }

  /** Relays advertising a given pair (or with no declared pairs). */
  async relaysFor(pair: Pair): Promise<RelayEntry[]> {
    const { relays } = await this.load();
    return relays.filter((r) => !r.pairs?.length || r.pairs.some((p) => samePair(p, pair)));
  }

  /** LPs advertising a given pair (or with no declared pairs). */
  async lpsFor(pair: Pair): Promise<LpEntry[]> {
    const { lps } = await this.load();
    return lps.filter((l) => !l.pairs?.length || l.pairs.some((p) => samePair(p, pair)));
  }
}

const samePair = (a: Pair, b: Pair) => a.base === b.base && a.quote === b.quote;

function upsert<T>(list: T[], entry: T, key: (t: T) => string): T[] {
  const k = key(entry);
  const out = list.filter((x) => key(x) !== k);
  out.push(entry);
  return out;
}
