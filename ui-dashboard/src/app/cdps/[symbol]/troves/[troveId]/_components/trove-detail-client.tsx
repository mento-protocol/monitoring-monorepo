"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useNetwork } from "@/components/network-provider";
import { EmptyBox, ErrorBox, Skeleton } from "@/components/feedback";
import { useGQL } from "@/lib/graphql";
import { hasErrorWithoutData, isLoadingWithoutData } from "@/lib/swr-state";
import type { Network } from "@/lib/networks";
import { explorerAddressUrl } from "@/lib/tokens";
import {
  CDP_MARKETS,
  CDP_TROVE_BY_ID,
  CDP_TROVE_OPERATIONS,
} from "@/lib/queries";
import type {
  CdpCollateral,
  CdpTrove,
  CdpTroveListRow,
  CdpTroveOperationEventRow,
} from "../../../../_lib/types";
import { cdpSymbolSlug } from "../../../../_lib/format";
import {
  CDP_TROVE_OPERATIONS_REQUEST_LIMIT,
  makeTroveEntityId,
  paginateTroveOperations,
} from "../_lib/params";
import { TroveHeaderCard } from "./trove-header-card";
import { TroveLifetimeTotals } from "./trove-lifetime-totals";
import { TroveOperationsList } from "./trove-operations-list";

const CELO_MAINNET_CHAIN_ID = 42220;

type CdpMarketsResponse = {
  LiquityCollateral: CdpCollateral[];
  LiquityInstance: unknown[];
  Trove: CdpTroveListRow[];
};

type CdpTroveByIdResponse = {
  Trove: CdpTrove[];
};

type CdpTroveOperationsResponse = {
  TroveOperationEvent: CdpTroveOperationEventRow[];
};

export function TroveDetailClient({
  symbol,
  troveId,
}: {
  symbol: string;
  /** Already validated + lowercased by the server component (page.tsx). */
  troveId: string;
}) {
  const { network } = useNetwork();
  const symbolSlug = cdpSymbolSlug(symbol);
  const markets = useGQL<CdpMarketsResponse>(
    network.chainId === CELO_MAINNET_CHAIN_ID ? CDP_MARKETS : null,
    { chainId: network.chainId },
  );
  const collateral = useMemo(
    () =>
      (markets.data?.LiquityCollateral ?? []).find(
        (row) => cdpSymbolSlug(row.symbol) === symbolSlug,
      ),
    [markets.data, symbolSlug],
  );
  const troveEntityId =
    collateral == null ? null : makeTroveEntityId(collateral.id, troveId);
  const troveById = useGQL<CdpTroveByIdResponse>(
    troveEntityId == null ? null : CDP_TROVE_BY_ID,
    troveEntityId == null ? undefined : { troveEntityId },
  );
  const operations = useGQL<CdpTroveOperationsResponse>(
    collateral == null ? null : CDP_TROVE_OPERATIONS,
    collateral == null
      ? undefined
      : {
          instanceId: collateral.id,
          troveId,
          limit: CDP_TROVE_OPERATIONS_REQUEST_LIMIT,
        },
  );
  const { rows: operationRows, truncated } = useMemo(
    () => paginateTroveOperations(operations.data?.TroveOperationEvent ?? []),
    [operations.data],
  );

  if (network.chainId !== CELO_MAINNET_CHAIN_ID) {
    return (
      <EmptyBox message="CDP markets are only deployed on Celo mainnet." />
    );
  }
  if (isLoadingWithoutData(markets.isLoading, markets.data)) {
    return <Skeleton rows={8} />;
  }
  if (hasErrorWithoutData(markets.error, markets.data)) {
    return (
      <ErrorBox
        message={`Failed to load CDP markets — ${markets.error.message}`}
      />
    );
  }
  if (collateral == null) {
    return <EmptyBox message="Unknown CDP market." />;
  }
  if (isLoadingWithoutData(troveById.isLoading, troveById.data)) {
    return <Skeleton rows={6} />;
  }
  if (hasErrorWithoutData(troveById.error, troveById.data)) {
    return (
      <ErrorBox message={`Failed to load trove — ${troveById.error.message}`} />
    );
  }
  const trove = troveById.data?.Trove[0];
  if (trove == null) {
    return (
      <NotIndexedNotice
        troveId={troveId}
        collateral={collateral}
        symbol={symbol}
        network={network}
      />
    );
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/cdps/${symbol}`}
        className="text-sm text-indigo-400 hover:text-indigo-300"
      >
        ← {collateral.symbol} market
      </Link>
      <TroveHeaderCard trove={trove} collateral={collateral} />
      <TroveLifetimeTotals trove={trove} debtSymbol={collateral.symbol} />
      <TroveOperationsList
        rows={operationRows}
        truncated={truncated}
        isLoading={operations.isLoading}
        error={operations.error}
        chainId={collateral.chainId}
        debtSymbol={collateral.symbol}
      />
    </div>
  );
}

function NotIndexedNotice({
  troveId,
  collateral,
  symbol,
  network,
}: {
  troveId: string;
  collateral: CdpCollateral;
  symbol: string;
  network: Network;
}) {
  return (
    <div className="space-y-3">
      <EmptyBox
        message={`Trove ${troveId} is not indexed for ${collateral.symbol}. Verify the id, or it may not exist on this market.`}
      />
      <div className="flex gap-3 text-sm">
        <a
          href={explorerAddressUrl(network, collateral.troveManager)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-indigo-400 hover:text-indigo-300"
        >
          View the TroveManager contract ↗
        </a>
        <Link
          href={`/cdps/${symbol}`}
          className="text-indigo-400 hover:text-indigo-300"
        >
          Back to {collateral.symbol} market
        </Link>
      </div>
    </div>
  );
}
