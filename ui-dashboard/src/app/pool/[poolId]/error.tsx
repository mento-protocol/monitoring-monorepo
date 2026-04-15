"use client";

import Link from "next/link";
import { useEffect } from "react";
import { ErrorBox } from "@/components/feedback";

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
      <div className="flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-800"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-800"
        >
          Back to overview
        </Link>
      </div>
    </div>
  );
}
