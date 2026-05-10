import type { Metadata } from "next";
import { PoolsPageClient } from "./_components/pools-page-client";

export const metadata: Metadata = {
  title: "Pools — Mento Analytics",
  description:
    "All Mento pools across chains: TVL, 24h volume, trading limits, and recent swaps.",
};

export default function PoolsPage() {
  return <PoolsPageClient />;
}
