"use client";

import { Suspense, useState, useCallback, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { NetworkAwareLink } from "@/components/network-aware-link";
import { useGQL } from "@/lib/graphql";
import {
  ALL_POOLS_WITH_HEALTH,
  POOL_SNAPSHOTS_WINDOW,
  RECENT_SWAPS,
  POOL_SWAPS,
  ALL_OLS_POOLS,
} from "@/lib/queries";
import {
  truncateAddress,
  formatWei,
  relativeTime,
  formatTimestamp,
  formatBlock,
  extractChainIdFromPoolId,
  isNamespacedPoolId,
  isValidAddress,
  normalizePoolIdForChain,
} from "@/lib/format";
import { buildPoolNameMap, tokenSymbol } from "@/lib/tokens";
import {
  snapshotWindow24h,
  snapshotWindow7d,
  buildPoolVolumeMap,
  SNAPSHOT_REFRESH_MS,
} from "@/lib/volume";
import { PoolsTable } from "@/components/pools-table";
import { useNetwork } from "@/components/network-provider";
import type { OlsPool, Pool, PoolSnapshotWindow, SwapEvent } from "@/lib/types";
import { Table, Row, Th, Td } from "@/components/table";
import { Skeleton, EmptyBox, ErrorBox, Tile } from "@/components/feedback";
import { LimitSelect } from "@/components/controls";
import { SenderCell } from "@/components/sender-cell";
import { buildPoolsFilterUrl } from "@/lib/routing";

export default function HomePage() {
  return (
    <Suspense>
      <HomeContent />
    </Suspense>
  );
}

function HomeContent() {
  const { network } = useNetwork();
  const searchParams = useSearchParams();
  const router = useRouter();

  const poolFilter = searchParams.get("pool") ?? "";
  const limit = Number(searchParams.get("limit") ?? "25");

  const [filterInput, setFilterInput] = useState(poolFilter);
  const [filterError, setFilterError] = useState("");

  // Sync URL → input state when the URL changes externally (derived state
  // pattern, avoids calling setState inside useEffect).
  const [prevPoolFilter, setPrevPoolFilter] = useState(poolFilter);
  if (prevPoolFilter !== poolFilter) {
    setPrevPoolFilter(poolFilter);
    setFilterInput(poolFilter);
    setFilterError("");
  }

  const {
    data: poolsData,
    error: poolsErr,
    isLoading: poolsLoading,
  } = useGQL<{ Pool: Pool[] }>(ALL_POOLS_WITH_HEALTH, {
    chainId: network.chainId,
  });

  const {
    data: olsData,
    error: olsErr,
    isLoading: olsLoading,
  } = useGQL<{ OlsPool: Pick<OlsPool, "poolId">[] }>(ALL_OLS_POOLS, {
    chainId: network.chainId,
  });
  const olsPoolIds = useMemo(
    () => new Set((olsData?.OlsPool ?? []).map((p) => p.poolId)),
    [olsData],
  );

  // 24h volume snapshots — query uses the same time window as the global page.
  const poolIds = useMemo(
    () => (poolsData?.Pool ?? []).map((p) => p.id),
    [poolsData],
  );
  const snapshotWindow = snapshotWindow24h(Date.now());
  const {
    data: snapshotData,
    error: snapshotErr,
    isLoading: snapshotLoading,
  } = useGQL<{ PoolSnapshot: PoolSnapshotWindow[] }>(
    poolIds.length > 0 ? POOL_SNAPSHOTS_WINDOW : null,
    { from: snapshotWindow.from, to: snapshotWindow.to, poolIds },
    SNAPSHOT_REFRESH_MS,
  );
  const volume24h = useMemo(
    () =>
      snapshotData
        ? buildPoolVolumeMap(
            snapshotData.PoolSnapshot ?? [],
            poolsData?.Pool ?? [],
            network,
          )
        : undefined,
    [snapshotData, poolsData, network],
  );

  // 7d volume snapshots
  const snapshotWindow7 = snapshotWindow7d(Date.now());
  const {
    data: snapshot7dData,
    error: snapshot7dErr,
    isLoading: snapshot7dLoading,
  } = useGQL<{ PoolSnapshot: PoolSnapshotWindow[] }>(
    poolIds.length > 0 ? POOL_SNAPSHOTS_WINDOW : null,
    { from: snapshotWindow7.from, to: snapshotWindow7.to, poolIds },
    SNAPSHOT_REFRESH_MS,
  );
  const volume7d = useMemo(
    () =>
      snapshot7dData
        ? buildPoolVolumeMap(
            snapshot7dData.PoolSnapshot ?? [],
            poolsData?.Pool ?? [],
            network,
          )
        : undefined,
    [snapshot7dData, poolsData, network],
  );

  const normalizedPoolFilter = poolFilter
    ? normalizePoolIdForChain(poolFilter, network.chainId)
    : "";
  const filteredPoolChainId = extractChainIdFromPoolId(normalizedPoolFilter);
  const hasForeignChainPoolFilter =
    filteredPoolChainId !== null && filteredPoolChainId !== network.chainId;
  const foreignChainErrorMsg = hasForeignChainPoolFilter
    ? `Pool ${normalizedPoolFilter} belongs to chain ${filteredPoolChainId}. Switch networks to view its swaps.`
    : "";
  const swapQuery = hasForeignChainPoolFilter
    ? null
    : normalizedPoolFilter
      ? POOL_SWAPS
      : RECENT_SWAPS;
  const swapVars = normalizedPoolFilter
    ? { poolId: normalizedPoolFilter, limit }
    : { chainId: network.chainId, limit };
  const {
    data: swapsData,
    error: swapsErr,
    isLoading: swapsLoading,
  } = useGQL<{ SwapEvent: SwapEvent[] }>(swapQuery, swapVars);

  const pools = poolsData?.Pool ?? [];
  const swaps = swapsData?.SwapEvent ?? [];
  const poolNames = buildPoolNameMap(network, pools);
  const poolMap = Object.fromEntries(pools.map((p) => [p.id, p]));

  const setURL = useCallback(
    (pool: string, lim: number) => {
      router.replace(buildPoolsFilterUrl(searchParams, pool, lim), {
        scroll: false,
      });
    },
    [router, searchParams],
  );

  const applyFilter = useCallback(() => {
    const v = filterInput.trim();
    if (v && !isValidAddress(v) && !isNamespacedPoolId(v)) {
      setFilterError("Invalid pool filter (expected 0x... or {chainId}-0x...)");
      return;
    }

    const normalized = normalizePoolIdForChain(v, network.chainId);
    const filterChainId = extractChainIdFromPoolId(normalized);
    if (filterChainId !== null && filterChainId !== network.chainId) {
      setFilterError(
        `Pool ${normalized} belongs to chain ${filterChainId}. Switch networks to view its swaps.`,
      );
      return;
    }

    setFilterError("");
    setURL(normalized, limit);
  }, [filterInput, limit, network.chainId, setURL]);

  const clearFilter = useCallback(() => {
    setFilterInput("");
    setFilterError("");
    setURL("", limit);
  }, [limit, setURL]);

  const latestBlock =
    swaps.length > 0
      ? swaps[0].blockNumber
      : pools.length > 0
        ? pools[0].createdAtBlock
        : null;

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Tile label="Pools" value={poolsLoading ? "…" : String(pools.length)} />
        <Tile
          label="Showing"
          value={swapsLoading ? "…" : `${swaps.length} swaps`}
        />
        <Tile
          label="Latest Swap Block"
          value={latestBlock ? formatBlock(latestBlock) : "—"}
        />
      </div>

      <section aria-labelledby="pools-heading">
        <h2
          id="pools-heading"
          className="text-lg font-semibold text-white mb-3"
        >
          Pools
        </h2>
        {poolsErr ? (
          <ErrorBox message={`Failed to load pools: ${poolsErr.message}`} />
        ) : poolsLoading ? (
          <Skeleton rows={3} />
        ) : pools.length === 0 ? (
          <EmptyBox message="No pools found. Is the indexer running?" />
        ) : (
          <>
            {olsErr && !olsLoading && (
              <div className="mb-3">
                <ErrorBox
                  message={`OLS status unavailable right now: ${olsErr.message}. Pool list is loaded, but OLS badges may be incomplete.`}
                />
              </div>
            )}
            <PoolsTable
              pools={pools}
              volume24h={volume24h}
              volume24hLoading={snapshotLoading}
              volume24hError={!!snapshotErr}
              volume7d={volume7d}
              volume7dLoading={snapshot7dLoading}
              volume7dError={!!snapshot7dErr}
              olsPoolIds={olsPoolIds}
            />
          </>
        )}
      </section>

      <section aria-labelledby="swaps-heading">
        <h2
          id="swaps-heading"
          className="text-lg font-semibold text-white mb-3"
        >
          {normalizedPoolFilter
            ? `Swaps for ${poolNames[normalizedPoolFilter] ?? truncateAddress(normalizedPoolFilter)}`
            : "Recent Swaps"}
        </h2>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <label htmlFor="pool-filter" className="text-sm text-slate-400">
            Filter by pool:
          </label>
          <input
            id="pool-filter"
            type="text"
            value={filterInput}
            onChange={(e) => {
              setFilterInput(e.target.value);
              setFilterError("");
            }}
            onKeyDown={(e) => e.key === "Enter" && applyFilter()}
            placeholder="0x… or 42220-0x…"
            aria-label="Filter swaps by pool ID or pool address"
            aria-describedby={filterError ? "filter-error" : undefined}
            aria-invalid={filterError ? true : undefined}
            className="w-96 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm font-mono text-slate-200 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <button
            onClick={applyFilter}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-950"
          >
            Apply
          </button>
          {poolFilter && (
            <button
              onClick={clearFilter}
              className="rounded-md bg-slate-700 px-3 py-1.5 text-sm font-medium text-slate-300 hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-500"
            >
              Clear
            </button>
          )}
          <LimitSelect
            id="limit-select"
            value={limit}
            onChange={(l) => setURL(poolFilter, l)}
          />
        </div>

        {(filterError || foreignChainErrorMsg) && (
          <p
            id="filter-error"
            className="mb-3 text-sm text-red-400"
            role="alert"
          >
            {filterError || foreignChainErrorMsg}
          </p>
        )}

        {swapsErr ? (
          <ErrorBox message={`Failed to load swaps: ${swapsErr.message}`} />
        ) : hasForeignChainPoolFilter ? (
          <EmptyBox message={foreignChainErrorMsg} />
        ) : swapsLoading ? (
          <Skeleton rows={5} />
        ) : swaps.length === 0 ? (
          <EmptyBox
            message={
              poolFilter
                ? "No swaps found for this pool."
                : "No swap events yet."
            }
          />
        ) : (
          <SwapTable
            swaps={swaps}
            showPool={!poolFilter}
            poolNames={poolNames}
            poolMap={poolMap}
          />
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SwapTable({
  swaps,
  showPool,
  poolNames,
  poolMap,
}: {
  swaps: SwapEvent[];
  showPool: boolean;
  poolNames: Record<string, string>;
  poolMap: Record<string, Pool>;
}) {
  const { network } = useNetwork();
  return (
    <Table>
      <thead>
        <tr className="border-b border-slate-800 bg-slate-900/50">
          {showPool && <Th>Pool</Th>}
          <Th>Sender</Th>
          <Th>Trader</Th>
          <Th align="right">Sold</Th>
          <Th align="right">Bought</Th>
          <Th align="right">Block</Th>
          <Th>Time</Th>
        </tr>
      </thead>
      <tbody>
        {swaps.map((s) => {
          const pool = poolMap[s.poolId];
          const sym0 = tokenSymbol(network, pool?.token0 ?? null);
          const sym1 = tokenSymbol(network, pool?.token1 ?? null);
          const soldToken0 = BigInt(s.amount0In) > BigInt(0);
          const soldAmt = soldToken0 ? s.amount0In : s.amount1In;
          const boughtAmt = soldToken0 ? s.amount1Out : s.amount0Out;
          const soldSym = soldToken0 ? sym0 : sym1;
          const boughtSym = soldToken0 ? sym1 : sym0;
          return (
            <Row key={s.id}>
              {showPool && (
                <td className="px-4 py-2">
                  <NetworkAwareLink
                    href={`/pool/${encodeURIComponent(s.poolId)}`}
                    className="text-sm font-medium text-indigo-400 hover:text-indigo-300"
                    title={s.poolId}
                  >
                    {poolNames[s.poolId] ?? truncateAddress(s.poolId)}
                  </NetworkAwareLink>
                </td>
              )}
              <SenderCell address={s.sender} />
              <SenderCell address={s.recipient} />
              <Td mono small align="right">
                {formatWei(soldAmt)} {soldSym}
              </Td>
              <Td mono small align="right">
                {formatWei(boughtAmt)} {boughtSym}
              </Td>
              <Td mono small muted align="right">
                {formatBlock(s.blockNumber)}
              </Td>
              <Td small muted title={formatTimestamp(s.blockTimestamp)}>
                {relativeTime(s.blockTimestamp)}
              </Td>
            </Row>
          );
        })}
      </tbody>
    </Table>
  );
}
