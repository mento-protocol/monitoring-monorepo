"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { AuthStatus } from "@/components/auth-status";
import { NavLinks, PUBLIC_NAV_LINKS } from "@/components/nav-links";

const mobileLinkClassName =
  "rounded-md px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800 hover:text-white focus:bg-slate-800 focus:text-white";

export function ResponsiveNav() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobilePanelId = useId();
  const brandLink = PUBLIC_NAV_LINKS[0]!;

  useEffect(() => {
    if (!mobileOpen) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileOpen]);

  const closeMobileMenu = () => setMobileOpen(false);

  return (
    <div className="w-full">
      <div className="flex items-center gap-3 lg:hidden">
        <Link
          href={brandLink.href}
          className="text-base font-bold text-white transition-colors hover:text-indigo-400"
          onClick={closeMobileMenu}
        >
          {brandLink.label}
        </Link>
        <button
          type="button"
          className="ml-auto rounded-md border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-slate-500 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          aria-expanded={mobileOpen}
          aria-controls={mobilePanelId}
          onClick={() => setMobileOpen((open) => !open)}
        >
          {mobileOpen ? "Close" : "Menu"}
        </button>
      </div>

      {mobileOpen && (
        <div
          id={mobilePanelId}
          className="mt-3 grid gap-3 border-t border-slate-800 pt-3 lg:hidden"
        >
          <div className="grid gap-1">
            <NavLinks
              includeBrand={false}
              linkClassName={mobileLinkClassName}
              onNavigate={closeMobileMenu}
            />
          </div>
          <AuthStatus variant="panel" />
        </div>
      )}

      <div className="hidden items-center gap-4 lg:flex">
        <NavLinks />
        <AuthStatus />
      </div>
    </div>
  );
}
