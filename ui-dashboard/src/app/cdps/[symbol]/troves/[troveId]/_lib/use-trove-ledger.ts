"use client";

// The one bounded full-history read for the trove history page. Every
// consumer of complete-ledger data on this route — the ledger table now,
// the charts (#2087) and the redemption-impact reconciliation (#2088) later
// — must read THIS hook's result, never its own pagination or a second
// ledger query (docs/PLAN-trove-history-page.md, invariant 5: charts read
// the full bounded history query, never a paginated slice).

import { useMemo } from "react";
import { HASURA_TIMEOUT_MS, useGQL } from "@/lib/graphql";
import { CDP_TROVE_LEDGER, CDP_TROVE_SCHEMA_FIELDS } from "@/lib/queries";
import { paginateTroveOperations } from "./params";
import {
  CDP_TROVE_LEDGER_RENDER_LIMIT,
  CDP_TROVE_LEDGER_REQUEST_LIMIT,
  CdpTroveLedgerSchema,
  hasCompleteDebtSnapshots,
  resolveLedgerWatermark,
  sortTroveLedgerRowsDesc,
  supportsTroveLedger,
  type CdpTroveLedgerEventRow,
  type CdpTroveLedgerResponse,
  type CdpTroveLedgerSchemaProbe,
  type TroveLedgerWatermark,
} from "./ledger";

export type TroveLedgerState = {
  /** The introspection gate: the live schema serves `TroveLedgerEvent` and
   *  the `Trove` watermark columns. Re-evaluated on every probe poll —
   *  false renders the interim assembly, and a mid-session flip in either
   *  direction swaps the view (upgrade on promotion, honest fallback on
   *  rollback). Fails closed while the probe loads or errors. */
  supported: boolean;
  /** Chronological (oldest-first) ledger rows, capped at the render limit.
   *  When truncated, the OLDEST rows were dropped (desc fetch, reversed
   *  client-side) so the recent events under investigation survive. */
  rows: CdpTroveLedgerEventRow[];
  /** True only when the limit+1 sentinel row came back — never inferred
   *  from `rows.length === renderLimit` (a history of exactly the render
   *  limit is complete). */
  truncated: boolean;
  /** Derivation gate for later slices as well as this one: the ledger has
   *  loaded and is NOT truncated. A truncated history counts as partial —
   *  interest estimates, net equity, and the cumulatives reconciliation
   *  all stay off (they need the whole history, and a missing early row
   *  would misattribute its delta). Refresh failures keep the last
   *  confirmed complete page, so `complete` stays true alongside a
   *  disclosed stale-refresh notice. */
  complete: boolean;
  /** Every rendered row carries non-null debt snapshots. False (batch-op
   *  rows present) switches debt-derived output to the explicit batch
   *  notice. Collateral snapshots are always present. */
  debtSnapshotsComplete: boolean;
  /** `Trove.lastLedgerBlock`/`lastLedgerLogIndex`, fetched inside the same
   *  gated response as the rows. Null while unsupported/loading or when
   *  the trove itself isn't indexed. `("0", 0)` means "no ledger row yet".
   *  The #2088 reconciliation compares this against the newest row's
   *  (blockNumber, logIndex) pair before trusting cumulative sums. */
  watermark: TroveLedgerWatermark | null;
  isLoading: boolean;
  error: Error | undefined;
  /** `data != null`, captured before any `?? []` fallback collapses "never
   *  loaded" and "loaded, confirmed empty" (a fresh trove can have a
   *  legitimately empty ledger). */
  hasLoadedOnce: boolean;
};

export function useTroveLedger(troveEntityId: string | null): TroveLedgerState {
  // Same probe query + cadence as the header's schema-lag gate in
  // `trove-detail-client.tsx` — SWR keys on the query text, so this is one
  // shared cache entry/network fetch, not a second poll.
  const probe = useGQL<CdpTroveLedgerSchemaProbe>(
    troveEntityId == null ? null : CDP_TROVE_SCHEMA_FIELDS,
    undefined,
    { refreshInterval: 300_000, timeoutMs: HASURA_TIMEOUT_MS },
  );
  const supported = supportsTroveLedger(probe.data);
  const enabled = supported && troveEntityId != null;
  const ledger = useGQL<CdpTroveLedgerResponse>(
    enabled ? CDP_TROVE_LEDGER : null,
    enabled
      ? { troveEntityId, limit: CDP_TROVE_LEDGER_REQUEST_LIMIT }
      : undefined,
    { timeoutMs: HASURA_TIMEOUT_MS, schema: CdpTroveLedgerSchema },
  );

  const { rows, truncated } = useMemo(
    () =>
      paginateTroveOperations(
        sortTroveLedgerRowsDesc(ledger.data?.TroveLedgerEvent ?? []),
        CDP_TROVE_LEDGER_RENDER_LIMIT,
      ),
    [ledger.data],
  );
  const debtSnapshotsComplete = useMemo(
    () => hasCompleteDebtSnapshots(rows),
    [rows],
  );

  const hasLoadedOnce = ledger.data != null;
  return {
    supported,
    rows,
    truncated,
    complete: hasLoadedOnce && !truncated,
    debtSnapshotsComplete,
    watermark: resolveLedgerWatermark(ledger.data),
    isLoading: ledger.isLoading,
    error: ledger.error,
    hasLoadedOnce,
  };
}
