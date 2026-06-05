import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { NetworkTag } from '../common/networks.js';

/**
 * Persistence for the coordinator. The executor is a crash-safe, idempotent state machine
 * (SwapExecutor.ts); its only durable state is the SwapRecord, which it re-loads on restart to
 * resume exactly where it left off. Everything in a record is JSON-serializable — pubkeys,
 * hashes and scripts as hex, sats as decimal strings, networks as tags (NOT the params object) —
 * so the on-chain plan can be deterministically re-derived after a process restart.
 *
 * The operator that runs a relay never sees these records: each is the PRIVATE state of one
 * user's own executor (taker or maker). Custody never enters the coordination layer.
 */

export type SwapRole = 'taker' | 'maker';

/**
 * The lifecycle phase, marking the furthest COMPLETED step. `run()` switches on this and
 * continues; every step persists the phase only after its on-chain action is durable, so a
 * crash mid-step re-runs that step (and each step is idempotent). Shared across roles — the role
 * disambiguates which transition each phase drives (see SwapExecutor).
 */
export type SwapPhase =
  | 'created'
  | 'source_funded' // taker funded the source leg
  | 'bond_funded' // taker funded the option bond
  | 'awaiting_counterparty' // taker: waiting for maker's dest lockup; maker: for taker's source+bond
  | 'counterparty_funded' // maker saw taker's source + bond lockups
  | 'dest_funded' // maker funded the dest leg
  | 'both_funded' // taker saw maker's dest lockup; ready to consummate
  | 'preimage_revealed' // taker broadcast the dest claim (preimage is now public)
  | 'source_claimed' // maker claimed the source leg with the preimage
  | 'bond_reclaimed' // taker reclaimed the option bond
  | 'completed' // terminal: swap consummated
  | 'aborting' // a refund path was entered (a timeout fired)
  | 'source_refunded'
  | 'dest_refunded'
  | 'bond_forfeited'
  | 'bond_reclaimed_on_abort'
  | 'refunded' // terminal: funds recovered via refund
  | 'failed'; // terminal: nothing was ever locked, gave up

/** Why an abort path was taken — selects which recovery actions the executor runs. */
export type AbortReason =
  | 'counterparty_no_fund' // counterparty never funded their leg by the deadline
  | 'walk' // this party (taker) chose not to consummate (loses the bond, by design)
  | 'dest_not_claimed'; // maker's view: taker never claimed dest, so taker walked

/** Serializable swap-plan terms; the plan is re-derived from these on resume. */
export interface SwapParamsJSON {
  preimageHashHex: string;
  takerPubHex: string;
  makerPubHex: string;
  sourceNetwork: NetworkTag;
  destNetwork: NetworkTag;
  bondNetwork: NetworkTag;
  sourceTimeoutHeight: number;
  destTimeoutHeight: number;
  bondForfeitHeight: number;
  /** operator fee output committed for this swap (soft-enforced in v1); carried for the record. */
  operatorFee?: { scriptHex: string; amountSat: string };
}

export interface UtxoRecord {
  txid: string;
  vout: number;
  amountSat: string;
}

export interface SwapRecord {
  id: string;
  role: SwapRole;
  params: SwapParamsJSON;
  amounts: { sourceSat: string; destSat: string; bondSat: string };
  /** the taker holds this from the start; the maker fills it in once it extracts it on-chain. */
  preimageHex?: string;
  phase: SwapPhase;
  lockups: { source?: UtxoRecord; dest?: UtxoRecord; bond?: UtxoRecord };
  /** action label -> broadcast txid, for idempotent (re)broadcast and fee-bump tracking. */
  txids: Record<string, string>;
  abortReason?: AbortReason;
  /** monotonically updated each persist; lets an operator order/expire records. */
  updatedAt: number;
}

export interface SwapStore {
  load(id: string): Promise<SwapRecord | null>;
  save(record: SwapRecord): Promise<void>;
  list(): Promise<SwapRecord[]>;
}

/** In-memory store (tests, ephemeral runs). Clones on the way in and out to avoid aliasing. */
export class MemorySwapStore implements SwapStore {
  private records = new Map<string, SwapRecord>();

  async load(id: string): Promise<SwapRecord | null> {
    const r = this.records.get(id);
    return r ? clone(r) : null;
  }
  async save(record: SwapRecord): Promise<void> {
    this.records.set(record.id, clone(record));
  }
  async list(): Promise<SwapRecord[]> {
    return [...this.records.values()].map(clone);
  }
}

/**
 * One JSON file per swap under `dir`. Writes go to a temp file then rename, so a crash mid-write
 * never leaves a torn record (atomic on POSIX). This is what gives a real daemon crash-safety.
 */
export class FileSwapStore implements SwapStore {
  constructor(private readonly dir: string) {}

  private path(id: string): string {
    return join(this.dir, `${safeId(id)}.json`);
  }

  async load(id: string): Promise<SwapRecord | null> {
    try {
      return JSON.parse(await readFile(this.path(id), 'utf8')) as SwapRecord;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async save(record: SwapRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const final = this.path(record.id);
    const tmp = `${final}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2));
    const { rename } = await import('node:fs/promises');
    await rename(tmp, final);
  }

  async list(): Promise<SwapRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const out: SwapRecord[] = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      out.push(JSON.parse(await readFile(join(this.dir, n), 'utf8')) as SwapRecord);
    }
    return out;
  }
}

const clone = (r: SwapRecord): SwapRecord => JSON.parse(JSON.stringify(r)) as SwapRecord;
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_');
