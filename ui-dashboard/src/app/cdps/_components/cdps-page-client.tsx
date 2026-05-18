"use client";

import { useMemo } from "react";
import { useNetwork } from "@/components/network-provider";
import { EmptyBox, ErrorBox, Skeleton } from "@/components/feedback";
import { useGQL } from "@/lib/graphql";
import { CDP_MARKETS } from "@/lib/queries";
import type { CdpCollateral, CdpInstance } from "../_lib/types";
import { CdpMarketCard } from "./cdp-market-card";

type CdpMarketsResponse = {
  LiquityCollateral: CdpCollateral[];
  LiquityInstance: CdpInstance[];
};

export function CdpsPageClient() {
  const { network } = useNetwork();
  const { data, error, isLoading } = useGQL<CdpMarketsResponse>(
    network.chainId === 42220 ? CDP_MARKETS : null,
    { chainId: network.chainId },
  );

  const instances = useMemo(() => {
    const m = new Map<string, CdpInstance>();
    for (const instance of data?.LiquityInstance ?? []) {
      m.set(instance.collateralId, instance);
    }
    return m;
  }, [data]);

  if (network.chainId !== 42220) {
    return (
      <EmptyBox message="CDP markets are only deployed on Celo mainnet." />
    );
  }

  if (isLoading) return <Skeleton rows={6} />;
  if (error) {
    return (
      <ErrorBox message={`Failed to load CDP markets — ${error.message}`} />
    );
  }

  const collaterals = data?.LiquityCollateral ?? [];
  if (collaterals.length === 0) {
    return <EmptyBox message="No CDP markets indexed yet." />;
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-white">CDPs</h1>
        <p className="mt-1 text-sm text-slate-400">
          USDm-backed borrower markets for Mento stable assets.
        </p>
      </header>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {collaterals.map((collateral) => (
          <CdpMarketCard
            key={collateral.id}
            collateral={collateral}
            instance={instances.get(collateral.id)}
          />
        ))}
      </div>
    </div>
  );
}
