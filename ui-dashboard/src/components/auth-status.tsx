"use client";

import { useEffect, type MouseEvent } from "react";
import { useSession, signOut } from "next-auth/react";
import { useSWRConfig } from "swr";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as Sentry from "@sentry/nextjs";

const SIGN_IN_PATH = "/sign-in";

// Build the `?callbackUrl=` payload that round-trips OAuth back to where the
// user was. Pulled out of the component so it can run with either the SSR
// snapshot (initial paint, when `window` is unavailable) or the live URL
// (click time — see the long comment on the click handler below). Exported
// for unit tests; not intended as a public component API.
export function buildSignInHref(pathname: string, search: string): string {
  // Already on `/sign-in`? Don't re-wrap — preserve any existing `callbackUrl`
  // so the chain of redirects doesn't lose the original destination. Falling
  // through to the wrap-and-encode path here would produce
  // `/sign-in?callbackUrl=%2F%3FcallbackUrl%3D...`, which the sanitizer then
  // collapses to `/`, losing the user's intended target.
  if (pathname === SIGN_IN_PATH) {
    return search ? `${SIGN_IN_PATH}${search}` : SIGN_IN_PATH;
  }
  const callback = search ? `${pathname}${search}` : pathname || "/";
  return `${SIGN_IN_PATH}?callbackUrl=${encodeURIComponent(callback)}`;
}

export function AuthStatus() {
  const { data: session, status } = useSession();
  const { mutate } = useSWRConfig();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();

  // Attach the authenticated user's email to every Sentry event so issues
  // are filterable by who's affected. Internal-only tool (mentolabs.xyz
  // domain enforced in auth.ts), so the email is not third-party PII.
  useEffect(() => {
    const email = session?.user?.email;
    if (email) {
      Sentry.setUser({ email });
    } else {
      Sentry.setUser(null);
    }
  }, [session?.user?.email]);

  if (status === "loading") return null;

  if (!session) {
    // Round-trip the current page through OAuth so the user lands back where
    // they were instead of on the sign-in page's hardcoded default.
    const renderSearch = searchParams?.toString();
    const renderSearchSuffix = renderSearch ? `?${renderSearch}` : "";
    const renderHref = buildSignInHref(pathname ?? "/", renderSearchSuffix);

    // Several pages (`/pools`, `/leaderboard`, ...) write URL state via
    // `window.history.replaceState`, which Next's `useSearchParams()` does
    // not observe — so the render-time `searchParams` snapshot is stale
    // relative to what's actually in the address bar. See
    // `ui-dashboard/src/lib/use-table-sort.ts:103-110` and `:169-173` for
    // the same gotcha. We rebuild the destination from `window.location` at
    // click time so the OAuth round-trip lands the user back on whatever
    // they're actually looking at, including their current sort/filter.
    const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
      // Let modified clicks (cmd/ctrl/shift, middle button) keep their
      // browser-native semantics — opening in a new tab with the
      // render-time href is fine; the user's not navigating away.
      if (
        e.defaultPrevented ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey ||
        e.button !== 0
      ) {
        return;
      }
      const liveHref = buildSignInHref(
        window.location.pathname,
        window.location.search,
      );
      if (liveHref === renderHref) return;
      e.preventDefault();
      router.push(liveHref);
    };

    return (
      <Link
        href={renderHref}
        onClick={handleClick}
        className="ml-auto text-xs text-slate-400 hover:text-white transition-colors"
      >
        Sign in
      </Link>
    );
  }

  const handleSignOut = async () => {
    await mutate(
      (key: unknown) => Array.isArray(key) && key[0] === "address-labels",
      undefined,
      { revalidate: false },
    );
    await signOut();
  };

  return (
    <div className="ml-auto flex items-center gap-3">
      <span className="text-xs text-slate-400">{session.user?.email}</span>
      <button
        type="button"
        onClick={handleSignOut}
        className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
      >
        Sign out
      </button>
    </div>
  );
}
