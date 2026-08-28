// Redemption-queue domain logic for the trove history page
// (docs/PLAN-trove-history-page.md, "UI design → Redemption queue"): the
// current rate ladder of ACTIVE troves, this trove's dense queue position,
// and the lower-rate debt "shield". Pure functions only — the SWR wiring
// lives in `use-trove-queue.ts`.

import { z } from "zod/mini";
import { sortedCopy } from "@/lib/immutable-sort";
import { CDP_TROVES_DETAIL_LIMIT } from "../../../../_lib/types";

/** One open-trove row as selected by `CDP_TROVE_QUEUE`'s `OpenTrove` branch.
 *  Includes zombies — the fetch mirrors the market table's open-trove branch
 *  so the cap suppression triggers in exactly the same place; the zombie
 *  exclusion happens in {@link buildTroveQueueModel}. */
type CdpTroveQueueTroveRow = {
  id: string;
  status: string;
  debt: string;
  interestRate: string;
  interestBatchId: string | null;
};

type CdpTroveQueueInstanceRow = {
  id: string;
  isShutDown: boolean;
  shutDownAt: string | null;
};

type CdpTroveQueueBatchRow = {
  id: string;
  annualInterestRate: string;
};

export type CdpTroveQueueResponse = {
  LiquityInstance: CdpTroveQueueInstanceRow[];
  OpenTrove: CdpTroveQueueTroveRow[];
  InterestBatch: CdpTroveQueueBatchRow[];
};

/** Runtime guard for hosted-Hasura rollout drift
 *  (docs/pr-checklists/swr-polling-hasura.md). Every field here is a
 *  long-deployed column (no introspection gate needed), but the queue math
 *  below runs BigInt arithmetic over the payload — a drifted response fails
 *  as a typed `GraphQLSchemaError` instead of feeding garbage into the rank
 *  and shield figures. */
export const CdpTroveQueueSchema = z.object({
  LiquityInstance: z.array(
    z.object({
      id: z.string(),
      isShutDown: z.boolean(),
      shutDownAt: z.nullable(z.string()),
    }),
  ),
  OpenTrove: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      debt: z.string(),
      interestRate: z.string(),
      interestBatchId: z.nullable(z.string()),
    }),
  ),
  InterestBatch: z.array(
    z.object({
      id: z.string(),
      annualInterestRate: z.string(),
    }),
  ),
});

/** One rate level of the ladder — every ACTIVE trove at exactly this
 *  effective rate, aggregated. */
export type TroveQueueRung = {
  /** Effective annual rate, wei-scaled string (1e18 = 100%), BigInt-
   *  normalized so equal rates always share one rung. */
  rate: string;
  /** Sum of active debt at exactly this rate, wei string. */
  debt: string;
  troveCount: number;
  /** 1-based dense queue position; #1 is the lowest rate — redeemed first. */
  position: number;
  containsThisTrove: boolean;
};

type TroveQueuePosition = {
  position: number;
  /** Total number of rate levels — the "#N of M" denominator. */
  rateLevels: number;
  /** This trove's effective rate (wei string). */
  rate: string;
  /** Sum of active debt at STRICTLY lower rates, wei string. Same-rate
   *  neighbors are not a shield — the queue tiebreaks inside a rate level
   *  by trove id, so only lower rates are certain to absorb first. */
  shieldDebt: string;
};

/** The panel's whole truth in one discriminated model, in precedence order:
 *  - `shutdown`: rate order no longer decides (urgent redemptions) — wins
 *    over everything, including a capped fetch.
 *  - `capped`: the open-trove fetch hit `CDP_TROVES_DETAIL_LIMIT`, so the
 *    dataset is incomplete — rank, shield, AND the ladder are suppressed
 *    entirely, never shown as a partial calculation (mirrors the market
 *    table's rank suppression at the same cap).
 *  - `unresolved-rates`: an active trove's effective rate could not be
 *    resolved (batch row missing during indexer lag) — a ladder missing its
 *    debt would misstate the shield, so suppress rather than approximate.
 *  - `empty`: no active troves — the queue does not exist.
 *  - `ready`: the ladder, with this trove's position when it is an active
 *    member. */
export type TroveQueueReadyModel = {
  kind: "ready";
  rungs: TroveQueueRung[];
  /** Null when this trove is not an active queue member (zombie, closed,
   *  liquidated, redeemed — or transiently absent from the fetch). */
  thisTrove: TroveQueuePosition | null;
};

export type TroveQueueModel =
  | { kind: "shutdown"; shutDownAt: string | null }
  /** The response carried no `LiquityInstance` row, so the shutdown flag —
   *  which decides whether rate order governs redemptions at all — is
   *  unknown. Fail closed: no ladder until the row is back. */
  | { kind: "instance-missing" }
  | { kind: "capped" }
  | { kind: "unresolved-rates"; unresolvedCount: number }
  | { kind: "empty" }
  | TroveQueueReadyModel;

function parseWeiString(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** Effective rate for queue ordering — same join semantics as the market
 *  table's `displayRowForTrove` (`[symbol]/_components/trove-row-data.ts`,
 *  mirrored rather than imported: that module is private to the market
 *  route): a batch-managed trove queues at the batch's CURRENT rate, never
 *  its own possibly-stale copied `interestRate`; a missing batch row means
 *  the rate is unknown, not zero. */
function resolveEffectiveRate(
  row: CdpTroveQueueTroveRow,
  batchRateById: ReadonlyMap<string, string>,
): bigint | null {
  if (row.interestBatchId != null) {
    const batchRate = batchRateById.get(row.interestBatchId);
    return batchRate == null ? null : parseWeiString(batchRate);
  }
  return parseWeiString(row.interestRate);
}

function compareBigIntAsc(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type RungAccumulator = {
  debt: bigint;
  troveCount: number;
  containsThisTrove: boolean;
};

function buildRungs(
  resolved: ReadonlyArray<{ id: string; debt: bigint; rate: bigint }>,
  troveEntityId: string,
): TroveQueueRung[] {
  const byRate = new Map<string, RungAccumulator>();
  for (const row of resolved) {
    const key = row.rate.toString();
    const entry = byRate.get(key) ?? {
      debt: BigInt(0),
      troveCount: 0,
      containsThisTrove: false,
    };
    entry.debt += row.debt;
    entry.troveCount += 1;
    entry.containsThisTrove =
      entry.containsThisTrove || row.id === troveEntityId;
    byRate.set(key, entry);
  }
  return sortedCopy(Array.from(byRate.entries()), ([rateA], [rateB]) =>
    compareBigIntAsc(BigInt(rateA), BigInt(rateB)),
  ).map(([rate, entry], index) => ({
    rate,
    debt: entry.debt.toString(),
    troveCount: entry.troveCount,
    position: index + 1,
    containsThisTrove: entry.containsThisTrove,
  }));
}

function resolveThisTrovePosition(
  rungs: TroveQueueRung[],
): TroveQueuePosition | null {
  const thisRung = rungs.find((rung) => rung.containsThisTrove);
  if (thisRung == null) return null;
  let shield = BigInt(0);
  for (const rung of rungs) {
    if (rung.position >= thisRung.position) break;
    shield += BigInt(rung.debt);
  }
  return {
    position: thisRung.position,
    rateLevels: rungs.length,
    rate: thisRung.rate,
    shieldDebt: shield.toString(),
  };
}

/** Derives the queue model from one `CDP_TROVE_QUEUE` response. Rank and
 *  shield count ACTIVE troves only — zombies are filtered out here even
 *  though the fetch includes them: they sit outside the sorted queue and
 *  their debt shields nobody. The cap check runs on the raw open-trove
 *  response (`>=`, exactly like the market table's `openCapped`) BEFORE the
 *  zombie filter, so suppression fires whenever the fetch itself may be
 *  incomplete. */
export function buildTroveQueueModel(
  data: CdpTroveQueueResponse,
  troveEntityId: string,
): TroveQueueModel {
  const instance = data.LiquityInstance[0];
  if (instance == null) {
    // Never default a missing shutdown flag to "not shut down": a healthy
    // ladder built during indexer lag or a partial resync would claim rate
    // order governs redemptions while the market may be urgent-mode.
    return { kind: "instance-missing" };
  }
  if (instance.isShutDown === true) {
    return { kind: "shutdown", shutDownAt: instance.shutDownAt };
  }
  if (data.OpenTrove.length >= CDP_TROVES_DETAIL_LIMIT) {
    return { kind: "capped" };
  }
  const batchRateById = new Map(
    data.InterestBatch.map((batch) => [batch.id, batch.annualInterestRate]),
  );
  const resolved: Array<{ id: string; debt: bigint; rate: bigint }> = [];
  let unresolvedCount = 0;
  for (const row of data.OpenTrove) {
    if (row.status !== "active") continue;
    const rate = resolveEffectiveRate(row, batchRateById);
    const debt = parseWeiString(row.debt);
    if (rate == null || debt == null) {
      unresolvedCount += 1;
      continue;
    }
    resolved.push({ id: row.id, debt, rate });
  }
  if (unresolvedCount > 0) {
    return { kind: "unresolved-rates", unresolvedCount };
  }
  if (resolved.length === 0) return { kind: "empty" };
  const rungs = buildRungs(resolved, troveEntityId);
  return { kind: "ready", rungs, thisTrove: resolveThisTrovePosition(rungs) };
}

export function maxTroveQueueRungDebt(
  rungs: ReadonlyArray<Pick<TroveQueueRung, "debt">>,
): string {
  let max = BigInt(0);
  for (const rung of rungs) {
    const debt = BigInt(rung.debt);
    if (debt > max) max = debt;
  }
  return max.toString();
}

/** CSS width for a rung's proportional bar — the footnote promises "bar
 *  length is proportional to the debt at each rate", so this is a straight
 *  ratio against the largest rung (integer basis-point math; wei magnitudes
 *  overflow Number). The component adds a 1px min-width so a tiny-but-real
 *  rung stays visible without breaking proportionality. */
export function troveQueueBarWidthPercent(
  debt: string,
  maxDebt: string,
): string {
  const max = BigInt(maxDebt);
  if (max <= BigInt(0)) return "0%";
  const basisPoints = (BigInt(debt) * BigInt(10_000)) / max;
  return `${(Number(basisPoints) / 100).toFixed(1)}%`;
}
