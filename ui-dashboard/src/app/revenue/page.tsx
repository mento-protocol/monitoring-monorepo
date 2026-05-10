import type { Metadata } from "next";
import { RevenuePageClient } from "./_components/revenue-page-client";

export const metadata: Metadata = {
  title: "Protocol Revenue — Mento Analytics",
  description:
    "Mento protocol revenue: swap fees, CDP borrowing fees, and reserve yield across all chains.",
};

export default function RevenuePage() {
  return <RevenuePageClient />;
}
