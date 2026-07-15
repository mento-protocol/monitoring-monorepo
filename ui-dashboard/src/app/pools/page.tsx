import type { Metadata } from "next";
import { PoolsPageClient } from "./_components/pools-page-client";
import { fetchInitialNetworkData } from "@/lib/network-fetcher/server-cache";
import { isWeekend } from "@/lib/weekend";

// SSR the initial cross-chain pool list so first paint already contains the
// full pools table. Without this, the client renders a 3-row `<Skeleton />`
// then swaps in a ~27-row table when SWR resolves, pushing the swaps section
// below it down by ~1 200 px — measured CLS 0.4896 on the lhci /pools run
// (BACKLOG "Lighthouse CI Follow-Ups"). The payload is served from a
// cross-request cache (30s TTL, ~90s worst-case staleness via the fetchedAt
// age gate in server-cache; healthy payloads only — degraded ones are never
// cached, and the underlying `fetchAllNetworks` uses `Promise.allSettled`
// internally so it degrades per-network on failure); the catch only fires on
// truly unexpected errors, and an undefined initial payload falls back to
// the existing client-only path.
//
// This route also now has its own `loading.tsx`, shaped like the real page
// (KPI tiles + table placeholders). The 0.4896 CLS regression above came
// from a *generic* skeleton whose dimensions didn't match the loaded
// content, not from having a loading boundary per se — a shape-matched one
// is safe and covers the SSR-await gap plus client-side navigations here.
export const revalidate = 60;

export const metadata: Metadata = {
  title: "Pools — Mento Analytics",
  description:
    "All Mento pools across chains: reserves, TVL, 24h volume, and recent swaps.",
};

export default async function PoolsPage() {
  const initialPayload = await fetchInitialNetworkData().catch(() => undefined);
  const initialIsWeekend = isWeekend();
  return (
    <PoolsPageClient
      initialNetworkData={initialPayload?.networks}
      initialNetworkDataFetchedAtMs={initialPayload?.fetchedAtMs}
      initialIsWeekend={initialIsWeekend}
    />
  );
}
