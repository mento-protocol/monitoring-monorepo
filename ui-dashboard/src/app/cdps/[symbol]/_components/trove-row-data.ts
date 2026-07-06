import {
  CDP_TROVE_OPEN_STATUSES,
  type CdpInterestBatch,
  type CdpTrove,
} from "../../_lib/types";
import {
  compareRedemptionPriorityRows,
  parseBigInt,
  type TroveDisplayRow,
} from "./trove-sort";

export function buildRankedOpenRows(
  troves: CdpTrove[],
  batchById: ReadonlyMap<string, CdpInterestBatch>,
  { rankingEnabled = true }: { rankingEnabled?: boolean } = {},
): TroveDisplayRow[] {
  const rows = troves.map((trove) => displayRowForTrove(trove, batchById));
  rows.sort(compareRedemptionPriorityRows);
  if (!rankingEnabled) return rows;
  const rateCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.effectiveRate == null) continue;
    const key = row.effectiveRate.toString();
    rateCounts.set(key, (rateCounts.get(key) ?? 0) + 1);
  }

  let currentRank = 0;
  let previousRate: string | null = null;
  return rows.map((row) => {
    if (row.effectiveRate == null) return row;
    const rate = row.effectiveRate.toString();
    if (rate !== previousRate) {
      currentRank += 1;
      previousRate = rate;
    }
    return {
      ...row,
      rank: currentRank,
      tied: (rateCounts.get(rate) ?? 0) > 1,
    };
  });
}

export function buildHistoryRows(
  troves: CdpTrove[],
  batchById: ReadonlyMap<string, CdpInterestBatch>,
): TroveDisplayRow[] {
  const rows: TroveDisplayRow[] = [];
  for (const trove of troves) {
    if (isOpenTroveStatus(trove.status)) continue;
    rows.push(
      displayRowForTrove(trove, batchById, {
        useStoredBatchRate: true,
      }),
    );
  }
  return rows;
}

function isOpenTroveStatus(status: string): boolean {
  return (CDP_TROVE_OPEN_STATUSES as readonly string[]).includes(status);
}

function displayRowForTrove(
  trove: CdpTrove,
  batchById: ReadonlyMap<string, CdpInterestBatch>,
  { useStoredBatchRate = false }: { useStoredBatchRate?: boolean } = {},
): TroveDisplayRow {
  if (trove.interestBatchId != null && !useStoredBatchRate) {
    const batch = batchById.get(trove.interestBatchId);
    if (batch == null) {
      return {
        trove,
        effectiveRate: null,
        rank: null,
        tied: false,
        rateSource: null,
      };
    }
    return {
      trove,
      effectiveRate: parseBigInt(batch.annualInterestRate),
      rank: null,
      tied: false,
      rateSource: "batch",
    };
  }

  const directRate = parseBigInt(trove.interestRate);
  return {
    trove,
    effectiveRate: directRate,
    rank: null,
    tied: false,
    rateSource: directRate != null ? "direct" : null,
  };
}

export function troveMatchesSearch(
  trove: CdpTrove,
  normalizedSearch: string,
): boolean {
  return (
    trove.owner.toLowerCase().includes(normalizedSearch) ||
    trove.previousOwner.toLowerCase().includes(normalizedSearch) ||
    trove.troveId.toLowerCase().includes(normalizedSearch) ||
    trove.id.toLowerCase().includes(normalizedSearch)
  );
}
