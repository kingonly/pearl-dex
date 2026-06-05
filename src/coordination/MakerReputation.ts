/**
 * Coordination-layer mitigation for the maker-grief gap (see docs/maker-grief-analysis.md): the
 * relay can't *prevent* a maker accepting a match and then never funding the dest leg, but it can
 * make it not worth it — track which makers grief and refuse repeat offenders, so griefing costs an
 * LP the flow it wants (worth more than the ~1–2% bond it could steal once).
 *
 * This is a HEURISTIC, not cryptographic enforcement. The grief signal (a matched maker that failed
 * to fund) has to come from somewhere trustworthy: the operator corroborating via chain observation,
 * or aggregated taker reports with anti-gaming. A naive self-report is gameable — treat `recordGrief`
 * as "the operator is confident this maker griefed", not "a taker said so".
 */

export type ReputationConfig = {
  /** below this many observed matches, a maker is treated as new and allowed (innocent until proven). */
  minObservations?: number;
  /** block a maker whose grief rate exceeds this once it has enough observations. */
  maxGriefRate?: number;
};

export interface MakerStats {
  matches: number;
  griefs: number;
  griefRate: number;
}

export class MakerReputation {
  private readonly counts = new Map<string, { matches: number; griefs: number }>();
  private readonly minObservations: number;
  private readonly maxGriefRate: number;

  constructor(cfg: ReputationConfig = {}) {
    this.minObservations = cfg.minObservations ?? 5;
    this.maxGriefRate = cfg.maxGriefRate ?? 0.2;
  }

  /** Record that a maker was matched and DID fund its leg (a good outcome). */
  recordFunded(makerPubHex: string): void {
    this.bump(makerPubHex, false);
  }

  /** Record that a maker was matched and FAILED to fund its leg (grief). */
  recordGrief(makerPubHex: string): void {
    this.bump(makerPubHex, true);
  }

  stats(makerPubHex: string): MakerStats {
    const s = this.counts.get(makerPubHex) ?? { matches: 0, griefs: 0 };
    return { matches: s.matches, griefs: s.griefs, griefRate: s.matches ? s.griefs / s.matches : 0 };
  }

  /** Policy: allow new makers; block established ones whose grief rate is too high. */
  allow(makerPubHex: string): boolean {
    const s = this.stats(makerPubHex);
    if (s.matches < this.minObservations) return true;
    return s.griefRate <= this.maxGriefRate;
  }

  private bump(makerPubHex: string, griefed: boolean): void {
    const s = this.counts.get(makerPubHex) ?? { matches: 0, griefs: 0 };
    s.matches += 1;
    if (griefed) s.griefs += 1;
    this.counts.set(makerPubHex, s);
  }
}
