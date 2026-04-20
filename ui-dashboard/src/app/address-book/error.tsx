"use client";

import { ErrorBox } from "@/components/feedback";
import { useReportError } from "@/hooks/use-report-error";

// Middleware redirects unauthenticated requests to /sign-in before this page
// ever mounts, and all foreseeable data-layer failures inside
// AddressBookClient are caught inline. This boundary is the last-resort
// fallback for render-time exceptions; keep it minimal.

export default function AddressBookError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useReportError(error);

  return (
    <div className="space-y-4">
      <ErrorBox
        message={
          error.message || "Failed to load the address book. Try refreshing."
        }
      />
      {error.digest && (
        <p className="text-xs text-slate-500">
          Error ID: <code className="font-mono">{error.digest}</code>
        </p>
      )}
      <button
        type="button"
        onClick={reset}
        className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-800"
      >
        Try again
      </button>
    </div>
  );
}
