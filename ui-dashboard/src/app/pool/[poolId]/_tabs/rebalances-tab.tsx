"use client";

import { useAddressLabels } from "@/components/address-labels-provider";
import { EffectivenessChart } from "@/components/effectiveness-chart";
import { EmptyBox, ErrorBox, Skeleton } from "@/components/feedback";
import { InfoPopover } from "@/components/info-popover";
import { Pagination } from "@/components/pagination";
import { SenderCell } from "@/components/sender-cell";
import { Row, Table, Td, Th } from "@/components/table";
import { TableSearch } from "@/components/table-search";
import { TagsCell } from "@/components/tags-cell";
import { TxHashCell } from "@/components/tx-hash-cell";
import {
  ENVIO_MAX_ROWS,
  SEARCH_BOOTSTRAP_LIMIT,
  SEARCH_MAX_LIMIT,
} from "@/lib/constants";
import {
  formatBlock,
  formatBoundaryBps,
  formatEffectivenessPercent,
  formatTimestamp,
  formatUSD,
  relativeTime,
} from "@/lib/format";
import { useGQL } from "@/lib/graphql";
import {
  POOL_REBALANCE_REWARDS,
  POOL_REBALANCES,
  POOL_REBALANCES_COUNT,
  POOL_REBALANCES_PAGE,
  POOL_REBALANCES_USD_EXT,
} from "@/lib/queries";
import { normalizeSearch } from "@/lib/table-search";
import { buildOrderBy } from "@/lib/table-sort";
import type { Pool, RebalanceEvent } from "@/lib/types";
import React, { useMemo } from "react";
import { MIN_REWARD_SAMPLE_SIZE } from "../_lib/constants";
import { addressSearchTerms, matchesRowSearch } from "../_lib/helpers";
import {
  BOUNDARY_TOOLTIP,
  EFFECTIVENESS_TOOLTIP,
  REWARD_TOOLTIP,
} from "../_lib/tooltips";

// Ordered highest-tier-first so the renderer picks the strongest match.
// Tooltips say "recent rebalances" because POOL_REBALANCE_REWARDS is
// capped at ENVIO_MAX_ROWS (1000) — pools with longer history sample
// from the recent window only.
const REWARD_OUTLIER_TIERS = [
  {
    quantile: 0.95,
    className: "text-amber-300 font-semibold",
    title: "Top 5% reward across this pool's recent rebalances",
  },
  {
    quantile: 0.9,
    className: "text-amber-400",
    title: "Top 10% reward across this pool's recent rebalances",
  },
] as const;

type RewardThresholds = readonly {
  tier: (typeof REWARD_OUTLIER_TIERS)[number];
  min: number;
}[];

// 5min refresh: distribution shifts <1% per new event, so the default 30s
// poll burns ~10x request volume on essentially-static data.
const REWARD_HIST_REFRESH_MS = 5 * 60_000;

export function computeRewardThresholds(
  rawRewards: readonly (string | null | undefined)[],
): RewardThresholds | null {
  // Filter to positives: zero-reward rebalances aren't outlier candidates
  // and including them would skew thresholds downward on pools that had a
  // 0-bps reward phase.
  const values = rawRewards
    .map((r) => (r ? Number(r) : Number.NaN))
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (values.length < MIN_REWARD_SAMPLE_SIZE) return null;
  // 1-based nearest-rank: ceil(n*q) gives the rank of the q-quantile, so
  // ceil(n*q)-1 is the 0-based index of the largest value at-or-below it.
  // Paired with strict `>` in the renderer this gives the top (n - ceil(n*q))
  // rows. floor(n*q) under-counted by one — at exactly N=20 it resolved
  // p95 to the max value so no row could ever fire the tier.
  const at = (q: number) =>
    values[Math.max(0, Math.ceil(values.length * q) - 1)];
  return REWARD_OUTLIER_TIERS.map((tier) => ({ tier, min: at(tier.quantile) }));
}

export function renderRewardCell(
  rewardUsd: string | null | undefined,
  thresholds: RewardThresholds | null,
): React.ReactNode {
  if (!rewardUsd) return "—";
  const value = Number(rewardUsd);
  const formatted = formatUSD(value);
  if (!thresholds || !Number.isFinite(value)) return formatted;
  // Strict >: ties at the cutoff are NOT highlighted. With heavy clustering
  // (e.g. a long stretch of identical-reward rebalances) this is the
  // fail-safe: if the cutoff isn't strictly above lower values, no row gets
  // the tier rather than every tied row getting it.
  const match = thresholds.find((t) => value > t.min);
  if (!match) return formatted;
  return (
    <span className={match.tier.className} title={match.tier.title}>
      {formatted}
      {/* Visible-on-hover via title; sr-only span gives screen readers
          the tier context they'd otherwise miss. */}
      <span className="sr-only"> — {match.tier.title}</span>
    </span>
  );
}

export function RebalancesTab({
  poolId,
  limit,
  pool,
  search,
  onSearchChange,
}: {
  poolId: string;
  limit: number;
  pool: Pool | null;
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const breachStart = pool?.deviationBreachStartedAt
    ? Number(pool.deviationBreachStartedAt)
    : 0;
  const { getName, getTags } = useAddressLabels();
  const query = normalizeSearch(search);
  const [rawPage, setRawPage] = React.useState(1);

  const handleSearchChange = React.useCallback(
    (value: string) => {
      onSearchChange(value);
      setRawPage(1);
    },
    [onSearchChange],
  );

  const { data: countData, error: countError } = useGQL<{
    RebalanceEvent: { id: string }[];
  }>(POOL_REBALANCES_COUNT, { poolId, limit: ENVIO_MAX_ROWS, offset: 0 });
  const lastKnownTotalRef = React.useRef(0);
  const rawTotal = countData?.RebalanceEvent?.length ?? 0;
  if (rawTotal > 0) lastKnownTotalRef.current = rawTotal;
  const total = countError ? lastKnownTotalRef.current : rawTotal;
  const countCapped = rawTotal >= ENVIO_MAX_ROWS;

  const totalPages = total > 0 ? Math.ceil(total / limit) : 1;
  const page = Math.max(1, Math.min(rawPage, totalPages));
  const isSearching = query.length > 0;
  const searchFetchLimit =
    total > 0 ? Math.min(total, SEARCH_MAX_LIMIT) : SEARCH_BOOTSTRAP_LIMIT;
  const fetchLimit = isSearching ? searchFetchLimit : limit;
  const fetchOffset = isSearching ? 0 : (page - 1) * limit;
  const orderBy = useMemo(() => buildOrderBy("blockNumber", "desc"), []);

  const { data, error, isLoading } = useGQL<{
    RebalanceEvent: RebalanceEvent[];
  }>(POOL_REBALANCES_PAGE, {
    poolId,
    limit: fetchLimit,
    offset: fetchOffset,
    orderBy,
  });
  const baseRows = data?.RebalanceEvent ?? [];

  // EXT query for the new USD profit fields. Isolated so a Hasura
  // schema-lag during deploy degrades the Reward column to "—" instead
  // of breaking the whole tab. Fetch by row id from the main page so
  // the result mirrors whatever the main query returned.
  const rebalanceIds = useMemo(() => baseRows.map((r) => r.id), [baseRows]);
  const { data: usdData } = useGQL<{
    RebalanceEvent: Pick<
      RebalanceEvent,
      | "id"
      | "amount0Delta"
      | "amount1Delta"
      | "rewardBps"
      | "notionalUsd"
      | "rewardUsd"
    >[];
  }>(rebalanceIds.length > 0 ? POOL_REBALANCES_USD_EXT : null, {
    ids: rebalanceIds,
  });
  const rows = useMemo(() => {
    const usdById = new Map(
      (usdData?.RebalanceEvent ?? []).map((r) => [r.id, r]),
    );
    return baseRows.map((r) => ({ ...r, ...(usdById.get(r.id) ?? {}) }));
  }, [baseRows, usdData]);

  // Full-pool-history reward distribution for outlier highlighting. Fetched
  // separately so paginating the table doesn't refetch the distribution.
  const { data: rewardHistData } = useGQL<{
    RebalanceEvent: { rewardUsd: string | null }[];
  }>(
    POOL_REBALANCE_REWARDS,
    { poolId, limit: ENVIO_MAX_ROWS },
    REWARD_HIST_REFRESH_MS,
  );
  const rewardThresholds = useMemo(
    () =>
      computeRewardThresholds(
        (rewardHistData?.RebalanceEvent ?? []).map((r) => r.rewardUsd),
      ),
    [rewardHistData],
  );

  // Separate chart query — fetch up to 200 events for the trend chart
  const { data: chartData } = useGQL<{ RebalanceEvent: RebalanceEvent[] }>(
    POOL_REBALANCES,
    { poolId, limit: 200 },
  );
  const chartRows = useMemo(() => {
    // Exclude degenerate rebalances: the indexer stamps empty string when
    // `computeEffectivenessRatio` returns null (threshold=0 sentinel, pool
    // already in-band, or before=0). A real `"0.0000"` (before==after above
    // threshold) is a legitimate KPI-4 miss and stays on the chart.
    const raw = (chartData?.RebalanceEvent ?? []).filter(
      (r) => r.effectivenessRatio != null && r.effectivenessRatio !== "",
    );
    return [...raw].sort(
      (a, b) => Number(a.blockTimestamp) - Number(b.blockTimestamp),
    );
  }, [chartData]);

  const filteredRows = useMemo(() => {
    if (!query) return rows;
    return rows.filter((r) => {
      return matchesRowSearch(query, [
        r.txHash,
        ...addressSearchTerms(r.sender, getName, getTags),
        ...addressSearchTerms(r.caller, getName, getTags),
        Number(r.priceDifferenceBefore).toLocaleString(),
        Number(r.priceDifferenceAfter).toLocaleString(),
        formatBoundaryBps(r.rebalanceThreshold),
        formatEffectivenessPercent(r.effectivenessRatio),
        r.rewardUsd ? formatUSD(Number(r.rewardUsd)) : null,
        r.blockNumber,
      ]);
    });
  }, [rows, query, getName, getTags]);

  if (error) return <ErrorBox message={error.message} />;
  if (isLoading) return <Skeleton rows={5} />;
  if (rows.length === 0)
    return <EmptyBox message="No rebalance events for this pool." />;

  return (
    <>
      <EffectivenessChart events={chartRows} />
      <TableSearch
        value={search}
        onChange={handleSearchChange}
        placeholder="Search rebalances by tx, strategy, rebalancer, name, tag, or block…"
        ariaLabel="Search rebalances"
      />
      {filteredRows.length === 0 ? (
        <EmptyBox message="No rebalances match your search." />
      ) : (
        <Table>
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/50">
              <Th>Tx</Th>
              <Th>Strategy</Th>
              <th
                scope="col"
                className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400"
              >
                Strat. Tags
              </th>
              <Th>Rebalancer</Th>
              <th
                scope="col"
                className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400"
              >
                Caller Tags
              </th>
              <Th align="right">Before (bps)</Th>
              <Th align="right">After (bps)</Th>
              <Th align="right">
                <span className="inline-flex items-center gap-1">
                  Boundary (bps)
                  <InfoPopover
                    label="About rebalance boundary"
                    content={BOUNDARY_TOOLTIP}
                  />
                </span>
              </Th>
              <Th align="right">
                <span className="inline-flex items-center gap-1">
                  Effectiveness
                  <InfoPopover
                    label="About rebalance effectiveness"
                    content={EFFECTIVENESS_TOOLTIP}
                  />
                </span>
              </Th>
              <Th align="right">
                <span className="inline-flex items-center gap-1">
                  Reward
                  <InfoPopover
                    label="About rebalance reward"
                    content={REWARD_TOOLTIP}
                  />
                </span>
              </Th>
              <Th align="right">Block</Th>
              <Th>Time</Th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r) => {
              const duringBreach =
                breachStart > 0 && Number(r.blockTimestamp) >= breachStart;
              return (
                <Row key={r.id}>
                  <TxHashCell txHash={r.txHash} />
                  <SenderCell address={r.sender} />
                  <TagsCell
                    address={r.sender}
                    className="hidden sm:table-cell"
                  />
                  <SenderCell address={r.caller} />
                  <TagsCell
                    address={r.caller}
                    className="hidden sm:table-cell"
                  />
                  <Td mono small align="right">
                    {Number(r.priceDifferenceBefore).toLocaleString()}
                  </Td>
                  <Td mono small align="right">
                    {Number(r.priceDifferenceAfter).toLocaleString()}
                  </Td>
                  <Td mono small muted align="right">
                    {formatBoundaryBps(r.rebalanceThreshold) ?? "—"}
                  </Td>
                  <Td mono small align="right">
                    {formatEffectivenessPercent(r.effectivenessRatio) ?? "—"}
                  </Td>
                  <Td mono small align="right">
                    {renderRewardCell(r.rewardUsd, rewardThresholds)}
                  </Td>
                  <Td mono small muted align="right">
                    {formatBlock(r.blockNumber)}
                  </Td>
                  <Td small muted title={formatTimestamp(r.blockTimestamp)}>
                    {relativeTime(r.blockTimestamp)}
                    {duringBreach && (
                      <span
                        className="ml-1 text-red-400"
                        role="img"
                        aria-label="Occurred during deviation breach"
                        title="Occurred during deviation breach"
                      >
                        !
                      </span>
                    )}
                  </Td>
                </Row>
              );
            })}
          </tbody>
        </Table>
      )}
      {!isSearching && (
        <Pagination
          page={page}
          pageSize={limit}
          total={total}
          onPageChange={setRawPage}
        />
      )}
      {countCapped && !isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Showing first {ENVIO_MAX_ROWS.toLocaleString()} rebalances — older
          entries may exist beyond this page range.
        </p>
      )}
      {countCapped && isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Search covers the most recent {ENVIO_MAX_ROWS.toLocaleString()}{" "}
          rebalances only.
        </p>
      )}
      {countError && !isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Could not load total count — pagination may be incomplete.
        </p>
      )}
      {countError && isSearching && (
        <p className="px-1 pt-1 text-xs text-amber-400">
          Could not load total count — search covers the most recent{" "}
          {SEARCH_BOOTSTRAP_LIMIT.toLocaleString()} entries only.
        </p>
      )}
    </>
  );
}
