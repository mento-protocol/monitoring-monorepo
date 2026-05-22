import type { Metadata } from "next";
import { StablesPageClient } from "./_components/stables-page-client";

export const metadata: Metadata = {
  title: "Stablecoin supply | Mento Monitoring",
  description:
    "Outstanding supply of Mento-issued stablecoins (USDm, EURm, GBPm, ...) over time. V2 Reserve + V3 hub USDm + V3 Liquity CDP debt — unified daily snapshots and per-tx supply changes.",
};

export default function StablesPage(): React.JSX.Element {
  return <StablesPageClient />;
}
