"use client";

import React, { useCallback, useMemo, useReducer } from "react";
import {
  isVirtualPool,
  type Pool,
  type DeviationThresholdBreach,
} from "@/lib/types";
import type { Network } from "@/lib/networks";
import { useGQL } from "@/lib/graphql";
import {
  POOL_DEVIATION_BREACHES_ALL,
  POOL_DEVIATION_BREACHES_COUNT,
  POOL_DEVIATION_BREACHES_PAGE,
} from "@/lib/queries";
import { useAddressLabels } from "@/components/address-labels-provider";
import { BreachHistoryChart } from "@/components/breach-history-chart";
import { TableSearch } from "@/components/table-search";
import { Pagination } from "@/components/pagination";
import { EmptyBox, ErrorBox } from "@/components/feedback";
import { buildOrderBy, type SortDir } from "@/lib/table-sort";
import {
  buildSearchBlob,
  matchesSearch,
  normalizeSearch,
} from "@/lib/table-search";
import { ENVIO_MAX_ROWS } from "@/lib/constants";
import {
  DurationRangeInputs,
  DurationFormatHint,
} from "@/components/breach-history/duration-filter";
import {
  BucketFilter,
  type DurationBucket,
} from "@/components/breach-history/bucket-filter";
import {
  composeWhere,
  START_REASON_LABELS,
  END_REASON_LABELS,
} from "@/components/breach-history/filters";
import {
  BreachTable,
  type SortKey,
} from "@/components/breach-history/breach-table";

interface Props {
  pool: Pool;
  network: Network;
  limit: number;
  search: string;
  onSearchChange: (value: string) => void;
}

type PanelState = {
  rawPage: number;
  sortKey: SortKey;
  sortDir: SortDir;
  bucket: DurationBucket;
  minSeconds: number | null;
  maxSeconds: number | null;
};

type PanelAction =
  | { type: "set-page"; page: number }
  | { type: "sort"; key: SortKey }
  | { type: "bucket"; bucket: DurationBucket }
  | { type: "min"; seconds: number | null }
  | { type: "max"; seconds: number | null };

const INITIAL_PANEL_STATE: PanelState = {
  rawPage: 1,
  sortKey: "startedAt",
  sortDir: "desc",
  bucket: "all",
  minSeconds: null,
  maxSeconds: null,
};

function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "set-page":
      return { ...state, rawPage: action.page };
    case "sort":
      if (state.sortKey === action.key) {
        return {
          ...state,
          rawPage: 1,
          sortDir: state.sortDir === "asc" ? "desc" : "asc",
        };
      }
      // First click on a new column: descending default (biggest durations
      // / peaks / most-recent starts at the top — usually what you want).
      return {
        ...state,
        rawPage: 1,
        sortKey: action.key,
        sortDir: "desc",
      };
    case "bucket":
      return { ...state, rawPage: 1, bucket: action.bucket };
    case "min":
      return { ...state, rawPage: 1, minSeconds: action.seconds };
    case "max":
      return { ...state, rawPage: 1, maxSeconds: action.seconds };
  }
}

export function BreachHistoryPanel(props: Props) {
  const { pool, network, limit, search, onSearchChange } = props;
  const { getName, getTags } = useAddressLabels();
  const query = normalizeSearch(search);
  const [state, dispatch] = useReducer(panelReducer, INITIAL_PANEL_STATE);
  const { rawPage, sortKey, sortDir, bucket, minSeconds, maxSeconds } = state;

  // Any control that changes the result set resets pagination. Without
  // this, clicking "Over 1d" on page 3 of an unfiltered 400-row result
  // would leave the user stranded on a now-empty page.
  const handleSearchChange = useCallback(
    (value: string) => {
      onSearchChange(value);
      dispatch({ type: "set-page", page: 1 });
    },
    [onSearchChange],
  );
  const handleSort = useCallback(
    (key: SortKey) => dispatch({ type: "sort", key }),
    [],
  );
  const handleBucket = useCallback((next: DurationBucket) => {
    dispatch({ type: "bucket", bucket: next });
  }, []);
  const handleMinCommit = useCallback((seconds: number | null) => {
    dispatch({ type: "min", seconds });
  }, []);
  const handleMaxCommit = useCallback((seconds: number | null) => {
    dispatch({ type: "max", seconds });
  }, []);

  const where = useMemo(
    () => composeWhere(bucket, minSeconds, maxSeconds),
    [bucket, minSeconds, maxSeconds],
  );

  const orderBy = useMemo(
    () => buildOrderBy(sortKey, sortDir, "startedAt"),
    [sortKey, sortDir],
  );

  if (isVirtualPool(pool)) return null;

  return (
    <BreachHistoryPanelInner
      pool={pool}
      network={network}
      limit={limit}
      query={query}
      search={search}
      onSearchChange={handleSearchChange}
      getName={getName}
      getTags={getTags}
      rawPage={rawPage}
      onPageChange={(page) => dispatch({ type: "set-page", page })}
      sortKey={sortKey}
      sortDir={sortDir}
      onSort={handleSort}
      bucket={bucket}
      onBucket={handleBucket}
      minSeconds={minSeconds}
      onMinCommit={handleMinCommit}
      maxSeconds={maxSeconds}
      onMaxCommit={handleMaxCommit}
      where={where}
      orderBy={orderBy}
    />
  );
}

function BreachHistoryPanelInner({
  pool,
  network,
  limit,
  query,
  search,
  onSearchChange,
  getName,
  getTags,
  rawPage,
  onPageChange,
  sortKey,
  sortDir,
  onSort,
  bucket,
  onBucket,
  minSeconds,
  onMinCommit,
  maxSeconds,
  onMaxCommit,
  where,
  orderBy,
}: {
  pool: Pool;
  network: Network;
  limit: number;
  query: string;
  search: string;
  onSearchChange: (v: string) => void;
  getName: (addr: string | null, chainId?: number) => string;
  getTags: (addr: string | null) => string[];
  rawPage: number;
  onPageChange: (n: number) => void;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  bucket: DurationBucket;
  onBucket: (next: DurationBucket) => void;
  minSeconds: number | null;
  onMinCommit: (seconds: number | null) => void;
  maxSeconds: number | null;
  onMaxCommit: (seconds: number | null) => void;
  where: Record<string, unknown>;
  orderBy: ReturnType<typeof buildOrderBy>;
}) {
  // Count + paginated page run in parallel against the same $where so the
  // pagination controls match what's rendered.
  //
  // All three queries below (COUNT, PAGE, ALL) suppress focus + reconnect
  // revalidation — firing three parallel reads against the same entity
  // on every alt-tab would triple the burst load on Envio's rate-limited
  // Hasura. Same pattern as use-bridge-gql. The 10s `refreshInterval`
  // still keeps the data live.
  const swrOptions = {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  };
  const { data: countData, error: countError } = useGQL<{
    DeviationThresholdBreach: { id: string }[];
  }>(
    POOL_DEVIATION_BREACHES_COUNT,
    {
      poolId: pool.id,
      where,
      limit: ENVIO_MAX_ROWS,
    },
    undefined,
    swrOptions,
  );
  // `countConfirmed` gates the empty state. Intentionally excludes the
  // countError branch — a failed count leaves `rawTotal = 0` as a
  // DEFAULT, not as a confirmed zero, and pairing that with an empty
  // page slice (e.g. user overshot past the last real page) would
  // falsely render "No breaches recorded" on a pool that clearly has
  // them. Empty-state requires an affirmative "count resolved to zero".
  const countConfirmed = countData !== undefined;
  const rawTotal = countData?.DeviationThresholdBreach?.length ?? 0;
  const countCapped = rawTotal >= ENVIO_MAX_ROWS;
  const totalPages = rawTotal > 0 ? Math.ceil(rawTotal / limit) : 1;
  // Clamp `page` against `totalPages` ONLY when the count is known. With
  // a degraded count, `totalPages` collapses to 1 and clamping would pin
  // the user to the first page — operators need to keep paging through
  // older incidents even when the count query is transiently failing.
  const page = countError
    ? Math.max(1, rawPage)
    : Math.max(1, Math.min(rawPage, totalPages));
  const offset = (page - 1) * limit;

  const { data, error, isLoading } = useGQL<{
    DeviationThresholdBreach: DeviationThresholdBreach[];
  }>(
    POOL_DEVIATION_BREACHES_PAGE,
    {
      poolId: pool.id,
      limit,
      offset,
      orderBy,
      where,
    },
    undefined,
    swrOptions,
  );

  const { data: chartData } = useGQL<{
    DeviationThresholdBreach: DeviationThresholdBreach[];
  }>(
    POOL_DEVIATION_BREACHES_ALL,
    { poolId: pool.id, where },
    undefined,
    swrOptions,
  );

  const rows = data?.DeviationThresholdBreach ?? [];
  const chartRows = chartData?.DeviationThresholdBreach ?? [];

  const filteredRows = useMemo(() => {
    if (!query) return rows;
    return rows.filter((b) =>
      matchesSearch(
        buildSearchBlob([
          b.startedByEvent,
          START_REASON_LABELS[b.startedByEvent],
          b.endedByEvent,
          b.endedByEvent ? END_REASON_LABELS[b.endedByEvent] : null,
          b.startedByTxHash,
          b.endedByTxHash,
          b.endedByStrategy,
          b.endedByStrategy ? getName(b.endedByStrategy, pool.chainId) : null,
          b.endedByStrategy ? getTags(b.endedByStrategy).join(" ") : null,
          b.rebalanceCountDuring,
        ]),
        query,
      ),
    );
  }, [rows, query, getName, getTags, pool.chainId]);

  // Full-panel error ONLY when the page query itself fails — a flaky
  // count request shouldn't blank rows we already have. countError
  // degrades to a small banner below the table (pagination metadata
  // unavailable) instead of hiding the incident list.
  if (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isSchemaLag =
      message.includes("not found in type") ||
      message.includes("type not found") ||
      message.includes("field 'DeviationThresholdBreach'");
    return (
      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
        <h2 className="mb-4 text-sm text-slate-400">Breach History</h2>
        <p
          className={`text-sm ${isSchemaLag ? "text-slate-500" : "text-red-400"}`}
        >
          {isSchemaLag
            ? "Breach history not available yet — indexer rollout in progress."
            : "Couldn't load breach history — try again later."}
        </p>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <BreachHistoryChart breaches={chartRows} />

      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5 sm:p-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm text-slate-400">Breach History</h2>
          <span className="text-xs text-slate-500">
            {countError
              ? `${rows.length.toLocaleString()}+ on this page`
              : countCapped
                ? `${ENVIO_MAX_ROWS.toLocaleString()}+ breaches`
                : `${rawTotal.toLocaleString()} ${rawTotal === 1 ? "breach" : "breaches"}`}
          </span>
        </div>

        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <TableSearch
            value={search}
            onChange={onSearchChange}
            placeholder="Search breaches by tx, trigger, strategy, tag…"
            ariaLabel="Search breaches"
            containerClassName="lg:flex-1 lg:max-w-md"
            inputClassName="w-full"
          />
          <div className="flex flex-wrap items-center gap-3">
            <BucketFilter selected={bucket} onChange={onBucket} />
            <div className="flex flex-col gap-0.5">
              <DurationRangeInputs
                minSeconds={minSeconds}
                maxSeconds={maxSeconds}
                onMinCommit={onMinCommit}
                onMaxCommit={onMaxCommit}
              />
              <DurationFormatHint />
            </div>
          </div>
        </div>

        {isLoading && rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">Loading…</p>
        ) : rows.length === 0 && countConfirmed && rawTotal === 0 ? (
          <EmptyBox
            message={
              bucket === "all"
                ? "No deviation-threshold breaches recorded for this pool."
                : "No breaches match this filter."
            }
          />
        ) : filteredRows.length === 0 ? (
          <EmptyBox message="No breaches on this page match your search. Try clearing it or navigating pages." />
        ) : (
          <BreachTable
            rows={filteredRows}
            network={network}
            getName={getName}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={onSort}
          />
        )}

        <Pagination
          page={page}
          pageSize={limit}
          // When the count query failed we can't know the total — infer
          // "at least one more page" from the length of the returned
          // slice. Full page → bump total so Next stays enabled; short
          // page → total pins at current page so Next disables. Keeps
          // operators able to drill into older breaches even when only
          // pagination metadata is degraded.
          total={
            countError
              ? rows.length === limit
                ? (page + 1) * limit
                : page * limit
              : rawTotal
          }
          onPageChange={onPageChange}
        />
        {countCapped && (
          <p className="px-1 pt-1 text-xs text-amber-400">
            Showing first {ENVIO_MAX_ROWS.toLocaleString()} breaches — older
            entries aren&apos;t visible.
          </p>
        )}
        {countError && (
          <ErrorBox
            message={`Pagination unavailable (count query failed): ${countError.message}`}
          />
        )}
      </section>
    </div>
  );
}
