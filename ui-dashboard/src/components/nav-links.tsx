"use client";

import { NetworkAwareLink } from "@/components/network-aware-link";

export function NavLinks() {
  return (
    <>
      <NetworkAwareLink
        href="/"
        className="text-base sm:text-lg font-bold text-white hover:text-indigo-400 transition-colors"
      >
        Mento v3
      </NetworkAwareLink>
      <NetworkAwareLink
        href="/"
        className="text-xs sm:text-sm font-medium text-slate-400 hover:text-indigo-400 transition-colors"
      >
        Global
      </NetworkAwareLink>
      <NetworkAwareLink
        href="/pools"
        className="text-xs sm:text-sm font-medium text-slate-400 hover:text-indigo-400 transition-colors"
      >
        Pools
      </NetworkAwareLink>
      <NetworkAwareLink
        href="/address-book"
        className="text-xs sm:text-sm font-medium text-slate-400 hover:text-indigo-400 transition-colors"
      >
        Addresses
      </NetworkAwareLink>
    </>
  );
}
