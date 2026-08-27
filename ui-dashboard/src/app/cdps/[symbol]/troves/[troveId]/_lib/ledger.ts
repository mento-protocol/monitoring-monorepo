// Complete-ledger domain logic for the trove history page
// (docs/PLAN-trove-history-page.md, "GraphQL contract → CDP_TROVE_LEDGER" and
// "UI design → Ledger table"): the introspection gate, row ordering, the
// limit+1 truncation sentinel, badge/status-flip vocabulary for all ten
// Operation ordinals, and the client-side interest-residual estimate. Pure
// functions only — the SWR wiring lives in `use-trove-ledger.ts`.

import { z } from "zod/mini";
import { sortedCopy } from "@/lib/immutable-sort";
import { BADGE_LABELS, type BadgeKind } from "../../../../_lib/transactions";

// Same sentinel scheme as the interim op list (`params.ts`): request one row
// beyond the render limit so a full response proves more history exists —
// aggregates are disabled on hosted Hasura, and `length === renderLimit`
// alone can't distinguish "exactly this many rows" from "capped". The render
// limit sits below the 1,000-row Hasura hard cap so a fully capped response
// still carries the sentinel.
export const CDP_TROVE_LEDGER_RENDER_LIMIT = 999;
export const CDP_TROVE_LEDGER_REQUEST_LIMIT = CDP_TROVE_LEDGER_RENDER_LIMIT + 1;

/** One `TroveLedgerEvent` row as selected by `CDP_TROVE_LEDGER`. All wei
 *  scalars arrive as strings; the nullable fields mirror the indexer schema
 *  (indexer-envio/schema.graphql): batch-op rows keep `debtBefore` null
 *  permanently (`debtAfter` too on batched op-5/6 rows), and the price/ICR
 *  trio is null on historical-replay rows — every consumer renders null as
 *  an em dash, never zero. Keep in sync with `TroveLedgerEventRowSchema`
 *  below. */
export type CdpTroveLedgerEventRow = {
  /** Unpadded `${chainId}_${blockNumber}_${logIndex}` — NEVER used for
   *  ordering ("_10" sorts before "_2" as text); the numeric triple below
   *  is the only ordering key. */
  id: string;
  /** Liquity v2 Operation ordinal 0-9 — unlike `TroveOperationEvent`, ALL
   *  ten appear here: 0 open, 1 close, 2 adjust, 3 adjustInterestRate,
   *  4 applyPendingDebt, 5 liquidate, 6 redeemCollateral,
   *  7 openAndJoinBatch, 8 setBatchManager, 9 removeFromBatch. */
  operation: number;
  /** Signed operation delta; excludes the redist term below. */
  collChange: string;
  /** Signed operation delta; excludes the fee/redist terms below. */
  debtChange: string;
  debtIncreaseFromUpfrontFee: string;
  debtIncreaseFromRedist: string;
  collIncreaseFromRedist: string;
  annualInterestRate: string;
  /** Post-accrual, pre-operation (accrued interest already folded in);
   *  null forever on batch-op rows. */
  debtBefore: string | null;
  debtAfter: string | null;
  collBefore: string;
  collAfter: string;
  statusBefore: string;
  statusAfter: string;
  /** Op 6 only: collateral fee credited TO the trove — always rendered as
   *  a positive credit. */
  redemptionFeeCredited: string | null;
  /** Op 6 only: tx-target discriminator. Null means undiscriminated —
   *  never presented as confirmed user activity. */
  isRebalance: boolean | null;
  redemptionPrice: string | null;
  priceAtEvent: string | null;
  icrAfterBps: number | null;
  timestamp: string;
  blockNumber: string;
  logIndex: number;
  txHash: string;
};

export type TroveLedgerWatermark = {
  lastLedgerBlock: string;
  lastLedgerLogIndex: number;
};

export type CdpTroveLedgerResponse = {
  LedgerWatermark: TroveLedgerWatermark[];
  TroveLedgerEvent: CdpTroveLedgerEventRow[];
};

const TroveLedgerEventRowSchema = z.object({
  id: z.string(),
  operation: z.number(),
  collChange: z.string(),
  debtChange: z.string(),
  debtIncreaseFromUpfrontFee: z.string(),
  debtIncreaseFromRedist: z.string(),
  collIncreaseFromRedist: z.string(),
  annualInterestRate: z.string(),
  debtBefore: z.nullable(z.string()),
  debtAfter: z.nullable(z.string()),
  collBefore: z.string(),
  collAfter: z.string(),
  statusBefore: z.string(),
  statusAfter: z.string(),
  redemptionFeeCredited: z.nullable(z.string()),
  isRebalance: z.nullable(z.boolean()),
  redemptionPrice: z.nullable(z.string()),
  priceAtEvent: z.nullable(z.string()),
  icrAfterBps: z.nullable(z.number()),
  timestamp: z.string(),
  blockNumber: z.string(),
  logIndex: z.number(),
  txHash: z.string(),
});

/** Runtime guard for hosted-Hasura rollout drift
 *  (docs/pr-checklists/swr-polling-hasura.md): the ledger query only fires
 *  behind the introspection gate, but the gate proves the TYPE exists, not
 *  that every row parses to the shape the derivations below assume — a
 *  drifted response fails as a typed `GraphQLSchemaError` (fixed-backoff
 *  recovery probe) instead of feeding NaN into BigInt arithmetic. */
export const CdpTroveLedgerSchema = z.object({
  LedgerWatermark: z.array(
    z.object({
      lastLedgerBlock: z.string(),
      lastLedgerLogIndex: z.number(),
    }),
  ),
  TroveLedgerEvent: z.array(TroveLedgerEventRowSchema),
});

/** Shape of the `CDP_TROVE_SCHEMA_FIELDS` probe as this route's gate reads
 *  it. `__type(name: ...)` returns null (not an error) for a type the live
 *  schema doesn't serve, so both branches are nullable; the extra aliases
 *  the market page reads are irrelevant here and left untyped. */
export type CdpTroveLedgerSchemaProbe = {
  TroveType: { fields: Array<{ name: string }> } | null;
  TroveLedgerEventType?: { fields: Array<{ name: string }> } | null;
};

/** The introspection gate: true only when the live schema serves BOTH the
 *  `TroveLedgerEvent` entity and the `Trove` watermark columns
 *  `CDP_TROVE_LEDGER` selects — hosted Hasura rejects a whole query for one
 *  unknown field at parse time, so a half-promoted schema must keep the
 *  gate closed. `=== true` semantics via the null checks: a loading,
 *  errored, or absent probe fails CLOSED to the interim assembly, and the
 *  probe re-polls (300s), so this re-evaluates in both directions — an
 *  explicit re-evaluation, never a one-shot latch. */
export function supportsTroveLedger(
  probe: CdpTroveLedgerSchemaProbe | undefined,
): boolean {
  if (probe?.TroveLedgerEventType == null) return false;
  const troveFields = probe.TroveType?.fields ?? [];
  return (
    troveFields.some((field) => field.name === "lastLedgerBlock") &&
    troveFields.some((field) => field.name === "lastLedgerLogIndex")
  );
}

export function resolveLedgerWatermark(
  data: CdpTroveLedgerResponse | undefined,
): TroveLedgerWatermark | null {
  return data?.LedgerWatermark[0] ?? null;
}

function compareBigIntStringsAsc(a: string, b: string): number {
  const diff = BigInt(a) - BigInt(b);
  return diff < BigInt(0) ? -1 : diff > BigInt(0) ? 1 : 0;
}

/** Newest-first comparator on the numeric ordering triple
 *  (timestamp, blockNumber, logIndex) — matches `CDP_TROVE_LEDGER`'s
 *  server-side `order_by` exactly. Unlike the interim query's id-parsing
 *  workaround, `TroveLedgerEvent` exposes `blockNumber`/`logIndex` as
 *  queryable numeric columns, so the server order is already correct; this
 *  re-assertion just makes the client's ordering invariant independent of
 *  what a (mocked or misbehaving) transport returned. The string `id` is
 *  never consulted. */
export function compareTroveLedgerRowsDesc(
  a: { timestamp: string; blockNumber: string; logIndex: number },
  b: { timestamp: string; blockNumber: string; logIndex: number },
): number {
  const byTimestamp = compareBigIntStringsAsc(b.timestamp, a.timestamp);
  if (byTimestamp !== 0) return byTimestamp;
  const byBlock = compareBigIntStringsAsc(b.blockNumber, a.blockNumber);
  if (byBlock !== 0) return byBlock;
  return b.logIndex - a.logIndex;
}

export function sortTroveLedgerRowsDesc<
  TRow extends { timestamp: string; blockNumber: string; logIndex: number },
>(rows: readonly TRow[]): TRow[] {
  return sortedCopy(rows, compareTroveLedgerRowsDesc);
}

/** Every rendered row carries both debt snapshots. False whenever a
 *  batch-op row (null `debtBefore`/`debtAfter`) is present — the signal
 *  that switches the debt columns and every debt-derived estimate to the
 *  explicit batch notice instead of a gapped or zero-coerced rendering. */
export function hasCompleteDebtSnapshots(
  rows: readonly Pick<CdpTroveLedgerEventRow, "debtBefore" | "debtAfter">[],
): boolean {
  return rows.every((row) => row.debtBefore != null && row.debtAfter != null);
}

/** Total recorded-debt movement attributable to the row: the signed
 *  operation change plus the fee/redist terms the events carry. With the
 *  writer's post-accrual snapshots this makes every non-batch row exactly
 *  self-consistent — `debtBefore + Δ = debtAfter`
 *  (indexer-envio/src/handlers/liquity/troveLedger.ts derives `before` as
 *  `after − (debtChange + upfrontFee + redist)`) — so accrued interest
 *  falls BETWEEN rows, never inside one. Same include-the-upfront-fee
 *  invariant as the interim list's `totalDebtChange`. */
export function totalLedgerDebtChange(row: CdpTroveLedgerEventRow): string {
  return (
    BigInt(row.debtChange) +
    BigInt(row.debtIncreaseFromUpfrontFee) +
    BigInt(row.debtIncreaseFromRedist)
  ).toString();
}

/** Collateral counterpart: `collBefore + Δ = collAfter` exactly (the
 *  credited redemption fee is already netted inside the writer's collateral
 *  identity, so it is context in the Fees column, not an extra term). */
export function totalLedgerCollChange(row: CdpTroveLedgerEventRow): string {
  return (
    BigInt(row.collChange) + BigInt(row.collIncreaseFromRedist)
  ).toString();
}

// Operation ordinals this module needs by name. Mirrors `OP` in
// indexer-envio/src/handlers/liquity/operations.ts (cross-package imports
// are off-limits; renumbering must update both).
const OP_OPEN_TROVE = 0;
const OP_ADJUST_TROVE = 2;
const OP_APPLY_PENDING_DEBT = 4;
const OP_LIQUIDATE = 5;
const OP_REDEEM_COLLATERAL = 6;
const OP_OPEN_AND_JOIN_BATCH = 7;
const OP_SET_BATCH_MANAGER = 8;
const OP_REMOVE_FROM_BATCH = 9;

const LEDGER_OP_BADGE: Record<number, BadgeKind> = {
  [OP_OPEN_TROVE]: "troveOpen",
  1: "troveClose",
  [OP_ADJUST_TROVE]: "troveAdjust",
  3: "troveInterestRateChange",
  [OP_APPLY_PENDING_DEBT]: "interest",
  [OP_LIQUIDATE]: "liquidation",
  [OP_OPEN_AND_JOIN_BATCH]: "troveOpen",
  [OP_SET_BATCH_MANAGER]: "troveBatch",
  [OP_REMOVE_FROM_BATCH]: "troveBatch",
};

/** Badge kind for a ledger row — covers all ten ordinals, unlike
 *  `badgeKindFor` (which maps the market feeds' user-ops-only rows). Op 6
 *  discriminates rebalance vs user redemptions via `isRebalance`; a null
 *  discriminator (undiscriminated row) falls back to the neutral
 *  "Redemption" kind rather than claiming rebalance attribution. */
export function ledgerBadgeKindFor(
  row: Pick<CdpTroveLedgerEventRow, "operation" | "isRebalance">,
): BadgeKind {
  if (row.operation === OP_REDEEM_COLLATERAL) {
    return row.isRebalance === true ? "rebalanceRedemption" : "userRedemption";
  }
  return LEDGER_OP_BADGE[row.operation] ?? "troveAdjust";
}

/** Label overrides on top of `BADGE_LABELS[kind]` where one kind covers
 *  operations that need distinct, truthful names (same rationale as the
 *  interim list's `operationBadgeLabel`). Op 4 gets its on-chain name — its
 *  `interest` kind styles it with the synthetic estimate rows it is the
 *  on-chain sibling of, but it is a real event, not an estimate. */
export function ledgerBadgeLabel(kind: BadgeKind, operation: number): string {
  if (operation === OP_OPEN_AND_JOIN_BATCH) return "Open & Join Batch";
  if (operation === OP_APPLY_PENDING_DEBT) return "Apply Pending Debt";
  if (kind === "troveBatch") {
    if (operation === OP_SET_BATCH_MANAGER) return "Joined Batch";
    if (operation === OP_REMOVE_FROM_BATCH) return "Left Batch";
  }
  return BADGE_LABELS[kind];
}

export type TroveLedgerStatusFlip = {
  /** e.g. "active → zombie", straight from the indexer vocabulary. */
  text: string;
  /** Badge kind styling the flip: `zombie` for a flip INTO zombie,
   *  `revived` for zombie → active, null for other flips (plain text —
   *  the op badge already tells that story, e.g. close/liquidate). */
  kind: "zombie" | "revived" | null;
};

/** Status-flip annotation from `statusBefore`/`statusAfter`. Open rows
 *  (ops 0/7) are suppressed: their `statusBefore` is the indexer's
 *  pre-open "closed" placeholder (see the open-row handler test), and
 *  rendering "closed → active" on an open would misread as a reopening —
 *  trove ids are never reused, one entity is one lifecycle. */
export function troveLedgerStatusFlip(
  row: Pick<
    CdpTroveLedgerEventRow,
    "operation" | "statusBefore" | "statusAfter"
  >,
): TroveLedgerStatusFlip | null {
  if (
    row.operation === OP_OPEN_TROVE ||
    row.operation === OP_OPEN_AND_JOIN_BATCH
  ) {
    return null;
  }
  if (row.statusBefore === row.statusAfter) return null;
  const kind =
    row.statusAfter === "zombie"
      ? ("zombie" as const)
      : row.statusBefore === "zombie" && row.statusAfter === "active"
        ? ("revived" as const)
        : null;
  return { text: `${row.statusBefore} → ${row.statusAfter}`, kind };
}

export type TroveLedgerDisplayRow =
  | { kind: "event"; row: CdpTroveLedgerEventRow }
  | {
      /** Synthetic, client-derived interest estimate — clearly labeled,
       *  excluded from any sum, and never persisted. */
      kind: "interest";
      /** Unique render key derived from the FOLLOWING event's id. */
      id: string;
      /** Timestamp of the following event: the accrual completed by then. */
      timestamp: string;
      /** Positive residual, wei string. */
      amount: string;
    };

/** Interleaves synthetic "interest accrued ≈" rows into a chronological
 *  (oldest-first) ledger page. The residual between consecutive rows is
 *  `debtAfter[i] − (debtChange + upfrontFee + redist)[i] − debtAfter[i-1]`
 *  — with post-accrual snapshots that equals `debtBefore[i] −
 *  debtAfter[i-1]`, i.e. exactly the interest that accrued between the two
 *  touches.
 *
 *  `synthesizeInterest` is the derivation gate: false for a partial or
 *  truncated ledger (a missing protocol row would masquerade as interest)
 *  and false whenever any row's debt snapshots are null (batch rows) — the
 *  caller shows the explicit batch notice instead. A non-positive residual
 *  is skipped: zero elapsed interest (same-block ops) yields no row, and a
 *  negative residual would mean inconsistent snapshots, which an estimate
 *  row must not paper over. */
export function buildTroveLedgerDisplayRows(
  ascendingRows: readonly CdpTroveLedgerEventRow[],
  { synthesizeInterest }: { synthesizeInterest: boolean },
): TroveLedgerDisplayRow[] {
  const out: TroveLedgerDisplayRow[] = [];
  for (let i = 0; i < ascendingRows.length; i += 1) {
    const row = ascendingRows[i]!;
    if (synthesizeInterest && i > 0) {
      const previous = ascendingRows[i - 1]!;
      if (previous.debtAfter != null && row.debtAfter != null) {
        const residual =
          BigInt(row.debtAfter) -
          BigInt(totalLedgerDebtChange(row)) -
          BigInt(previous.debtAfter);
        if (residual > BigInt(0)) {
          out.push({
            kind: "interest",
            id: `interest-${row.id}`,
            timestamp: row.timestamp,
            amount: residual.toString(),
          });
        }
      }
    }
    out.push({ kind: "event", row });
  }
  return out;
}
