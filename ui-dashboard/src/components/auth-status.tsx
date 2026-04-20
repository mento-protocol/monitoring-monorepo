"use client";

import { useEffect } from "react";
import { useSession, signOut } from "next-auth/react";
import { useSWRConfig } from "swr";
import Link from "next/link";
import * as Sentry from "@sentry/nextjs";

export function AuthStatus() {
  const { data: session, status } = useSession();
  const { mutate } = useSWRConfig();

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
    return (
      <Link
        href="/sign-in"
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
