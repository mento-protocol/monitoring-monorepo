"use client";

import Link from "next/link";
import { useEffect } from "react";
import { ErrorBox } from "@/components/feedback";

// Middleware redirects unauthenticated requests to /sign-in before this ever
// renders, so most errors here are data-layer failures or transient bugs in
// the client. We still check the message defensively in case a server action
// rethrows an auth failure after the page has mounted.
const AUTH_HINTS = ["unauthorized", "authentication required", "access denied"];

export default function AddressBookError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[address-book/error]", error);
  }, [error]);

  const isAuthError = AUTH_HINTS.some((hint) =>
    error.message?.toLowerCase().includes(hint),
  );

  return (
    <div className="space-y-4">
      <ErrorBox
        message={
          isAuthError
            ? "Your session expired. Sign in again to continue."
            : error.message ||
              "Failed to load the address book. Try refreshing."
        }
      />
      <div className="flex gap-2">
        {isAuthError ? (
          <Link
            href="/sign-in?callbackUrl=/address-book"
            className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-800"
          >
            Sign in
          </Link>
        ) : (
          <button
            type="button"
            onClick={reset}
            className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-800"
          >
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
