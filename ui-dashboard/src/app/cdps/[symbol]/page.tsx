import type { Metadata } from "next";
import { CdpDetailClient } from "./_components/cdp-detail-client";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ symbol: string }>;
}): Promise<Metadata> {
  const { symbol } = await params;
  return {
    title: `${symbol.toUpperCase()} CDP Market — Mento Analytics`,
    description: "Detailed system health for a Mento CDP market.",
  };
}

export default async function CdpDetailPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol } = await params;
  return <CdpDetailClient symbol={symbol} />;
}
