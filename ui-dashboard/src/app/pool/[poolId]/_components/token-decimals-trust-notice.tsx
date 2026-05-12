import type { Pool } from "@/lib/types";
import { EmptyBox, Skeleton } from "@/components/feedback";
import type { Tab } from "../_lib/constants";
import type { ReactNode } from "react";

const TOKEN_AMOUNT_TABS = new Set<Tab>([
  "swaps",
  "reserves",
  "rebalances",
  "liquidity",
  "providers",
  "ols",
]);

export function isTokenAmountTab(tab: Tab): boolean {
  return TOKEN_AMOUNT_TABS.has(tab);
}

export function TokenDecimalsTrustNotice({
  pool,
  thresholdsLoading,
  thresholdsError,
}: {
  pool: Pool | null;
  thresholdsLoading: boolean;
  thresholdsError: Error | undefined;
}) {
  if (!pool) return null;

  if (thresholdsLoading) {
    return (
      <p
        role="status"
        className="mb-4 rounded-md border border-slate-700 bg-slate-900/70 px-4 py-3 text-sm text-slate-300"
      >
        Checking token decimal metadata before rendering token amount tab data.
      </p>
    );
  }

  if (thresholdsError) {
    return (
      <p
        role="alert"
        className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
      >
        Token decimal metadata is unavailable. Token amount tabs are hidden
        until the trust query recovers.
      </p>
    );
  }

  if (pool.tokenDecimalsKnown !== true) {
    return (
      <p
        role="alert"
        className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
      >
        Token decimals are unverified for this pool. Token amount tabs are
        hidden until the indexer confirms on-chain decimals.
      </p>
    );
  }

  return null;
}

export function TokenAmountTrustGate({
  active,
  pool,
  thresholdsLoading,
  thresholdsError,
  children,
}: {
  active: boolean;
  pool: Pool | null;
  thresholdsLoading: boolean;
  thresholdsError: Error | undefined;
  children: ReactNode;
}) {
  if (!active) return <>{children}</>;
  // The primary pool query intentionally excludes tokenDecimalsKnown; wait for
  // the isolated trust query before mounting amount-tab data hooks.
  if (!pool || thresholdsLoading) return <Skeleton rows={5} />;
  if (thresholdsError) {
    return (
      <EmptyBox message="Token amount tab data is hidden until token decimal metadata can be verified." />
    );
  }
  if (pool.tokenDecimalsKnown !== true) {
    return (
      <EmptyBox message="Token amount tab data is hidden because token decimals are unverified for this pool." />
    );
  }
  return <>{children}</>;
}
