import type { Metadata } from "next";
import { fetchPoolForMetadata, type PoolOgData } from "@/lib/pool-og";
import { formatUSD } from "@/lib/format";
import { buildPoolDetailUrl, POOL_NOT_FOUND_DEST } from "@/lib/routing";
import { redirect } from "next/navigation";
import { PoolDetailPageClient } from "./_components/pool-detail-page-client";
import { decodePoolId } from "./_lib/helpers";
import {
  isRoutablePoolId,
  parseRouteChainId,
  routeCanonicalPoolId,
} from "./_lib/route-canonicalization";

// 60s — incident-time state flips should propagate in minutes, not hours.
export const revalidate = 60;

const FALLBACK_TITLE = "Pool — Mento Analytics";
const FALLBACK_DESCRIPTION = "Mento protocol pool analytics";

type PageSearchParams = Record<string, string | string[] | undefined>;
type PoolDetailPageProps = {
  params?: Promise<{ poolId: string }>;
  searchParams?: Promise<PageSearchParams>;
};

function healthLabel(status: PoolOgData["health"]): string {
  switch (status) {
    case "OK":
      return "OK";
    case "WARN":
      return "warn";
    case "CRITICAL":
      return "critical";
    case "WEEKEND":
      return "markets closed";
    default:
      return "n/a";
  }
}

function buildDescription(data: PoolOgData): string {
  const parts: string[] = [];
  // `tvlUsd === null` means unpriceable; omit. `0` means empty pool and
  // renders as "$0.00" — a real state worth communicating.
  if (data.tvlUsd != null) parts.push(`TVL ${formatUSD(data.tvlUsd)}`);
  if (data.volume7dUsd != null) {
    parts.push(`7d volume ${formatUSD(data.volume7dUsd)}`);
  }
  let healthText = `Health: ${healthLabel(data.health)}`;
  if (data.healthReasons.length > 0) {
    healthText += ` (${data.healthReasons.join(", ")})`;
  }
  parts.push(healthText);
  return parts.join(" · ");
}

function toURLSearchParams(searchParams: PageSearchParams): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else if (value !== undefined) {
      params.set(key, value);
    }
  }
  return params;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ poolId: string }>;
}): Promise<Metadata> {
  const { poolId } = await params;
  const data = await fetchPoolForMetadata(poolId);
  if (!data) {
    return {
      title: FALLBACK_TITLE,
      description: FALLBACK_DESCRIPTION,
      openGraph: {
        title: FALLBACK_TITLE,
        description: FALLBACK_DESCRIPTION,
        type: "website",
      },
      twitter: {
        card: "summary_large_image",
        title: FALLBACK_TITLE,
        description: FALLBACK_DESCRIPTION,
      },
    };
  }

  const title = `${data.name} on ${data.chainLabel} — Mento Analytics`;
  const description = buildDescription(data);
  return {
    title,
    description,
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}

// Re-export public symbols — `__tests__/exports.test.ts` pins this list,
// and several test files (ols, page, reward-outliers, use-gql-shape) import
// these directly from "../page". Keep stable.
export {
  decodePoolId,
  getDebtTokenSideLabel,
  parseTabLimit,
  selectActiveOlsPool,
} from "./_lib/helpers";
export {
  computeRewardThresholds,
  renderRewardCell,
  toDisplayPrecision,
} from "./_tabs/rebalances-tab";
export { OlsLiquidityTable } from "./_components/ols-liquidity-table";
export { OlsStatusPanel } from "./_components/ols-status-panel";

async function CanonicalPoolDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ poolId: string }>;
  searchParams: Promise<PageSearchParams>;
}) {
  const [{ poolId }, resolvedSearchParams] = await Promise.all([
    params,
    searchParams,
  ]);
  const decodedId = decodePoolId(poolId);
  const explicitChainId = parseRouteChainId(resolvedSearchParams.chainId);
  const canonicalPoolId = routeCanonicalPoolId(decodedId, explicitChainId);

  if (canonicalPoolId !== decodedId) {
    const redirectParams = toURLSearchParams(resolvedSearchParams);
    redirectParams.delete("chainId");
    redirect(buildPoolDetailUrl(canonicalPoolId, redirectParams));
  }
  if (!isRoutablePoolId(canonicalPoolId)) {
    redirect(POOL_NOT_FOUND_DEST);
  }

  return <PoolDetailPageClient />;
}

export default function PoolDetailPage({
  params,
  searchParams,
}: PoolDetailPageProps = {}) {
  if (!params || !searchParams) return <PoolDetailPageClient />;
  return (
    <CanonicalPoolDetailPage params={params} searchParams={searchParams} />
  );
}
