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
  const { symbol, troveId: rawTroveId } = await params;
  const decoded = decodeTroveIdParam(rawTroveId);
  const troveId = isValidTroveIdParam(decoded)
    ? normalizeTroveIdParam(decoded)
    : decoded;
  const title = `Trove ${troveId} — ${symbol.toUpperCase()} CDP — Mento Analytics`;
  const socialTitle = `${symbol.toUpperCase()} Trove ${shortTroveId(troveId)} history — Mento Analytics`;
  const description = "Indexed history for a Mento CDP position.";
  return {
    title,
    description,
    // A page-level title does not replace the root layout's Open Graph block.
    // Spell these out so Slack labels the nested dynamic image with this
    // position, rather than the homepage's generic "Mento Analytics" title.
    openGraph: { title: socialTitle, description, type: "website" },
    twitter: {
      card: "summary_large_image",
      title: socialTitle,
      description,
    },
  };
}

function shortTroveId(value: string): string {
  return value.length <= 13 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
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
