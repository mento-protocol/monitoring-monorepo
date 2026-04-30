"use client";

import { EmptyBox, ErrorBox, Skeleton } from "@/components/feedback";
import type { useNetwork } from "@/components/network-provider";
import { SenderCell } from "@/components/sender-cell";
import { Row, Table, Td, Th } from "@/components/table";
import { TxHashCell } from "@/components/tx-hash-cell";
import { formatTimestamp, formatWei, relativeTime } from "@/lib/format";
import { tokenSymbol } from "@/lib/tokens";
import type { OlsLiquidityEvent, Pool } from "@/lib/types";

export function OlsLiquidityTable({
  events,
  pool,
  network,
  isLoading,
  error,
}: {
  events: OlsLiquidityEvent[];
  pool: Pool | null;
  network: ReturnType<typeof useNetwork>["network"];
  isLoading: boolean;
  error: Error | null;
}) {
  if (error) return <ErrorBox message={error.message} />;
  if (isLoading) return <Skeleton rows={5} />;
  if (events.length === 0)
    return <EmptyBox message="No OLS liquidity events for this pool." />;

  return (
    <Table>
      <thead>
        <tr className="border-b border-slate-800 bg-slate-900/50">
          <Th>Time</Th>
          <Th>Direction</Th>
          <Th align="right">Given to Pool</Th>
          <Th align="right">Taken from Pool</Th>
          <Th>Caller</Th>
          <Th>Tx</Th>
        </tr>
      </thead>
      <tbody>
        {events.map((e) => {
          const givenSym = tokenSymbol(network, e.tokenGivenToPool);
          const takenSym = tokenSymbol(network, e.tokenTakenFromPool);
          const givenDec =
            pool?.token0?.toLowerCase() === e.tokenGivenToPool.toLowerCase()
              ? (pool?.token0Decimals ?? 18)
              : (pool?.token1Decimals ?? 18);
          const takenDec =
            pool?.token0?.toLowerCase() === e.tokenTakenFromPool.toLowerCase()
              ? (pool?.token0Decimals ?? 18)
              : (pool?.token1Decimals ?? 18);
          return (
            <Row key={e.id}>
              <Td small muted title={formatTimestamp(e.blockTimestamp)}>
                {relativeTime(e.blockTimestamp)}
              </Td>
              <td className="px-4 py-2">
                {e.direction === 0 ? (
                  <span className="inline-flex items-center rounded-full bg-emerald-900/60 px-2 py-0.5 text-xs font-medium text-emerald-300 ring-1 ring-emerald-700/50">
                    EXPAND
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-red-900/60 px-2 py-0.5 text-xs font-medium text-red-300 ring-1 ring-red-700/50">
                    CONTRACT
                  </span>
                )}
              </td>
              <Td mono small align="right">
                {formatWei(e.amountGivenToPool, givenDec)} {givenSym}
              </Td>
              <Td mono small align="right">
                {formatWei(e.amountTakenFromPool, takenDec)} {takenSym}
              </Td>
              <SenderCell address={e.caller} />
              <TxHashCell txHash={e.txHash} />
            </Row>
          );
        })}
      </tbody>
    </Table>
  );
}
