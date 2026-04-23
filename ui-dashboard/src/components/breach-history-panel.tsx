"use client";

import React, { useCallback, useMemo, useState } from "react";
import type {
  Pool,
  DeviationThresholdBreach,
  BreachEventCategory,
} from "@/lib/types";
import type { Network } from "@/lib/networks";
import { useGQL } from "@/lib/graphql";
import {
  POOL_DEVIATION_BREACHES_ALL,
  POOL_DEVIATION_BREACHES_COUNT,
  POOL_DEVIATION_BREACHES_PAGE,
} from "@/lib/queries";
import { formatTimestamp, relativeTime } from "@/lib/format";
import { formatDurationShort, parseDurationSeconds } from "@/lib/bridge-status";
import {
  formatDeviationPct,
  DEVIATION_BREACH_GRACE_SECONDS,
} from "@/lib/health";
import { tradingSecondsInRange } from "@/lib/weekend";
import { explorerTxUrl } from "@/lib/tokens";
import { useAddressLabels } from "@/components/address-labels-provider";
import { BreachHistoryChart } from "@/components/breach-history-chart";
import { TableSearch } from "@/components/table-search";
import { Pagination } from "@/components/pagination";
import { SortableTh } from "@/components/sortable-th";
import { EmptyBox, ErrorBox } from "@/components/feedback";
import { buildOrderBy, type SortDir } from "@/lib/table-sort";
import {
  buildSearchBlob,
  matchesSearch,
  normalizeSearch,
} from "@/lib/table-search";
import { ENVIO_MAX_ROWS } from "@/lib/constants";

interface Props {
  pool: Pool;
  network: Network;
  limit: number;
  search: string;
  onSearchChange: (value: string) => void;
}

const END_REASON_LABELS: Record<BreachEventCategory, string> = {
  rebalance: "Rebalanced",
  swap: "Swap",
  liquidity: "Liquidity event",
  oracle_update: "Oracle moved",
  threshold_change: "Threshold changed",
  unknown: "Unknown",
};

const START_REASON_LABELS: Record<BreachEventCategory, string> = {
  rebalance: "Rebalance (reverse)",
  swap: "Swap",
  liquidity: "Liquidity event",
  oracle_update: "Oracle moved",
  threshold_change: "Threshold change",
  unknown: "Unknown",
};

/**
 * Duration-range filter presets. Each one compiles to a Hasura
 * `_and`-able where clause. Buckets line up with how operators think
 * about breach severity (in-grace = WARN-only, 1h–1d = moderately bad,
 * >1d = really stuck).
 */
type DurationBucket = "all" | "in_grace" | "short" | "long" | "ongoing";

const ONE_HOUR = 3600;
const ONE_DAY = 86400;

const BUCKET_LABEL: Record<DurationBucket, string> = {
  all: "All",
  in_grace: "≤1h",
  short: "1h – 1d",
  long: "Over 1d",
  ongoing: "Ongoing",
};

function whereForBucket(bucket: DurationBucket): Record<string, unknown> {
  switch (bucket) {
    case "all":
      return {};
    case "in_grace":
      // Closed breaches whose post-grace critical portion was zero.
      return {
        endedAt: { _is_null: false },
        criticalDurationSeconds: { _eq: "0" },
      };
    case "short":
      return {
        endedAt: { _is_null: false },
        durationSeconds: { _gt: String(ONE_HOUR), _lte: String(ONE_DAY) },
      };
    case "long":
      return {
        endedAt: { _is_null: false },
        durationSeconds: { _gt: String(ONE_DAY) },
      };
    case "ongoing":
      return { endedAt: { _is_null: true } };
  }
}

/**
 * Compose the bucket clause with optional numeric min/max filters. The
 * min/max values come from free-text inputs the user types (`1h`, `3
 * days`, etc.); they compose with the bucket via `_and` so "Over 1d +
 * min: 7d" narrows to breaches strictly over a week. Applied only when
 * non-null so an empty input doesn't pin everything to "≥0s".
 *
 * Open breaches have NULL `durationSeconds` until they close, so a naive
 * `durationSeconds >= min` predicate would drop every in-flight
 * incident. We OR the range against `durationSeconds IS NULL` so
 * ongoing rows stay visible regardless of the numeric filter — hiding
 * an active incident behind a filter is the worst-case UX here.
 */
function composeWhere(
  bucket: DurationBucket,
  minSeconds: number | null,
  maxSeconds: number | null,
): Record<string, unknown> {
  const bucketClause = whereForBucket(bucket);
  if (minSeconds == null && maxSeconds == null) return bucketClause;

  const durationRange: Record<string, unknown> = {};
  if (minSeconds != null) durationRange._gte = String(minSeconds);
  if (maxSeconds != null) durationRange._lte = String(maxSeconds);

  const durationOr = {
    _or: [
      { durationSeconds: durationRange },
      { durationSeconds: { _is_null: true } },
    ],
  };

  // Hasura tolerates an empty object on one side of _and, so this is safe
  // even when `bucket === "all"` (bucketClause === {}).
  return { _and: [bucketClause, durationOr] };
}

/** Columns the user can sort on server-side. */
type SortKey =
  | "startedAt"
  | "durationSeconds"
  | "criticalDurationSeconds"
  | "peakPriceDifference";

export function BreachHistoryPanel({
  pool,
  network,
  limit,
  search,
  onSearchChange,
}: Props) {
  const { getName, getTags } = useAddressLabels();
  const query = normalizeSearch(search);
  const [rawPage, setRawPage] = useState(1);
  const [sortKey, setSortKey] = useState<SortKey>("startedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [bucket, setBucket] = useState<DurationBucket>("all");
  // Min/max are committed values (numeric seconds, or null when empty /
  // invalid). The child controls their own draft text — we only see
  // committed numbers here so re-renders don't fire on every keystroke.
  const [minSeconds, setMinSeconds] = useState<number | null>(null);
  const [maxSeconds, setMaxSeconds] = useState<number | null>(null);

  // Any control that changes the result set resets pagination. Without
  // this, clicking "Over 1d" on page 3 of an unfiltered 400-row result
  // would leave the user stranded on a now-empty page.
  const handleSearchChange = useCallback(
    (value: string) => {
      onSearchChange(value);
      setRawPage(1);
    },
    [onSearchChange],
  );
  const handleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return prev;
      }
      // First click on a new column: descending default (biggest durations
      // / peaks / most-recent starts at the top — usually what you want).
      setSortDir("desc");
      return key;
    });
    setRawPage(1);
  }, []);
  const handleBucket = useCallback((next: DurationBucket) => {
    setBucket(next);
    setRawPage(1);
  }, []);
  const handleMinCommit = useCallback((seconds: number | null) => {
    setMinSeconds(seconds);
    setRawPage(1);
  }, []);
  const handleMaxCommit = useCallback((seconds: number | null) => {
    setMaxSeconds(seconds);
    setRawPage(1);
  }, []);

  const where = useMemo(
    () => composeWhere(bucket, minSeconds, maxSeconds),
    [bucket, minSeconds, maxSeconds],
  );

  const orderBy = useMemo(
    () => buildOrderBy(sortKey, sortDir, "startedAt"),
    [sortKey, sortDir],
  );

  if (pool.source.includes("virtual")) return null;

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
      setRawPage={setRawPage}
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
  setRawPage,
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
  setRawPage: (n: number) => void;
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
  const { data: countData, error: countError } = useGQL<{
    DeviationThresholdBreach: { id: string }[];
  }>(POOL_DEVIATION_BREACHES_COUNT, {
    poolId: pool.id,
    where,
    limit: ENVIO_MAX_ROWS,
  });
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
  }>(POOL_DEVIATION_BREACHES_PAGE, {
    poolId: pool.id,
    limit,
    offset,
    orderBy,
    where,
  });

  const { data: chartData } = useGQL<{
    DeviationThresholdBreach: DeviationThresholdBreach[];
  }>(POOL_DEVIATION_BREACHES_ALL, { poolId: pool.id, where });

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
      <BreachHistoryChart breaches={chartRows} pool={pool} />

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
            <DurationRangeInputs
              minSeconds={minSeconds}
              maxSeconds={maxSeconds}
              onMinCommit={onMinCommit}
              onMaxCommit={onMaxCommit}
            />
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
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <SortableTh
                    sortKey="startedAt"
                    activeSortKey={sortKey}
                    sortDir={sortDir}
                    onSort={onSort}
                  >
                    Started
                  </SortableTh>
                  <SortableTh
                    sortKey="durationSeconds"
                    activeSortKey={sortKey}
                    sortDir={sortDir}
                    onSort={onSort}
                  >
                    Duration
                  </SortableTh>
                  <SortableTh
                    sortKey="criticalDurationSeconds"
                    activeSortKey={sortKey}
                    sortDir={sortDir}
                    onSort={onSort}
                  >
                    Past grace
                  </SortableTh>
                  <SortableTh
                    sortKey="peakPriceDifference"
                    activeSortKey={sortKey}
                    sortDir={sortDir}
                    onSort={onSort}
                    align="right"
                  >
                    Peak
                  </SortableTh>
                  <th className="py-2 pr-4 font-normal">Trigger</th>
                  <th className="py-2 pr-4 font-normal">Ended by</th>
                  <th className="py-2 pr-4 font-normal text-right">
                    Rebalances
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((b) => (
                  <BreachRow
                    key={b.id}
                    breach={b}
                    pool={pool}
                    network={network}
                    getName={getName}
                  />
                ))}
              </tbody>
            </table>
          </div>
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
          onPageChange={setRawPage}
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

function DurationRangeInputs({
  minSeconds,
  maxSeconds,
  onMinCommit,
  onMaxCommit,
}: {
  minSeconds: number | null;
  maxSeconds: number | null;
  onMinCommit: (seconds: number | null) => void;
  onMaxCommit: (seconds: number | null) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <DurationField
        ariaLabel="Minimum breach duration"
        placeholder="Min."
        committedSeconds={minSeconds}
        onCommit={onMinCommit}
      />
      <span className="text-xs text-slate-600">–</span>
      <DurationField
        ariaLabel="Maximum breach duration"
        placeholder="Max."
        committedSeconds={maxSeconds}
        onCommit={onMaxCommit}
      />
    </div>
  );
}

/**
 * Single duration input. Keeps its own draft text so the parent only
 * re-renders (and re-fires the GraphQL query) on blur or Enter. An empty
 * draft commits `null` — clears the filter instead of leaving it stale.
 * A parse failure keeps the previous committed value and flags the input
 * with a red ring until the user fixes it.
 */
function DurationField({
  ariaLabel,
  placeholder,
  committedSeconds,
  onCommit,
}: {
  ariaLabel: string;
  placeholder: string;
  committedSeconds: number | null;
  onCommit: (seconds: number | null) => void;
}) {
  const [draft, setDraft] = useState(() =>
    committedSeconds != null ? formatDurationShort(committedSeconds) : "",
  );
  const [invalid, setInvalid] = useState(false);
  const commit = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setInvalid(false);
      onCommit(null);
      return;
    }
    const parsed = parseDurationSeconds(trimmed);
    if (parsed == null || parsed <= 0) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onCommit(parsed);
  }, [draft, onCommit]);
  return (
    <input
      type="text"
      inputMode="text"
      autoComplete="off"
      placeholder={placeholder}
      aria-label={ariaLabel}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        // Clear the error as soon as they start fixing it — no point
        // yelling while they type.
        if (invalid) setInvalid(false);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
      className={
        "w-20 rounded-lg border bg-slate-800 px-2 py-1 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 " +
        (invalid
          ? "border-red-500/70 focus:border-red-400 focus:ring-red-400"
          : "border-slate-700 focus:border-indigo-500 focus:ring-indigo-500")
      }
      title={
        invalid
          ? 'Enter a duration like "1h", "30m", "3 days"'
          : "Filter by duration. Supports 1h, 30m, 3d, 1h30m, 2 hours…"
      }
    />
  );
}

function BucketFilter({
  selected,
  onChange,
}: {
  selected: DurationBucket;
  onChange: (next: DurationBucket) => void;
}) {
  const options: DurationBucket[] = [
    "all",
    "in_grace",
    "short",
    "long",
    "ongoing",
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Filter breaches by duration"
      className="flex flex-wrap gap-1.5"
    >
      {options.map((b) => {
        const active = b === selected;
        return (
          <button
            key={b}
            role="radio"
            type="button"
            aria-checked={active}
            onClick={() => !active && onChange(b)}
            className={
              "rounded-full px-2.5 py-0.5 text-[10px] uppercase tracking-wider font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 " +
              (active
                ? "bg-slate-700 text-slate-200"
                : "bg-slate-800/60 text-slate-400 hover:text-slate-200")
            }
          >
            {BUCKET_LABEL[b]}
          </button>
        );
      })}
    </div>
  );
}

function BreachRow({
  breach,
  pool,
  network,
  getName,
}: {
  breach: DeviationThresholdBreach;
  pool: Pool;
  network: Network;
  getName: (addr: string | null, chainId?: number) => string;
}) {
  const isOpen = breach.endedAt == null;
  const now = Math.floor(Date.now() / 1000);
  const wallDuration = isOpen
    ? now - Number(breach.startedAt)
    : Number(breach.durationSeconds);
  // Past-grace uses trading-seconds on open rows so the unit matches the
  // stored `criticalDurationSeconds` on closed rows and the uptime
  // tile's live math. Without this, an open breach spanning an FX
  // weekend would briefly show an inflated "past grace" that collapses
  // once the indexer closes it.
  const graceEnd =
    Number(breach.startedAt) + Number(DEVIATION_BREACH_GRACE_SECONDS);
  const critDuration = isOpen
    ? now > graceEnd
      ? tradingSecondsInRange(graceEnd, now)
      : 0
    : Number(breach.criticalDurationSeconds);
  const threshold = pool.rebalanceThreshold ?? 0;
  const peakPct = threshold
    ? formatDeviationPct(breach.peakPriceDifference, threshold)
    : null;

  const endedLabel = isOpen
    ? "Ongoing"
    : END_REASON_LABELS[breach.endedByEvent ?? "unknown"];
  const startedLabel = START_REASON_LABELS[breach.startedByEvent];

  return (
    <tr className="border-t border-slate-800/60 text-slate-300">
      <td
        className="py-2 pr-4 whitespace-nowrap"
        title={formatTimestamp(breach.startedAt)}
      >
        <a
          href={explorerTxUrl(network, breach.startedByTxHash)}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-indigo-400 transition-colors"
        >
          {relativeTime(breach.startedAt)}
        </a>
      </td>
      <td
        className={`py-2 pr-4 whitespace-nowrap ${isOpen ? "text-amber-400" : ""}`}
      >
        {formatDurationShort(wallDuration)}
        {isOpen && <span className="ml-1 text-xs text-slate-500">ongoing</span>}
      </td>
      <td
        className={`py-2 pr-4 whitespace-nowrap ${critDuration > 0 ? "text-red-400" : "text-slate-500"}`}
      >
        {critDuration > 0 ? formatDurationShort(critDuration) : "—"}
      </td>
      <td
        className="py-2 pr-4 whitespace-nowrap text-right"
        title={breach.peakPriceDifference}
      >
        {peakPct ?? "—"}
      </td>
      <td className="py-2 pr-4 whitespace-nowrap text-slate-400">
        {startedLabel}
      </td>
      <td className="py-2 pr-4 whitespace-nowrap">
        {isOpen ? (
          <span className="text-slate-500">—</span>
        ) : breach.endedByTxHash ? (
          <a
            href={explorerTxUrl(network, breach.endedByTxHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-indigo-400 transition-colors"
            title={
              breach.endedByStrategy
                ? `via ${getName(breach.endedByStrategy, network.chainId)}`
                : undefined
            }
          >
            {endedLabel}
          </a>
        ) : (
          <span className="text-slate-400">{endedLabel}</span>
        )}
      </td>
      <td className="py-2 pr-4 whitespace-nowrap text-right text-slate-400">
        {breach.rebalanceCountDuring}
      </td>
    </tr>
  );
}
