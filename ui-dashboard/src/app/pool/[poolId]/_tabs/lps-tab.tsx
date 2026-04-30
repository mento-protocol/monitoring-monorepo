"use client";

import { AddressLink } from "@/components/address-link";
import { useAddressLabels } from "@/components/address-labels-provider";
import { EmptyBox, ErrorBox, Skeleton } from "@/components/feedback";
import { LpConcentrationChart } from "@/components/lp-concentration-chart";
import { useNetwork } from "@/components/network-provider";
import { Pagination } from "@/components/pagination";
import { Row, Table, Td, Th } from "@/components/table";
import { TableSearch } from "@/components/table-search";
import { formatTimestamp, parseWei, relativeTime } from "@/lib/format";
import { useGQL } from "@/lib/graphql";
import { POOL_LP_POSITIONS } from "@/lib/queries";
import { normalizeSearch } from "@/lib/table-search";
import { isFpmm, tokenSymbol, USDM_SYMBOLS } from "@/lib/tokens";
import type { LiquidityPosition, Pool } from "@/lib/types";
import React, { useMemo } from "react";
import { addressSearchTerms, matchesRowSearch } from "../_lib/helpers";

function isLiquidityPositionSchemaError(error: Error | undefined) {
  if (!error) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("liquidityposition") &&
    (msg.includes("cannot query field") ||
      msg.includes("not found in type") ||
      msg.includes("field not found"))
  );
}

export function LpsTab({
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
  const isFpmmPool = pool ? isFpmm(pool) : null;
  const shouldSkip = isFpmmPool === false;
  const { getName, getTags } = useAddressLabels();
  const { network } = useNetwork();
  const query = normalizeSearch(search);
  const [rawPage, setRawPage] = React.useState(1);

  const handleSearchChange = React.useCallback(
    (value: string) => {
      onSearchChange(value);
      setRawPage(1);
    },
    [onSearchChange],
  );

  const {
    data: indexedData,
    error: indexedError,
    isLoading: indexedLoading,
  } = useGQL<{
    LiquidityPosition: LiquidityPosition[];
  }>(shouldSkip ? null : POOL_LP_POSITIONS, { poolId });

  const positions = useMemo(
    () =>
      (indexedData?.LiquidityPosition ?? [])
        .map((position) => ({
          address: position.address,
          netLiquidity: BigInt(position.netLiquidity),
          lastUpdatedTimestamp: position.lastUpdatedTimestamp,
        }))
        .filter((position) => position.netLiquidity > BigInt(0))
        .sort((a, b) =>
          a.netLiquidity === b.netLiquidity
            ? 0
            : a.netLiquidity > b.netLiquidity
              ? -1
              : 1,
        ),
    [indexedData],
  );

  const totalLiquidity = useMemo(
    () =>
      positions.reduce(
        (acc, position) => acc + position.netLiquidity,
        BigInt(0),
      ),
    [positions],
  );

  if (isFpmmPool === false) {
    return (
      <EmptyBox message="LP provider data is only available for FPMM pools." />
    );
  }
  if (indexedError) {
    if (isLiquidityPositionSchemaError(indexedError)) {
      return (
        <EmptyBox message="LP provider data is unavailable until this environment is reindexed with the LiquidityPosition schema." />
      );
    }
    return <ErrorBox message={indexedError.message} />;
  }
  if (indexedLoading) return <Skeleton rows={5} />;
  if (positions.length === 0)
    return <EmptyBox message="No active LP positions for this pool." />;

  const rankedPositions = positions.map((p, i) => ({ ...p, rank: i + 1 }));
  const filteredPositions = query
    ? rankedPositions.filter((p) =>
        matchesRowSearch(query, [
          ...addressSearchTerms(p.address, getName, getTags),
        ]),
      )
    : rankedPositions;

  const isSearching = query.length > 0;
  const lpTotal = filteredPositions.length;
  const lpTotalPages = lpTotal > 0 ? Math.ceil(lpTotal / limit) : 1;
  const lpPage = Math.max(1, Math.min(rawPage, lpTotalPages));
  const pagedPositions = isSearching
    ? filteredPositions
    : filteredPositions.slice((lpPage - 1) * limit, lpPage * limit);

  // Derive per-position token amounts from pool reserves and LP share.
  // positionTokenAmount = positionShare * poolReserve
  const sym0 = tokenSymbol(network, pool?.token0 ?? null);
  const sym1 = tokenSymbol(network, pool?.token1 ?? null);
  const dec0 = pool?.token0Decimals ?? 18;
  const dec1 = pool?.token1Decimals ?? 18;
  const reserves0Raw = parseWei(pool?.reserves0 ?? "0", dec0);
  const reserves1Raw = parseWei(pool?.reserves1 ?? "0", dec1);
  const hasReserves = reserves0Raw > 0 || reserves1Raw > 0;

  // Oracle price for USD conversion — same logic as ReservesTab.
  const feedVal =
    pool?.oraclePrice && pool.oraclePrice !== "0"
      ? Number(pool.oraclePrice) / 1e24
      : null;
  const usdmIsToken0 = USDM_SYMBOLS.has(sym0);
  const usdmIsToken1 = USDM_SYMBOLS.has(sym1);
  // Only show USD values when exactly one side is USDm (ensures meaningful conversion)
  const hasUsdmSide = usdmIsToken0 !== usdmIsToken1; // XOR: exactly one side is USDm
  const showUsd = feedVal !== null && hasReserves && hasUsdmSide;

  return (
    <>
      <LpConcentrationChart
        positions={positions}
        totalLiquidity={totalLiquidity}
        getLabel={(addr) => getName(addr)}
        pool={pool}
        sym0={sym0}
        sym1={sym1}
        reserves0Raw={reserves0Raw}
        reserves1Raw={reserves1Raw}
        feedVal={feedVal}
        usdmIsToken0={usdmIsToken0}
      />
      <TableSearch
        value={search}
        onChange={handleSearchChange}
        placeholder="Search LPs by address, name, or tag..."
        ariaLabel="Search LPs"
      />
      {filteredPositions.length === 0 ? (
        <EmptyBox message="No LPs match your search." />
      ) : (
        <Table>
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/50">
              <Th>#</Th>
              <Th>Address</Th>
              <Th align="right">{sym0}</Th>
              <Th align="right">{sym1}</Th>
              {showUsd && <Th align="right">Total Value</Th>}
              <Th align="right">Share</Th>
              <Th>Last Active</Th>
            </tr>
          </thead>
          <tbody>
            {pagedPositions.map((position) => {
              const fmtTok = (
                v: number | null,
                sym: string,
                vUsd: number | null,
              ) => {
                if (v === null) return "—";
                const formatted = v.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                });
                const showSubUsd = vUsd !== null && !USDM_SYMBOLS.has(sym);
                return (
                  <div>
                    <span>
                      {formatted} {sym}
                    </span>
                    {showSubUsd && (
                      <div className="text-xs text-slate-500">
                        ≈ $
                        {vUsd!.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </div>
                    )}
                  </div>
                );
              };
              // Scale up by 1e6 before converting to Number to preserve precision
              // for large bigint liquidity values that exceed JS safe integer range.
              const shareNum =
                totalLiquidity > BigInt(0)
                  ? Number(
                      (position.netLiquidity * BigInt(1_000_000)) /
                        totalLiquidity,
                    ) / 1_000_000
                  : 0;
              const sharePct = (shareNum * 100).toFixed(2);

              const tok0 = hasReserves ? shareNum * reserves0Raw : null;
              const tok1 = hasReserves ? shareNum * reserves1Raw : null;

              // Convert each token to USD only when we have a valid USDm-paired oracle price.
              // tok0Usd = USD value of tok0:
              //   - if tok0 IS USDm → already in USD, value = tok0
              //   - if tok1 IS USDm → tok0 is the non-stable, convert via feedVal
              //   - otherwise → no valid conversion, null
              const tok0Usd: number | null =
                tok0 === null || !hasUsdmSide
                  ? null
                  : usdmIsToken0
                    ? tok0 // tok0 is USDm → already USD
                    : feedVal !== null
                      ? tok0 * feedVal // tok0 is non-stable → convert
                      : null;
              const tok1Usd: number | null =
                tok1 === null || !hasUsdmSide
                  ? null
                  : usdmIsToken1
                    ? tok1 // tok1 is USDm → already USD
                    : feedVal !== null
                      ? tok1 * feedVal // tok1 is non-stable → convert
                      : null;
              const totalUsd =
                tok0Usd !== null && tok1Usd !== null ? tok0Usd + tok1Usd : null;

              return (
                <Row key={position.address}>
                  <Td small muted>
                    {position.rank}
                  </Td>
                  <Td>
                    <AddressLink address={position.address} />
                  </Td>
                  <Td mono small align="right">
                    {fmtTok(tok0, sym0, tok0Usd)}
                  </Td>
                  <Td mono small align="right">
                    {fmtTok(tok1, sym1, tok1Usd)}
                  </Td>
                  {showUsd && (
                    <Td mono small align="right">
                      {totalUsd !== null
                        ? `$${totalUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : "—"}
                    </Td>
                  )}
                  <Td mono small align="right">
                    {sharePct}%
                  </Td>
                  <Td
                    small
                    muted
                    title={formatTimestamp(position.lastUpdatedTimestamp)}
                  >
                    {relativeTime(position.lastUpdatedTimestamp)}
                  </Td>
                </Row>
              );
            })}
          </tbody>
        </Table>
      )}
      {!isSearching && (
        <Pagination
          page={lpPage}
          pageSize={limit}
          total={lpTotal}
          onPageChange={setRawPage}
        />
      )}
    </>
  );
}
