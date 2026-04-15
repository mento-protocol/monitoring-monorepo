"use client";

import { Suspense, useState, useCallback, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { buildPoolDetailHref, buildPoolsFilterUrl } from "@/lib/routing";
import { useGQL } from "@/lib/graphql";
import { useAllNetworksData } from "@/hooks/use-all-networks-data";
import { buildGlobalPoolEntries } from "@/lib/global-pool-entries";
import { ALL_OLS_POOLS, RECENT_SWAPS, POOL_SWAPS } from "@/lib/queries";
import {
  truncateAddress,
  formatWei,
  relativeTime,
  formatTimestamp,
  formatBlock,
  isNamespacedPoolId,
  isValidAddress,
} from "@/lib/format";
import { poolName, tokenSymbol } from "@/lib/tokens";
import {
  GlobalPoolsTable,
  type GlobalPoolEntry,
} from "@/components/global-pools-table";
import { ChainIcon } from "@/components/chain-icon";
import {
  NETWORKS,
  networkIdForChainId,
  DEFAULT_NETWORK,
  type Network,
} from "@/lib/networks";
import type { OlsPool, Pool, SwapEvent } from "@/lib/types";
import { Table, Row, Th, Td } from "@/components/table";
import { Skeleton, EmptyBox, ErrorBox, Tile } from "@/components/feedback";
import { LimitSelect } from "@/components/controls";
import { SenderCell } from "@/components/sender-cell";

export default function PoolsPage() {
  return (
    <Suspense>
      <PoolsContent />
    </Suspense>
  );
}

function PoolsContent() {
  const { networkData, isLoading: poolsLoading } = useAllNetworksData();
  const searchParams = useSearchParams();
  const router = useRouter();

  const poolFilter = searchParams.get("pool") ?? "";
  const limit = Number(searchParams.get("limit") ?? "25");

  const [filterInput, setFilterInput] = useState(poolFilter);
  const [filterError, setFilterError] = useState("");

  const [prevPoolFilter, setPrevPoolFilter] = useState(poolFilter);
  if (prevPoolFilter !== poolFilter) {
    setPrevPoolFilter(poolFilter);
    setFilterInput(poolFilter);
    setFilterError("");
  }

  const { entries, volume24hByKey, volume7dByKey, tvlChangeWoWByKey } = useMemo(
    () => buildGlobalPoolEntries(networkData),
    [networkData],
  );

  const poolsByNamespacedId = useMemo(() => {
    const m = new Map<string, GlobalPoolEntry>();
    for (const e of entries) m.set(e.pool.id, e);
    return m;
  }, [entries]);

  const poolNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const [id, { pool, network }] of poolsByNamespacedId) {
      m[id] = poolName(network, pool.token0, pool.token1);
    }
    return m;
  }, [poolsByNamespacedId]);

  const {
    data: olsData,
    error: olsErr,
    isLoading: olsLoading,
  } = useGQL<{ OlsPool: Pick<OlsPool, "poolId">[] }>(ALL_OLS_POOLS);
  const olsPoolIds = useMemo(
    () => new Set((olsData?.OlsPool ?? []).map((p) => p.poolId)),
    [olsData],
  );

  const swapQuery = poolFilter ? POOL_SWAPS : RECENT_SWAPS;
  const swapVars = poolFilter ? { poolId: poolFilter, limit } : { limit };
  const {
    data: swapsData,
    error: swapsErr,
    isLoading: swapsLoading,
  } = useGQL<{ SwapEvent: SwapEvent[] }>(swapQuery, swapVars);

  const swaps = swapsData?.SwapEvent ?? [];
  const failedNetworks = networkData.filter((n) => n.error !== null);

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
      setFilterError("Invalid pool filter (expected 0x… or {chainId}-0x…)");
      return;
    }
    setFilterError("");
    setURL(v, limit);
  }, [filterInput, limit, setURL]);

  const clearFilter = useCallback(() => {
    setFilterInput("");
    setFilterError("");
    setURL("", limit);
  }, [limit, setURL]);

  const latestBlock = swaps.length > 0 ? swaps[0].blockNumber : null;

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Tile
          label="Pools"
          value={poolsLoading ? "…" : String(entries.length)}
        />
        <Tile
          label="Showing"
          value={swapsLoading ? "…" : `${swaps.length} swaps`}
        />
        <Tile
          label="Latest Swap Block"
          value={latestBlock ? formatBlock(latestBlock) : "—"}
        />
      </div>

      {failedNetworks.map((net) => (
        <ErrorBox
          key={net.network.id}
          message={`${net.network.label}: Failed to load pools — ${net.error?.message}`}
        />
      ))}

      <section aria-labelledby="pools-heading">
        <h2
          id="pools-heading"
          className="text-lg font-semibold text-white mb-3"
        >
          Pools
        </h2>
        {olsErr && !olsLoading && (
          <div className="mb-3">
            <ErrorBox
              message={`OLS status unavailable right now: ${olsErr.message}. Pool list is loaded, but OLS badges may be incomplete.`}
            />
          </div>
        )}
        {poolsLoading ? (
          <Skeleton rows={3} />
        ) : failedNetworks.length === 0 && entries.length === 0 ? (
          <EmptyBox message="No pools found across any chain." />
        ) : (
          <GlobalPoolsTable
            entries={entries}
            volume24hByKey={volume24hByKey}
            volume7dByKey={volume7dByKey}
            tvlChangeWoWByKey={tvlChangeWoWByKey}
            olsPoolIds={olsPoolIds}
          />
        )}
      </section>

      <section aria-labelledby="swaps-heading">
        <h2
          id="swaps-heading"
          className="text-lg font-semibold text-white mb-3"
        >
          {poolFilter
            ? `Swaps for ${poolNames[poolFilter] ?? truncateAddress(poolFilter)}`
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

        {filterError && (
          <p
            id="filter-error"
            className="mb-3 text-sm text-red-400"
            role="alert"
          >
            {filterError}
          </p>
        )}

        {swapsErr ? (
          <ErrorBox message={`Failed to load swaps: ${swapsErr.message}`} />
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
            poolsByNamespacedId={poolsByNamespacedId}
          />
        )}
      </section>
    </div>
  );
}

function networkForChainId(chainId: number): Network {
  const id = networkIdForChainId(chainId);
  return id ? NETWORKS[id] : NETWORKS[DEFAULT_NETWORK];
}

function SwapTable({
  swaps,
  showPool,
  poolNames,
  poolsByNamespacedId,
}: {
  swaps: SwapEvent[];
  showPool: boolean;
  poolNames: Record<string, string>;
  poolsByNamespacedId: Map<string, GlobalPoolEntry>;
}) {
  return (
    <Table>
      <thead>
        <tr className="border-b border-slate-800 bg-slate-900/50">
          <Th>Chain</Th>
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
          const entry = poolsByNamespacedId.get(s.poolId);
          const network = entry?.network ?? networkForChainId(s.chainId);
          const pool: Pool | undefined = entry?.pool;
          const sym0 = tokenSymbol(network, pool?.token0 ?? null);
          const sym1 = tokenSymbol(network, pool?.token1 ?? null);
          const soldToken0 = BigInt(s.amount0In) > BigInt(0);
          const soldAmt = soldToken0 ? s.amount0In : s.amount1In;
          const boughtAmt = soldToken0 ? s.amount1Out : s.amount0Out;
          const soldSym = soldToken0 ? sym0 : sym1;
          const boughtSym = soldToken0 ? sym1 : sym0;
          return (
            <Row key={s.id}>
              <td className="px-4 py-2">
                <ChainIcon network={network} />
              </td>
              {showPool && (
                <td className="px-4 py-2">
                  <Link
                    href={buildPoolDetailHref(s.poolId)}
                    className="text-sm font-medium text-indigo-400 hover:text-indigo-300"
                    title={s.poolId}
                  >
                    {poolNames[s.poolId] ?? truncateAddress(s.poolId)}
                  </Link>
                </td>
              )}
              <SenderCell address={s.sender} chainId={s.chainId} />
              <SenderCell address={s.recipient} chainId={s.chainId} />
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
