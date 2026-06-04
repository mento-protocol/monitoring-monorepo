"use client";

import { useEffect } from "react";
import { signOut, useSession } from "next-auth/react";

// The server already rejects RefreshTokenError sessions (getAuthSession() +
// middleware + the export route). But the client `useSession()` model reports
// `authenticated` for ANY truthy session, so after a client-side session
// refetch a revoked/offboarded user could briefly see auth-only affordances
// (nav links, AuthStatus) and fire protected fetches that then 401.
//
// Rather than gate every `useSession()` consumer on `session?.error`, sign out
// centrally the moment the client observes the error — this drops the client
// to `unauthenticated` and clears the stale cookie, covering all consumers at
// once. `redirect: false` keeps the user on the current (public) page; if they
// navigate to a protected route, middleware handles the redirect. Rendered once
// inside SessionProvider.
export function SessionErrorGuard() {
  const { data: session } = useSession();

  useEffect(() => {
    if (session?.error === "RefreshTokenError") {
      void signOut({ redirect: false });
    }
  }, [session?.error]);

  return null;
}
