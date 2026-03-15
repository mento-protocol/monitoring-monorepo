"use client";

import { usePathname } from "next/navigation";
import { NetworkSelector } from "@/components/network-selector";

/**
 * Renders the NetworkSelector on all routes except the global homepage (/).
 * Hidden on / since it aggregates all chains; visible everywhere else
 * (e.g. /pools, /pool/*, /address-book) where per-chain context matters.
 */
export function ConditionalNetworkSelector() {
  const pathname = usePathname();
  // Hide only on the global homepage — every other route is network-scoped
  if (pathname === "/") return null;
  return <NetworkSelector />;
}
