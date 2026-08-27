import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isValidTroveIdParam, normalizeTroveIdParam } from "./_lib/params";
import { TroveDetailClient } from "./_components/trove-detail-client";

function decodeTroveIdParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ symbol: string; troveId: string }>;
}): Promise<Metadata> {
  const { symbol, troveId } = await params;
  return {
    title: `Trove ${troveId} — ${symbol.toUpperCase()} CDP — Mento Analytics`,
    description: "Trove history for a Mento CDP position.",
  };
}

export default async function TroveDetailPage({
  params,
}: {
  params: Promise<{ symbol: string; troveId: string }>;
}) {
  const { symbol, troveId: rawTroveId } = await params;
  const decoded = decodeTroveIdParam(rawTroveId);
  // Server-side guard runs before any client JS ships — malformed input
  // (not a `0x`-prefixed hex id) redirects to the market page instead of
  // reaching the client resolver with garbage.
  if (!isValidTroveIdParam(decoded)) redirect(`/cdps/${symbol}`);
  const troveId = normalizeTroveIdParam(decoded);
  return <TroveDetailClient symbol={symbol} troveId={troveId} />;
}
