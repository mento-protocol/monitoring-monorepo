"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";

export function NavLinks() {
  const { data: session } = useSession();

  return (
    <>
      <Link
        href="/"
        className="text-base sm:text-lg font-bold text-white hover:text-indigo-400 transition-colors"
      >
        Mento Analytics
      </Link>
      <Link
        href="/pools"
        className="text-xs sm:text-sm font-medium text-slate-400 hover:text-indigo-400 transition-colors"
      >
        Pools
      </Link>
      <Link
        href="/bridge-flows"
        className="text-xs sm:text-sm font-medium text-slate-400 hover:text-indigo-400 transition-colors"
      >
        Bridges
      </Link>
      <Link
        href="/revenue"
        className="text-xs sm:text-sm font-medium text-slate-400 hover:text-indigo-400 transition-colors"
      >
        Revenue
      </Link>
      {session && (
        <Link
          href="/address-book"
          className="text-xs sm:text-sm font-medium text-slate-400 hover:text-indigo-400 transition-colors"
        >
          Addresses
        </Link>
      )}
    </>
  );
}
