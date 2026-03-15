"use client";

import { usePathname } from "next/navigation";
import { NetworkSelector } from "@/components/network-selector";

/**
 * Renders the NetworkSelector only on per-network pages (/pools, /pool/[id]).
 * Hidden on the global homepage (/) since it aggregates all chains already.
 */
export function ConditionalNetworkSelector() {
  const pathname = usePathname();
  // Hide only on the global homepage — every other route is network-scoped
  if (pathname === "/") return null;
  return <NetworkSelector />;
}
