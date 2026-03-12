"use client";

import { Suspense, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { NetworkAwareLink } from "@/components/network-aware-link";
import { useGQL } from "@/lib/graphql";
import { ALL_POOLS_WITH_HEALTH, RECENT_SWAPS, POOL_SWAPS } from "@/lib/queries";
import {
  truncateAddress,
  formatWei,
  relativeTime,
  formatTimestamp,
  formatBlock,
  isValidAddress,
} from "@/lib/format";
import { buildPoolNameMap, tokenSymbol } from "@/lib/tokens";
import { PoolsTable } from "@/components/pools-table";
import { useNetwork } from "@/components/network-provider";
import type { Pool, SwapEvent } from "@/lib/types";
import { Table, Row, Th, Td } from "@/components/table";
import { Skeleton, EmptyBox, ErrorBox, Tile } from "@/components/feedback";
import { LimitSelect } from "@/components/controls";
import { SenderCell } from "@/components/sender-cell";

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
  } = useGQL<{ Pool: Pool[] }>(ALL_POOLS_WITH_HEALTH);

  const swapQuery = poolFilter ? POOL_SWAPS : RECENT_SWAPS;
  const swapVars = poolFilter ? { poolId: poolFilter, limit } : { limit };
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
      const p = new URLSearchParams(searchParams.toString());
      if (pool) p.set("pool", pool);
      else p.delete("pool");
      if (lim !== 25) p.set("limit", String(lim));
      else p.delete("limit");
      const qs = p.toString();
      router.replace(qs ? `/?${qs}` : "/", { scroll: false });
    },
    [router, searchParams],
  );

  const applyFilter = useCallback(() => {
    const v = filterInput.trim();
    if (v && !isValidAddress(v)) {
      setFilterError("Invalid address (expected 0x + 40 hex chars)");
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
          <PoolsTable pools={pools} />
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
            placeholder="0x…"
            aria-label="Filter swaps by pool address"
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
