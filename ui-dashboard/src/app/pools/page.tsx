import type { Metadata } from "next";
import { PoolsPageClient } from "./_components/pools-page-client";
import { fetchAllNetworks } from "@/lib/fetch-all-networks";

// SSR the initial cross-chain pool list so first paint already contains the
// full pools table. Without this, the client renders a 3-row `<Skeleton />`
// then swaps in a ~27-row table when SWR resolves, pushing the swaps section
// below it down by ~1 200 px — measured CLS 0.4896 on the lhci /pools run
// (BACKLOG "Lighthouse CI Follow-Ups"). `fetchAllNetworks` uses
// `Promise.allSettled` internally and degrades per-network on failure, so
// the catch only fires on truly unexpected errors; an undefined initial
// payload falls back to the existing client-only path.
export const revalidate = 60;

export const metadata: Metadata = {
  title: "Pools — Mento Analytics",
  description:
    "All Mento pools across chains: TVL, 24h volume, trading limits, and recent swaps.",
};

export default async function PoolsPage() {
  const initialNetworkData = await fetchAllNetworks().catch(() => undefined);
  return <PoolsPageClient initialNetworkData={initialNetworkData} />;
}
