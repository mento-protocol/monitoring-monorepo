"use client";

import Link from "next/link";
import { useNetwork } from "@/components/network-provider";
import { DEFAULT_NETWORK } from "@/lib/networks";
import type { ComponentProps } from "react";

type Props = ComponentProps<typeof Link>;

/**
 * Drop-in replacement for Next.js <Link> that automatically preserves the
 * active `?network=` query param on every navigation. Falls back to a plain
 * <Link> when the active network is the default (no param needed).
 */
export function NetworkAwareLink({ href, ...props }: Props) {
  const { networkId } = useNetwork();

  let networkHref = href;
  if (networkId !== DEFAULT_NETWORK && typeof href === "string") {
    const separator = href.includes("?") ? "&" : "?";
    networkHref = `${href}${separator}network=${networkId}`;
  }

  return <Link href={networkHref} {...props} />;
}
