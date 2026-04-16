"use client";

import { useEffect } from "react";
import { ErrorBox } from "@/components/feedback";
import Link from "next/link";

export default function PoolDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[pool/[poolId]/error]", error);
  }, [error]);

  return (
    <div className="space-y-4">
      <ErrorBox
        message={
          error.message ||
          "Failed to load pool. The pool may not exist on this network, or the indexer may be offline."
        }
      />
      {error.digest && (
        <p className="text-xs text-slate-500">
          Error ID: <code className="font-mono">{error.digest}</code>
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-800"
        >
          Try again
        </button>
        <Link
          href="/pools"
          className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-800"
        >
          Back to pools
        </Link>
      </div>
    </div>
  );
}
