import type { BTC_NETWORK } from '@scure/btc-signer/utils.js';
import { networkForTag, tagForNetwork, type NetworkTag } from '../common/networks.js';
import type { Signer } from '../signer/index.js';
import type { ChainClient, UtxoRef } from '../settlement/ChainClient.js';
import { buildSwapPlan, type SwapPlan } from '../settlement/SwapPlan.js';
import { buildClaimTx, buildRefundTx, extractPreimage, type SpendOutput } from '../settlement/SwapTree.js';
import { buildBondReclaimTx, buildBondForfeitTx } from '../settlement/Bond.js';
import { assertSafeBondTimeout } from '../settlement/Timelocks.js';
import {
  type SwapRecord,
  type SwapStore,
  type SwapRole,
  type SwapParamsJSON,
} from './SwapStore.js';

/**
 * The P2P coordinator: a crash-safe, idempotent state machine that drives ONE party's side of a
 * cross-chain atomic swap (SwapPlan) to completion. Each user runs their own executor — the
 * operator never runs it and never holds funds. It turns the (correct, unit-tested) settlement
 * primitives into a runnable system: it funds its legs, watches the chains for the counterparty's
 * actions and the timeout heights, and broadcasts the right claim/refund/reclaim/forfeit tx at the
 * right moment, fee-bumping (RBF) until each lands.
 *
 * Restart-safety: the only durable state is the SwapRecord (SwapStore). Every transition persists
 * the new phase only AFTER its on-chain action is durable, and every step is idempotent (it adopts
 * an already-broadcast tx or an already-present lockup instead of repeating it), so killing and
 * restarting the process resumes exactly where it left off. The on-chain plan is re-derived
 * deterministically from the persisted params.
 *
 * Roles (BTC->PRL; symmetric for PRL->BTC):
 *   TAKER  funds source + posts the option bond, waits for the maker's dest lockup, then claims
 *          dest (revealing the preimage) and reclaims the bond. On a stall it refunds source.
 *   MAKER  waits for the taker's source + bond, funds dest, watches dest for the taker's claim to
 *          learn the preimage, then claims source. If the taker walks it refunds dest and
 *          forfeit-claims the bond (its compensation for the free option the taker held).
 *
 * KNOWN GAP (deferred, DESIGN.md §5.4): because penalizing a taker walk requires
 * `bondForfeitHeight < sourceTimeoutHeight`, a malicious maker who accepts but never funds dest can
 * forfeit-claim the taker's bond before the taker can safely refund source and reclaim it. The
 * taker still recovers the source leg; only the (~1-2%) bond is at risk. The fix is the symmetric
 * maker COMMITMENT bond — not yet built. The executor attempts the abort-path bond reclaim anyway
 * and logs if it was already forfeited.
 */

/** A user's wallet, the only custody surface — owned by the user, never by the operator. */
export interface SwapWallet {
  /**
   * Fund a swap lockup: pay `amountSat` to `address` on `network` from the user's own funds,
   * returning the created outpoint. (Reference impl wraps `buildP2trKeyPathSpend` over a UTXO.)
   */
  fundLockup(
    network: BTC_NETWORK,
    address: string,
    amountSat: bigint,
  ): Promise<UtxoRef & { amountSat: bigint }>;
  /** Where claimed/refunded/reclaimed funds should be paid on `network` (an output script). */
  payoutScript(network: BTC_NETWORK): Uint8Array;
}

export interface ExecutorPolicy {
  /** confirmations to require before treating a counterparty lockup as real. */
  minConfs?: number;
  /** poll interval (ms) for chain conditions and height checks. */
  pollMs?: number;
  /** approximate vbytes of a claim/refund tx, for fee sizing. */
  approxVbytes?: number;
  /** wait this long (ms) for a broadcast to confirm before RBF-bumping the fee. */
  bumpAfterMs?: number;
  /** max RBF bumps before giving up the bump loop. */
  maxBumps?: number;
  /** each bump multiplies the fee rate by this factor. */
  bumpFactor?: number;
  /**
   * TAKER decision at `both_funded`: consummate the swap (default) or walk. A real client wires
   * this to the user / a price check; walking forfeits the bond by design.
   */
  shouldConsummate?: () => boolean | Promise<boolean>;
  /** height (on the relevant chain) past which we give up waiting for the counterparty's lockup. */
  counterpartyDeadlineHeight?: number;
}

export interface SwapExecutorDeps {
  store: SwapStore;
  /** chain clients for each leg; `bond` defaults to whichever of source/dest matches bondNetwork. */
  source: ChainClient;
  dest: ChainClient;
  bond?: ChainClient;
  wallet: SwapWallet;
  /**
   * This party's swap signer — authority over its claim/refund/bond spends, through the Signer
   * seam (a held key — incl. an in-browser ephemeral swap key — or a remote/hardware signer). Its pubkey must match this role's key in the
   * params. It is NOT custody: funds always pay out to the wallet's payoutScript, never to the signer.
   */
  swapSigner: Signer;
  policy?: ExecutorPolicy;
  log?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sat = (s: string) => BigInt(s);

/** Build the initial record for the TAKER (who generates and holds the preimage). */
export function newTakerRecord(p: {
  id: string;
  params: SwapParamsJSON;
  preimage: Uint8Array;
  amounts: { sourceSat: bigint; destSat: bigint; bondSat: bigint };
}): SwapRecord {
  return baseRecord('taker', p.id, p.params, p.amounts, Buffer.from(p.preimage).toString('hex'));
}

/** Build the initial record for the MAKER (who learns the preimage on-chain). */
export function newMakerRecord(p: {
  id: string;
  params: SwapParamsJSON;
  amounts: { sourceSat: bigint; destSat: bigint; bondSat: bigint };
}): SwapRecord {
  return baseRecord('maker', p.id, p.params, p.amounts, undefined);
}

function baseRecord(
  role: SwapRole,
  id: string,
  params: SwapParamsJSON,
  amounts: { sourceSat: bigint; destSat: bigint; bondSat: bigint },
  preimageHex: string | undefined,
): SwapRecord {
  return {
    id,
    role,
    params,
    amounts: {
      sourceSat: amounts.sourceSat.toString(),
      destSat: amounts.destSat.toString(),
      bondSat: amounts.bondSat.toString(),
    },
    preimageHex,
    phase: 'created',
    lockups: {},
    txids: {},
    updatedAt: 0,
  };
}

export class SwapExecutor {
  private record: SwapRecord;
  private readonly plan: SwapPlan;
  private readonly src: ChainClient;
  private readonly dst: ChainClient;
  private readonly bnd: ChainClient;
  private readonly srcNet: BTC_NETWORK;
  private readonly dstNet: BTC_NETWORK;
  private readonly bndNet: BTC_NETWORK;
  private readonly p: Required<Omit<ExecutorPolicy, 'shouldConsummate' | 'counterpartyDeadlineHeight'>> &
    Pick<ExecutorPolicy, 'shouldConsummate' | 'counterpartyDeadlineHeight'>;
  private stopped = false;

  constructor(
    record: SwapRecord,
    private readonly deps: SwapExecutorDeps,
  ) {
    this.record = record;
    const pa = record.params;
    this.srcNet = networkForTag(pa.sourceNetwork);
    this.dstNet = networkForTag(pa.destNetwork);
    this.bndNet = networkForTag(pa.bondNetwork);

    this.src = deps.source;
    this.dst = deps.dest;
    this.bnd = deps.bond ?? pickBond(pa.bondNetwork, deps.source, deps.dest);
    assertNet(this.src, this.srcNet, 'source');
    assertNet(this.dst, this.dstNet, 'dest');
    assertNet(this.bnd, this.bndNet, 'bond');

    // The executor's swap signer must control this role's key in the params, or it can't sign.
    const myPub = Buffer.from(deps.swapSigner.publicKey()).toString('hex');
    const expect = record.role === 'taker' ? pa.takerPubHex : pa.makerPubHex;
    if (myPub !== expect) {
      throw new Error(`swapSigner does not match the ${record.role} pubkey in the swap params`);
    }

    // Defense in depth: the bond's forfeit height MUST be strictly before the source can refund,
    // or a taker could refund source and still reclaim the bond (escaping the walk penalty). The
    // handshake already validates this, but the executor trusts no one and re-checks its params.
    assertSafeBondTimeout({
      bondForfeitHeight: pa.bondForfeitHeight,
      sourceTimeoutHeight: pa.sourceTimeoutHeight,
    });

    this.plan = buildSwapPlan({
      preimageHash: hex(pa.preimageHashHex),
      taker: { pub: hex(pa.takerPubHex) },
      maker: { pub: hex(pa.makerPubHex) },
      sourceNetwork: this.srcNet,
      destNetwork: this.dstNet,
      bondNetwork: this.bndNet,
      sourceTimeoutHeight: pa.sourceTimeoutHeight,
      destTimeoutHeight: pa.destTimeoutHeight,
      bondForfeitHeight: pa.bondForfeitHeight,
      operatorFee: pa.operatorFee
        ? { script: hex(pa.operatorFee.scriptHex), amountSat: sat(pa.operatorFee.amountSat) }
        : undefined,
    });

    const pol = deps.policy ?? {};
    this.p = {
      minConfs: pol.minConfs ?? 1,
      pollMs: pol.pollMs ?? 1000,
      approxVbytes: pol.approxVbytes ?? 150,
      bumpAfterMs: pol.bumpAfterMs ?? 60_000,
      maxBumps: pol.maxBumps ?? 3,
      bumpFactor: pol.bumpFactor ?? 1.5,
      shouldConsummate: pol.shouldConsummate,
      counterpartyDeadlineHeight: pol.counterpartyDeadlineHeight,
    };
  }

  /** Tell the executor to stop at the next poll boundary (it can be resumed later). */
  stop(): void {
    this.stopped = true;
  }

  get phase(): SwapRecord['phase'] {
    return this.record.phase;
  }
  get current(): SwapRecord {
    return this.record;
  }

  /** Drive the swap to a terminal phase, persisting after every transition. Resume-safe. */
  async run(): Promise<SwapRecord> {
    // Reload in case another run() persisted progress (resume after restart).
    const stored = await this.deps.store.load(this.record.id);
    if (stored) this.record = stored;

    let guard = 0;
    while (!this.stopped && !isTerminal(this.record.phase)) {
      if (guard++ > 64) throw new Error('executor exceeded transition budget (stuck?)');
      const before = this.record.phase;
      await (this.record.role === 'taker' ? this.stepTaker() : this.stepMaker());
      if (this.record.phase === before && !this.stopped) {
        // No phase change and not stopped -> a wait was interrupted; avoid a hot loop.
        await sleep(this.p.pollMs);
      }
    }
    return this.record;
  }

  // ---------------------------------------------------------------- TAKER ----

  private async stepTaker(): Promise<void> {
    const r = this.record;
    switch (r.phase) {
      case 'created': {
        const u = await this.ensureSelfLockup(this.src, this.plan.sourceLeg.address, sat(r.amounts.sourceSat));
        r.lockups.source = utxoRec(u);
        await this.advance('source_funded');
        return;
      }
      case 'source_funded': {
        const u = await this.ensureSelfLockup(this.bnd, this.plan.optionBond.address, sat(r.amounts.bondSat));
        r.lockups.bond = utxoRec(u);
        await this.advance('awaiting_counterparty');
        return;
      }
      case 'awaiting_counterparty': {
        const deadline = this.p.counterpartyDeadlineHeight ?? r.params.destTimeoutHeight;
        const found = await this.raceLockup(this.dst, this.plan.destLeg.address, deadline);
        if (!found) {
          this.log('maker never funded dest by the deadline; aborting to refund');
          r.abortReason = 'counterparty_no_fund';
          await this.advance('aborting');
          return;
        }
        if (BigInt(found.amountSat) < sat(r.amounts.destSat)) {
          this.log(`maker dest lockup underfunded (${found.amountSat} < ${r.amounts.destSat}); aborting`);
          r.abortReason = 'counterparty_no_fund';
          await this.advance('aborting');
          return;
        }
        r.lockups.dest = { txid: found.utxo.txid, vout: found.utxo.vout, amountSat: String(found.amountSat) };
        await this.advance('both_funded');
        return;
      }
      case 'both_funded': {
        const consummate = this.p.shouldConsummate ? await this.p.shouldConsummate() : true;
        if (!consummate) {
          this.log('policy chose to WALK; will refund source and forfeit the bond');
          r.abortReason = 'walk';
          await this.advance('aborting');
          return;
        }
        // Claim the dest leg, revealing the preimage. Must confirm before destTimeoutHeight, else
        // the maker can refund dest out from under us. The operator fee rides as an extra output on
        // THIS claim (collected only on consummation — no fill, no fee), borne by the taker.
        const lk = r.lockups.dest!;
        await this.broadcastConfirmed(
          this.dst,
          'dest_claim',
          async (feeSat) =>
            (
              await buildClaimTx({
                leg: this.plan.destLeg,
                utxo: { txid: lk.txid, vout: lk.vout, amountSat: sat(lk.amountSat) },
                signer: this.deps.swapSigner,
                preimage: this.preimage(),
                destinationScript: this.deps.wallet.payoutScript(this.dstNet),
                feeSat,
                extraOutputs: this.feeOutputs(),
              })
            ).hex,
          { deadlineHeight: r.params.destTimeoutHeight },
        );
        await this.advance('preimage_revealed');
        return;
      }
      case 'preimage_revealed': {
        // Reclaim the option bond with the same preimage (no timelock). Must land before the maker
        // can forfeit it at bondForfeitHeight. Idempotent.
        const lk = r.lockups.bond!;
        await this.broadcastConfirmed(
          this.bnd,
          'bond_reclaim',
          async (feeSat) =>
            (
              await buildBondReclaimTx({
                bond: this.plan.optionBond,
                utxo: { txid: lk.txid, vout: lk.vout, amountSat: sat(lk.amountSat) },
                ownerSigner: this.deps.swapSigner,
                preimage: this.preimage(),
                destinationScript: this.deps.wallet.payoutScript(this.bndNet),
                feeSat,
              })
            ).hex,
          { deadlineHeight: r.params.bondForfeitHeight },
        );
        await this.advance('completed');
        return;
      }
      case 'aborting':
        await this.takerRefund();
        return;
    }
  }

  private async takerRefund(): Promise<void> {
    const r = this.record;
    // 1. Refund the source leg after its timeout (recovers the taker's principal).
    await this.waitForHeight(this.src, r.params.sourceTimeoutHeight);
    const src = r.lockups.source!;
    await this.broadcastConfirmed(this.src, 'source_refund', async (feeSat) =>
      (
        await buildRefundTx({
          leg: this.plan.sourceLeg,
          utxo: { txid: src.txid, vout: src.vout, amountSat: sat(src.amountSat) },
          signer: this.deps.swapSigner,
          timeoutBlockHeight: r.params.sourceTimeoutHeight,
          destinationScript: this.deps.wallet.payoutScript(this.srcNet),
          feeSat,
        })
      ).hex,
    );
    r.phase = 'source_refunded';
    await this.persist();

    // 2. The bond. On a WALK it is forfeited by design (don't reveal the preimage). On honest
    //    counterparty-no-fund we try to reclaim it (source is now refunded, so revealing the
    //    preimage is safe) — but the maker may have already forfeited it (KNOWN GAP above).
    if (r.abortReason === 'walk') {
      await this.advance('refunded');
      return;
    }
    const bond = r.lockups.bond;
    if (bond) {
      try {
        await this.broadcastConfirmed(this.bnd, 'bond_reclaim', async (feeSat) =>
          (
            await buildBondReclaimTx({
              bond: this.plan.optionBond,
              utxo: { txid: bond.txid, vout: bond.vout, amountSat: sat(bond.amountSat) },
              ownerSigner: this.deps.swapSigner,
              preimage: this.preimage(),
              destinationScript: this.deps.wallet.payoutScript(this.bndNet),
              feeSat,
            })
          ).hex,
        );
        r.phase = 'bond_reclaimed_on_abort';
      } catch (e) {
        this.log(`bond reclaim failed (likely already forfeited by the maker): ${(e as Error).message}`);
      }
    }
    await this.advance('refunded');
  }

  // ---------------------------------------------------------------- MAKER ----

  private async stepMaker(): Promise<void> {
    const r = this.record;
    switch (r.phase) {
      case 'created':
        await this.advance('awaiting_counterparty');
        return;
      case 'awaiting_counterparty': {
        // Require BOTH the taker's source leg AND the option bond before committing dest funds —
        // this is the maker's protection against funding into a swap with no posted bond. The two
        // lockups are separate txs that may land a beat apart, so wait for both (or the deadline).
        const deadline = this.p.counterpartyDeadlineHeight ?? r.params.sourceTimeoutHeight;
        while (!this.stopped) {
          const source = await this.src.getLockup(this.plan.sourceLeg.address, this.p.minConfs);
          const bond = await this.bnd.getLockup(this.plan.optionBond.address, this.p.minConfs);
          // A present-but-underfunded leg is a permanent failure; a missing one just means "wait".
          if (source && BigInt(source.amountSat) < sat(r.amounts.sourceSat)) {
            this.log('taker source lockup underfunded; refusing to fund dest');
            await this.advance('failed');
            return;
          }
          if (bond && BigInt(bond.amountSat) < sat(r.amounts.bondSat)) {
            this.log('taker option bond underfunded; refusing to fund dest');
            await this.advance('failed');
            return;
          }
          if (source && bond) {
            r.lockups.source = { txid: source.utxo.txid, vout: source.utxo.vout, amountSat: String(source.amountSat) };
            r.lockups.bond = { txid: bond.utxo.txid, vout: bond.utxo.vout, amountSat: String(bond.amountSat) };
            await this.advance('counterparty_funded');
            return;
          }
          if ((await this.src.getBlockHeight()) >= deadline) {
            this.log('taker never funded source + bond by the deadline; nothing committed, giving up');
            await this.advance('failed');
            return;
          }
          await sleep(this.p.pollMs);
        }
        return;
      }
      case 'counterparty_funded': {
        const u = await this.ensureSelfLockup(this.dst, this.plan.destLeg.address, sat(r.amounts.destSat));
        r.lockups.dest = utxoRec(u);
        await this.advance('dest_funded');
        return;
      }
      case 'dest_funded': {
        // Watch the dest leg for the taker's claim (reveals the preimage) until destTimeout.
        //
        // REORG SAFETY: we act on the preimage as soon as the spend is seen, without waiting for
        // confirmations, and that is safe. The preimage is a SECRET, not a transaction — it does not
        // become invalid if the dest claim is later reorged out. If that happens, our source claim
        // (on the OTHER chain, deadline-driven below) still stands, and the taker can re-claim dest
        // with the same preimage; every leg still settles to its intended owner. The only thing that
        // must beat a clock is the source claim itself, which broadcastConfirmed gates on
        // sourceTimeoutHeight. (Lockups, by contrast, ARE reorg-sensitive and were already required
        // to reach minConfs before we funded dest.)
        const lk = r.lockups.dest!;
        const spend = await this.raceSpend(this.dst, { txid: lk.txid, vout: lk.vout }, r.params.destTimeoutHeight);
        if (!spend) {
          this.log('taker never claimed dest by destTimeout; walked. Refunding dest + forfeiting bond');
          r.abortReason = 'dest_not_claimed';
          await this.advance('aborting');
          return;
        }
        const preimage = extractPreimage(spend.spendTxHex, spend.inputIndex);
        r.preimageHex = Buffer.from(preimage).toString('hex');
        await this.advance('preimage_revealed');
        return;
      }
      case 'preimage_revealed': {
        // Claim the source leg with the learned preimage. Must confirm before sourceTimeout, else
        // the taker refunds source and we lose principal — so this is deadline-driven.
        const src = r.lockups.source!;
        await this.broadcastConfirmed(
          this.src,
          'source_claim',
          async (feeSat) =>
            (
              await buildClaimTx({
                leg: this.plan.sourceLeg,
                utxo: { txid: src.txid, vout: src.vout, amountSat: sat(src.amountSat) },
                signer: this.deps.swapSigner,
                preimage: this.preimage(),
                destinationScript: this.deps.wallet.payoutScript(this.srcNet),
                feeSat,
              })
            ).hex,
          { deadlineHeight: r.params.sourceTimeoutHeight },
        );
        await this.advance('completed');
        return;
      }
      case 'aborting':
        await this.makerRefund();
        return;
    }
  }

  private async makerRefund(): Promise<void> {
    const r = this.record;
    // 1. Refund the dest leg after its timeout (recovers the maker's principal).
    await this.waitForHeight(this.dst, r.params.destTimeoutHeight);
    const dst = r.lockups.dest!;
    await this.broadcastConfirmed(this.dst, 'dest_refund', async (feeSat) =>
      (
        await buildRefundTx({
          leg: this.plan.destLeg,
          utxo: { txid: dst.txid, vout: dst.vout, amountSat: sat(dst.amountSat) },
          signer: this.deps.swapSigner,
          timeoutBlockHeight: r.params.destTimeoutHeight,
          destinationScript: this.deps.wallet.payoutScript(this.dstNet),
          feeSat,
        })
      ).hex,
    );
    r.phase = 'dest_refunded';
    await this.persist();

    // 2. Forfeit-claim the option bond after its timeout — the maker's compensation for the walk.
    const bond = r.lockups.bond!;
    await this.waitForHeight(this.bnd, r.params.bondForfeitHeight);
    try {
      await this.broadcastConfirmed(this.bnd, 'bond_forfeit', async (feeSat) =>
        (
          await buildBondForfeitTx({
            bond: this.plan.optionBond,
            utxo: { txid: bond.txid, vout: bond.vout, amountSat: sat(bond.amountSat) },
            counterpartySigner: this.deps.swapSigner,
            forfeitTimeoutHeight: r.params.bondForfeitHeight,
            destinationScript: this.deps.wallet.payoutScript(this.bndNet),
            feeSat,
          })
        ).hex,
      );
      r.phase = 'bond_forfeited';
    } catch (e) {
      this.log(`bond forfeit failed (taker may have reclaimed it): ${(e as Error).message}`);
    }
    await this.advance('refunded');
  }

  // -------------------------------------------------------------- helpers ----

  /** Adopt an existing lockup at `address` (resume / pre-funded) or fund it via the wallet. */
  private async ensureSelfLockup(
    client: ChainClient,
    address: string,
    amountSat: bigint,
  ): Promise<UtxoRef & { amountSat: bigint }> {
    const existing = await client.getLockup(address, this.p.minConfs);
    if (existing && BigInt(existing.amountSat) >= amountSat) {
      return { txid: existing.utxo.txid, vout: existing.utxo.vout, amountSat: BigInt(existing.amountSat) };
    }
    return this.deps.wallet.fundLockup(client.network, address, amountSat);
  }

  /** Poll for a lockup at `address`; resolve it, or null once `deadlineHeight` is reached. */
  private async raceLockup(client: ChainClient, address: string, deadlineHeight: number) {
    while (!this.stopped) {
      const lk = await client.getLockup(address, this.p.minConfs);
      if (lk) return lk;
      if ((await client.getBlockHeight()) >= deadlineHeight) return null;
      await sleep(this.p.pollMs);
    }
    return null;
  }

  /** Poll for a spend of `utxo`; resolve it, or null once `deadlineHeight` is reached. */
  private async raceSpend(client: ChainClient, utxo: UtxoRef, deadlineHeight: number) {
    while (!this.stopped) {
      const sp = await client.getSpend(utxo);
      if (sp) return sp;
      if ((await client.getBlockHeight()) >= deadlineHeight) return null;
      await sleep(this.p.pollMs);
    }
    return null;
  }

  /** Block until the chain reaches `height` (for timelocked refund/forfeit spends). */
  private async waitForHeight(client: ChainClient, height: number): Promise<void> {
    while (!this.stopped && (await client.getBlockHeight()) < height) {
      await sleep(this.p.pollMs);
    }
  }

  /**
   * Broadcast a tx and keep it alive until it CONFIRMS, RBF-bumping the fee on each timeout. The
   * action label keys the stored txid so a restart re-checks confirmation before re-broadcasting
   * (idempotent). `build(feeSat)` returns the signed raw hex at the given miner fee.
   *
   * Liveness is the contract: this does NOT return on an unconfirmed tx. Fee escalation is capped at
   * `maxBumps` (to bound cost), but it keeps re-broadcasting at the top rate until the tx lands — so
   * a caller that gets a return value KNOWS the tx confirmed and can safely advance the state machine.
   *
   * `opts.deadlineHeight` (set for time-critical CLAIMS that must beat a timeout — the taker's dest
   * claim before destTimeout, the maker's source claim before sourceTimeout, the taker's bond
   * reclaim before bondForfeit) makes the wait deadline-driven: if the chain reaches the deadline
   * before the tx confirms, it THROWS instead of returning, so the caller never advances past an
   * unconfirmed, now-unsafe claim (the previous code returned silently here — a principal-loss bug).
   */
  private async broadcastConfirmed(
    client: ChainClient,
    action: string,
    build: (feeSat: bigint) => Promise<string>,
    opts: { deadlineHeight?: number } = {},
  ): Promise<string> {
    const prior = this.record.txids[action];
    if (prior) {
      const tx = await client.getTransaction(prior);
      if (tx?.status.confirmed) return prior;
    }
    const rate = await client.estimateFeeSatPerVbyte();
    let lastTxid = prior ?? '';
    let bump = 0;
    while (!this.stopped) {
      if (
        opts.deadlineHeight !== undefined &&
        (await client.getBlockHeight()) >= opts.deadlineHeight
      ) {
        throw new Error(
          `${action}: reached deadline height ${opts.deadlineHeight} before the tx confirmed`,
        );
      }
      const exp = Math.min(bump, this.p.maxBumps); // cap fee growth, but keep rebroadcasting
      const feeSat = BigInt(Math.ceil(rate * this.p.approxVbytes * Math.pow(this.p.bumpFactor, exp)));
      lastTxid = await client.broadcast(await build(feeSat));
      this.record.txids[action] = lastTxid;
      await this.persist();
      if (await this.pollConfirmed(client, lastTxid)) return lastTxid;
      bump++;
      const dl = opts.deadlineHeight !== undefined ? `, deadline h=${opts.deadlineHeight}` : '';
      this.log(`${action} not confirmed; RBF-bumping the fee (bump ${bump}${dl})`);
    }
    return lastTxid;
  }

  /** Poll a txid for confirmation up to `bumpAfterMs`; true if confirmed, false to trigger a bump. */
  private async pollConfirmed(client: ChainClient, txid: string): Promise<boolean> {
    const deadline = Date.now() + this.p.bumpAfterMs;
    while (!this.stopped) {
      const tx = await client.getTransaction(txid);
      if (tx?.status.confirmed) return true;
      if (Date.now() >= deadline) return false;
      await sleep(this.p.pollMs);
    }
    return false;
  }

  /** The operator fee output(s) to attach to the taker's dest claim, if a fee was committed. */
  private feeOutputs(): SpendOutput[] | undefined {
    const f = this.plan.operatorFee;
    return f ? [{ script: f.script, amountSat: f.amountSat }] : undefined;
  }

  private preimage(): Uint8Array {
    if (!this.record.preimageHex) throw new Error('preimage not available');
    return hex(this.record.preimageHex);
  }

  private async advance(phase: SwapRecord['phase']): Promise<void> {
    this.record.phase = phase;
    await this.persist();
  }

  private async persist(): Promise<void> {
    this.record.updatedAt += 1;
    await this.deps.store.save(this.record);
  }

  private log(msg: string): void {
    this.deps.log?.(`[swap ${this.record.id} ${this.record.role}] ${msg}`);
  }
}

// --------------------------------------------------------------- module fns --

function isTerminal(phase: SwapRecord['phase']): boolean {
  return phase === 'completed' || phase === 'refunded' || phase === 'failed';
}

function utxoRec(u: UtxoRef & { amountSat: bigint }) {
  return { txid: u.txid, vout: u.vout, amountSat: u.amountSat.toString() };
}

function pickBond(tag: NetworkTag, source: ChainClient, dest: ChainClient): ChainClient {
  if (tagForNetwork(source.network) === tag) return source;
  if (tagForNetwork(dest.network) === tag) return dest;
  throw new Error(`no client matches bond network ${tag}; pass deps.bond explicitly`);
}

function assertNet(client: ChainClient, net: BTC_NETWORK, label: string): void {
  if (client.network.bech32 !== net.bech32) {
    throw new Error(`${label} client network mismatch: ${client.network.bech32} != ${net.bech32}`);
  }
}

const hex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
