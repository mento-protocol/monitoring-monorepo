import { deriveBridgeStatus } from "@/lib/bridge-status";
import type { OracleRateMap } from "@/lib/tokens";
import type { SortDir } from "@/lib/table-sort";
import type { BridgeTransfer } from "@/lib/types";
import {
  transferAmountTokens,
  transferAmountUsd,
} from "@/lib/bridge-flows/pricing";

export type BridgeSortKey =
  | "provider"
  | "route"
  | "status"
  | "token"
  | "amount"
  | "amountUsd"
  | "sender"
  | "receiver"
  | "time";

/**
 * Compare nullable values. Nulls always sink regardless of direction —
 * keeps "no data" rows at the bottom so users never see a page of dashes
 * on top when sorting by an often-null column (amount, amountUsd).
 */
export function compareNullable<T>(
  a: T | null | undefined,
  b: T | null | undefined,
  cmp: (x: T, y: T) => number,
  dir: SortDir,
): number {
  const aMissing = a == null;
  const bMissing = b == null;
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  const r = cmp(a, b);
  return dir === "asc" ? r : -r;
}

/**
 * Numeric route comparator. Sorts on (sourceChainId, destChainId) so routes
 * with shorter chain IDs don't lex-float above longer ones (Monad=143 vs
 * Celo=42220 — "143…" < "42220…" lexically, which is wrong).
 */
function compareRoute(
  a: BridgeTransfer,
  b: BridgeTransfer,
  dir: SortDir,
): number {
  const as = a.sourceChainId ?? Number.POSITIVE_INFINITY;
  const bs = b.sourceChainId ?? Number.POSITIVE_INFINITY;
  if (as !== bs) return dir === "asc" ? as - bs : bs - as;
  const ad = a.destChainId ?? Number.POSITIVE_INFINITY;
  const bd = b.destChainId ?? Number.POSITIVE_INFINITY;
  return dir === "asc" ? ad - bd : bd - ad;
}

function timestampSortValue(
  t: Pick<BridgeTransfer, "sentTimestamp" | "firstSeenAt">,
): number | null {
  const raw = t.sentTimestamp ?? t.firstSeenAt;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function compareString(
  a: string | null | undefined,
  b: string | null | undefined,
  dir: SortDir,
): number {
  return compareNullable(
    a?.toLowerCase(),
    b?.toLowerCase(),
    (x, y) => x.localeCompare(y),
    dir,
  );
}

export function sortTransfers(
  transfers: BridgeTransfer[],
  sortKey: BridgeSortKey,
  sortDir: SortDir,
  rates: OracleRateMap,
): BridgeTransfer[] {
  return [...transfers].sort((a, b) => {
    switch (sortKey) {
      case "provider":
        return compareString(a.provider, b.provider, sortDir);
      case "route":
        return compareRoute(a, b, sortDir);
      case "status":
        return compareString(
          deriveBridgeStatus(a),
          deriveBridgeStatus(b),
          sortDir,
        );
      case "token":
        return compareString(a.tokenSymbol, b.tokenSymbol, sortDir);
      case "amount":
        return compareNullable(
          transferAmountTokens(a),
          transferAmountTokens(b),
          (x, y) => x - y,
          sortDir,
        );
      case "amountUsd":
        return compareNullable(
          transferAmountUsd(a, rates),
          transferAmountUsd(b, rates),
          (x, y) => x - y,
          sortDir,
        );
      case "sender":
        return compareString(a.sender, b.sender, sortDir);
      case "receiver":
        return compareString(a.recipient, b.recipient, sortDir);
      case "time": {
        // Null/NaN timestamps sink regardless of direction so a garbled row
        // can't scramble the neighbourhood around it.
        return compareNullable(
          timestampSortValue(a),
          timestampSortValue(b),
          (x, y) => x - y,
          sortDir,
        );
      }
    }
  });
}
