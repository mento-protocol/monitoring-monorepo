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

// Ordered strongest-tier-first so the renderer picks the bigger match.
// `kMad` = how many MADs above the median a reward must clear to fire the
// tier. 5·MAD ≈ z=3.4, near the Iglewicz-Hoaglin "outlier" cutoff of 3.5.
const REWARD_OUTLIER_TIERS = [
  {
    kMad: 5,
    className: "text-amber-300 font-semibold",
    title: "Strong reward outlier — far above typical for this pool",
  },
  {
    kMad: 3,
    className: "text-amber-400",
    title: "Reward outlier — above typical for this pool",
  },
] as const;

type RewardThresholds = readonly {
  tier: (typeof REWARD_OUTLIER_TIERS)[number];
  cutoff: number;
}[];

// 5min refresh: distribution shifts <1% per new event, so the default 30s
// poll burns ~10x request volume on essentially-static data.
const REWARD_HIST_REFRESH_MS = 5 * 60_000;

// Round to formatUSD's display precision so two values rendering as the
// same string (e.g. 9.8493 and 9.8511 both → "$9.85") compare equal at the
// percentile cutoff. Round-trips through formatUSD itself rather than
// re-implementing the tier arithmetic — `.toFixed(1)`'s IEEE-754
// round-half-to-even disagrees with `Math.round`'s round-half-away-from-zero
// at $X50 boundaries (e.g. formatUSD(1150)="$1.1K" but Math.round(1150/100)
// would give 1200 → "$1.2K"), reintroducing the same visual-split bug this
// helper is supposed to fix. Parsing the formatted string keeps the two in
// lockstep automatically as formatUSD's tiers evolve.
//
// Invariant we actually depend on: formatUSD(a) === formatUSD(b) implies
// toDisplayPrecision(a) === toDisplayPrecision(b) — i.e. cells that look
// identical never split across a tier. The reverse is not guaranteed: at
// the [999.995, 1000) boundary formatUSD takes the sub-$1K branch (".$X.XX"
// rounds up to "$1000.00") but parsing yields 1000, which re-formats via
// the K-branch as "$1K". That's fine — both still round to the same
// threshold value, so two such cells stay tier-consistent.
export function toDisplayPrecision(value: number): number {
  if (!Number.isFinite(value)) return value;
  const formatted = formatUSD(value);
  const m = formatted.match(/^\$(-?\d+(?:\.\d+)?)([KM]?)$/);
  if (!m) return value;
  const scale = m[2] === "M" ? 1_000_000 : m[2] === "K" ? 1_000 : 1;
  return Number(m[1]) * scale;
}

function median(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function computeRewardThresholds(
  rawRewards: readonly (string | null | undefined)[],
): RewardThresholds | null {
  // Compute on raw values (NOT toDisplayPrecision). Rounding here would
  // collapse sub-cent pools to a vector of zeros — formatUSD reports
  // "$0.00" for any value < $0.005, so e.g. a pool with rewards in the
  // 0.001–0.004 range plus a single $50 outlier ends up with 30 zeros
  // and one 50, MAD=0, and *no* highlighting on the obvious outlier.
  // Visual-equality across display-precision is preserved at the cell
  // render site by `rounded > cutoff` (renderRewardCell), which quantises
  // both cells to the same bin regardless of where cutoff lands.
  const values = rawRewards
    .flatMap((r) => {
      const v = r ? Number(r) : Number.NaN;
      return Number.isFinite(v) && v > 0 ? [v] : [];
    })
    .toSorted((a, b) => a - b);
  if (values.length < MIN_REWARD_SAMPLE_SIZE) return null;
  const med = median(values);
  const mad = median(
    values.map((v) => Math.abs(v - med)).toSorted((a, b) => a - b),
  );
  // MAD = 0 means majority of samples are exactly equal. No meaningful
  // spread → skip highlighting rather than tier on noise.
  if (mad === 0) return null;
  return REWARD_OUTLIER_TIERS.map((tier) => ({
    tier,
    cutoff: med + tier.kMad * mad,
  }));
}

export function renderRewardCell(
  rewardUsd: string | null | undefined,
  thresholds: RewardThresholds | null,
): React.ReactNode {
  if (!rewardUsd) return "—";
  const value = Number(rewardUsd);
  const formatted = formatUSD(value);
  if (!thresholds || !Number.isFinite(value)) return formatted;
  // Compare at display precision so visually-identical cells always share
  // a tier (e.g. raw 9.8493 and 9.8511 both render "$9.85" → both quantise
  // to 9.85 here, regardless of where cutoff lands between them).
  const rounded = toDisplayPrecision(value);
  const match = thresholds.find((t) => rounded > t.cutoff);
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

function RewardCell({
  rewardUsd,
  thresholds,
}: {
  rewardUsd: string | null | undefined;
  thresholds: RewardThresholds | null;
}) {
  // `renderRewardCell` stays exported for `__tests__/exports.test.ts`'s
  // pinned contract; this wrapper is the named-component form the rule
  // wants for proper reconciliation.
  // react-doctor-disable-next-line react-doctor/no-render-in-render
  return renderRewardCell(rewardUsd, thresholds);
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
    return raw.toSorted(
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
                    <RewardCell
                      rewardUsd={r.rewardUsd}
                      thresholds={rewardThresholds}
                    />
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
