"use client";

import { usePathname } from "next/navigation";
import { NetworkSelector } from "@/components/network-selector";

/**
 * Renders the NetworkSelector only on per-network pages (/pools, /pool/[id]).
 * Hidden on the global homepage (/) since it aggregates all chains already.
 */
export function ConditionalNetworkSelector() {
  const pathname = usePathname();
  const showSelector =
    pathname.startsWith("/pools") || pathname.startsWith("/pool/");
  if (!showSelector) return null;
  return <NetworkSelector />;
}
