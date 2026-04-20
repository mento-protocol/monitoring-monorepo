import type { Metadata } from "next";
import { fetchPoolForMetadata, type PoolOgData } from "@/lib/pool-og";
import { formatUSD } from "@/lib/format";

export const revalidate = 3600;

const FALLBACK_TITLE = "Pool — Mento Analytics";
const FALLBACK_DESCRIPTION = "Mento protocol pool analytics";

function healthLabel(status: PoolOgData["health"]): string {
  switch (status) {
    case "OK":
      return "healthy";
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

export default function PoolLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
