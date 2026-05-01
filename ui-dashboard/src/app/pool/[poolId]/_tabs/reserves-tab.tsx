"use client";

import { EmptyBox, ErrorBox, Skeleton } from "@/components/feedback";
import { useNetwork } from "@/components/network-provider";
import { ReserveChart } from "@/components/reserve-chart";
import { Row, Table, Td, Th } from "@/components/table";
import { TableSearch } from "@/components/table-search";
import { TxHashCell } from "@/components/tx-hash-cell";
import {
  formatBlock,
  formatTimestamp,
  formatWei,
  parseWei,
  relativeTime,
} from "@/lib/format";
import { useGQL } from "@/lib/graphql";
import { POOL_RESERVES } from "@/lib/queries";
import { normalizeSearch } from "@/lib/table-search";
import { tokenSymbol, USDM_SYMBOLS } from "@/lib/tokens";
import type { Pool, ReserveUpdate } from "@/lib/types";
import { useMemo } from "react";
import { matchesRowSearch } from "../_lib/helpers";

export function ReservesTab({
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
  const { data, error, isLoading } = useGQL<{ ReserveUpdate: ReserveUpdate[] }>(
    POOL_RESERVES,
    { poolId, limit },
  );
  const { network } = useNetwork();
  const query = normalizeSearch(search);

  const rows = data?.ReserveUpdate ?? [];
  const sym0 = tokenSymbol(network, pool?.token0 ?? null);
  const sym1 = tokenSymbol(network, pool?.token1 ?? null);

  // Query returns newest-first; chart needs chronological (asc) for plotting.
  const chartRows = useMemo(() => [...rows].reverse(), [rows]);

  const feedVal =
    pool?.oraclePrice && pool.oraclePrice !== "0"
      ? Number(pool.oraclePrice) / 1e24
      : null;
  const usdmIsToken0 = USDM_SYMBOLS.has(sym0);
  const usdmIsToken1 = USDM_SYMBOLS.has(sym1);
  const hasUsdmSide = usdmIsToken0 !== usdmIsToken1;
  const showUsd = feedVal !== null && hasUsdmSide;

  const filteredRows = useMemo(() => {
    if (!query) return rows;
    return rows.filter((r) => {
      const raw0 = parseWei(r.reserve0, pool?.token0Decimals ?? 18);
      const raw1 = parseWei(r.reserve1, pool?.token1Decimals ?? 18);
      const usd0 = feedVal && !usdmIsToken0 ? raw0 * feedVal : raw0;
      const usd1 = feedVal && usdmIsToken0 ? raw1 * feedVal : raw1;
      const total = usd0 + usd1;

      return matchesRowSearch(query, [
        r.txHash,
        sym0,
        sym1,
        formatWei(r.reserve0, pool?.token0Decimals ?? 18, 2),
        formatWei(r.reserve1, pool?.token1Decimals ?? 18, 2),
        showUsd
          ? total.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })
          : null,
        r.blockNumber,
      ]);
    });
  }, [rows, query, sym0, sym1, pool, feedVal, usdmIsToken0, showUsd]);

  if (error) return <ErrorBox message={error.message} />;
  if (isLoading) return <Skeleton rows={5} />;
  if (rows.length === 0)
    return <EmptyBox message="No reserve updates for this pool." />;

  return (
    <>
      <ReserveChart
        rows={chartRows}
        token0={pool?.token0 ?? null}
        token1={pool?.token1 ?? null}
        pool={pool}
      />
      <TableSearch
        value={search}
        onChange={onSearchChange}
        placeholder="Search reserves by tx, token, amount, or block…"
        ariaLabel="Search reserves"
      />
      {filteredRows.length === 0 ? (
        <EmptyBox message="No reserve updates match your search." />
      ) : (
        <Table>
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/50">
              <Th>Tx</Th>
              <Th align="right">{sym0} Reserve</Th>
              <Th align="right">{sym1} Reserve</Th>
              <Th align="right">Total (USD)</Th>
              <th
                scope="col"
                className="hidden sm:table-cell px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium text-slate-400 text-right"
              >
                Block
              </th>
              <Th>Time</Th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r) => {
              const raw0 = parseWei(r.reserve0, pool?.token0Decimals ?? 18);
              const raw1 = parseWei(r.reserve1, pool?.token1Decimals ?? 18);
              const usd0 = feedVal && !usdmIsToken0 ? raw0 * feedVal : raw0;
              const usd1 = feedVal && usdmIsToken0 ? raw1 * feedVal : raw1;
              const total = usd0 + usd1;

              return (
                <Row key={r.id}>
                  <TxHashCell txHash={r.txHash} />
                  <Td mono small align="right">
                    <div>
                      {formatWei(r.reserve0, pool?.token0Decimals ?? 18, 2)}{" "}
                      {sym0}
                    </div>
                    {showUsd && (
                      <div className="text-xs text-slate-500">
                        ≈ $
                        {usd0.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </div>
                    )}
                  </Td>
                  <Td mono small align="right">
                    <div>
                      {formatWei(r.reserve1, pool?.token1Decimals ?? 18, 2)}{" "}
                      {sym1}
                    </div>
                    {showUsd && (
                      <div className="text-xs text-slate-500">
                        ≈ $
                        {usd1.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </div>
                    )}
                  </Td>
                  <Td mono small align="right">
                    {showUsd
                      ? `$${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                      : "—"}
                  </Td>
                  <td className="hidden sm:table-cell px-2 sm:px-4 py-1.5 sm:py-2 font-mono text-[10px] sm:text-xs text-slate-400 text-right">
                    {formatBlock(r.blockNumber)}
                  </td>
                  <Td small muted title={formatTimestamp(r.blockTimestamp)}>
                    {relativeTime(r.blockTimestamp)}
                  </Td>
                </Row>
              );
            })}
          </tbody>
        </Table>
      )}
    </>
  );
}
