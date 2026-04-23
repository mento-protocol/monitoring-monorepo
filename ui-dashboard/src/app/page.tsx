import type { Metadata } from "next";
import GlobalPage from "./page-client";
import { fetchHomepageOgData } from "@/lib/homepage-og";
import { fetchAllNetworks } from "@/lib/fetch-all-networks";
import { formatUSD } from "@/lib/format";

// Dynamic OG metadata — scoped to the homepage so other routes (/pool/...,
// /address-book, etc.) don't inherit the cross-chain I/O when the cache is
// cold. Matches the helper + opengraph-image.tsx 60s TTL.
export const revalidate = 60;

const FALLBACK_TITLE = "Mento Analytics";
const FALLBACK_DESCRIPTION =
  "Cross-chain analytics dashboard for Mento protocol";

function buildDescription(
  data: NonNullable<Awaited<ReturnType<typeof fetchHomepageOgData>>>,
): string {
  const parts: string[] = [];
  // Lead with a partial-overview warning when any chain is offline — the
  // surviving-chain numbers aren't protocol-wide in that case.
  if (data.partial) {
    parts.push(`Partial — ${data.offlineChains.join(", ")} offline`);
  }
  // `null` = unavailable (omit); `0` = real empty state (render as "$0.00").
  if (data.totalTvlUsd != null)
    parts.push(`TVL ${formatUSD(data.totalTvlUsd)}`);
  if (data.totalVolume7dUsd != null) {
    parts.push(`7d volume ${formatUSD(data.totalVolume7dUsd)}`);
  }
  parts.push(`${data.poolCount} pools on ${data.chains.join(" + ")}`);
  const { WARN = 0, CRITICAL = 0 } = data.healthBuckets;
  const attention = WARN + CRITICAL;
  if (attention > 0) {
    parts.push(`${attention} ${attention === 1 ? "needs" : "need"} attention`);
  }
  return parts.join(" · ");
}

export async function generateMetadata(): Promise<Metadata> {
  const data = await fetchHomepageOgData();
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
  const description = buildDescription(data);
  return {
    title: FALLBACK_TITLE,
    description,
    openGraph: {
      title: FALLBACK_TITLE,
      description,
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: FALLBACK_TITLE,
      description,
    },
  };
}

export default async function HomePage() {
  // SSR the initial dashboard payload so first paint renders without a
  // 14-fan-out GraphQL waterfall. `fetchAllNetworks` uses Promise.allSettled
  // internally and returns per-network fallback on failure, so it won't
  // throw — but guard anyway in case a truly unexpected error bubbles up;
  // an undefined initial payload just reverts to the client-only code path.
  const initialNetworkData = await fetchAllNetworks().catch(() => undefined);
  return <GlobalPage initialNetworkData={initialNetworkData} />;
}
