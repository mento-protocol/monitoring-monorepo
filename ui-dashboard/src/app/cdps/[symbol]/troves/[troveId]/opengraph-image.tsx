import { ImageResponse } from "next/og";
import { ogFontOptions } from "@/lib/og-fonts";
import { isValidTroveIdParam, normalizeTroveIdParam } from "./_lib/params";
import {
  fetchTroveOgDataForMetadata,
  type TroveOgData,
} from "./_lib/trove-og-data";
import {
  shortTroveId,
  TroveOgCard,
  type TroveOgIdentity,
} from "./_og/trove-og-card";

export const runtime = "nodejs";
export const revalidate = 60;
export const contentType = "image/png";
export const size = { width: 1200, height: 630 };

type RouteParams = { symbol: string; troveId: string };

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function routeIdentity(params: RouteParams): TroveOgIdentity {
  const decodedTroveId = decodeParam(params.troveId);
  return {
    symbol: decodeParam(params.symbol),
    troveId: isValidTroveIdParam(decodedTroveId)
      ? normalizeTroveIdParam(decodedTroveId)
      : decodedTroveId,
  };
}

export function buildTroveOgAlt(
  data: TroveOgData | null,
  identity: TroveOgIdentity,
): string {
  const shown = data ?? identity;
  const prefix = `Mento Analytics · ${shown.symbol.toUpperCase()} Trove ${shortTroveId(shown.troveId)}`;
  if (data === null) return `${prefix} · indexed snapshot unavailable`;
  return `${prefix} · ${data.statusLabel} · collateral ${data.collateral} · debt ${data.debt} · ICR ${data.icr} · ${data.lastEventLabel.toLowerCase()} ${data.lastEventDate}`;
}

// One minute fresh, then at most five minutes of stale replay. The card can
// show a collateral-ratio warning, so it uses the same bounded stale window as
// the peg-monitoring safety card. Slack can keep its own per-URL copy longer;
// no response header can refresh a message that Slack already expanded.
const IMAGE_CACHE_CONTROL =
  "public, max-age=60, s-maxage=60, stale-while-revalidate=300";

export async function generateImageMetadata({
  params,
}: {
  params: Promise<RouteParams>;
}) {
  const identity = routeIdentity(await params);
  const data = await fetchTroveOgDataForMetadata(
    identity.symbol,
    identity.troveId,
  );
  return [
    {
      id: "og",
      alt: buildTroveOgAlt(data, identity),
      size,
      contentType,
    },
  ];
}

export default async function Image({
  params,
}: {
  params: Promise<RouteParams>;
}) {
  const identity = routeIdentity(await params);
  const data = await fetchTroveOgDataForMetadata(
    identity.symbol,
    identity.troveId,
  );
  return new ImageResponse(<TroveOgCard data={data} identity={identity} />, {
    ...size,
    ...(await ogFontOptions()),
    headers: { "Cache-Control": IMAGE_CACHE_CONTROL },
  });
}
