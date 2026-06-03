"use client";

import type {
  BrokerAggregatorWindowRow,
  BrokerTraderWindowRow,
} from "@/lib/volume";
import { V2VolumeTraderTable } from "./v2-volume-tables";
import { AggregatorBreakdownSection } from "./aggregator-breakdown-section";
import { TableSectionTitle } from "./table-section-title";

/**
 * V2 venue panel for `/volume` — the legacy-broker trader table plus
 * the aggregator / entry-point breakdown table (canonical names from
 * `aggregators.json`; the `unknown` rows are the curation backlog). The
 * aggregator panel is the primary migration-outreach surface — converting
 * a single integration migrates all of its downstream flow, far higher
 * leverage than reaching out to individual signer EOAs.
 *
 * Owns only rendering — the parent (`VolumeClient`) keeps the
 * `BROKER_TRADER_DAILY_TOP` and `BROKER_AGGREGATOR_DAILY_TOP` queries
 * because their loading/error state and the trader-aggregated rows
 * also feed hero KPIs (top-10 concentration's `kpiSource`) and the v2
 * fallback chart's daily-volume series. Splitting just the JSX keeps
 * the data flow explicit at the call site while taking ~60 lines of
 * markup out of the page-client.
 *
 * Lives in its own file so `page-client.tsx` stays under the 600-line
 * soft cap (see repo-root AGENTS.md "File-size budget").
 */
export function V2VolumeSection({
  rangeLabel,
  cutoff,
  v2Aggregated,
  v2AggregatorAggregated,
  hasExploratoryExclusions,
  tableIsLoading,
  tableHasError,
  v2AggIsLoading,
  v2AggHasError,
  isV2AggregatorCapHit,
}: {
  /** Short label for the active range — "24h", "7d", "1M", "3M", or
   *  "all-time" — already mapped from `VolumeRangeKey` by the
   *  parent. Used only in section titles. */
  rangeLabel: string;
  /** Same UTC-day cutoff used by the trader query; bounds the Via marker query. */
  cutoff: number;
  v2Aggregated: readonly BrokerTraderWindowRow[];
  v2AggregatorAggregated: readonly BrokerAggregatorWindowRow[];
  hasExploratoryExclusions: boolean;
  /** Trader-table loading/error: `BrokerTraderDailySnapshot` query. */
  tableIsLoading: boolean;
  tableHasError: boolean;
  /** Aggregator-table loading/error: independent of the trader query so
   *  a slow `BrokerAggregatorDailySnapshot` doesn't take down the
   *  trader view. */
  v2AggIsLoading: boolean;
  v2AggHasError: boolean;
  /** True when `BROKER_AGGREGATOR_DAILY_TOP` saturates the 1000-row
   *  cap — surfaces a banner above the aggregator table because long-tail
   *  aggregator-day rows would silently drop. */
  isV2AggregatorCapHit: boolean;
}) {
  return (
    <>
      <section>
        <TableSectionTitle
          label="About top v2 traders table"
          info="Ranks signer wallets still using legacy Broker v2 by USD volume in this window. Via lists the entry-point routes observed for each wallet."
        >
          Top v2 traders ({rangeLabel})
        </TableSectionTitle>
        <V2VolumeTraderTable
          cutoff={cutoff}
          traders={v2Aggregated}
          isLoading={tableIsLoading}
          hasError={tableHasError}
          hasExploratoryExclusions={hasExploratoryExclusions}
        />
      </section>
      <AggregatorBreakdownSection
        venueLabel="v2"
        rangeLabel={rangeLabel}
        aggregators={v2AggregatorAggregated}
        isLoading={v2AggIsLoading}
        hasError={v2AggHasError}
        isCapHit={isV2AggregatorCapHit}
      />
    </>
  );
}
