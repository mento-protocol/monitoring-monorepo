"use client";

import Link from "next/link";
import { useMemo } from "react";
import { AddressLink } from "@/components/address-link";
import { useNetwork } from "@/components/network-provider";
import { EmptyBox, ErrorBox, Skeleton, Tile } from "@/components/feedback";
import { Table, Row, Th, Td } from "@/components/table";
import { useGQL } from "@/lib/graphql";
import { CDP_MARKET_DETAIL, CDP_MARKETS } from "@/lib/queries";
import { buildPoolDetailHref } from "@/lib/routing";
import { formatWei, relativeTime, truncateAddress } from "@/lib/format";
import type {
  CdpCollateral,
  CdpDepositor,
  CdpInstance,
  CdpPoolRow,
  CdpTrove,
} from "../../_lib/types";
import {
  cdpSymbolSlug,
  formatBpsPercent,
  formatTokenAmount,
} from "../../_lib/format";

type CdpMarketsResponse = {
  LiquityCollateral: CdpCollateral[];
  LiquityInstance: CdpInstance[];
};

type CdpDetailResponse = {
  LiquityCollateral: CdpCollateral[];
  LiquityInstance: CdpInstance[];
  Trove: CdpTrove[];
  StabilityPoolDepositor: CdpDepositor[];
  CdpPool: CdpPoolRow[];
};

export function CdpDetailClient({ symbol }: { symbol: string }) {
  const { network } = useNetwork();
  const symbolSlug = cdpSymbolSlug(symbol);
  const markets = useGQL<CdpMarketsResponse>(
    network.chainId === 42220 ? CDP_MARKETS : null,
    { chainId: network.chainId },
  );
  const collateral = useMemo(
    () =>
      (markets.data?.LiquityCollateral ?? []).find(
        (row) => cdpSymbolSlug(row.symbol) === symbolSlug,
      ),
    [markets.data, symbolSlug],
  );
  const detail = useGQL<CdpDetailResponse>(
    collateral == null ? null : CDP_MARKET_DETAIL,
    collateral == null ? undefined : { collateralId: collateral.id },
  );

  return (
    <CdpDetailState
      chainId={network.chainId}
      markets={markets}
      detail={detail}
      collateral={collateral}
    />
  );
}

function CdpDetailState({
  chainId,
  markets,
  detail,
  collateral,
}: {
  chainId: number;
  markets: ReturnType<typeof useGQL<CdpMarketsResponse>>;
  detail: ReturnType<typeof useGQL<CdpDetailResponse>>;
  collateral: CdpCollateral | undefined;
}) {
  if (chainId !== 42220) {
    return (
      <EmptyBox message="CDP markets are only deployed on Celo mainnet." />
    );
  }
  if (markets.isLoading || (collateral != null && detail.isLoading)) {
    return <Skeleton rows={8} />;
  }
  if (markets.error) {
    return (
      <ErrorBox
        message={`Failed to load CDP markets — ${markets.error.message}`}
      />
    );
  }
  if (collateral == null) {
    return <EmptyBox message="Unknown CDP market." />;
  }
  if (detail.error) {
    return (
      <ErrorBox
        message={`Failed to load CDP market — ${detail.error.message}`}
      />
    );
  }

  const instance = detail.data?.LiquityInstance[0];
  const troves = detail.data?.Trove ?? [];
  const depositors = detail.data?.StabilityPoolDepositor ?? [];
  const cdpPools = detail.data?.CdpPool ?? [];

  return (
    <CdpDetailContent
      collateral={collateral}
      instance={instance}
      troves={troves}
      depositors={depositors}
      cdpPools={cdpPools}
    />
  );
}

function CdpDetailContent({
  collateral,
  instance,
  troves,
  depositors,
  cdpPools,
}: {
  collateral: CdpCollateral;
  instance: CdpInstance | undefined;
  troves: CdpTrove[];
  depositors: CdpDepositor[];
  cdpPools: CdpPoolRow[];
}) {
  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link
            href="/cdps"
            className="text-sm text-indigo-400 hover:text-indigo-300"
          >
            CDPs
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-white">
            {collateral.symbol} CDP Market
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            USDm collateral, debt denominated in {collateral.symbol}.
          </p>
        </div>
        <span className="text-xs text-slate-500">
          Last event {relativeTime(instance?.lastEventTimestamp ?? "0")}
        </span>
      </header>

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Tile
          label="System Debt"
          value={formatTokenAmount(instance?.systemDebt, collateral.symbol)}
        />
        <Tile label="TCR" value={formatBpsPercent(instance?.tcrBps)} />
        <Tile
          label="Stability Pool"
          value={formatTokenAmount(instance?.spDeposits, collateral.symbol)}
          subtitle={`Headroom ${formatTokenAmount(instance?.spHeadroom, collateral.symbol)}`}
        />
        <Tile
          label="Active Troves"
          value={instance == null ? "—" : String(instance.activeTroveCount)}
          subtitle={`Median ICR ${formatBpsPercent(instance?.icrP50Bps)}`}
        />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TroveTable
          troves={troves}
          symbol={collateral.symbol}
          chainId={collateral.chainId}
        />
        <DepositorTable
          depositors={depositors}
          symbol={collateral.symbol}
          chainId={collateral.chainId}
        />
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-3">CDP Pools</h2>
        {cdpPools.length === 0 ? (
          <EmptyBox message="No active FPMM pools linked to this CDP market." />
        ) : (
          <Table>
            <thead>
              <Row>
                <Th>Pool</Th>
                <Th align="right">Cooldown</Th>
                <Th align="right">Updated</Th>
              </Row>
            </thead>
            <tbody>
              {cdpPools.map((pool) => (
                <Row key={pool.id}>
                  <Td mono>
                    <Link
                      href={buildPoolDetailHref(pool.poolId)}
                      className="text-indigo-400 hover:text-indigo-300"
                    >
                      {truncateAddress(pool.poolId)}
                    </Link>
                  </Td>
                  <Td align="right">{pool.rebalanceCooldownSec}s</Td>
                  <Td align="right">{relativeTime(pool.updatedAtTimestamp)}</Td>
                </Row>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}

function TroveTable({
  troves,
  symbol,
  chainId,
}: {
  troves: CdpTrove[];
  symbol: string;
  chainId: number;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3">Riskiest Troves</h2>
      {troves.length === 0 ? (
        <EmptyBox message="No troves indexed yet." />
      ) : (
        <Table>
          <thead>
            <Row>
              <Th>Owner</Th>
              <Th>Status</Th>
              <Th align="right">Debt</Th>
              <Th align="right">ICR</Th>
            </Row>
          </thead>
          <tbody>
            {troves.map((trove) => (
              <Row key={trove.id}>
                <Td>
                  <AddressLink address={trove.owner} chainId={chainId} />
                </Td>
                <Td>{trove.status}</Td>
                <Td align="right">{formatTokenAmount(trove.debt, symbol)}</Td>
                <Td align="right">{formatBpsPercent(trove.icrBps)}</Td>
              </Row>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

function DepositorTable({
  depositors,
  symbol,
  chainId,
}: {
  depositors: CdpDepositor[];
  symbol: string;
  chainId: number;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3">
        Last-Touched Depositors
      </h2>
      {depositors.length === 0 ? (
        <EmptyBox message="No stability pool depositors indexed yet." />
      ) : (
        <Table>
          <thead>
            <Row>
              <Th>Depositor</Th>
              <Th align="right">Deposit</Th>
              <Th align="right">Stashed Coll</Th>
              <Th align="right">Updated</Th>
            </Row>
          </thead>
          <tbody>
            {depositors.map((depositor) => (
              <Row key={depositor.id}>
                <Td>
                  <AddressLink address={depositor.address} chainId={chainId} />
                </Td>
                <Td align="right">
                  {formatTokenAmount(depositor.lastTouchedDeposit, symbol)}
                </Td>
                <Td align="right">
                  {formatWei(depositor.stashedColl, 18, 2)} USDm
                </Td>
                <Td align="right">{relativeTime(depositor.lastUpdatedAt)}</Td>
              </Row>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}
