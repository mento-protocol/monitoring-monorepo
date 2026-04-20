import type { Metadata } from "next";
import type { ReactNode } from "react";
import {
  fetchBridgeFlowsOgData,
  type BridgeFlowsOgData,
} from "@/lib/bridge-flows-og";
import { formatUSD } from "@/lib/format";

// Match the 60s cadence of the OG image route. Without segment revalidation,
// /bridge-flows is otherwise treated as fully static (the page itself is a
// client component with no server-side data fetches), so `generateMetadata`
// would only re-run on deploys — leaving Slack/Twitter unfurls stale until
// the next push.
export const revalidate = 60;

const STATIC_FALLBACK =
  "Wormhole bridge transfers of Mento stable tokens across Celo and Monad.";

function buildDescription(data: BridgeFlowsOgData | null): string {
  if (!data) return STATIC_FALLBACK;

  // `null` = snapshots query failed → omit the metric entirely (don't lie
  // about $0 when we don't know). `0` = snapshots returned empty (truly
  // idle) → include "$0" / "0 transfers" so the description is honest.
  const parts: string[] = [];
  if (data.volume30dUsd != null) {
    parts.push(`30d bridged volume ${formatUSD(data.volume30dUsd)}`);
  }
  if (data.totalTransfers30d != null) {
    parts.push(
      `${data.totalTransfers30d.toLocaleString()} ${
        data.totalTransfers30d === 1 ? "transfer" : "transfers"
      }`,
    );
  }

  // If both data fields are unavailable (snapshot fetch failed), the chains
  // list alone reads as a fragment ("on Celo + Monad."). Fall through to
  // the static sentence in that case so the meta tag is grammatical.
  if (parts.length === 0) return STATIC_FALLBACK;

  if (data.chains.length > 0) {
    parts.push(`on ${data.chains.join(" + ")}`);
  }
  return parts.join(" · ") + ".";
}

export async function generateMetadata(): Promise<Metadata> {
  const data = await fetchBridgeFlowsOgData();
  const title = "Bridge Flows — Mento Analytics";
  const description = buildDescription(data);
  return {
    title,
    description,
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default function BridgeFlowsLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
