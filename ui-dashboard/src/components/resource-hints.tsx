"use client";

import { preconnect, prefetchDNS } from "react-dom";
import { clientEnv } from "@/env";

const HASURA_URLS = [
  clientEnv.NEXT_PUBLIC_HASURA_URL,
  clientEnv.NEXT_PUBLIC_HASURA_URL_CELO_SEPOLIA,
  clientEnv.NEXT_PUBLIC_HASURA_URL_TESTNET,
];

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export function resourceHintOriginFromHasuraUrl(
  hasuraUrl: string | undefined,
): string | null {
  if (!hasuraUrl) return null;
  try {
    const url = new URL(hasuraUrl);
    if (url.protocol !== "https:" || isLocalHostname(url.hostname)) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function resourceHintOriginsFromHasuraUrls(
  hasuraUrls: readonly (string | undefined)[],
): string[] {
  const origins = new Set<string>();
  for (const hasuraUrl of hasuraUrls) {
    const origin = resourceHintOriginFromHasuraUrl(hasuraUrl);
    if (origin) origins.add(origin);
  }
  return Array.from(origins);
}

export function ResourceHints() {
  for (const origin of resourceHintOriginsFromHasuraUrls(HASURA_URLS)) {
    preconnect(origin, { crossOrigin: "anonymous" });
    prefetchDNS(origin);
  }
  return null;
}
