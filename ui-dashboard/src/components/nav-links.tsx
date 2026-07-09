"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";

type NavLinkItem = {
  href: string;
  label: string;
  kind: "brand" | "section";
};

export const BRAND_NAV_LINK: NavLinkItem = {
  href: "/",
  label: "Mento Analytics",
  kind: "brand",
};

const PUBLIC_NAV_LINKS: readonly NavLinkItem[] = [
  BRAND_NAV_LINK,
  { href: "/pools", label: "Pools", kind: "section" },
  { href: "/volume", label: "Volume", kind: "section" },
  { href: "/stables", label: "Stables", kind: "section" },
  { href: "/bridge-flows", label: "Bridges", kind: "section" },
  { href: "/cdps", label: "CDPs", kind: "section" },
];

const AUTH_NAV_LINKS: readonly NavLinkItem[] = [
  { href: "/integrations", label: "Integrations", kind: "section" },
  { href: "/revenue", label: "Revenue", kind: "section" },
  { href: "/address-book", label: "Addresses", kind: "section" },
  { href: "/entities", label: "Entities", kind: "section" },
];

type NavLinksProps = {
  includeBrand?: boolean;
  linkClassName?: string;
  brandClassName?: string;
  onNavigate?: () => void;
};

const desktopBrandClassName =
  "text-base sm:text-lg font-bold text-white hover:text-indigo-400 transition-colors";
const desktopLinkClassName =
  "text-xs sm:text-sm font-medium text-slate-400 hover:text-indigo-400 transition-colors";

export function NavLinks({
  includeBrand = true,
  linkClassName = desktopLinkClassName,
  brandClassName = desktopBrandClassName,
  onNavigate,
}: NavLinksProps = {}) {
  const { data: session } = useSession();
  const publicLinks = includeBrand
    ? PUBLIC_NAV_LINKS
    : PUBLIC_NAV_LINKS.slice(1);
  const links = session ? [...publicLinks, ...AUTH_NAV_LINKS] : publicLinks;

  return (
    <>
      {links.map((link) => {
        const navigateProps = onNavigate ? { onClick: onNavigate } : {};

        return (
          <Link
            key={link.href}
            href={link.href}
            className={link.kind === "brand" ? brandClassName : linkClassName}
            {...navigateProps}
          >
            {link.label}
          </Link>
        );
      })}
    </>
  );
}
