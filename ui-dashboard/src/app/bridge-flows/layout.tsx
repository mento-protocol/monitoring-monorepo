import type { Metadata } from "next";
import type { ReactNode } from "react";
import {
  fetchBridgeFlowsOgData,
  type BridgeFlowsOgData,
} from "@/lib/bridge-flows-og";
import { formatUSD } from "@/lib/format";

function buildDescription(data: BridgeFlowsOgData | null): string {
  if (!data) {
    return "Wormhole NTT bridge transfers of Mento stable tokens across Celo and Monad.";
  }
  const parts: string[] = [];
  if (data.volume30dUsd != null && data.volume30dUsd > 0) {
    parts.push(`30d bridged volume ${formatUSD(data.volume30dUsd)}`);
  }
  if (data.totalTransfers30d != null && data.totalTransfers30d > 0) {
    parts.push(
      `${data.totalTransfers30d.toLocaleString()} ${
        data.totalTransfers30d === 1 ? "transfer" : "transfers"
      }`,
    );
  }
  if (data.chains.length > 0) {
    parts.push(`on ${data.chains.join(" + ")}`);
  }
  if (parts.length === 0) {
    return "Wormhole NTT bridge transfers of Mento stable tokens across Celo and Monad.";
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
