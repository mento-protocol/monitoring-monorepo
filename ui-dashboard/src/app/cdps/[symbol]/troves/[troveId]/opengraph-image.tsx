import { ImageResponse } from "next/og";
import { ogFontOptions } from "@/lib/og-fonts";
import { isValidTroveIdParam, normalizeTroveIdParam } from "./_lib/params";
import {
  fetchTroveOgDataForMetadata,
  TROVE_OG_MAX_DATA_AGE_MS,
  type TroveOgData,
} from "./_lib/trove-og-data";
import {
  shortTroveId,
  TroveOgCard,
  type TroveOgIdentity,
} from "./_og/trove-og-card";

export const runtime = "nodejs";
export const revalidate = 0;
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
  return `${prefix} · ${data.statusLabel} · collateral ${data.collateral} · debt ${data.debt} · indexed ICR ${data.icr} · ${data.lastEventLabel.toLowerCase()} ${data.lastEventDate}`;
}

const IMAGE_CACHE_MAX_SECONDS = 60;

export function buildImageCacheControl(
  data: TroveOgData | null,
  nowMs: number = Date.now(),
): string {
  const remainingMs =
    data === null
      ? IMAGE_CACHE_MAX_SECONDS * 1_000
      : Math.max(0, TROVE_OG_MAX_DATA_AGE_MS - (nowMs - data.fetchedAtMs));
  const sharedMaxAge = Math.min(
    IMAGE_CACHE_MAX_SECONDS,
    Math.floor(remainingMs / 1_000),
  );
  return `public, max-age=0, s-maxage=${sharedMaxAge}, must-revalidate`;
}

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
    // The route output is not ISR-cached. The CDN lifetime cannot cross the
    // source snapshot's five-minute freshness boundary. Slack can retain a
    // message-local copy longer after it expands the URL.
    headers: { "Cache-Control": buildImageCacheControl(data) },
  });
}
